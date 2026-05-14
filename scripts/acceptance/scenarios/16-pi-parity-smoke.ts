/**
 * Scenario 16 — pi built-in agent parity smoke (warren-d18e / pl-4374 step 2).
 *
 * Acceptance criterion (warren-d18e):
 *   "POST /runs with agentName='pi' returns 201 + run_xxx; burrow.up is
 *   invoked with agents: ['pi']; the run reaches state='running' and
 *   emits at least one event through warren's events table; cleanup
 *   cancels the run."
 *
 * This is the parity wedge for pl-4374 — the same minimal proof scenario
 * 04 does for stub-shell, but for the pi built-in shipped in
 * src/registry/builtins/pi.ts. It verifies:
 *
 *   1. The pi built-in is seeded into warren's agents registry on boot
 *      (GET /agents/pi returns the AgentDefinition with frontmatter.source
 *      = "builtin").
 *   2. POST /runs accepts agentName='pi' and dispatches through burrow —
 *      burrowId + burrowRunId are populated on the 201 (proving burrow.up
 *      was invoked with `agents: ['pi']` per src/runs/spawn.ts:196).
 *   3. The run's renderedAgentJson is frozen from the pi built-in
 *      (name='pi', frontmatter.source='builtin').
 *   4. At least one event lands in the events table — the durable signal
 *      that warren's bridge picked the run up off burrow's event stream.
 *   5. Cleanup cancels the run so teardown doesn't race a live agent.
 *
 * Why "at least one event" instead of "agent_start specifically": burrow's
 * upstream piRuntime (--mode rpc) is the cross-repo step warren-0e06,
 * not yet shipped in @os-eco/burrow-cli 0.2.12. Until it lands, the
 * acceptance harness registers a CUSTOM AgentRuntime for the `pi` id
 * (burrow-with-stub.ts) that combines burrow's declarative spawn
 * machinery with its real `parsePiEvents` parser — so the pi-shaped
 * JSONL emitted by `tools/pi-stub-agent.sh` lands as `state_change`
 * events whose payload preserves the original pi envelope verbatim.
 * Once piRuntime ships, this scenario can tighten the assertion to
 * kind='agent_start' (follow-on warren-70af).
 *
 * warren-17a4 extension: this scenario also asserts that the run's
 * cost_usd / tokens_input / tokens_output columns are non-null after
 * the run completes. The pi stub emits a `turn_end` envelope carrying
 * `message.usage.cost.total` + token counts and an `agent_end` envelope
 * — warren's bridge (src/runs/stream.ts) accumulates the usage and
 * persists via `RunsRepo.attachStats`. End-to-end proof that pi cost
 * tracking works through the public HTTP surface, not just unit tests.
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
	readonly resolvedFrom?: readonly string[];
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
	readonly prompt: string;
	readonly trigger: string;
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
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

const RUN_ID_PATTERN = /^run_[0-9a-hjkmnpqrstvwxyz]{12}$/;
const FIRST_EVENT_TIMEOUT_MS = 15_000;
const PI_USAGE_TIMEOUT_MS = 15_000;

export const scenario: Scenario = {
	id: "16",
	title:
		"pi built-in parity smoke — POST /runs agent=pi dispatches through burrow and emits events",
	// Same constraint as scenario 04: needs the host-side sample project,
	// canopy fixture, and the declarative-pi registration in burrow-with-stub.
	// Container mode does not bind-mount any of those.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// 1. GET /agents/pi — the boot-seed should have registered the
		// built-in before the harness even runs scenarios. The detail row
		// carries source='builtin' (via readAgentSource off frontmatter).
		const piAgent = await http.expectJson<AgentRow>("GET", "/agents/pi", 200);
		assertEqual(piAgent.name, "pi", "GET /agents/pi name");
		assertEqual(piAgent.source, "builtin", "GET /agents/pi source");
		assertEqual(piAgent.renderedJson.name, "pi", "GET /agents/pi renderedJson.name");
		assertTrue(
			(piAgent.renderedJson.sections.system?.length ?? 0) > 0,
			"GET /agents/pi renderedJson.sections.system is non-empty",
		);
		assertEqual(
			piAgent.renderedJson.frontmatter?.source,
			"builtin",
			"GET /agents/pi renderedJson.frontmatter.source",
		);

		const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

		// 2. POST /runs with agent='pi' — 201 + run_xxx, burrowId/burrowRunId
		// populated by spawnRun (proves burrow.up was called with agents: ['pi']).
		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: "pi",
				project: project.id,
				prompt: "scenario-16 pi parity smoke",
			},
		});
		const run = created.run;
		assertTrue(
			RUN_ID_PATTERN.test(run.id),
			`POST /runs run.id ${JSON.stringify(run.id)} does not match ${RUN_ID_PATTERN}`,
		);
		assertEqual(run.agentName, "pi", "POST /runs run.agentName");
		assertEqual(run.projectId, project.id, "POST /runs run.projectId");
		assertTrue(
			typeof run.burrowId === "string" && run.burrowId !== null && run.burrowId.length > 0,
			"POST /runs run.burrowId populated (proves burrow.up was invoked)",
		);
		assertTrue(
			typeof run.burrowRunId === "string" && run.burrowRunId !== null && run.burrowRunId.length > 0,
			"POST /runs run.burrowRunId populated",
		);
		assertEqual(created.burrow.id, run.burrowId, "response.burrow.id matches run.burrowId");

		// 3. renderedAgentJson is the frozen pi built-in.
		assertEqual(run.renderedAgentJson.name, "pi", "run.renderedAgentJson.name");
		assertEqual(
			run.renderedAgentJson.frontmatter?.source,
			"builtin",
			"run.renderedAgentJson carries the builtin provenance",
		);

		try {
			// 4. Wait for at least one event to land in the events table.
			// Bridge writes events FIRST then broker.publish (mx-e402e5), so
			// a non-follow GET against the run's events endpoint is the
			// durable signal we want.
			await waitForFirstEvent(http, run.id, FIRST_EVENT_TIMEOUT_MS);

			// 5. Wait for pi `turn_end` accumulation to land on the run row
			// (warren-17a4). The acceptance pi runtime (burrow-with-stub.ts)
			// dispatches `tools/pi-stub-agent.sh`, which emits a pi RPC
			// `turn_end` envelope with `message.usage.cost.total=0.000666`
			// plus token counts, followed by `agent_end`. Warren's bridge
			// (src/runs/stream.ts) accumulates `turn_end` usage and calls
			// `RunsRepo.attachStats` on `agent_end` — so by the time the
			// run reaches a terminal state, cost_usd / tokens_input /
			// tokens_output MUST be non-null. This is the assertion the
			// seed was tracking: pi cost wiring is end-to-end observable
			// via the warren HTTP surface, not just in unit tests.
			const final = await waitForPiUsage(http, run.id, PI_USAGE_TIMEOUT_MS);
			assertTrue(
				typeof final.costUsd === "number" && final.costUsd > 0,
				`run.cost_usd should be > 0 after pi turn_end; got ${JSON.stringify(final.costUsd)}`,
			);
			assertTrue(
				typeof final.tokensInput === "number" && final.tokensInput > 0,
				`run.tokens_input should be > 0 after pi turn_end; got ${JSON.stringify(final.tokensInput)}`,
			);
			assertTrue(
				typeof final.tokensOutput === "number" && final.tokensOutput > 0,
				`run.tokens_output should be > 0 after pi turn_end; got ${JSON.stringify(final.tokensOutput)}`,
			);
		} finally {
			// 6. Cancel — cancel is idempotent (mx-fadaa2), best-effort. The
			// pi stub usually exits on its own before we get here, but the
			// teardown safety net keeps us aligned with scenario 04.
			await safelyCancel(http, run.id, ctx);
		}
	},
};

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	// Other scenarios share the same fixture; tolerate either state
	// (mx-a8d92b).
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
 * Poll GET /runs/:id until pi usage columns are populated, or throw on
 * timeout. Both attachStats fire-points (isPiAgentEnd + terminal
 * detection) target the same row, so the first non-null read wins.
 */
async function waitForPiUsage(http: WarrenHttp, runId: string, timeoutMs: number): Promise<RunRow> {
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
		`pi usage columns stayed null on run ${runId} after ${timeoutMs}ms ` +
			`(state=${JSON.stringify(last?.state)} costUsd=${JSON.stringify(last?.costUsd)} ` +
			`tokensInput=${JSON.stringify(last?.tokensInput)} tokensOutput=${JSON.stringify(last?.tokensOutput)}) ` +
			"— warren's bridge did not accumulate+persist the pi turn_end usage envelope",
	);
}

async function safelyCancel(http: WarrenHttp, runId: string, ctx: ScenarioCtx): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch (err) {
		ctx.logger.debug(
			`scenario-16: cancel failed (${err instanceof Error ? err.message : String(err)}) — best-effort`,
		);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
