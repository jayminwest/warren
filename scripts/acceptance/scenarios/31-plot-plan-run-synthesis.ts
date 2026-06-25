/**
 * Scenario 31 — Plot → synthesized plan-run roundtrip (warren-af97 /
 * pl-f404 step 5 / SPEC §11.Q). Composes scenarios 25 (Plot dispatch),
 * 27 (PlanRun + Plot), and 29 (PlotDetail surfaces) against one
 * `.plot/`-and-`.seeds/`-enabled fixture, exercising the synthesis
 * endpoint `POST /plot-plan-runs` end-to-end:
 *
 *   1. Synthesizer mints a throwaway parent seed + plan whose children
 *      adopt the Plot's open `seeds_issue` attachments via
 *      `existing_seed` (seeds-cli 0.4.7, warren-d519). Closed attachments
 *      and `sd_plan`-shaped attachments (ref ~ `^pl-`) are filtered at
 *      the handler edge.
 *   2. The persisted PlanRun row carries `plotId`, so every §11.P.Plot
 *      hook lights up unchanged: `plan_run_dispatched` lands at
 *      POST-time, every child run inherits `PLOT_ID`+`PLOT_ACTOR` env
 *      injection (acceptance-soft-skip on warren-a346 today, same as
 *      scenarios 25/27/29), per-child `run_dispatched` appends to the
 *      Plot events.jsonl. The bound Plot starts at `ready`; dispatch
 *      promotes it `ready → active` (promotePlotToActiveOnDispatch,
 *      warren-dfff / #487), then the Plot auto-transitions
 *      `active → done` on `plan_succeeded`.
 *   3. Re-dispatching the same Plot mints a SECOND synthesized plan
 *      (no clobber, no idempotency) — SPEC §11.Q acceptance #6.
 *
 * Negative paths covered (SPEC §11.Q acceptance #5):
 *   - malformed `plot_id` → 400 `plot_id_invalid` (warren-bae5)
 *   - non-existent `plot_id` → 400 `plot_id_not_found` (warren-bae5)
 *   - project without `.plot/` → 400 `project_lacks_plot`
 *   - Plot with zero dispatchable attachments → 400
 *     `no_dispatchable_seeds`
 *
 * The `project_lacks_seeds` arm is unit-test-only here: a project with
 * `.plot/` but no `.seeds/` requires a third fixture clone for one
 * assertion already covered by `plot-plan-runs.validation.test.ts`.
 *
 * Topology: in-proc only, per-scenario stack so the
 * `WARREN_GH_FETCH_OVERRIDE=merged` / `WARREN_STUB_NO_COMMIT_SEEDS`
 * / `WARREN_PLAN_RUN_TICK_MS` knobs stay scoped (mirrors scenarios
 * 26 / 27 / 29). Two project clones — one fully wired
 * (`.plot/`+`.seeds/`) and one bare — so the `project_lacks_plot`
 * arm runs against a real cloned project.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import {
	assertPlotPromotedToActiveOnDispatch,
	fetchAllPlanRunEvents,
	fetchAllRunEvents,
	findTextEvent,
	parsePlotLines,
	readPlotEventLines,
} from "./lib/event-helpers.ts";
import {
	BARE_PROJECT_URL,
	buildBareFixture,
	buildPlottedFixture,
	PLOTTED_PROJECT_URL,
	SEED_A,
	SEED_B,
	SEED_C,
	writeGitConfigRedirects,
} from "./lib/fixture-31.ts";
import { sleep, waitForPlanState, waitForPlotStatus } from "./lib/poll-helpers.ts";
import type { CreatePlotPlanRunResponse, ErrorEnvelope, ProjectRow } from "./lib/types.ts";

const PLAN_DEADLINE_MS = 120_000;
const PLOT_FILE_POLL_TIMEOUT_MS = 10_000;
/**
 * Auto-done landing budget — the plan-run state flips to `succeeded`
 * BEFORE the transitionPlot hook writes. 1.5s ≫ 1s coordinator tick.
 * Mirrors scenarios 27/29 (`POST_PLAN_FLUSH_MS`).
 */
const POST_PLAN_FLUSH_MS = 1_500;

export const scenario: Scenario = {
	id: "31",
	title:
		"Plot → synthesized plan-run roundtrip — POST /plot-plan-runs synthesizes a plan from open seeds_issue attachments, walks children to merged, auto-dones the Plot; re-dispatch mints a second plan; typed 4xx for malformed plot_id, missing .plot/, and zero dispatchable seeds",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-31-"));
		const plottedFixture = join(scenarioRoot, "plotted-fixture");
		const bareFixture = join(scenarioRoot, "bare-fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");

		const { happyPlotId, emptyPlotId } = await buildPlottedFixture({
			fixturePath: plottedFixture,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
		});
		await buildBareFixture({
			fixturePath: bareFixture,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
		});
		await writeGitConfigRedirects(gitConfigPath, [
			{ harnessGitConfigPath: join(ctx.tmp, "git-config") },
			{ fakeUrl: PLOTTED_PROJECT_URL, localPath: plottedFixture },
			{ fakeUrl: BARE_PROJECT_URL, localPath: bareFixture },
		]);
		ctx.logger.debug(
			`scenario-31: plottedFixture=${plottedFixture} happyPlot=${happyPlotId} emptyPlot=${emptyPlotId}`,
		);

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					WARREN_STUB_SLEEP_MS: "0",
					// Stub GH PR-open + checkPullRequestMerged so the
					// coordinator short-circuits to merged without a real
					// GitHub fixture (matches scenarios 26 / 27 / 29).
					WARREN_GH_FETCH_OVERRIDE: "merged",
					// Drive the trivial-merge branch on SEED_C: stub agent
					// skips workspace mutations, reap → commitsAhead=0, the
					// coordinator advances without GH polling.
					WARREN_STUB_NO_COMMIT_SEEDS: SEED_C,
					WARREN_PLAN_RUN_TICK_MS: "1000",
				},
			});
			ctx.logger.info(`scenario-31: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const plotted = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PLOTTED_PROJECT_URL },
			});
			assertEqual(plotted.hasSeeds, true, "plotted project surfaces hasSeeds=true (warren-9990)");
			assertEqual(plotted.hasPlot, true, "plotted project surfaces hasPlot=true (warren-4e20)");

			const bare = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: BARE_PROJECT_URL },
			});
			assertEqual(bare.hasPlot, false, "bare project surfaces hasPlot=false");

			// =====================================================
			// Negative paths (cheap — exercise before walking a plan).
			// =====================================================

			// (a) Malformed plot_id → 400 plot_id_invalid (warren-bae5).
			// Same regex gate POST /plan-runs uses; verified up-front so
			// a typo never reaches the project lookup.
			{
				const res = await http.request("POST", "/plot-plan-runs", {
					body: {
						plot_id: "not-a-plot-id",
						project_id: plotted.id,
						agent_name: "claude-code",
					},
				});
				assertEqual(
					res.status,
					400,
					"malformed plot_id → 400 (plot_id_invalid handler-edge reject)",
				);
				const body = (await res.json()) as ErrorEnvelope;
				assertEqual(
					body.error?.code,
					"plot_id_invalid",
					`malformed plot_id error code; got '${body.error?.code}'`,
				);
			}

			// (b) Well-formed but non-existent plot_id → 400
			// plot_id_not_found (plotResolver rejects).
			{
				const res = await http.request("POST", "/plot-plan-runs", {
					body: {
						plot_id: "plot-deadbeef",
						project_id: plotted.id,
						agent_name: "claude-code",
					},
				});
				assertEqual(
					res.status,
					400,
					"non-existent plot_id → 400 (plot_id_not_found resolver reject)",
				);
				const body = (await res.json()) as ErrorEnvelope;
				assertEqual(
					body.error?.code,
					"plot_id_not_found",
					`non-existent plot_id error code; got '${body.error?.code}'`,
				);
			}

			// (c) Bare project (no .plot/) → 400 project_lacks_plot.
			{
				const res = await http.request("POST", "/plot-plan-runs", {
					body: {
						plot_id: happyPlotId,
						project_id: bare.id,
						agent_name: "claude-code",
					},
				});
				assertEqual(res.status, 400, "bare project → 400 (project_lacks_plot handler-edge reject)");
				const body = (await res.json()) as ErrorEnvelope;
				assertEqual(
					body.error?.code,
					"project_lacks_plot",
					`bare project error code; got '${body.error?.code}'`,
				);
			}

			// (d) Plot with zero dispatchable attachments → 400
			// no_dispatchable_seeds. The empty plot was seeded with one
			// closed seed_issue + one sd_plan-shaped seeds_issue and no
			// open attachments — both filtered, leaving an empty
			// candidate list.
			{
				const res = await http.request("POST", "/plot-plan-runs", {
					body: {
						plot_id: emptyPlotId,
						project_id: plotted.id,
						agent_name: "claude-code",
					},
				});
				assertEqual(
					res.status,
					400,
					"empty-candidates plot → 400 (no_dispatchable_seeds handler-edge reject)",
				);
				const body = (await res.json()) as ErrorEnvelope;
				assertEqual(
					body.error?.code,
					"no_dispatchable_seeds",
					`empty-candidates error code; got '${body.error?.code}'`,
				);
			}

			// =====================================================
			// Happy path — synthesize + walk to completion + auto-done.
			// =====================================================

			const plotEventsPath = join(plotted.localPath, ".plot", `${happyPlotId}.events.jsonl`);
			const plotJsonPath = join(plotted.localPath, ".plot", `${happyPlotId}.json`);

			const created = await http.expectJson<CreatePlotPlanRunResponse>(
				"POST",
				"/plot-plan-runs",
				201,
				{
					body: {
						plot_id: happyPlotId,
						project_id: plotted.id,
						agent_name: "claude-code",
						prompt_template: "closeseed {seed_id}",
					},
				},
			);
			assertEqual(
				created.planRun.plotId,
				happyPlotId,
				"synthesis happy path: response planRun.plotId matches the dispatched plotId",
			);
			assertEqual(
				created.planRun.state,
				"queued",
				"synthesis happy path: planRun state starts as 'queued'",
			);
			assertTrue(
				/^pl-[a-z0-9]+$/i.test(created.synthesizedPlanId),
				`synthesis happy path: synthesizedPlanId is pl-* shaped (got '${created.synthesizedPlanId}')`,
			);
			assertTrue(
				typeof created.parentSeedId === "string" && created.parentSeedId.length > 0,
				`synthesis happy path: parentSeedId is a non-empty string (got '${created.parentSeedId}')`,
			);

			// Dispatch promotes the Plot `ready` → `active` at POST time
			// (promotePlotToActiveOnDispatch, warren-dfff / #487) so the
			// auto-done guard (status === 'active') is reachable via dispatch
			// as well as operator action.
			await assertPlotPromotedToActiveOnDispatch({
				plotJsonPath,
				plotEventsPath,
				timeoutMs: PLOT_FILE_POLL_TIMEOUT_MS,
				label: "synthesis happy path",
			});

			// Children equal the OPEN, non-sd_plan attachments only —
			// closed (SEED_CLOSED) and sd_plan (SD_PLAN_REF) refs were
			// filtered at the handler edge (steps 6 + 7 in SPEC §11.Q).
			const childSeeds = created.children.map((c) => c.seedId).sort();
			assertEqual(
				JSON.stringify(childSeeds),
				JSON.stringify([SEED_A, SEED_B, SEED_C].sort()),
				`synthesis happy path: children adopt open non-sd_plan attachments only (got [${childSeeds.join(", ")}])`,
			);

			const planRunId = created.planRun.id;
			ctx.logger.debug(`scenario-31: planRunId=${planRunId} synth=${created.synthesizedPlanId}`);

			// Walk to terminal. Three children: two regular + one
			// trivial-merge (SEED_C via WARREN_STUB_NO_COMMIT_SEEDS).
			const finished = await waitForPlanState(http, planRunId, "succeeded", PLAN_DEADLINE_MS);
			assertEqual(
				finished.planRun.state,
				"succeeded",
				"synthesis happy path: plan-run reaches terminal 'succeeded'",
			);
			assertEqual(finished.children.length, 3, "synthesis happy path: still 3 children");
			for (const child of finished.children) {
				assertEqual(
					child.state,
					"merged",
					`synthesis happy path: child seq=${child.seq} (seed=${child.seedId}) ended in 'merged'`,
				);
				assertTrue(
					typeof child.runId === "string" && child.runId.length > 0,
					`synthesis happy path: child seq=${child.seq} has a runId`,
				);
			}
			assertEqual(finished.runs.length, 3, "synthesis happy path: detail fans out 3 runs");
			for (const run of finished.runs) {
				assertEqual(
					run.plotId,
					happyPlotId,
					`synthesis happy path: child run ${run.id} carries plotId=${happyPlotId} (spawn.plotId inherited from plan-run)`,
				);
			}

			// Wait one tick past the plan_succeeded arm so the
			// transitionPlot write lands; refreshProjectClone snapshots
			// .plot/ across resets (warren-fdd2) so a single post-
			// completion read sees every host-side append.
			await sleep(POST_PLAN_FLUSH_MS);
			const parsedSeen = parsePlotLines(await readPlotEventLines(plotEventsPath));

			// plan_run_dispatched lands at POST time (warren-b89f /
			// pl-7937 step 4 — inherited unchanged by §11.Q step 9).
			const planRunDispatched = parsedSeen.find(
				(ev) =>
					ev.type === "plan_run_dispatched" &&
					(ev.data as { plan_run_id?: unknown } | null)?.plan_run_id === planRunId,
			);
			if (planRunDispatched === undefined) {
				throw new AcceptanceError(
					`synthesis happy path: missing 'plan_run_dispatched' for planRun=${planRunId} in on-disk events.jsonl (${parsedSeen.length} parsed events)`,
				);
			}
			assertEqual(
				planRunDispatched.actor,
				"user:operator",
				"synthesis happy path: plan_run_dispatched actor defaults to user:operator",
			);

			// Per-child run_dispatched events accumulate for every child
			// (Phase 1 host-side appender — independent of commitsAhead,
			// so SEED_C's trivial-merge also fires).
			const runDispatchedSet = new Set(
				parsedSeen
					.filter((ev) => ev.type === "run_dispatched")
					.map((ev) => (ev.data as { run_id?: unknown } | null)?.run_id)
					.filter((id): id is string => typeof id === "string"),
			);
			const missingRunDispatched = finished.runs.filter((r) => !runDispatchedSet.has(r.id));
			if (missingRunDispatched.length > 0) {
				throw new AcceptanceError(
					`synthesis happy path: missing per-child 'run_dispatched' for runIds=[${missingRunDispatched
						.map((r) => r.id)
						.join(", ")}]; saw runIds=[${[...runDispatchedSet].join(", ")}]`,
				);
			}

			// Auto-done: persisted .json snapshot + status_changed event.
			const finalSnapshot = await waitForPlotStatus(
				plotJsonPath,
				"done",
				PLOT_FILE_POLL_TIMEOUT_MS,
			);
			assertEqual(
				finalSnapshot.status,
				"done",
				"synthesis happy path: .plot/<id>.json status flipped to 'done'",
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
					"synthesis happy path: missing 'status_changed' → done by user:operator in on-disk events.jsonl",
				);
			}

			const planRunEvents = await fetchAllPlanRunEvents(http, planRunId);
			const planKinds = new Set(planRunEvents.map((e) => e.kind));
			if (!planKinds.has("plan_run.plot_auto_done")) {
				throw new AcceptanceError(
					`synthesis happy path: missing 'plan_run.plot_auto_done' on plan-run stream; saw kinds=[${[...planKinds].join(", ")}]`,
				);
			}
			for (const forbidden of [
				"plan_run.plot_status_skipped",
				"plan_run.plot_auto_done_failed",
				"plan_run.plot_append_failed",
			] as const) {
				if (planKinds.has(forbidden)) {
					throw new AcceptanceError(
						`synthesis happy path: unexpected '${forbidden}' on plan-run stream — happy path should hit only plan_run.plot_auto_done`,
					);
				}
			}

			// SOFT_SKIP (warren-a346, shared with scenarios 25/27/29): the
			// per-child sandbox carrying PLOT_ID + PLOT_ACTOR. burrow-cli
			// 0.3.x doesn't yet forward body.env into the sandbox, so the
			// claude-stub agent's `PLOT_ID=<id>` echo never fires. Flip
			// to a hard AcceptanceError when warren-a346 lands and the
			// burrow-cli pin advances.
			const childRunEvents = await Promise.all(
				finished.runs.map(async (r) => ({
					runId: r.id,
					events: await fetchAllRunEvents(http, r.id),
				})),
			);
			const missingEnvEcho: string[] = [];
			for (const { runId, events } of childRunEvents) {
				if (findTextEvent(events, `PLOT_ID=${happyPlotId}`) === undefined) {
					missingEnvEcho.push(runId);
				}
			}
			if (missingEnvEcho.length > 0) {
				ctx.logger.warn(
					`scenario-31 (warren-a346 pending): ${missingEnvEcho.length}/${finished.runs.length} child run(s) missing 'PLOT_ID=${happyPlotId}' echo — burrow does not yet forward body.env into the sandbox; runIds=${missingEnvEcho.join(", ")}`,
				);
			}

			// =====================================================
			// Re-dispatch (SPEC §11.Q acceptance #6).
			// Second POST against the same Plot mints a NEW synthesized
			// plan (different plan_id, different parent seed id). We
			// don't walk the second PlanRun to completion — the Plot is
			// already `done` and the auto-done hook would correctly
			// no-op or surface plan_run.plot_status_skipped, which is a
			// different code path. Verifying the dispatch returns 201
			// with a fresh synthesizedPlanId proves the "no clobber, no
			// idempotency" contract.
			// =====================================================
			const second = await http.expectJson<CreatePlotPlanRunResponse>(
				"POST",
				"/plot-plan-runs",
				201,
				{
					body: {
						plot_id: happyPlotId,
						project_id: plotted.id,
						agent_name: "claude-code",
						prompt_template: "closeseed {seed_id}",
					},
				},
			);
			assertEqual(
				second.planRun.plotId,
				happyPlotId,
				"re-dispatch: second planRun also carries plotId",
			);
			assertTrue(
				second.synthesizedPlanId !== created.synthesizedPlanId,
				`re-dispatch: second synthesizedPlanId differs from first (got '${second.synthesizedPlanId}' vs '${created.synthesizedPlanId}')`,
			);
			assertTrue(
				second.parentSeedId !== created.parentSeedId,
				`re-dispatch: second parentSeedId differs from first (got '${second.parentSeedId}' vs '${created.parentSeedId}')`,
			);
			// Cancel the second PlanRun so the scenario teardown isn't
			// racing the coordinator's tick loop (Plot is `done`, the
			// auto-done arm will skip cleanly, but cancellation is the
			// cheaper exit).
			await http
				.request("POST", `/plan-runs/${encodeURIComponent(second.planRun.id)}/cancel`)
				.catch(() => undefined);
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
		}
	},
};
