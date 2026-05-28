/**
 * Scenario 29 — Plot detail roundtrip end-to-end (warren-c40b / pl-9d6a step 18).
 * Closes the loop the per-step unit tests open for the 3b sub-phase:
 *   - warren-961e (GET /plots/:id envelope shape),
 *   - warren-896f (POST /plots/:id/intent — intent_edited append + intent_goal_preview refresh),
 *   - warren-e868 (POST /plots/:id/status — illegal-transition guard surfaces 409 / `plot_illegal_status_transition`),
 *   - warren-589c (POST /plots/:id/attachments + DELETE — roundtrip through the lib's att-NNN id),
 *   - warren-e1ac (POST /plots/:id/questions/:event_id/answer + already-answered invariant),
 *   - warren-5d94 (Run-plan button → POST /plan-runs with plot_id; composes with pl-7937's append + auto-done wiring).
 *
 * Composes with scenario 25 (Plot integration roundtrip, mx-af2627) and scenario 27 (PlanRun + Plot, mx-15e4da).
 *
 * Topology: in-proc only, per-scenario stack (mirrors scenario 27's stack reuse).
 *
 * Idempotent teardown: per-scenario stack lives entirely under `mkdtemp` so the harness wipes it on success.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";

import {
	fetchAllPlanRunEvents,
	fetchAllRunEvents,
	findTextEvent,
	parsePlotLines,
	startPlotEventsTail,
} from "./lib/event-helpers.ts";
import { buildFixture29 } from "./lib/fixture-29.ts";
import { sleep, waitForPlanState, waitForPlotStatus } from "./lib/poll-helpers.ts";
import type {
	AnswerResponse,
	AttachResponse,
	CreatePlanRunResponse,
	DetachResponse,
	ErrorEnvelope,
	PlotEnvelope,
	ProjectRow,
} from "./lib/types.ts";

const PROJECT_URL = "https://github.com/warren-acceptance/sample-plot-detail.git";
const PLAN_ID = "pl-acc-29ab";
const SEED_B = "ah-acc29-bbbb";
const MULCH_REF = "mx-acc290";

const PLAN_DEADLINE_MS = 90_000;
const PLOT_FILE_POLL_TIMEOUT_MS = 10_000;
const POST_PLAN_TAIL_FLUSH_MS = 1_500;

export const scenario: Scenario = {
	id: "29",
	title:
		"Plot detail roundtrip — full envelope, intent edit, illegal-transition reject, attach/detach, question answer + already-answered, Run-plan triggers auto-done",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-29-"));
		const fixturePath = join(scenarioRoot, "fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");

		const { plotId, questionAt } = await buildFixture29({
			fixturePath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitConfigPath,
			projectGitUrl: PROJECT_URL,
		});
		ctx.logger.debug(
			`scenario-29: fixture=${fixturePath} plotId=${plotId} questionAt=${questionAt}`,
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
					WARREN_GH_FETCH_OVERRIDE: "merged",
					WARREN_STUB_NO_COMMIT_SEEDS: SEED_B,
					WARREN_PLAN_RUN_TICK_MS: "1000",
				},
			});
			ctx.logger.info(`scenario-29: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PROJECT_URL },
			});
			assertEqual(project.hasSeeds, true, "fixture project surfaces hasSeeds=true");
			assertEqual(project.hasPlot, true, "fixture project surfaces hasPlot=true");

			// === Assertion 1: GET /plots/:id full envelope ===
			const env1 = await http.expectJson<PlotEnvelope>(
				"GET",
				`/plots/${encodeURIComponent(plotId)}`,
				200,
			);
			assertEqual(env1.id, plotId, "envelope.id matches");
			assertEqual(env1.status, "active", "envelope.status is 'active' (fixture pre-transitioned)");
			assertEqual(env1.project_id, project.id, "envelope.project_id stitched from resolver");
			assertEqual(env1.attachments.length, 2, "envelope.attachments has 2 seeded entries");

			const sdPlanAtt = env1.attachments.find((a) => a.type === "seeds_issue" && a.ref === PLAN_ID);
			const mulchAtt = env1.attachments.find(
				(a) => a.type === "mulch_record" && a.ref === MULCH_REF,
			);
			if (sdPlanAtt === undefined || mulchAtt === undefined) {
				throw new AcceptanceError(
					`envelope.attachments missing seeded entries; got ${JSON.stringify(env1.attachments)}`,
				);
			}

			const kinds = env1.event_log.map((e) => e.type);
			for (const required of [
				"plot_created",
				"status_changed",
				"attachment_added",
				"question_posed",
			]) {
				assertTrue(
					kinds.includes(required),
					`envelope.event_log includes '${required}'; got [${kinds.join(", ")}]`,
				);
			}
			for (let i = 1; i < env1.event_log.length; i++) {
				const prev = env1.event_log[i - 1];
				const cur = env1.event_log[i];
				if (prev && cur) {
					assertTrue(
						prev.at <= cur.at,
						`envelope.event_log not ascending at index ${i}: ${prev.at} vs ${cur.at}`,
					);
				}
			}
			const seededQuestion = env1.event_log.find(
				(e) => e.type === "question_posed" && e.at === questionAt,
			);
			if (seededQuestion === undefined) {
				throw new AcceptanceError(
					`envelope.event_log missing the seeded question_posed at ${questionAt}`,
				);
			}

			// === Assertion 2: POST /plots/:id/intent ===
			const newGoal = "scenario-29 acceptance: drive plot detail roundtrip to completion";
			const envAfterIntent = await http.expectJson<PlotEnvelope>(
				"POST",
				`/plots/${encodeURIComponent(plotId)}/intent`,
				200,
				{ body: { goal: newGoal } },
			);
			assertEqual(envAfterIntent.intent.goal, newGoal, "intent.goal applied in response envelope");
			const env2 = await http.expectJson<PlotEnvelope>(
				"GET",
				`/plots/${encodeURIComponent(plotId)}`,
				200,
			);
			assertEqual(env2.intent.goal, newGoal, "intent.goal persists across GET");
			const intentEdited = env2.event_log.find(
				(e) => e.type === "intent_edited" && e.actor === "user:operator",
			);
			if (intentEdited === undefined) {
				throw new AcceptanceError(
					`event_log missing 'intent_edited' by user:operator after POST /intent; got actors [${env2.event_log.map((e) => `${e.type}/${e.actor}`).join(", ")}]`,
				);
			}

			// === Assertion 3: illegal status transitions from active ===
			for (const next of ["drafting", "ready", "active"] as const) {
				const res = await http.request("POST", `/plots/${encodeURIComponent(plotId)}/status`, {
					body: { next },
				});
				assertEqual(
					res.status,
					409,
					`POST /plots/:id/status next='${next}' should reject with 409 (illegal from active)`,
				);
				const body = (await res.json()) as ErrorEnvelope;
				assertEqual(
					body.error?.code,
					"plot_illegal_status_transition",
					`illegal next='${next}' carries code 'plot_illegal_status_transition'; got '${body.error?.code}'`,
				);
			}

			// === Assertion 4: attach + detach roundtrip ===
			const attachRef = "run-acc29-marker";
			const attachResp = await http.expectJson<AttachResponse>(
				"POST",
				`/plots/${encodeURIComponent(plotId)}/attachments`,
				200,
				{ body: { kind: "agent_run", ref: attachRef, role: "marker" } },
			);
			assertEqual(attachResp.attachment.type, "agent_run", "attach response carries the new type");
			assertEqual(attachResp.attachment.ref, attachRef, "attach response carries the new ref");
			assertEqual(
				attachResp.envelope.attachments.length,
				3,
				"envelope now has 3 attachments after attach",
			);

			const detachResp = await http.expectJson<DetachResponse>(
				"DELETE",
				`/plots/${encodeURIComponent(plotId)}/attachments/${encodeURIComponent(attachRef)}`,
				200,
			);
			assertEqual(
				detachResp.removed_id,
				attachResp.attachment.id,
				"detach removed the att-NNN id matching the just-attached ref",
			);
			assertEqual(
				detachResp.envelope.attachments.length,
				2,
				"envelope back to 2 attachments after detach",
			);
			// The two seeded entries survive.
			const survivors = detachResp.envelope.attachments.map((a) => `${a.type}:${a.ref}`).sort();
			assertEqual(
				JSON.stringify(survivors),
				JSON.stringify([`mulch_record:${MULCH_REF}`, `seeds_issue:${PLAN_ID}`]),
				"the two pre-seeded attachments survive the attach+detach roundtrip",
			);

			// === Assertion 5: answer question + already-answered ===
			const answerPath = `/plots/${encodeURIComponent(plotId)}/questions/${encodeURIComponent(questionAt)}/answer`;
			const answerResp = await http.expectJson<AnswerResponse>("POST", answerPath, 200, {
				body: { answer: "scenario-29: postgres" },
			});
			assertEqual(
				answerResp.event.type,
				"question_answered",
				"answer response carries the freshly-appended question_answered event",
			);
			assertEqual(
				answerResp.event.actor,
				"user:operator",
				"question_answered actor is the default dispatcher (operator)",
			);
			// Second attempt → 409 plot_question_already_answered.
			const secondAttempt = await http.request("POST", answerPath, {
				body: { answer: "scenario-29: redis" },
			});
			assertEqual(
				secondAttempt.status,
				409,
				"second POST against the same question_posed at-id should reject with 409",
			);
			const secondBody = (await secondAttempt.json()) as ErrorEnvelope;
			assertEqual(
				secondBody.error?.code,
				"plot_question_already_answered",
				`already-answered rejection carries the typed code; got '${secondBody.error?.code}'`,
			);

			// === Assertion 6: Run-plan triggers plan-run + auto-done ===
			const plotEventsPath = join(project.localPath, ".plot", `${plotId}.events.jsonl`);
			const plotJsonPath = join(project.localPath, ".plot", `${plotId}.json`);
			const plotTail = startPlotEventsTail(plotEventsPath, 100);
			try {
				const planRunResp = await http.expectJson<CreatePlanRunResponse>(
					"POST",
					"/plan-runs",
					201,
					{
						body: {
							project: project.id,
							planId: PLAN_ID,
							agent: "claude-code",
							promptTemplate: "closeseed {seed_id}",
							plotId,
						},
					},
				);
				assertEqual(
					planRunResp.planRun.plotId,
					plotId,
					"POST /plan-runs with plot_id: response carries the dispatched plotId",
				);
				assertEqual(
					planRunResp.children.length,
					2,
					"plan-run: 2 child rows created (one per fixture child)",
				);
				const planRunId = planRunResp.planRun.id;

				const finished = await waitForPlanState(http, planRunId, "succeeded", PLAN_DEADLINE_MS);
				assertEqual(
					finished.planRun.state,
					"succeeded",
					"plan-run reaches terminal 'succeeded' (one normal child + one trivial-merge)",
				);
				for (const child of finished.children) {
					assertEqual(
						child.state,
						"merged",
						`plan-run child seq=${child.seq} (seed=${child.seedId}) ended in 'merged'`,
					);
				}
				assertEqual(finished.runs.length, 2, "plan-run detail fans out 2 runs");
				for (const run of finished.runs) {
					assertEqual(
						run.plotId,
						plotId,
						`plan-run child run ${run.id} carries plotId=${plotId} (warren-b290 spawn.plotId)`,
					);
				}

				// Flush the tail past the auto-done arm (mirrors scenario 27).
				await sleep(POST_PLAN_TAIL_FLUSH_MS);
				await plotTail.tickOnce();
				const parsedSeen = parsePlotLines(plotTail.lines());

				const planRunDispatched = parsedSeen.find(
					(ev) =>
						ev.type === "plan_run_dispatched" &&
						(ev.data as { plan_run_id?: unknown } | null)?.plan_run_id === planRunId,
				);
				if (planRunDispatched === undefined) {
					throw new AcceptanceError(
						`plan-run: missing 'plan_run_dispatched' on Plot tail for planRun=${planRunId}; saw ${parsedSeen.length} events`,
					);
				}
				assertEqual(
					planRunDispatched.actor,
					"user:operator",
					"plan_run_dispatched on Plot tail is by user:<dispatcher_handle> (default 'operator')",
				);

				const runDispatchedRunIds = new Set(
					parsedSeen
						.filter((ev) => ev.type === "run_dispatched")
						.map((ev) => (ev.data as { run_id?: unknown } | null)?.run_id)
						.filter((id): id is string => typeof id === "string"),
				);
				const missingRunDispatched = finished.runs.filter((r) => !runDispatchedRunIds.has(r.id));
				if (missingRunDispatched.length > 0) {
					throw new AcceptanceError(
						`plan-run: missing 'run_dispatched' Plot events for runIds=[${missingRunDispatched.map((r) => r.id).join(", ")}] (Phase 1 host-side appender independent of commitsAhead)`,
					);
				}

				// Auto-done: persisted .json + status_changed in tail.
				const finalSnapshot = await waitForPlotStatus(
					plotJsonPath,
					"done",
					PLOT_FILE_POLL_TIMEOUT_MS,
				);
				assertEqual(
					finalSnapshot.status,
					"done",
					"plot-bound plan-run: .plot/<id>.json snapshot flipped to 'done'",
				);
				await plotTail.tickOnce();
				const statusChanged = parsePlotLines(plotTail.lines()).find((ev) => {
					if (ev.type !== "status_changed") return false;
					if (ev.actor !== "user:operator") return false;
					const data = ev.data as { to?: unknown; status?: unknown } | null;
					const to = data?.to ?? data?.status;
					return to === "done";
				});
				if (statusChanged === undefined) {
					throw new AcceptanceError(
						"plot-bound plan-run: missing 'status_changed → done' by user:operator in events.jsonl tail",
					);
				}

				const planRunEvents = await fetchAllPlanRunEvents(http, planRunId);
				const planKinds = new Set(planRunEvents.map((e) => e.kind));
				if (!planKinds.has("plan_run.plot_auto_done")) {
					throw new AcceptanceError(
						`plot-bound plan-run: missing 'plan_run.plot_auto_done' on plan-run stream; saw [${[...planKinds].join(", ")}]`,
					);
				}
				for (const forbidden of [
					"plan_run.plot_status_skipped",
					"plan_run.plot_auto_done_failed",
					"plan_run.plot_append_failed",
				] as const) {
					if (planKinds.has(forbidden)) {
						throw new AcceptanceError(
							`plot-bound plan-run: unexpected '${forbidden}' on plan-run stream — happy path should hit only plan_run.plot_auto_done`,
						);
					}
				}

				// === Assertion 7: mergePlot mirror SOFT_SKIP (warren-a346) ===
				// The claude-stub agent emits 'claude-stub: PLOT_ID=<id>
				// PLOT_ACTOR=<actor>' (mx-deeeac) when PLOT_ID lands in
				// its sandbox env; until burrow-cli forwards body.env
				// the env never arrives and the echo never fires. Flip
				// to a hard AcceptanceError when warren-a346 lands and
				// burrow-cli's pin advances.
				const childRunEvents = await Promise.all(
					finished.runs.map(async (r) => ({
						runId: r.id,
						events: await fetchAllRunEvents(http, r.id),
					})),
				);
				const missingEnvEcho: string[] = [];
				for (const { runId, events } of childRunEvents) {
					if (findTextEvent(events, `PLOT_ID=${plotId}`) === undefined) {
						missingEnvEcho.push(runId);
					}
				}
				if (missingEnvEcho.length > 0) {
					ctx.logger.warn(
						`scenario-29 (warren-a346 pending): ${missingEnvEcho.length}/${finished.runs.length} child run(s) missing 'PLOT_ID=${plotId}' echo — burrow does not yet forward body.env into the sandbox; runIds=${missingEnvEcho.join(", ")}`,
					);
				}
			} finally {
				plotTail.stop();
			}
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
		}
	},
};
