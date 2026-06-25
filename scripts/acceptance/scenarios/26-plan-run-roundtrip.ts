/**
 * Scenario 26 — plan-run roundtrip (pl-a258 step 9 / warren-ae00).
 *
 * Closes the loop the per-step unit tests open: warren-9990 wires
 * hasSeeds, warren-4d7c lands the DB tables, warren-a3ea adds the
 * seeds-cli plan readers, warren-9e4c the PR-merge polling helper,
 * warren-2623 the coordinator state machine, warren-f923 the server API
 * surface, warren-a87f the UI. This scenario chains them through a real
 * warren+burrow stack against a `.seeds/`-enabled fixture.
 *
 * Topology mirrors scenario 22 (closest twin): an in-proc warren+burrow
 * pair against a bespoke fixture committed under `ctx.tmp`. The shared
 * sample-source isn't reused — scenario 22's seed-extension roundtrip
 * already mutates that path, and the harness boots one warren for every
 * scenario; isolating into a per-scenario stack keeps the GH-merge
 * fetch override (`WARREN_GH_FETCH_OVERRIDE=merged`) scoped to this
 * scenario alone.
 *
 * The fixture commits real `.seeds/{config.yaml, issues.jsonl, plans.jsonl}`
 * rows (mirrors scenario 22's posture of writing files rather than shelling
 * `sd plan submit`, so the harness stays deterministic). Three children:
 *
 *   - ah-acc-26-a — open; agent dispatches, closes via the stub, reap
 *     opens a stubbed PR, coordinator polls merged, child advances.
 *   - ah-acc-26-b — open; same.
 *   - ah-acc-26-c — open AND listed in `WARREN_STUB_NO_COMMIT_SEEDS`,
 *     so the stub agent skips every workspace mutation. Reap reports
 *     `commitsAhead=0` + emits `reap.empty_push`, and the coordinator
 *     drives the trivial-merge branch (no GH polling, child → merged).
 *
 * Then a SECOND POST after rewriting the source seed row for
 * ah-acc-26-b to `status=closed` verifies the resume contract
 * (warren-fcc9): the closed child flips directly to `skipped` without
 * dispatching a run.
 *
 * In-proc only: drives source-repo edits the container harness doesn't
 * bind-mount (matches scenario 22 / mx-1d31f0 posture).
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import {
	buildPlanRunFixture,
	type CreatePlanRunResponse,
	fetchAllPlanRunEvents,
	PLAN_DEADLINE_MS,
	PLAN_ID,
	PLAN_PROJECT_URL,
	type ProjectRow,
	rewriteSourceSeedClosed,
	SEED_A,
	SEED_B,
	SEED_C,
	waitForPlanState,
} from "./26-plan-run-roundtrip.helpers.ts";

export const scenario: Scenario = {
	id: "26",
	title:
		"Plan-run roundtrip — coordinator dispatches three children, merges via stubbed GH PR, trivial-merges the no-commit child; second POST resumes from the next open seed",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-26-"));
		const fixturePath = join(scenarioRoot, "fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");

		await buildPlanRunFixture({
			fixturePath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitConfigPath,
			projectGitUrl: PLAN_PROJECT_URL,
		});

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					WARREN_STUB_SLEEP_MS: "0",
					// Stub every GitHub REST call so reap's pr_open + the
					// coordinator's checkPullRequestMerged short-circuit to a
					// canned `merged` shape — no real GH fixture needed.
					WARREN_GH_FETCH_OVERRIDE: "merged",
					// Drive the trivial-merge branch on the third child by
					// telling the stub agent to skip every workspace mutation
					// for that seed id.
					WARREN_STUB_NO_COMMIT_SEEDS: SEED_C,
					// Coordinator tick fires every 1s so the three-child
					// roundtrip lands inside PLAN_DEADLINE_MS.
					WARREN_PLAN_RUN_TICK_MS: "1000",
				},
			});
			ctx.logger.info(`scenario-26: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PLAN_PROJECT_URL },
			});
			assertEqual(
				project.hasSeeds,
				true,
				"plan-run fixture project surfaces hasSeeds=true after clone (warren-9990)",
			);

			// === First POST: full happy-path roundtrip ===
			const created = await http.expectJson<CreatePlanRunResponse>("POST", "/plan-runs", 201, {
				body: {
					project: project.id,
					planId: PLAN_ID,
					agent: "claude-code",
					promptTemplate: "closeseed {seed_id}",
				},
			});
			assertEqual(created.planRun.state, "queued", "first POST: plan-run state starts as 'queued'");
			assertEqual(created.children.length, 3, "first POST: 3 child rows created");
			for (const child of created.children) {
				assertEqual(
					child.state,
					"pending",
					`first POST: child seq=${child.seq} state starts as 'pending'`,
				);
			}
			const planRunId = created.planRun.id;
			ctx.logger.debug(`scenario-26: planRunId=${planRunId}`);

			const finished = await waitForPlanState(http, planRunId, "succeeded", PLAN_DEADLINE_MS);
			assertEqual(
				finished.planRun.state,
				"succeeded",
				"first POST: plan-run reaches terminal 'succeeded'",
			);
			assertEqual(finished.children.length, 3, "first POST: still 3 children");
			for (const child of finished.children) {
				assertEqual(
					child.state,
					"merged",
					`first POST: child seq=${child.seq} (seed=${child.seedId}) ended in 'merged' (no failures/skips)`,
				);
				assertTrue(
					typeof child.runId === "string" && child.runId.length > 0,
					`first POST: child seq=${child.seq} has a runId`,
				);
			}

			// Every child run carries trigger='plan-run' and the planRun→run
			// link is recoverable via plan_run_children.run_id (no metadata
			// column exists on warren's runs table today; the dispatch
			// metadata is forwarded into burrow only).
			assertEqual(finished.runs.length, 3, "first POST: detail response fans out 3 runs");
			for (const run of finished.runs) {
				assertEqual(
					run.trigger,
					"plan-run",
					`first POST: run ${run.id} trigger='plan-run' (createPlanRunSpawn wires it)`,
				);
				const linkedChild = finished.children.find((c) => c.runId === run.id);
				if (linkedChild === undefined) {
					throw new AcceptanceError(
						`first POST: run ${run.id} has trigger='plan-run' but no plan_run_children row links to it`,
					);
				}
			}

			// One child must have hit the trivial-merge branch (prUrl=null +
			// reap.empty_push), the other two land via the polled merge path.
			const trivialChild = finished.children.find((c) => c.seedId === SEED_C);
			if (trivialChild === undefined) {
				throw new AcceptanceError(`first POST: missing child for ${SEED_C}`);
			}
			const trivialRun = finished.runs.find((r) => r.id === trivialChild.runId);
			if (trivialRun === undefined) {
				throw new AcceptanceError(
					`first POST: could not locate the fanned-out run for trivial-merge child (runId=${trivialChild.runId})`,
				);
			}
			assertEqual(
				trivialRun.prUrl,
				null,
				`first POST: ${SEED_C} run's prUrl stays null (no-commit child → trivial-merge)`,
			);
			for (const seedId of [SEED_A, SEED_B]) {
				const child = finished.children.find((c) => c.seedId === seedId);
				if (child === undefined) {
					throw new AcceptanceError(`first POST: missing child for ${seedId}`);
				}
				const run = finished.runs.find((r) => r.id === child.runId);
				if (run === undefined) {
					throw new AcceptanceError(`first POST: no fanned-out run for ${seedId}`);
				}
				assertTrue(
					typeof run.prUrl === "string" && run.prUrl.length > 0,
					`first POST: ${seedId} run.prUrl populated by the GH-override pr_open stub`,
				);
			}

			// Event stream surfaces the coordinator's lifecycle kinds.
			const planRunEvents = await fetchAllPlanRunEvents(http, planRunId);
			const seenKinds = new Set(planRunEvents.map((e) => e.kind));
			for (const kind of [
				"plan_run.dispatched",
				"plan_run.merged",
				"plan_run.succeeded",
			] as const) {
				if (!seenKinds.has(kind)) {
					throw new AcceptanceError(
						`first POST: plan-run event stream missing '${kind}'; saw kinds=[${[...seenKinds].join(", ")}]`,
					);
				}
			}

			// === Second POST: resume semantics on closed children ===
			//
			// Mutate the source repo so ah-acc-26-b is `closed`, then refresh
			// the project clone. The coordinator's per-child showSeed should
			// catch the closed status and flip child seq=2 to 'skipped'
			// without spawning a run (warren-fcc9 resume contract).
			await rewriteSourceSeedClosed(fixturePath, SEED_B);
			await http.expectJson<unknown>(
				"POST",
				`/projects/${encodeURIComponent(project.id)}/refresh`,
				200,
			);

			const resumed = await http.expectJson<CreatePlanRunResponse>("POST", "/plan-runs", 201, {
				body: {
					project: project.id,
					planId: PLAN_ID,
					agent: "claude-code",
					promptTemplate: "closeseed {seed_id}",
				},
			});
			assertEqual(
				resumed.children.length,
				3,
				"second POST: same plan id → same 3 child seeds enumerated",
			);
			const finishedResumed = await waitForPlanState(
				http,
				resumed.planRun.id,
				"succeeded",
				PLAN_DEADLINE_MS,
			);
			assertEqual(
				finishedResumed.planRun.state,
				"succeeded",
				"second POST: plan-run reaches terminal 'succeeded'",
			);
			const skippedChild = finishedResumed.children.find((c) => c.seedId === SEED_B);
			if (skippedChild === undefined) {
				throw new AcceptanceError(`second POST: missing child for ${SEED_B}`);
			}
			assertEqual(
				skippedChild.state,
				"skipped",
				`second POST: ${SEED_B} flipped to 'skipped' without dispatching (resume semantics)`,
			);
			assertEqual(
				skippedChild.runId,
				null,
				`second POST: ${SEED_B} carries runId=null (no spawn happened)`,
			);
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
		}
	},
};
