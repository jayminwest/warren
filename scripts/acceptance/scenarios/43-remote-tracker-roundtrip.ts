/**
 * Scenario 43 — RemoteTracker roundtrip (warren-53ea, plan pl-a37b
 * Track B): the warren-tracker/v1 FALSIFICATION TEST and the track's
 * release acceptance criterion.
 *
 * A warren booted with its issue-tracker seam swapped onto a
 * RemoteTracker (lib/remote-tracker-server-entry.ts) pointed at the
 * FakeTracker reference server (extensions/tracker-conformance)
 * runs a warren-de42 ordered-issue-list plan-run end to end: dispatch →
 * stub-agent commit → reap → FakeForge PR → auto-merge → coordinator
 * close — and the issues end CLOSED IN THE REMOTE TRACKER, with ZERO
 * seeds code in the path (the fixture project has no .seeds/ directory
 * and FakeTracker declares every git-native capability off).
 *
 * Topology mirrors scenario 26 (closest twin), with two deltas:
 *
 *   - No `.seeds/` in the fixture. The three issue ids exist only in
 *     FakeTracker's store, seeded from a fixture JSON the scenario
 *     spawns it with (lib/fake-tracker.ts — process boundary, not an
 *     import, per the extension layer seam).
 *   - FakeTracker declares supportsPlans/supportsMetadata/
 *     supportsScheduledIssues all FALSE, so the plan-run walks the
 *     explicit `issues` list (warren-de42), no seed-extension stamping
 *     happens, and the stub agent's `touchfile <id>` commit is what
 *     gives the run branch a non-zero commitsAhead.
 *
 * The assertions:
 *
 *   1. POST /projects registers the project with hasSeeds falsy.
 *   2. POST /plan-runs with an ordered issue-id list creates three
 *      pending children and reaches terminal 'succeeded' with every
 *      child 'merged' through a FakeForge PR.
 *   3. FakeTracker's state-file mirror shows every issue closed and a
 *      POST /issues/<id>/close call recorded per issue — the
 *      coordinator-owned close (warren-3806 → warren-6234's seam) went
 *      over the wire protocol.
 *
 * If this scenario ever needs a src/runs/ or src/plan-runs/ edit to
 * pass, the IssueTracker abstraction failed — treat that as a finding,
 * not a fix.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { startFakeForgeAutoMerge } from "../lib/fake-forge.ts";
import { type FakeTrackerStateView, spawnFakeTracker } from "../lib/fake-tracker.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import { pollAcceptance } from "../lib/poll.ts";

const PROJECT_URL = "fake://warren-acceptance/remote-tracker-43";
const ISSUE_A = "ext-43-a";
const ISSUE_B = "ext-43-b";
const ISSUE_C = "ext-43-c";
const ISSUES = [ISSUE_A, ISSUE_B, ISSUE_C] as const;
const PLAN_DEADLINE_MS = 90_000;

interface ProjectRow {
	readonly id: string;
	readonly hasSeeds?: boolean;
}

interface RunEventRow {
	readonly kind: string;
	readonly payload: Record<string, unknown> | null;
}

/** Tail the last few events of a run, for failure diagnostics (NDJSON replay). */
async function tailRunEvents(http: WarrenHttp, runId: string): Promise<string> {
	try {
		const res = await http.expectStatus("GET", `/runs/${encodeURIComponent(runId)}/events`, 200);
		const lines = (await res.text())
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l) as RunEventRow);
		return lines
			.slice(-8)
			.map((e) => `${e.kind} ${JSON.stringify(e.payload ?? {}).slice(0, 160)}`)
			.join(" | ");
	} catch (err) {
		return `<events unavailable: ${err instanceof Error ? err.message : String(err)}>`;
	}
}

interface PlanRunDetail {
	readonly planRun: { readonly id: string; readonly state: string };
	readonly children: readonly {
		readonly seq: number;
		readonly seedId: string;
		readonly runId: string | null;
		readonly state: string;
	}[];
	readonly runs: readonly {
		readonly id: string;
		readonly state: string;
		readonly prUrl: string | null;
		readonly failureReason?: string | null;
	}[];
}

const TERMINAL_PLAN_STATES = new Set(["succeeded", "failed", "cancelled"]);

/** Build the seeds-free fixture repo + the insteadOf rewrite for PROJECT_URL. */
async function buildFixture(input: {
	fixturePath: string;
	sourceSamplePath: string;
	harnessGitConfigPath: string;
	gitConfigPath: string;
}): Promise<void> {
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# scenario-43 fixture: a seeds-free project served by FakeTracker\n",
	);
	for (const tool of ["claude-code-stub-agent.sh"]) {
		const body = await readFile(join(input.sourceSamplePath, "tools", tool));
		await writeFile(join(input.fixturePath, "tools", tool), body, { mode: 0o755 });
	}
	const burrowToml = await readFile(join(input.sourceSamplePath, "burrow.toml"));
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);

	const gitEnv: Record<string, string> = {
		...process.env,
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
	};
	execFileSync("git", ["init", "--initial-branch=main"], { cwd: input.fixturePath, env: gitEnv });
	execFileSync("git", ["add", "."], { cwd: input.fixturePath, env: gitEnv });
	execFileSync("git", ["commit", "-m", "init: scenario-43 remote-tracker fixture"], {
		cwd: input.fixturePath,
		env: gitEnv,
	});

	let harnessConfig = "";
	try {
		harnessConfig = await readFile(join(input.harnessGitConfigPath), "utf8");
	} catch {
		// A missing harness config means no canopy rewrite — fine for 43.
	}
	await writeFile(
		input.gitConfigPath,
		`${harnessConfig.trimEnd()}\n[url "${input.fixturePath}"]\n\tinsteadOf = ${PROJECT_URL}\n`,
	);
}

async function waitForPlanState(
	http: WarrenHttp,
	planRunId: string,
	target: string,
): Promise<PlanRunDetail> {
	return pollAcceptance({
		label: "plan-run",
		id: planRunId,
		timeoutMs: PLAN_DEADLINE_MS,
		fetchRow: () =>
			http.expectJson<PlanRunDetail>("GET", `/plan-runs/${encodeURIComponent(planRunId)}`, 200),
		isDone: (row) => row.planRun.state === target,
		describe: (row) => row.planRun.state,
		onRow: (row) => {
			if (row.planRun.state !== target && TERMINAL_PLAN_STATES.has(row.planRun.state)) {
				const kids = row.children.map((c) => `${c.seedId}=${c.state}`).join(", ");
				const runs = row.runs.map((r) => `${r.id}=${r.state}/${r.failureReason ?? "-"}`).join(", ");
				throw new AcceptanceError(
					`plan-run ${planRunId}: expected '${target}', reached terminal '${row.planRun.state}' (children: ${kids}; runs: ${runs})`,
				);
			}
		},
	});
}

export const scenario: Scenario = {
	id: "43",
	title:
		"RemoteTracker roundtrip — ordered issue-id plan-run against FakeTracker over warren-tracker/v1; issues close on merge with zero seeds code",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-43-"));
		const fixturePath = join(scenarioRoot, "fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");
		const forgeStateFile = join(scenarioRoot, "fake-forge-state.json");
		const trackerStateFile = join(scenarioRoot, "fake-tracker-state.json");
		const trackerFixtureFile = join(scenarioRoot, "fake-tracker-fixture.json");

		await writeFile(
			trackerFixtureFile,
			`${JSON.stringify({
				issues: ISSUES.map((id) => ({ id, status: "open", title: `scenario-43 ${id}` })),
			})}\n`,
		);
		await buildFixture({
			fixturePath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitConfigPath,
		});

		// FakeTracker with EVERY optional capability off and isGitNative
		// false: the posture a foreign hosted tracker (GitHub Issues,
		// Linear) presents — the de42 ordered-list form is the only
		// plan-run shape available to it.
		const tracker = await spawnFakeTracker({
			fixturePath: trackerFixtureFile,
			stateFilePath: trackerStateFile,
			flags: ["--no-plans", "--no-metadata", "--no-scheduled-issues"],
		});
		ctx.logger.info(`scenario-43: FakeTracker at ${tracker.url}`);

		let handle: BootHandle | undefined;
		const autoMerge = startFakeForgeAutoMerge(forgeStateFile);
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				// The boot variant whose ONLY delta is the issue-tracker seam:
				// a connected RemoteTracker in place of the SeedsTracker.
				serverEntry: "scripts/acceptance/lib/remote-tracker-server-entry.ts",
				extraEnv: {
					WARREN_FORGE: "fake",
					WARREN_FAKE_FORGE_STATE_FILE: forgeStateFile,
					WARREN_PLAN_RUN_TICK_MS: "1000",
					WARREN_TRACKER_URL: tracker.url,
				},
			});
			ctx.logger.info(`scenario-43: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });

			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PROJECT_URL },
			});
			assertTrue(
				project.hasSeeds !== true,
				"scenario-43 fixture project must surface hasSeeds falsy (no .seeds/ committed)",
			);

			const created = await http.expectJson<{
				planRun: { id: string; state: string; source: string };
				children: readonly { seq: number; seedId: string; state: string }[];
			}>("POST", "/plan-runs", 201, {
				body: {
					project: project.id,
					issues: [...ISSUES],
					agent: "claude-code",
					promptTemplate: "touchfile {seed_id}",
				},
			});
			assertEqual(created.planRun.source, "issues", "plan-run source is the de42 issues form");
			assertEqual(created.children.length, 3, "three children created from the issue-id list");
			for (const child of created.children) {
				assertEqual(child.state, "pending", `child ${child.seedId} starts pending`);
			}

			let finished: PlanRunDetail;
			try {
				finished = await waitForPlanState(http, created.planRun.id, "succeeded");
			} catch (err) {
				// Enrich a coordinator failure with the child runs' event tails.
				const detail = await http.expectJson<PlanRunDetail>(
					"GET",
					`/plan-runs/${encodeURIComponent(created.planRun.id)}`,
					200,
				);
				const tails: string[] = [];
				for (const child of detail.children) {
					if (child.runId !== null && child.state === "failed") {
						tails.push(`${child.seedId}: ${await tailRunEvents(http, child.runId)}`);
					}
				}
				throw new AcceptanceError(
					`${err instanceof Error ? err.message : String(err)}\nchild run tails:\n${tails.join("\n")}`,
				);
			}
			assertEqual(finished.children.length, 3, "still three children at terminal");
			for (const child of finished.children) {
				assertEqual(
					child.state,
					"merged",
					`child ${child.seedId} must end merged (got ${child.state})`,
				);
			}
			for (const run of finished.runs) {
				assertTrue(
					typeof run.prUrl === "string" && run.prUrl.startsWith(`${PROJECT_URL}/pulls/`),
					`run ${run.id} carries the FakeForge PR ref (got ${run.prUrl})`,
				);
			}

			// The release assertion: every issue is CLOSED IN THE REMOTE
			// TRACKER, and the close went over the wire protocol (a recorded
			// POST /issues/<id>/close per issue).
			const trackerState = JSON.parse(
				await readFile(trackerStateFile, "utf8"),
			) as FakeTrackerStateView;
			for (const id of ISSUES) {
				const issue = trackerState.issues.find((i) => i.id === id);
				assertEqual(
					issue?.status,
					"closed",
					`FakeTracker must report ${id} closed after its PR merged`,
				);
				assertTrue(
					trackerState.calls.some((c) => c.method === "POST" && c.path === `/issues/${id}/close`),
					`FakeTracker must have RECORDED a close call for ${id} (proves the wire path)`,
				);
			}
		} finally {
			autoMerge.stop();
			await handle?.stop();
			await tracker.stop();
		}
	},
};
