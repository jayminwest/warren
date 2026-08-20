/**
 * Scenario 04 — POST /runs (the docs/design/agent-composition.md composition flow).
 *
 * Acceptance criterion #4:
 *   "POST /runs returns 201 with a `run_xxx` id; the response carries
 *   the warren run row with `renderedAgentJson` populated; the column
 *   is frozen at spawn time and not re-read mid-run."
 *
 * The spawn path (src/runs/spawn/dispatch.ts) reads the agent definition from
 * the agents-table cache and writes it onto runs.rendered_agent_json
 * before any burrow call. Re-rendering at run time would (a) shell out
 * to an external registry on every dispatch, and (b) drift the run's
 * frozen prompt away from what the operator saw when they hit
 * POST /runs (mx-e1ecb1).
 *
 * Verifying the freeze against the builtins-only registry (warren-dc19 —
 * the pre-pl-3a79 version of this scenario drifted the envelope through
 * the canopy fixture + POST /agents/refresh; both are deleted):
 *
 *   1. Spawn r1 against the boot-seeded stub agent. Capture
 *      r1.renderedAgentJson off the 201 body.
 *   2. Rewrite the WARREN_SEED_AGENTS_FILE payload with a drifted
 *      `system` section and restart warren (ctx.lifecycle). Boot-time
 *      seeding (seedBuiltinAgents, src/registry/builtins/index.ts)
 *      upserts builtin-sourced rows on drift, so the agents row picks
 *      up the new envelope — this also guards the "builtin seeding on
 *      boot" contract and the GET /agents `source: "builtin"`
 *      provenance.
 *   3. GET /runs/:r1 — r1.renderedAgentJson is unchanged from step 1.
 *   4. Spawn r2 — its frozen JSON reflects the post-restart envelope,
 *      proving the freeze is per-run, not per-agent.
 *
 * The scenario shares one warren+burrow pair with its siblings, so it
 * restores the original seed payload and restarts warren again at the
 * end, leaving the registry in its pre-scenario state. Cancels both
 * runs so teardown doesn't trip over a live burrow workspace.
 */

import { readFile, writeFile } from "node:fs/promises";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly addedAt: string;
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
	readonly source: string;
	readonly renderedJson: AgentDefinitionEnvelope;
}

interface RunRow {
	readonly id: string;
	readonly agentName: string;
	readonly projectId: string | null;
	readonly sandboxId: string | null;
	readonly sandboxRunId: string | null;
	readonly renderedAgentJson: AgentDefinitionEnvelope;
	readonly state: string;
	readonly prompt: string;
	readonly trigger: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly sandbox: { readonly id: string; readonly workspacePath: string };
}

const RUN_ID_PATTERN = /^run_[0-9a-hjkmnpqrstvwxyz]{12}$/;

export const scenario: Scenario = {
	id: "04",
	title: "POST /runs returns 201 + run_xxx; renderedAgentJson populated and frozen at spawn",
	// Run spawn requires the host-side sample project + seeded stub agent,
	// and the drift step drives warren process control. In-proc only.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });
		const lifecycle = ctx.lifecycle;
		if (lifecycle === undefined) {
			throw new AcceptanceError("scenario-04 requires the in-proc lifecycle handle");
		}

		// Pre-req: add the project. The stub agent itself was seeded at
		// boot via WARREN_SEED_AGENTS_FILE (warren-e376) — there is no
		// runtime registration call anymore. GET /agents proves the boot
		// seeding landed before we spawn against it.
		const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
			body: { gitUrl: ctx.fixtures.sampleProjectGitUrl },
		});

		// Capture the agent envelope warren has cached pre-spawn — this
		// is what we expect r1.renderedAgentJson to deeply match. The
		// `source` provenance must read "builtin": the seed-file payload
		// declares frontmatter.source="builtin" so boot seeding owns the
		// row and upserts it on drift.
		const agentBefore = await http.expectJson<AgentRow>(
			"GET",
			`/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}`,
			200,
		);
		assertEqual(
			agentBefore.source,
			"builtin",
			"GET /agents/:name provenance for the boot-seeded stub agent",
		);
		const systemBefore = agentBefore.renderedJson.sections.system;
		assertTrue(
			typeof systemBefore === "string" && systemBefore.length > 0,
			"pre-spawn agent.renderedJson.sections.system is missing",
		);

		// 1. Spawn r1 — POST /runs returns 201 with the warren run row.
		const r1Body = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-04 first run",
			},
		});
		const r1 = r1Body.run;

		// run_xxx id shape (core/ids.ts: `${prefix}_${12-char base32}`).
		assertTrue(
			RUN_ID_PATTERN.test(r1.id),
			`POST /runs response run.id ${JSON.stringify(r1.id)} does not match ${RUN_ID_PATTERN}`,
		);
		assertEqual(r1.agentName, ctx.fixtures.stubAgentName, "POST /runs run.agentName");
		assertEqual(r1.projectId, project.id, "POST /runs run.projectId");
		assertEqual(r1.prompt, "scenario-04 first run", "POST /runs run.prompt");
		assertEqual(r1.state, "queued", "POST /runs run.state at create time");
		assertEqual(r1.trigger, "manual", "POST /runs run.trigger defaults to 'manual'");

		// sandbox_id + sandbox_run_id are attached during spawnRun (mx-3bf4da)
		// — both should be set by the time the 201 is returned.
		assertTrue(
			typeof r1.sandboxId === "string" && r1.sandboxId !== null && r1.sandboxId.length > 0,
			"POST /runs run.sandboxId is null or empty after 201",
		);
		assertTrue(
			typeof r1.sandboxRunId === "string" && r1.sandboxRunId !== null && r1.sandboxRunId.length > 0,
			"POST /runs run.sandboxRunId is null or empty after 201",
		);
		assertTrue(
			typeof r1Body.sandbox?.id === "string" && r1Body.sandbox.id === r1.sandboxId,
			"POST /runs response.sandbox.id matches run.sandboxId",
		);
		// workspacePath is intentionally an empty string post-RuntimeProvider
		// seam (warren-1f56): a burrow host path has no provider-neutral home,
		// so the seam's RunHandle drops it and dispatch returns
		// `workspacePath: ""` (src/runs/spawn/dispatch.ts). It survives only as
		// a display-only field slated for removal with the multi-worker /
		// `/sandboxes` surface (design §5.C). Re-tighten this to assert a real
		// path if/when §5.C reinstates a provider-neutral workspace handle.
		//
		// warren-5af5: assert the EXACT contract value (`""`) rather than the
		// weaker "is a string" — the empty string is the deliberate seam
		// output, and locking it means a regression that leaves a stale host
		// path (or emits some other non-empty value) is caught here instead of
		// silently passing. The field's presence is asserted by the strict
		// equality itself (`undefined !== ""`).
		assertEqual(
			r1Body.sandbox?.workspacePath,
			"",
			'POST /runs response.sandbox.workspacePath is exactly "" (seam drops host path until §5.C — warren-1f56)',
		);

		// rendered_agent_json populated and matches the cached envelope.
		assertTrue(
			typeof r1.renderedAgentJson === "object" && r1.renderedAgentJson !== null,
			"POST /runs run.renderedAgentJson is missing or non-object",
		);
		assertEqual(
			r1.renderedAgentJson.name,
			ctx.fixtures.stubAgentName,
			"POST /runs run.renderedAgentJson.name",
		);
		assertEqual(
			r1.renderedAgentJson.sections.system,
			systemBefore,
			"POST /runs run.renderedAgentJson.sections.system matches cached agent",
		);

		// GET /runs/:id returns the same row (sanity — no projection
		// drift between createRunHandler and getRunHandler).
		const { run: r1Reread } = await http.expectJson<{ run: RunRow }>(
			"GET",
			`/runs/${encodeURIComponent(r1.id)}`,
			200,
		);
		assertEqual(
			r1Reread.renderedAgentJson.sections.system,
			systemBefore,
			"GET /runs/:id sections.system matches POST response",
		);

		// 2. Drift the stub agent's envelope: rewrite the seed payload
		// with a changed system body, then restart warren. Boot-time
		// seeding upserts builtin-sourced rows whose rendered envelope
		// diverged (isAlreadySeeded deep-equal), so the agents row picks
		// up the drift with no runtime registration call.
		const driftBody = `${systemBefore}\n[scenario-04 drift marker — must NOT appear on r1]`;
		const seedFilePath = ctx.fixtures.seedAgentsFilePath;
		const originalSeedPayload = await readFile(seedFilePath, "utf8");
		const seedAgents = JSON.parse(originalSeedPayload) as Array<{
			sections: Record<string, string>;
		}>;
		const stubSeed = seedAgents.find(
			(a) => (a as { name?: string }).name === ctx.fixtures.stubAgentName,
		);
		if (stubSeed === undefined) {
			throw new AcceptanceError(
				`seed agents file ${seedFilePath} does not carry ${ctx.fixtures.stubAgentName}`,
			);
		}
		stubSeed.sections.system = driftBody;
		await writeFile(seedFilePath, `${JSON.stringify(seedAgents, null, 2)}\n`);

		await lifecycle.killWarren();
		await lifecycle.restartWarren();

		const agentAfter = await http.expectJson<AgentRow>(
			"GET",
			`/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}`,
			200,
		);
		assertEqual(
			agentAfter.renderedJson.sections.system,
			driftBody,
			"agents row.renderedJson.sections.system reflects the drifted seed payload after boot re-seed",
		);

		// 3. r1's frozen JSON is unchanged.
		const { run: r1AfterDrift } = await http.expectJson<{ run: RunRow }>(
			"GET",
			`/runs/${encodeURIComponent(r1.id)}`,
			200,
		);
		assertEqual(
			r1AfterDrift.renderedAgentJson.sections.system,
			systemBefore,
			"GET /runs/:id after seed drift — r1.renderedAgentJson must remain frozen at spawn-time value",
		);
		if (r1AfterDrift.renderedAgentJson.sections.system === driftBody) {
			throw new AcceptanceError(
				"r1.renderedAgentJson was re-read after the agent envelope drifted — spawn-time freeze contract violated",
			);
		}

		// 4. Spawn r2 — its frozen JSON reflects the new envelope.
		const r2Body = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-04 second run",
			},
		});
		const r2 = r2Body.run;
		assertTrue(RUN_ID_PATTERN.test(r2.id), `r2.id does not match ${RUN_ID_PATTERN}: ${r2.id}`);
		assertTrue(r2.id !== r1.id, "second POST /runs must mint a fresh run_xxx id");
		assertEqual(
			r2.renderedAgentJson.sections.system,
			driftBody,
			"r2.renderedAgentJson reflects the post-drift envelope",
		);

		// Negative paths — POST /runs validates at the wire.
		const missingAgentRes = await http.request("POST", "/runs", {
			body: { project: project.id, prompt: "x" },
		});
		assertEqual(missingAgentRes.status, 400, "POST /runs missing 'agent' returns 400");
		const unknownAgentRes = await http.request("POST", "/runs", {
			body: { agent: "no-such-agent", project: project.id, prompt: "x" },
		});
		assertEqual(unknownAgentRes.status, 404, "POST /runs unknown agent returns 404");

		// Cleanup: cancel both runs so teardown doesn't race a live agent.
		// Cancel is idempotent (mx-fadaa2) — fire-and-forget is fine.
		for (const id of [r1.id, r2.id]) {
			try {
				await http.request("POST", `/runs/${encodeURIComponent(id)}/cancel`, { body: {} });
			} catch {
				// Best-effort — the run may already be terminal.
			}
		}

		// Restore the shared warren to its pre-scenario registry state:
		// put the original seed payload back and restart once more so the
		// boot re-seed reverts the drifted row. Sibling scenarios dispatch
		// against this agent, and a second harness pass must observe the
		// same fixture (idempotency).
		await writeFile(seedFilePath, originalSeedPayload);
		await lifecycle.killWarren();
		await lifecycle.restartWarren();
		const agentRestored = await http.expectJson<AgentRow>(
			"GET",
			`/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}`,
			200,
		);
		assertEqual(
			agentRestored.renderedJson.sections.system,
			systemBefore,
			"agents row restored to the pre-scenario envelope after seed-file restore + restart",
		);
	},
};
