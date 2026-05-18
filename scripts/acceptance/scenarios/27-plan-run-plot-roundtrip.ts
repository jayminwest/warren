/**
 * Scenario 27 — PlanRun + Plot roundtrip end-to-end (warren-97a3,
 * pl-7937 step 8). Composes scenario 25 (Plot dispatch) and scenario 26
 * (PlanRun coordinator) into one stack: a `.seeds/`-and-`.plot/`-enabled
 * fixture, a three-child plan with one trivial-merge case, and a Plot
 * bound to the PlanRun via `plot_id` on POST /plan-runs. Closes the loop
 * the per-step unit tests open:
 *   - warren-8bb4 / pl-7937 step 2 lands `plan_runs.plot_id` + repo plumbing.
 *   - warren-c900 / step 3 wires the handler validation + `project_lacks_plot`.
 *   - warren-b89f / step 4 emits `plan_run_dispatched` to the Plot at POST-time.
 *   - warren-b290 / step 5 threads `plot_id` into the coordinator spawn
 *     (lighting up the unchanged Phase 1 PLOT_ID/PLOT_ACTOR env injection
 *     and per-child `run_dispatched` append for every child) AND adds the
 *     auto-`done` transition on plan_succeeded.
 *   - warren-909c / step 6 keeps the gating stacked (.plot/ requires .seeds/).
 *   - warren-b636 / step 7 surfaces `plotId` in the UI surfaces (not exercised
 *     here — UI is out of scope for the acceptance harness).
 *
 * Topology mirrors scenario 26: in-proc only, per-scenario stack so the
 * `WARREN_GH_FETCH_OVERRIDE=merged` shim and `WARREN_STUB_NO_COMMIT_SEEDS`
 * knob stay scoped. The fixture commits both a `.seeds/` directory (config
 * + issues + plans) and a `.plot/` directory (one pre-init Plot transitioned
 * through drafting → ready → active so the auto-done transition is the only
 * `active → done` step left).
 *
 * Two plans live in the fixture so we can hit both the plot-bound dispatch
 * and the byte-identical baseline against the same project:
 *   - pl-acc-27-plot — 3 children (ah-acc-27-a, ah-acc-27-b open; ah-acc-27-c
 *     listed in WARREN_STUB_NO_COMMIT_SEEDS → trivial-merge branch).
 *   - pl-acc-27-base — 1 child (ah-acc-27-d open) used for the no-plot baseline.
 *
 * Plot append durability: host-side appenders (the `plan_run_dispatched`
 * write in createPlanRunHandler and the per-child `run_dispatched` write
 * in spawnRun's defaultPlotAppender) write to the project clone's
 * `.plot/<plotId>.events.jsonl` WITHOUT committing. Historically
 * `spawnRun`'s pre-child `refreshProject` (`git reset --hard origin/<ref>`)
 * wiped those uncommitted lines, so the scenario tailed the file every
 * 100ms to accumulate transient writes. That workaround is gone: as of
 * warren-fdd2 (pl-d4d6 step 1) refreshProjectClone snapshots `.plot/`
 * out-of-tree before the reset and restores it after, so every host-side
 * append persists across child dispatches and assertions read directly
 * from the on-disk events.jsonl at the end of the plan-run
 * (warren-aa63 / pl-d4d6 step 3 removes the tail).
 *
 * Assertions:
 *   1. POST /plan-runs with plot_id → 201 with planRun.plotId set; the
 *      PlanRun row stores it. (covers acceptance #1 from a real stack)
 *   2. `plan_run_dispatched` lands in events.jsonl between POST and the
 *      first child's dispatch (acceptance #5, warren-b89f) — read
 *      directly from disk post-completion now that refreshProjectClone
 *      preserves .plot/ (warren-fdd2).
 *   3. PlanRun reaches `succeeded` with three `merged` children, mirroring
 *      scenario 26's happy path (acceptance #12).
 *   4. Per-child `run_dispatched` lands in events.jsonl for every child —
 *      including the trivial-merge case — via the unchanged Phase 1
 *      host-side appender (acceptance #7, warren-e848).
 *   5. Plot status flips `active → done` after the coordinator's
 *      `plan_succeeded` arm, verified two ways: (a) the persisted
 *      `<plotId>.json` snapshot's `status` field, and (b) a
 *      `status_changed` event in events.jsonl authored by `user:operator`
 *      (acceptance #8, warren-b290). The events stream on the anchor
 *      child run surfaces `plan_run.plot_auto_done`.
 *   6. SOFT_SKIP (warren-a346, shared with scenario 25): the per-child
 *      sandbox carrying `PLOT_ID=<id>` + `PLOT_ACTOR=agent:<agent>:<run-id>`.
 *      The claude-stub agent emits these as a `text` envelope when present;
 *      burrow-cli@0.3.x doesn't yet forward body.env into the sandbox so
 *      the assertion soft-skips with a warn until warren-a346 lands.
 *   7. Byte-identical baseline (acceptance #4): POST /plan-runs WITHOUT
 *      plot_id against the same `.plot/`-enabled project returns
 *      planRun.plotId=null AND produces zero new Plot writes — no new
 *      plan_run_dispatched line and no run_dispatched line referencing
 *      the baseline planRun's id or its child run id. The Plot stays at
 *      `done` (already terminal from step 5, durable across refreshes
 *      thanks to warren-fdd2) and the coordinator's transitionPlot is
 *      a no-op since planRun.plotId is null.
 *
 * Negative-path (acceptance #2: plot_id on a non-Plot project → 400
 * `project_lacks_plot`) is covered by the unit test in
 * src/server/handlers.plan-runs.test.ts and is not re-exercised here to
 * keep the scenario's fixture footprint to one project clone.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly hasSeeds?: boolean;
	readonly hasPlot?: boolean;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly trigger: string;
	readonly prUrl: string | null;
	readonly plotId: string | null;
}

interface PlanRunRow {
	readonly id: string;
	readonly planId: string;
	readonly projectId: string;
	readonly agentName: string;
	readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	readonly plotId: string | null;
}

interface PlanRunChildRow {
	readonly planRunId: string;
	readonly seq: number;
	readonly seedId: string;
	readonly runId: string | null;
	readonly state:
		| "pending"
		| "dispatched"
		| "running"
		| "pr_open"
		| "merged"
		| "failed"
		| "skipped";
}

interface CreatePlanRunResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
}

interface PlanRunDetailResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
	readonly runs: readonly RunRow[];
}

interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: Record<string, unknown> | null;
}

interface PlotSnapshot {
	readonly id: string;
	readonly status: string;
}

const PLAN_PROJECT_URL = "https://github.com/warren-acceptance/sample-plan-run-plot.git";
const PLAN_ID_PLOT = "pl-acc-27-plot";
const PLAN_ID_BASE = "pl-acc-27-base";
const SEED_A = "ah-acc-27-a";
const SEED_B = "ah-acc-27-b";
const SEED_C = "ah-acc-27-c";
const SEED_D = "ah-acc-27-d";
const SEED_TS = "2026-05-17T00:00:00.000Z";

const TERMINAL_PLAN_STATES = new Set(["succeeded", "failed", "cancelled"]);
const PLAN_DEADLINE_MS = 90_000;
const POLL_INTERVAL_MS = 500;
const PLOT_FILE_POLL_TIMEOUT_MS = 10_000;
/**
 * After waitForPlanState returns, give the auto-done transition one more
 * cycle to land on disk. The plan-run state flips to `succeeded` BEFORE
 * the transitionPlot hook runs, so a tight read can miss the
 * status_changed event. 1.5s ≫ 1s coordinator tick — accommodates the
 * slowest realistic schedule.
 */
const POST_PLAN_FLUSH_MS = 1_500;

export const scenario: Scenario = {
	id: "27",
	title:
		"PlanRun + Plot roundtrip — plot_id threads through three-child plan-run, Plot auto-transitions active → done; baseline POST without plot_id leaves the Plot untouched",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-27-"));
		const fixturePath = join(scenarioRoot, "fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");

		const plotId = await buildPlanRunPlotFixture({
			fixturePath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitConfigPath,
			projectGitUrl: PLAN_PROJECT_URL,
		});
		ctx.logger.debug(`scenario-27: built fixture at ${fixturePath} with plotId=${plotId}`);

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					WARREN_STUB_SLEEP_MS: "0",
					// Stub GH PR-open + checkPullRequestMerged so the coordinator
					// short-circuits to merged without a real GitHub fixture
					// (matches scenario 26).
					WARREN_GH_FETCH_OVERRIDE: "merged",
					// Drive the trivial-merge branch on SEED_C: the stub agent
					// skips workspace mutations, reap reports commitsAhead=0,
					// the coordinator advances without GH polling.
					WARREN_STUB_NO_COMMIT_SEEDS: SEED_C,
					WARREN_PLAN_RUN_TICK_MS: "1000",
				},
			});
			ctx.logger.info(`scenario-27: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PLAN_PROJECT_URL },
			});
			assertEqual(
				project.hasSeeds,
				true,
				"plan-run+plot fixture project surfaces hasSeeds=true after clone (warren-9990)",
			);
			assertEqual(
				project.hasPlot,
				true,
				"plan-run+plot fixture project surfaces hasPlot=true after clone (warren-4e20)",
			);

			const plotEventsPath = join(project.localPath, ".plot", `${plotId}.events.jsonl`);
			const plotJsonPath = join(project.localPath, ".plot", `${plotId}.json`);

			{
				// === Plot-bound PlanRun ===
				const created = await http.expectJson<CreatePlanRunResponse>("POST", "/plan-runs", 201, {
					body: {
						project: project.id,
						planId: PLAN_ID_PLOT,
						agent: "claude-code",
						promptTemplate: "closeseed {seed_id}",
						plotId,
					},
				});
				assertEqual(
					created.planRun.plotId,
					plotId,
					"plot-bound PlanRun: POST response carries the dispatched plotId (warren-c900)",
				);
				assertEqual(
					created.planRun.state,
					"queued",
					"plot-bound PlanRun: state starts as 'queued'",
				);
				assertEqual(created.children.length, 3, "plot-bound PlanRun: 3 child rows created");
				const planRunId = created.planRun.id;
				ctx.logger.debug(`scenario-27: planRunId=${planRunId}`);

				const finished = await waitForPlanState(http, planRunId, "succeeded", PLAN_DEADLINE_MS);
				assertEqual(
					finished.planRun.state,
					"succeeded",
					"plot-bound PlanRun: reaches terminal 'succeeded'",
				);
				assertEqual(finished.children.length, 3, "plot-bound PlanRun: still 3 children");
				for (const child of finished.children) {
					assertEqual(
						child.state,
						"merged",
						`plot-bound PlanRun: child seq=${child.seq} (seed=${child.seedId}) ended in 'merged'`,
					);
					assertTrue(
						typeof child.runId === "string" && child.runId.length > 0,
						`plot-bound PlanRun: child seq=${child.seq} has a runId`,
					);
				}
				assertEqual(finished.runs.length, 3, "plot-bound PlanRun: detail response fans out 3 runs");
				for (const run of finished.runs) {
					assertEqual(
						run.plotId,
						plotId,
						`plot-bound PlanRun: child run ${run.id} carries plotId=${plotId} (warren-b290 → spawnRun.plotId)`,
					);
				}

				// Wait one cycle for the coordinator's plan_succeeded arm
				// to land its transitionPlot write — the plan-run state
				// flips to `succeeded` BEFORE the transitionPlot hook
				// runs. As of warren-fdd2 (pl-d4d6) refreshProjectClone
				// preserves .plot/ across resets, so we read directly from
				// the on-disk events.jsonl rather than tailing — every
				// host-side append now survives.
				await sleep(POST_PLAN_FLUSH_MS);
				const seenLines = await readPlotEventLines(plotEventsPath);
				const parsedSeen = parsePlotLines(seenLines);

				// (warren-b89f / pl-7937 step 4) plan_run_dispatched landed
				// at POST time.
				const planRunDispatched = parsedSeen.find(
					(ev) =>
						ev.type === "plan_run_dispatched" &&
						(ev.data as { plan_run_id?: unknown } | null)?.plan_run_id === planRunId,
				);
				if (planRunDispatched === undefined) {
					throw new AcceptanceError(
						`plot-bound PlanRun: missing 'plan_run_dispatched' event for planRun=${planRunId} in on-disk events.jsonl (${seenLines.size} lines seen)`,
					);
				}
				assertEqual(
					planRunDispatched.actor,
					"user:operator",
					"plot-bound PlanRun: plan_run_dispatched actor is user:<dispatcherHandle> (default 'operator')",
				);

				// (warren-e848 unchanged path) per-child run_dispatched
				// events accumulate for every child including the
				// trivial-merge SEED_C — defaultPlotAppender fires at spawn,
				// independent of commitsAhead.
				const runDispatchedSet = new Set(
					parsedSeen
						.filter((ev) => ev.type === "run_dispatched")
						.map((ev) => (ev.data as { run_id?: unknown } | null)?.run_id)
						.filter((id): id is string => typeof id === "string"),
				);
				const missingRunDispatched = finished.runs.filter((r) => !runDispatchedSet.has(r.id));
				if (missingRunDispatched.length > 0) {
					throw new AcceptanceError(
						`plot-bound PlanRun: missing per-child 'run_dispatched' Plot events for runIds=[${missingRunDispatched
							.map((r) => r.id)
							.join(", ")}]; saw runIds=[${[...runDispatchedSet].join(", ")}]`,
					);
				}

				const trivialChild = finished.children.find((c) => c.seedId === SEED_C);
				if (trivialChild === undefined) {
					throw new AcceptanceError(`plot-bound PlanRun: missing child for ${SEED_C}`);
				}
				const trivialRun = finished.runs.find((r) => r.id === trivialChild.runId);
				if (trivialRun === undefined) {
					throw new AcceptanceError(
						`plot-bound PlanRun: could not locate the fanned-out run for trivial-merge child (runId=${trivialChild.runId})`,
					);
				}
				assertEqual(
					trivialRun.prUrl,
					null,
					`plot-bound PlanRun: ${SEED_C} run's prUrl stays null (no-commit child → trivial-merge)`,
				);
				assertTrue(
					runDispatchedSet.has(trivialRun.id),
					`plot-bound PlanRun: trivial-merge child ${trivialRun.id} produced a run_dispatched Plot event (Phase 1 appender independent of commitsAhead)`,
				);

				// (warren-b290 / pl-7937 step 5) plot.status flips
				// active → done after the coordinator's plan_succeeded arm.
				// The .json snapshot survives because no further refresh
				// fires; the status_changed event lands in the tail and
				// survives for the same reason.
				const finalSnapshot = await waitForPlotStatus(
					plotJsonPath,
					"done",
					PLOT_FILE_POLL_TIMEOUT_MS,
				);
				assertEqual(
					finalSnapshot.status,
					"done",
					"plot-bound PlanRun: .plot/<id>.json snapshot status flipped to 'done'",
				);

				const parsedAfterDone = parsePlotLines(await readPlotEventLines(plotEventsPath));
				const statusChanged = parsedAfterDone.find((ev) => {
					if (ev.type !== "status_changed") return false;
					if (ev.actor !== "user:operator") return false;
					const data = ev.data as { to?: unknown; status?: unknown } | null;
					const to = data?.to ?? data?.status;
					return to === "done";
				});
				if (statusChanged === undefined) {
					throw new AcceptanceError(
						`plot-bound PlanRun: missing 'status_changed' → done by user:operator in on-disk events.jsonl`,
					);
				}

				const planRunEvents = await fetchAllPlanRunEvents(http, planRunId);
				const planKinds = new Set(planRunEvents.map((e) => e.kind));
				if (!planKinds.has("plan_run.plot_auto_done")) {
					throw new AcceptanceError(
						`plot-bound PlanRun: missing 'plan_run.plot_auto_done' on plan-run event stream; saw kinds=[${[...planKinds].join(", ")}]`,
					);
				}
				for (const forbidden of [
					"plan_run.plot_status_skipped",
					"plan_run.plot_auto_done_failed",
					"plan_run.plot_append_failed",
				] as const) {
					if (planKinds.has(forbidden)) {
						throw new AcceptanceError(
							`plot-bound PlanRun: unexpected '${forbidden}' on plan-run event stream — happy path should hit only plan_run.plot_auto_done`,
						);
					}
				}

				// SOFT_SKIP (warren-a346): PLOT_ID + PLOT_ACTOR reaching
				// the per-child sandbox. claude-code-stub-agent.sh emits
				// a `claude-stub: PLOT_ID=<id> PLOT_ACTOR=<actor>` text
				// envelope when PLOT_ID is set; until burrow-cli forwards
				// body.env into the sandbox the env never lands and the
				// echo never fires. Flip the warn branch to
				// `throw new AcceptanceError` when warren-a346 lands and
				// the burrow-cli pin moves forward.
				const childRunEvents = await Promise.all(
					finished.runs.map(async (run) => ({
						runId: run.id,
						events: await fetchAllRunEvents(http, run.id),
					})),
				);
				const missingEnvEcho: string[] = [];
				for (const { runId, events } of childRunEvents) {
					const echoed = findTextEvent(events, `PLOT_ID=${plotId}`);
					if (echoed === undefined) missingEnvEcho.push(runId);
				}
				if (missingEnvEcho.length > 0) {
					ctx.logger.warn(
						`scenario-27 (warren-a346 pending): ${missingEnvEcho.length}/${finished.runs.length} child run(s) missing 'PLOT_ID=${plotId}' echo — burrow does not yet forward body.env into the sandbox; runIds=${missingEnvEcho.join(", ")}`,
					);
				}

				// === Byte-identical baseline: POST without plot_id ===
				// (acceptance #4) A second POST against the SAME
				// .plot/-enabled project, omitting plot_id, must:
				//   - return planRun.plotId === null
				//   - produce zero new Plot writes (no plan_run_dispatched
				//     line referencing the baseline planRun id, no
				//     run_dispatched line referencing its child run id)
				//   - NOT emit plan_run.plot_* events on the coordinator
				//     stream
				// Snapshot the on-disk events.jsonl before the baseline
				// POST; after completion we diff the two reads. Any
				// appender write from the no-plot path would persist
				// (refresh preservation, warren-fdd2) and show up in the
				// diff.
				const linesBeforeBaseline = await readPlotEventLines(plotEventsPath);

				const baseline = await http.expectJson<CreatePlanRunResponse>("POST", "/plan-runs", 201, {
					body: {
						project: project.id,
						planId: PLAN_ID_BASE,
						agent: "claude-code",
						promptTemplate: "closeseed {seed_id}",
					},
				});
				assertEqual(
					baseline.planRun.plotId,
					null,
					"baseline PlanRun: omitting plot_id → planRun.plotId is null",
				);
				assertEqual(baseline.children.length, 1, "baseline PlanRun: single-child plan");
				const baselinePlanRunId = baseline.planRun.id;

				const baselineFinished = await waitForPlanState(
					http,
					baselinePlanRunId,
					"succeeded",
					PLAN_DEADLINE_MS,
				);
				assertEqual(
					baselineFinished.planRun.state,
					"succeeded",
					"baseline PlanRun: reaches terminal 'succeeded'",
				);
				assertEqual(
					baselineFinished.runs.length,
					1,
					"baseline PlanRun: detail response fans out 1 run",
				);
				const baselineRun = baselineFinished.runs[0];
				if (baselineRun === undefined) {
					throw new AcceptanceError("baseline PlanRun: missing fanned-out run row");
				}
				assertEqual(
					baselineRun.plotId,
					null,
					"baseline PlanRun: child run carries plotId=null (no env injection)",
				);

				await sleep(POST_PLAN_FLUSH_MS);
				const linesAfterBaseline = await readPlotEventLines(plotEventsPath);
				const newLines = [...linesAfterBaseline].filter((l) => !linesBeforeBaseline.has(l));
				for (const line of newLines) {
					if (
						line.includes(`"plan_run_id":"${baselinePlanRunId}"`) ||
						line.includes(`"run_id":"${baselineRun.id}"`)
					) {
						throw new AcceptanceError(
							`baseline PlanRun: Plot file leaked a write referencing the no-plot PlanRun (${baselinePlanRunId}) or its child run (${baselineRun.id}): ${line}`,
						);
					}
				}

				const baselineEvents = await fetchAllPlanRunEvents(http, baselinePlanRunId);
				const baselineKinds = baselineEvents.map((e) => e.kind);
				const baselinePlotKinds = baselineKinds.filter((k) => k.startsWith("plan_run.plot_"));
				if (baselinePlotKinds.length > 0) {
					throw new AcceptanceError(
						`baseline PlanRun: emitted plan_run.plot_* events on the coordinator stream despite plot_id=null: ${baselinePlotKinds.join(", ")}`,
					);
				}

				// The persisted .json status stays `done` across the
				// baseline PlanRun's refreshes thanks to warren-fdd2's
				// snapshot+restore — verify the on-disk snapshot still
				// reports the terminal status from step 5.
				const baselineSnapshot = await readPlotSnapshot(plotJsonPath);
				assertEqual(
					baselineSnapshot.status,
					"done",
					"baseline PlanRun: .plot/<id>.json status remains 'done' across refresh (warren-fdd2)",
				);
			}
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
		}
	},
};

interface BuildPlanRunPlotFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
	readonly harnessGitConfigPath: string;
	readonly gitConfigPath: string;
	readonly projectGitUrl: string;
}

/**
 * Build a fixture mirroring scenario 26's `.seeds/`-enabled layout plus a
 * committed `.plot/` directory holding one Plot pre-transitioned to
 * `active`. Returns the plot id so the scenario can dispatch with it.
 *
 * Two plans land in `.seeds/plans.jsonl` so the scenario can hit both
 * dispatch shapes against the same project without re-cloning.
 */
async function buildPlanRunPlotFixture(input: BuildPlanRunPlotFixtureInput): Promise<string> {
	await mkdir(input.fixturePath, { recursive: true });
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });
	await mkdir(join(input.fixturePath, ".seeds"), { recursive: true });

	const burrowToml = await readFile(join(input.sourceSamplePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceSamplePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	await copyFile(
		join(input.sourceSamplePath, "tools", "claude-code-stub-agent.sh"),
		join(input.fixturePath, "tools", "claude-code-stub-agent.sh"),
	);
	await writeFile(
		join(input.fixturePath, "README.md"),
		"# warren acceptance plan-run + plot fixture\n\nUsed by scripts/acceptance/scenarios/27-plan-run-plot-roundtrip.ts.\n",
	);

	await writeFile(
		join(input.fixturePath, ".seeds", "config.yaml"),
		`project: "sample-plan-run-plot"\nversion: "1"\nmax_plan_depth: 3\n`,
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "issues.jsonl"),
		[seedRowOpen(SEED_A), seedRowOpen(SEED_B), seedRowOpen(SEED_C), seedRowOpen(SEED_D)].join(""),
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "plans.jsonl"),
		[planRow(PLAN_ID_PLOT, [SEED_A, SEED_B, SEED_C]), planRow(PLAN_ID_BASE, [SEED_D])].join(""),
	);

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);

	// `plot init` with a user actor (Plot SPEC §6 forbids agent actors on
	// plot_created). Then transition drafting → ready → active so the
	// coordinator's auto-done has an `active` plot to terminate. Without
	// this the auto-done would correctly skip-with-currentStatus=drafting,
	// which is a different code path (acceptance #9).
	const plotEnv: Record<string, string> = { ...env, PLOT_ACTOR: "user:acceptance" };
	await runIn(input.fixturePath, ["plot", "init", "scenario-27"], plotEnv);
	const list = await runIn(input.fixturePath, ["plot", "list", "--json"], env);
	const plots = JSON.parse(list.stdout) as ReadonlyArray<{ id: string }>;
	if (plots.length !== 1) {
		throw new AcceptanceError(
			`scenario-27 fixture: expected exactly one Plot after init, got ${plots.length}: ${list.stdout}`,
		);
	}
	const plotId = plots[0]?.id;
	if (plotId === undefined) {
		throw new AcceptanceError(`scenario-27 fixture: plot list --json missing id: ${list.stdout}`);
	}
	await runIn(input.fixturePath, ["plot", "status", plotId, "ready"], plotEnv);
	await runIn(input.fixturePath, ["plot", "status", plotId, "active"], plotEnv);

	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(
		input.fixturePath,
		["git", "commit", "-m", "init: plan-run + plot acceptance fixture"],
		env,
	);

	const harnessConfig = existsSync(input.harnessGitConfigPath)
		? await readFile(input.harnessGitConfigPath, "utf8")
		: "";
	const lines: string[] = [
		harnessConfig.trimEnd(),
		`[url "${input.fixturePath}"]`,
		`\tinsteadOf = ${input.projectGitUrl}`,
		"",
	];
	await writeFile(input.gitConfigPath, `${lines.join("\n")}\n`);

	return plotId;
}

function seedRowOpen(id: string): string {
	const row = {
		id,
		title: `scenario-27 ${id}`,
		status: "open",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
	};
	return `${JSON.stringify(row)}\n`;
}

function planRow(id: string, children: readonly string[]): string {
	const plan = {
		id,
		seed: "warren-acc-27",
		template: "feature",
		status: "approved",
		revision: 1,
		sections: {
			context: `scenario-27 acceptance plan ${id}`,
			approach: "dispatch child seeds via the plan-run coordinator",
			steps: children.map((s) => ({ title: `close ${s}` })),
		},
		children,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		name: `scenario-27 ${id}`,
	};
	return `${JSON.stringify(plan)}\n`;
}

async function waitForPlanState(
	http: WarrenHttp,
	planRunId: string,
	target: string,
	timeoutMs: number,
): Promise<PlanRunDetailResponse> {
	const start = Date.now();
	let last = "unknown";
	while (Date.now() - start < timeoutMs) {
		const row = await http.expectJson<PlanRunDetailResponse>(
			"GET",
			`/plan-runs/${encodeURIComponent(planRunId)}`,
			200,
		);
		last = row.planRun.state;
		if (row.planRun.state === target) return row;
		if (TERMINAL_PLAN_STATES.has(row.planRun.state)) {
			throw new AcceptanceError(
				`plan-run ${planRunId}: expected '${target}', reached terminal '${row.planRun.state}'`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`plan-run ${planRunId} did not reach '${target}' within ${timeoutMs}ms (last state=${last})`,
	);
}

async function fetchAllPlanRunEvents(http: WarrenHttp, planRunId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/plan-runs/${encodeURIComponent(planRunId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

async function fetchAllRunEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

function findTextEvent(events: readonly EventRow[], needle: string): EventRow | undefined {
	return events.find(
		(e) =>
			e.kind === "text" &&
			typeof e.payload?.text === "string" &&
			(e.payload.text as string).includes(needle),
	);
}

/**
 * Read the Plot events.jsonl from disk and return the set of trimmed
 * non-empty lines. As of warren-fdd2 (pl-d4d6 step 1) refreshProjectClone
 * snapshots `.plot/` out-of-tree before `git reset --hard` and restores
 * it after, so host-side appender writes accumulate across child
 * dispatches and a single post-completion read sees every line. Missing
 * file is treated as an empty set so the helper composes with the
 * pre-dispatch baseline snapshot.
 */
async function readPlotEventLines(path: string): Promise<ReadonlySet<string>> {
	const seen = new Set<string>();
	try {
		const body = await readFile(path, "utf8");
		for (const line of body.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			seen.add(trimmed);
		}
	} catch {
		// File not yet present — return empty set.
	}
	return seen;
}

interface ParsedPlotEvent {
	readonly type: string;
	readonly actor: string;
	readonly at: string;
	readonly data: unknown;
}

function parsePlotLines(lines: ReadonlySet<string>): ParsedPlotEvent[] {
	const out: ParsedPlotEvent[] = [];
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const row = parsed as { type?: unknown; actor?: unknown; at?: unknown; data?: unknown };
		if (
			typeof row.type !== "string" ||
			typeof row.actor !== "string" ||
			typeof row.at !== "string"
		) {
			continue;
		}
		out.push({ type: row.type, actor: row.actor, at: row.at, data: row.data ?? null });
	}
	return out;
}

async function readPlotSnapshot(path: string): Promise<PlotSnapshot> {
	const body = await readFile(path, "utf8");
	const parsed = JSON.parse(body) as PlotSnapshot;
	return parsed;
}

async function waitForPlotStatus(
	path: string,
	target: string,
	timeoutMs: number,
): Promise<PlotSnapshot> {
	const start = Date.now();
	let lastStatus = "unknown";
	while (Date.now() - start < timeoutMs) {
		try {
			const snapshot = await readPlotSnapshot(path);
			lastStatus = snapshot.status;
			if (snapshot.status === target) return snapshot;
		} catch {
			// File not yet present or mid-write — keep polling.
		}
		await sleep(100);
	}
	throw new AcceptanceError(
		`Plot at ${path} did not reach status='${target}' within ${timeoutMs}ms (last status=${lastStatus})`,
	);
}

interface RunResult {
	stdout: string;
	stderr: string;
}

async function runIn(
	cwd: string,
	cmd: readonly string[],
	env: Record<string, string>,
): Promise<RunResult> {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd,
		env,
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
			`scenario-27 command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
		);
	}
	return { stdout, stderr };
}

function withGitIdentity(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "/tmp",
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
