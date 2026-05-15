/**
 * Scenario 21 — claude-code built-in cost-tracking smoke (warren-87f9).
 *
 * Parallel to scenario 16 (pi cost parity) but for the `claude-code`
 * built-in. Asserts that warren's bridge `extractClaudeUsage` reads the
 * terminal `result` envelope's `total_cost_usd` + `usage.*_tokens` and
 * persists them via `RunsRepo.attachStats` — so a claude-code run lands
 * with non-null `cost_usd` / `tokens_input` / `tokens_output` /
 * `tokens_cache_read` / `tokens_cache_write` columns, the same way pi
 * runs do.
 *
 * The acceptance harness overrides burrow's built-in `claude-code`
 * runtime (which would otherwise invoke the real `claude` CLI and
 * require an Anthropic API key) with a custom AgentRuntime in
 * `burrow-with-stub.ts` — declarative spawn into
 * `tools/claude-code-stub-agent.sh`, event parsing via burrow's real
 * `parseJsonlClaude`. The stub emits a fixed-shape stream-json result
 * envelope so cost assertions are deterministic.
 */

import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
}

interface AgentDefinitionEnvelope {
	readonly name: string;
	readonly version: number;
	readonly sections: Record<string, string>;
	readonly frontmatter?: Record<string, unknown>;
}

interface AgentRow {
	readonly name: string;
	readonly source?: string;
	readonly renderedJson: AgentDefinitionEnvelope;
}

interface RunRow {
	readonly id: string;
	readonly agentName: string;
	readonly projectId: string | null;
	readonly burrowId: string | null;
	readonly burrowRunId: string | null;
	readonly renderedAgentJson: AgentDefinitionEnvelope;
	readonly state: string;
	readonly costUsd?: number | null;
	readonly tokensInput?: number | null;
	readonly tokensOutput?: number | null;
	readonly tokensCacheRead?: number | null;
	readonly tokensCacheWrite?: number | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

interface EventEnvelope {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

const RUN_ID_PATTERN = /^run_[0-9a-hjkmnpqrstvwxyz]{12}$/;
const FIRST_EVENT_TIMEOUT_MS = 15_000;
const CLAUDE_USAGE_TIMEOUT_MS = 15_000;

export const scenario: Scenario = {
	id: "21",
	title:
		"claude-code cost smoke — POST /runs agent=claude-code populates cost_usd/tokens_* on terminal",
	// Same constraint as 16: needs the host-side sample project + the
	// claude-code stub registered in burrow-with-stub.ts.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// 1. Built-in registration — claude-code is the default and ships
		// inline in src/registry/builtins/.
		const claudeAgent = await http.expectJson<AgentRow>("GET", "/agents/claude-code", 200);
		assertEqual(claudeAgent.name, "claude-code", "GET /agents/claude-code name");
		assertEqual(claudeAgent.source, "builtin", "GET /agents/claude-code source");

		const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: "claude-code",
				project: project.id,
				prompt: "scenario-17 claude-code cost smoke",
			},
		});
		const run = created.run;
		assertTrue(
			RUN_ID_PATTERN.test(run.id),
			`POST /runs run.id ${JSON.stringify(run.id)} does not match ${RUN_ID_PATTERN}`,
		);
		assertEqual(run.agentName, "claude-code", "POST /runs run.agentName");
		assertTrue(
			typeof run.burrowId === "string" && run.burrowId !== null && run.burrowId.length > 0,
			"POST /runs run.burrowId populated (proves burrow.up was invoked)",
		);
		assertTrue(
			typeof run.burrowRunId === "string" && run.burrowRunId !== null && run.burrowRunId.length > 0,
			"POST /runs run.burrowRunId populated",
		);

		try {
			await waitForFirstEvent(http, run.id, FIRST_EVENT_TIMEOUT_MS);

			// Wait for terminal cost extraction to land on the run row
			// (warren-87f9). The stub emits a single `result` envelope with
			// `total_cost_usd=0.000421`, `input_tokens=1200`,
			// `output_tokens=400`, `cache_read_input_tokens=5000`,
			// `cache_creation_input_tokens=200` — warren's bridge calls
			// extractClaudeUsage on terminal detection and persists via
			// attachStats.
			const final = await waitForClaudeUsage(http, run.id, CLAUDE_USAGE_TIMEOUT_MS);
			assertTrue(
				typeof final.costUsd === "number" && final.costUsd > 0,
				`run.cost_usd should be > 0 after claude-code result; got ${JSON.stringify(final.costUsd)}`,
			);
			assertTrue(
				typeof final.tokensInput === "number" && final.tokensInput > 0,
				`run.tokens_input should be > 0; got ${JSON.stringify(final.tokensInput)}`,
			);
			assertTrue(
				typeof final.tokensOutput === "number" && final.tokensOutput > 0,
				`run.tokens_output should be > 0; got ${JSON.stringify(final.tokensOutput)}`,
			);
			// claude-code differs from pi here: it explicitly reports cache
			// columns on the same envelope, so we tighten the assertion
			// past the pi parity baseline.
			assertTrue(
				typeof final.tokensCacheRead === "number" && final.tokensCacheRead > 0,
				`run.tokens_cache_read should be > 0; got ${JSON.stringify(final.tokensCacheRead)}`,
			);
			assertTrue(
				typeof final.tokensCacheWrite === "number" && final.tokensCacheWrite > 0,
				`run.tokens_cache_write should be > 0; got ${JSON.stringify(final.tokensCacheWrite)}`,
			);
		} finally {
			await safelyCancel(http, run.id, ctx);
		}
	},
};

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const existing = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const found = existing.projects.find((p) => p.gitUrl === gitUrl);
	if (found !== undefined) return found;
	return await http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function waitForFirstEvent(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const events: EventEnvelope[] = [];
		for await (const env of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
			events.push(env as EventEnvelope);
			if (events.length >= 1) break;
		}
		if (events.length >= 1) return;
		await sleep(100);
	}
	throw new AcceptanceError(
		`no events landed for run ${runId} within ${timeoutMs}ms — bridge or dispatch wiring is broken`,
	);
}

/**
 * Poll GET /runs/:id until claude-code usage columns are populated, or
 * throw on timeout. Mirror of scenario 16's waitForPiUsage. The bridge
 * persists on terminalDetected (claude-code result envelope), so the
 * first non-null read should come within a few hundred ms of the stub
 * exiting.
 */
async function waitForClaudeUsage(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<RunRow> {
	const deadline = Date.now() + timeoutMs;
	let last: RunRow | undefined;
	while (Date.now() < deadline) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row;
		if (
			typeof row.costUsd === "number" &&
			typeof row.tokensInput === "number" &&
			typeof row.tokensOutput === "number"
		) {
			return row;
		}
		await sleep(150);
	}
	throw new AcceptanceError(
		`claude-code usage columns stayed null on run ${runId} after ${timeoutMs}ms ` +
			`(state=${JSON.stringify(last?.state)} costUsd=${JSON.stringify(last?.costUsd)} ` +
			`tokensInput=${JSON.stringify(last?.tokensInput)} tokensOutput=${JSON.stringify(last?.tokensOutput)}) ` +
			"— warren's bridge did not extract the claude-code result envelope",
	);
}

async function safelyCancel(http: WarrenHttp, runId: string, ctx: ScenarioCtx): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch (err) {
		ctx.logger.debug(
			`scenario-21: cancel failed (${err instanceof Error ? err.message : String(err)}) — best-effort`,
		);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
