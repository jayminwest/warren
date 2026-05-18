/**
 * Scenario 29 — Plot detail roundtrip end-to-end (warren-c40b /
 * pl-9d6a step 18). Closes the loop the per-step unit tests open for
 * the 3b sub-phase:
 *   - warren-961e (GET /plots/:id envelope shape),
 *   - warren-896f (POST /plots/:id/intent — intent_edited append +
 *     intent_goal_preview refresh),
 *   - warren-e868 (POST /plots/:id/status — illegal-transition guard
 *     surfaces 409 / `plot_illegal_status_transition`),
 *   - warren-589c (POST /plots/:id/attachments + DELETE — roundtrip
 *     through the lib's att-NNN id),
 *   - warren-e1ac (POST /plots/:id/questions/:event_id/answer +
 *     already-answered invariant),
 *   - warren-5d94 (Run-plan button → POST /plan-runs with plot_id;
 *     composes with pl-7937's append + auto-done wiring).
 *
 * Composes with scenario 25 (Plot integration roundtrip, mx-af2627)
 * and scenario 27 (PlanRun + Plot, mx-15e4da): scenario 25 covers the
 * spawn-time env injection + reap mirror; scenario 27 covers the
 * coordinator's per-child append + auto-done. This scenario sits
 * between them — exercising every per-Plot mutation handler on one
 * .seeds/-and-.plot/-enabled project, then triggering the same
 * plan-run flow scenario 27 covers, but ALSO verifying the Plot's
 * pre-plan-run state shape on the wire (envelope, attachments,
 * question_posed surface).
 *
 * Topology: in-proc only, per-scenario stack (mirrors scenario 27's
 * stack reuse — we need the same `WARREN_GH_FETCH_OVERRIDE=merged` /
 * `WARREN_STUB_NO_COMMIT_SEEDS` / `WARREN_PLAN_RUN_TICK_MS` knobs).
 *
 * Fixture (committed to git):
 *   - .seeds/ with two open children (ah-acc29-aaaa, ah-acc29-bbbb)
 *     and one two-child plan (pl-acc-29ab). `WARREN_STUB_NO_COMMIT_SEEDS`
 *     names ah-acc29-bbbb so it drives the trivial-merge branch.
 *   - .plot/ with one pre-init Plot transitioned drafting → ready →
 *     active, holding:
 *       * one `question_posed` event by an agent actor (so the
 *         already-answered invariant has a real, unanswered question
 *         to target),
 *       * one `seeds_issue` attachment whose ref is the plan id
 *         (`pl-acc-29ab`) — that's how the UI's Run-plan button
 *         detects an "sd_plan" attachment today (warren-5d94's
 *         `seeds_issue + ref ~ /^pl-/i` convention),
 *       * one `mulch_record` attachment (ref `mx-acc290`).
 *
 * Wire assertions, in order:
 *   1. GET /plots/:id returns the full envelope (id, name, status,
 *      intent, attachments[], event_log[], project_id) with the
 *      fixture's seeded shape (active, two attachments, plot_created
 *      + status_changed×2 + attachment_attached×2 + question_posed
 *      events present, ordered ascending by `at`).
 *   2. POST /plots/:id/intent {goal:"…"} returns the refreshed
 *      envelope; the next GET shows `intent.goal` updated AND a new
 *      `intent_edited` event in the event log authored by
 *      `user:operator` (default dispatcher fallback per mx-6a9788).
 *   3. POST /plots/:id/status rejects three actually-illegal
 *      transitions from `active` with 409 /
 *      `plot_illegal_status_transition`:
 *        - next=`drafting` (back-edge),
 *        - next=`ready`    (back-edge),
 *        - next=`active`   (self-transition).
 *      The seed text also lists "→ done rejected" with the rationale
 *      "active → done requires plan completion", but the SPEC §6.5
 *      transition matrix (`STATUS_TRANSITIONS`) actually permits
 *      `active → done` directly — that's exactly the edge the
 *      auto-done hook fires on at the end of this scenario. We
 *      deliberately do NOT assert `done` is rejected here because it
 *      isn't; the gap between the seed's rationale and the
 *      implementation is intentional (no plan-completion guard lives
 *      at the handler edge; auto-done is the trusted caller). When a
 *      plan-completion gate lands, add the assertion back here.
 *   4. POST /plots/:id/attachments adds a third attachment (kind
 *      `agent_run`, ref shape `^run-[A-Za-z0-9_-]+$`), the next GET
 *      shows it, and DELETE /plots/:id/attachments/:ref removes it.
 *      The two pre-seeded attachments stay untouched.
 *   5. POST /plots/:id/questions/:event_id/answer lands a
 *      `question_answered` event referencing the targeted
 *      `question_posed`. A second POST against the same event_id is
 *      rejected with 409 / `plot_question_already_answered`
 *      (handler-edge concurrency invariant — warren-e1ac).
 *   6. Run-plan button equivalent: POST /plan-runs with
 *      `{project, planId: 'pl-acc-29ab', agent: 'claude-code', plotId,
 *       promptTemplate: 'closeseed {seed_id}'}` triggers the pl-7937
 *      wiring. We mirror scenario 27's Plot-events-file tail to verify:
 *        - `plan_run_dispatched` lands on the Plot at POST time
 *          (warren-b89f),
 *        - both children produce a `run_dispatched` Plot event
 *          including the trivial-merge child (warren-e848, Phase 1
 *          host-side appender independent of commitsAhead),
 *        - on plan_succeeded the Plot auto-transitions `active → done`
 *          (warren-b290) verified two ways: the persisted
 *          `<plotId>.json` snapshot AND a `status_changed → done`
 *          event in the events tail authored by `user:operator`.
 *      The plan-run's own stream carries `plan_run.plot_auto_done`
 *      and none of the failure-arm kinds.
 *   7. mergePlot mirror SOFT_SKIP (warren-a346, shared with scenarios
 *      25 + 27): the per-child sandbox carries PLOT_ID + PLOT_ACTOR
 *      and the agent emits a `plot append` whose result reap mirrors
 *      into warren's stream tagged with `plotId` (mx-98e080). The
 *      claude-stub agent emits a `claude-stub: PLOT_ID=<id> PLOT_ACTOR=<actor>`
 *      text envelope when the env is present (mx-deeeac), so we look
 *      for that across the child run streams. burrow-cli@0.3.x does
 *      not yet forward body.env into the sandbox; until warren-a346
 *      lands the assertion soft-skips with a `ctx.logger.warn`. Flip
 *      to a hard `AcceptanceError` when the pin moves forward.
 *
 * Idempotent teardown: per-scenario stack lives entirely under
 * `mkdtemp` so the harness wipes it on success. The fixture is built
 * fresh each run (no insteadOf accumulation in the shared
 * `ctx.tmp/git-config`).
 */

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

interface PlotAttachment {
	readonly id: string;
	readonly type: string;
	readonly ref: string;
	readonly role?: string;
	readonly added_at: string;
	readonly added_by: string;
}

interface PlotEventWire {
	readonly type: string;
	readonly actor: string;
	readonly at: string;
	readonly data?: Record<string, unknown>;
}

interface PlotEnvelope {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly intent: {
		readonly goal: string;
		readonly non_goals: readonly string[];
		readonly constraints: readonly string[];
		readonly success_criteria: readonly string[];
	};
	readonly attachments: readonly PlotAttachment[];
	readonly event_log: readonly PlotEventWire[];
	readonly project_id: string;
}

interface AttachResponse {
	readonly envelope: PlotEnvelope;
	readonly attachment: PlotAttachment;
}

interface DetachResponse {
	readonly envelope: PlotEnvelope;
	readonly removed_id: string;
}

interface AnswerResponse {
	readonly event: PlotEventWire;
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

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly plotId: string | null;
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
	readonly payload: Record<string, unknown> | null;
}

interface ErrorEnvelope {
	readonly error?: { readonly code?: string; readonly message?: string };
}

interface PlotSnapshot {
	readonly id: string;
	readonly status: string;
}

const PROJECT_URL = "https://github.com/warren-acceptance/sample-plot-detail.git";
const PLAN_ID = "pl-acc-29ab";
const SEED_A = "ah-acc29-aaaa";
const SEED_B = "ah-acc29-bbbb";
const MULCH_REF = "mx-acc290";
const SEED_TS = "2026-05-17T00:00:00.000Z";

const TERMINAL_PLAN_STATES = new Set(["succeeded", "failed", "cancelled"]);
const PLAN_DEADLINE_MS = 90_000;
const POLL_INTERVAL_MS = 500;
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

		const { plotId, questionAt } = await buildFixture({
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

			// event_log ordering + presence of seeded kinds.
			const kinds = env1.event_log.map((e) => e.type);
			for (const required of [
				"plot_created",
				"status_changed",
				"attachment_attached",
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
				if (prev === undefined || cur === undefined) continue;
				assertTrue(
					prev.at <= cur.at,
					`envelope.event_log not ascending at index ${i}: ${prev.at} vs ${cur.at}`,
				);
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

interface BuildFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
	readonly harnessGitConfigPath: string;
	readonly gitConfigPath: string;
	readonly projectGitUrl: string;
}

interface BuildFixtureResult {
	readonly plotId: string;
	readonly questionAt: string;
}

/**
 * Build a `.seeds/`-and-`.plot/`-enabled fixture and append an
 * insteadOf redirect so warren's `git clone <projectGitUrl>` resolves
 * to the on-disk path. Returns the seeded Plot id + the `at`
 * timestamp of the seeded `question_posed` (the wire :event_id).
 *
 * Mirrors scenario 27's fixture shape verbatim with three deltas:
 *   (1) the plan has two children (not three),
 *   (2) we append `question_posed` via PLOT_ACTOR=agent:* so the
 *       answer endpoint has a real, unanswered question to target,
 *   (3) we attach two refs (sd_plan-via-seeds_issue + mulch_record)
 *       so the GET /plots/:id assertion sees a populated
 *       attachments[] before the scenario starts mutating.
 */
async function buildFixture(input: BuildFixtureInput): Promise<BuildFixtureResult> {
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
		"# warren acceptance plot detail fixture\n\nUsed by scripts/acceptance/scenarios/29-plot-detail-roundtrip.ts.\n",
	);

	await writeFile(
		join(input.fixturePath, ".seeds", "config.yaml"),
		`project: "sample-plot-detail"\nversion: "1"\nmax_plan_depth: 3\n`,
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "issues.jsonl"),
		[seedRowOpen(SEED_A), seedRowOpen(SEED_B)].join(""),
	);
	await writeFile(
		join(input.fixturePath, ".seeds", "plans.jsonl"),
		[planRow(PLAN_ID, [SEED_A, SEED_B])].join(""),
	);

	const env = withGitIdentity();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);

	const userEnv: Record<string, string> = { ...env, PLOT_ACTOR: "user:acceptance" };
	const agentEnv: Record<string, string> = {
		...env,
		PLOT_ACTOR: "agent:claude-code:scenario-29-seed",
	};

	await runIn(input.fixturePath, ["plot", "init", "scenario-29"], userEnv);
	const list = await runIn(input.fixturePath, ["plot", "list", "--json"], userEnv);
	const plots = JSON.parse(list.stdout) as ReadonlyArray<{ id: string }>;
	if (plots.length !== 1) {
		throw new AcceptanceError(
			`scenario-29 fixture: expected one Plot after init, got ${plots.length}: ${list.stdout}`,
		);
	}
	const plotId = plots[0]?.id;
	if (plotId === undefined) {
		throw new AcceptanceError(`scenario-29 fixture: plot list --json missing id`);
	}

	// drafting → ready → active so the auto-done has an active Plot to terminate.
	await runIn(input.fixturePath, ["plot", "status", plotId, "ready"], userEnv);
	await runIn(input.fixturePath, ["plot", "status", plotId, "active"], userEnv);

	// Attach the two pre-seeded refs. The sd_plan convention is a
	// `seeds_issue` attachment whose ref is a `pl-*` id (warren-5d94 /
	// isSdPlanAttachment in PlotDetail.tsx); update if plot-cli ever
	// grows a first-class `seeds_plan` kind.
	await runIn(
		input.fixturePath,
		["plot", "attach", plotId, `seeds_issue:${PLAN_ID}`, "--role", "primary"],
		userEnv,
	);
	await runIn(
		input.fixturePath,
		["plot", "attach", plotId, `mulch_record:${MULCH_REF}`, "--role", "context"],
		userEnv,
	);

	// Agent-authored question_posed so the answerer has a real
	// unanswered question to target. The agent actor route is the
	// only legal one for question_posed (SPEC §6 — humans-only event
	// types exclude it from the agent restriction but in practice
	// agents pose, users answer; using `agent:*` keeps the actor
	// consistent with how the warren stack would generate it).
	await runIn(
		input.fixturePath,
		[
			"plot",
			"append",
			plotId,
			"--event",
			"question_posed",
			"--data",
			JSON.stringify({ text: "scenario-29: which db?", blocking: true }),
		],
		agentEnv,
	);

	// Recover the `at` timestamp of the just-appended question_posed
	// from the events.jsonl tail — the wire :event_id is that ISO
	// string (warren-e1ac).
	const eventsBody = await readFile(
		join(input.fixturePath, ".plot", `${plotId}.events.jsonl`),
		"utf8",
	);
	let questionAt: string | undefined;
	for (const line of eventsBody.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const ev = JSON.parse(trimmed) as { type?: string; at?: string };
			if (ev.type === "question_posed" && typeof ev.at === "string") {
				questionAt = ev.at;
				break;
			}
		} catch {
			// non-JSON line, ignore
		}
	}
	if (questionAt === undefined) {
		throw new AcceptanceError(
			`scenario-29 fixture: could not find seeded question_posed in ${plotId}.events.jsonl`,
		);
	}

	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(
		input.fixturePath,
		["git", "commit", "-m", "init: plot detail acceptance fixture"],
		env,
	);

	const harnessConfig = await readFile(input.harnessGitConfigPath, "utf8").catch(() => "");
	const lines: string[] = [
		harnessConfig.trimEnd(),
		`[url "${input.fixturePath}"]`,
		`\tinsteadOf = ${input.projectGitUrl}`,
		"",
	];
	await writeFile(input.gitConfigPath, `${lines.join("\n")}\n`);

	return { plotId, questionAt };
}

function seedRowOpen(id: string): string {
	const row = {
		id,
		title: `scenario-29 ${id}`,
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
		seed: "warren-acc-29",
		template: "feature",
		status: "approved",
		revision: 1,
		sections: {
			context: `scenario-29 acceptance plan ${id}`,
			approach: "dispatch child seeds via the plan-run coordinator",
			steps: children.map((s) => ({ title: `close ${s}` })),
		},
		children,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		name: `scenario-29 ${id}`,
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
		`plan-run ${planRunId} did not reach '${target}' within ${timeoutMs}ms (last=${last})`,
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

interface PlotEventsTail {
	lines(): ReadonlySet<string>;
	tickOnce(): Promise<void>;
	stop(): void;
}

function startPlotEventsTail(path: string, intervalMs: number): PlotEventsTail {
	const seen = new Set<string>();
	let stopped = false;
	const tick = async (): Promise<void> => {
		if (stopped) return;
		try {
			const body = await readFile(path, "utf8");
			for (const line of body.split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "") continue;
				seen.add(trimmed);
			}
		} catch {
			// not yet present — keep polling
		}
	};
	const handle = setInterval(() => {
		void tick();
	}, intervalMs);
	return {
		lines: () => seen,
		tickOnce: tick,
		stop: () => {
			stopped = true;
			clearInterval(handle);
		},
	};
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
	return JSON.parse(body) as PlotSnapshot;
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
			const snap = await readPlotSnapshot(path);
			lastStatus = snap.status;
			if (snap.status === target) return snap;
		} catch {
			// not yet present or mid-write
		}
		await sleep(100);
	}
	throw new AcceptanceError(
		`Plot at ${path} did not reach status='${target}' within ${timeoutMs}ms (last=${lastStatus})`,
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
			`scenario-29 command failed (${cmd.join(" ")} in ${cwd}): exit ${exitCode}\nstderr: ${stderr}\nstdout: ${stdout}`,
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
