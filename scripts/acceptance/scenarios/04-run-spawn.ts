/**
 * Scenario 04 — POST /runs (the §4.3 composition flow).
 *
 * Acceptance criterion #4:
 *   "POST /runs returns 201 with a `run_xxx` id; the response carries
 *   the warren run row with `renderedAgentJson` populated; the column
 *   is frozen at spawn time and not re-read mid-run."
 *
 * The spawn path (src/runs/spawn/dispatch.ts) reads the agent definition from
 * the agents-table cache and writes it onto runs.rendered_agent_json
 * before any burrow call. Re-rendering at run time would (a) shell out
 * to `cn` on every dispatch, and (b) drift the run's frozen prompt
 * away from what the operator saw when they hit POST /runs (mx-e1ecb1).
 *
 * Verifying the freeze:
 *
 *   1. Spawn r1 against the canopy-cached stub agent. Capture
 *      r1.renderedAgentJson off the 201 body.
 *   2. Mutate the canopy fixture (`cn update <name> --section system
 *      --body "<drift>"` + `cn sync`) and POST /agents/refresh so the
 *      agents row picks up the new envelope.
 *   3. GET /runs/:r1 — r1.renderedAgentJson is unchanged from step 1.
 *      (Bridge events flow into events table, not runs row.)
 *   4. Spawn r2 — its frozen JSON reflects the post-refresh envelope,
 *      proving the freeze is per-run, not per-agent.
 *
 * Cancels both runs at the end so teardown doesn't trip over a live
 * burrow workspace.
 */

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
	readonly startedAt: string | null;
	readonly endedAt: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

const RUN_ID_PATTERN = /^run_[0-9a-hjkmnpqrstvwxyz]{12}$/;

export const scenario: Scenario = {
	id: "04",
	title: "POST /runs returns 201 + run_xxx; renderedAgentJson populated and frozen at spawn",
	// Run spawn requires the host-side sample project + canopy fixture,
	// neither of which the compose harness bind-mounts. In-proc only.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// Pre-reqs: register agents and add the project. Each scenario
		// boots its own warren+burrow, so we can't rely on scenario 02/03
		// having seeded these.
		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
			body: { gitUrl: ctx.fixtures.sampleProjectGitUrl },
		});

		// Capture the agent envelope warren has cached pre-spawn — this
		// is what we expect r1.renderedAgentJson to deeply match.
		const agentBefore = await http.expectJson<AgentRow>(
			"GET",
			`/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}`,
			200,
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

		// burrow_id + burrow_run_id are attached during spawnRun (mx-3bf4da)
		// — both should be set by the time the 201 is returned.
		assertTrue(
			typeof r1.burrowId === "string" && r1.burrowId !== null && r1.burrowId.length > 0,
			"POST /runs run.burrowId is null or empty after 201",
		);
		assertTrue(
			typeof r1.burrowRunId === "string" && r1.burrowRunId !== null && r1.burrowRunId.length > 0,
			"POST /runs run.burrowRunId is null or empty after 201",
		);
		assertTrue(
			typeof r1Body.burrow?.id === "string" && r1Body.burrow.id === r1.burrowId,
			"POST /runs response.burrow.id matches run.burrowId",
		);
		assertTrue(
			typeof r1Body.burrow?.workspacePath === "string" && r1Body.burrow.workspacePath.length > 0,
			"POST /runs response.burrow.workspacePath is populated",
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
		const r1Reread = await http.expectJson<RunRow>(
			"GET",
			`/runs/${encodeURIComponent(r1.id)}`,
			200,
		);
		assertEqual(
			r1Reread.renderedAgentJson.sections.system,
			systemBefore,
			"GET /runs/:id sections.system matches POST response",
		);

		// 2. Mutate the canopy fixture: change stub-shell's system body,
		// commit, then POST /agents/refresh so warren picks it up.
		const driftBody = `${systemBefore}\n[scenario-04 drift marker — must NOT appear on r1]`;
		await runIn(ctx.fixtures.canopyRepoPath, [
			"cn",
			"update",
			ctx.fixtures.stubAgentName,
			"--section",
			"system",
			"--body",
			driftBody,
		]);
		// `cn sync` stages and commits the .canopy/ dirty state. Fall back
		// to a plain git commit if cn sync isn't available in this build.
		try {
			await runIn(ctx.fixtures.canopyRepoPath, ["cn", "sync"]);
		} catch {
			await runIn(ctx.fixtures.canopyRepoPath, ["git", "add", "."]);
			await runIn(ctx.fixtures.canopyRepoPath, [
				"git",
				"commit",
				"-m",
				"scenario-04: drift the stub agent system body",
			]);
		}

		await http.expectStatus("POST", "/agents/refresh", 200);
		const agentAfter = await http.expectJson<AgentRow>(
			"GET",
			`/agents/${encodeURIComponent(ctx.fixtures.stubAgentName)}`,
			200,
		);
		assertEqual(
			agentAfter.renderedJson.sections.system,
			driftBody,
			"agents row.renderedJson.sections.system reflects post-refresh canopy fixture",
		);

		// 3. r1's frozen JSON is unchanged.
		const r1AfterDrift = await http.expectJson<RunRow>(
			"GET",
			`/runs/${encodeURIComponent(r1.id)}`,
			200,
		);
		assertEqual(
			r1AfterDrift.renderedAgentJson.sections.system,
			systemBefore,
			"GET /runs/:id after canopy drift — r1.renderedAgentJson must remain frozen at spawn-time value",
		);
		if (r1AfterDrift.renderedAgentJson.sections.system === driftBody) {
			throw new AcceptanceError(
				"r1.renderedAgentJson was re-read after canopy drift — spawn-time freeze contract violated",
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
			"r2.renderedAgentJson reflects the post-refresh envelope",
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
	},
};

async function runIn(cwd: string, cmd: readonly string[]): Promise<void> {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "/tmp",
			GIT_AUTHOR_NAME: "Warren Acceptance",
			GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
			GIT_COMMITTER_NAME: "Warren Acceptance",
			GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new AcceptanceError(
			`fixture command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
		);
	}
}
