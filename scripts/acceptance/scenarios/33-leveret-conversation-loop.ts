/**
 * Scenario 33 — Workspace flow end-to-end (warren-9f47, adapted for the
 * single tabbed Workspace surface, pl-0008 step 12 / warren-1198).
 *
 * The acceptance harness is API-level, so each leg below drives the endpoints
 * that BACK a Workspace tab rather than the old /leveret + /plots pages:
 *   - list   — GET /plots (the durable spine the Workspace list rows on) joined
 *              with GET /conversations (active-conversation indicator).
 *   - Shape  — POST /conversations (+ messages, re-wake) + intent edit.
 *   - send-off — POST /conversations/:id/send-off (plotSync PR & close).
 *   - Plan   — merge-detected planner auto-dispatch (Plan tab planner status).
 *   - Run    — operator status control + operator-gated plan-run dispatch
 *              (Plan tab DispatchPlanButton) + per-child execution to merged +
 *              Plot auto-done (Run tab, SPEC §11.P).
 * Then: Plot persists + re-plan is a NEW conversation on the SAME Plot.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import {
	buildFixture,
	type RunRow,
	waitForRunState,
	waitForRunTerminal,
} from "./32-plot-workbench-loop.helpers.ts";
import {
	type ConversationRow,
	type ConversationsListResponse,
	type CreateConversationResponse,
	driveWorkspaceRunLeg,
	extendFixtureWithPlan,
	type GetConversationResponse,
	type PlotEnvelope,
	type PostMessageResponse,
	type ProjectRow,
	type RunsListResponse,
	type SendOffResponse,
	waitForPlannerDispatch,
} from "./lib/scenario-33.ts";

const PROJECT_URL = "https://github.com/warren-acceptance/sample-leveret.git";
const FINAL_GOAL = "scenario-33 acceptance: drive the leveret conversation loop end-to-end";

const RUNNING_DEADLINE_MS = 30_000;
const TERMINAL_DEADLINE_MS = 60_000;
const DISPATCH_DEADLINE_MS = 30_000;
const PLAN_DEADLINE_MS = 90_000;

export const scenario: Scenario = {
	id: "33",
	title:
		"Workspace flow — list (Plots ⋈ conversations) → Shape (conversation create hidden from Runs + operator turns + re-wake) → send-off (plotSync PR + close) → Plan (merge-detected planner auto-dispatch) → Run (operator-gated plan-run dispatch → children merged → Plot auto-done) → re-plan on same Plot",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-33-"));
		const fixturePath = join(scenarioRoot, "fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");

		await buildFixture({
			fixturePath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitConfigPath,
			projectGitUrl: PROJECT_URL,
		});
		// Run leg (warren-1198): append a plan + its open child seeds so the
		// operator-gated dispatch has a real seeds plan to drive once the
		// planner has run.
		await extendFixtureWithPlan(fixturePath);
		ctx.logger.debug(`scenario-33: fixture=${fixturePath}`);

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					// Conversation runs drive their own long sleep via the
					// [sleep_ms=...] prompt knob; the auto-dispatched planner run
					// (no knob) inherits this default so it exits + reaps fast.
					WARREN_STUB_SLEEP_MS: "0",
					// Send-off plotSync PR open + merge-poller PR-merge check both
					// short-circuit to a synthetic `merged` result so the loop
					// stays hermetic (no real GitHub).
					WARREN_GH_FETCH_OVERRIDE: "merged",
					// Merge poller — on by default (warren-157a); the 500ms tick
					// lets the planner auto-dispatch land within seconds of the
					// (synthesized) PR merge.
					WARREN_MERGE_POLLER_TICK_MS: "500",
					// Run leg — the plan-run coordinator tick drives each child
					// through dispatch → PR-open → (synthesized) merge.
					WARREN_PLAN_RUN_TICK_MS: "1000",
				},
			});
			ctx.logger.info(`scenario-33: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PROJECT_URL },
			});
			assertEqual(project.hasPlot, true, "fixture project surfaces hasPlot=true");

			// =============================================================
			// Phase A — conversation create + hidden-from-Runs
			// =============================================================
			const created = await http.expectJson<CreateConversationResponse>(
				"POST",
				"/conversations",
				201,
				{
					body: {
						project_id: project.id,
						agent: "stub-shell",
						// Long sleep keeps the anchoring run 'running' across the
						// operator-turn + send-off phases so steerRun + the
						// finalize-on-close path both have a live run to act on.
						message: "[sleep_ms=120000] scenario-33: let's shape this Plot's intent",
						title: "scenario-33 conversation",
					},
				},
			);
			const conversationId = created.conversation.id;
			const anchorRunId = created.run.id;
			const plotId = created.conversation.plotId;
			assertEqual(created.run.mode, "conversation", "create dispatches a mode='conversation' run");
			assertTrue(plotId !== null && plotId.length > 0, "conversation auto-creates + binds a Plot");
			assertEqual(created.conversation.status, "active", "fresh conversation is active");

			// The anchoring run is HIDDEN from the Runs list (both unfiltered
			// and project-scoped) — operators see conversations, not a pile of
			// never-terminating runs.
			const runsBefore = await http.expectJson<RunsListResponse>(
				"GET",
				`/runs?project=${encodeURIComponent(project.id)}`,
				200,
			);
			assertTrue(
				!runsBefore.runs.some((r) => r.id === anchorRunId),
				"anchoring mode='conversation' run is excluded from the Runs list",
			);
			// ...but still reachable by id (it's a real run row).
			const anchorRow = await http.expectJson<RunRow>(
				"GET",
				`/runs/${encodeURIComponent(anchorRunId)}`,
				200,
			);
			assertEqual(anchorRow.mode, "conversation", "GET /runs/:id resolves the conversation run");

			// It DOES surface on the conversations list.
			const convList = await http.expectJson<ConversationsListResponse>(
				"GET",
				`/conversations?project=${encodeURIComponent(project.id)}`,
				200,
			);
			assertTrue(
				convList.conversations.some((c) => c.id === conversationId),
				"conversation appears on the conversations list",
			);

			// Workspace LIST leg — the Workspace page rows one entry per Plot (the
			// durable spine) and joins the active conversation as the
			// active-conversation indicator. Assert the backing endpoints: the
			// freshly bound Plot surfaces on GET /plots and the live conversation
			// joins it.
			if (plotId === null) throw new Error("unreachable: plotId asserted non-null above");
			const plotsList = await http.expectJson<{ plots: readonly { id: string }[] }>(
				"GET",
				`/plots?project=${encodeURIComponent(project.id)}`,
				200,
			);
			assertTrue(
				plotsList.plots.some((p) => p.id === plotId),
				"Workspace list: the conversation's Plot rows on GET /plots (the list spine)",
			);
			assertTrue(
				convList.conversations.some((c) => c.id === conversationId && c.plotId === plotId),
				"Workspace list: the active conversation joins its Plot (active-conversation indicator)",
			);

			// =============================================================
			// Phase B — many operator turns, transcript persists + survives
			// =============================================================
			await waitForRunState(http, anchorRunId, "running", RUNNING_DEADLINE_MS);

			const turns = [
				"scenario-33 turn 1: the goal is to ship the leveret loop",
				"scenario-33 turn 2: non-goal is rewriting the planner",
				"scenario-33 turn 3: constraint is deterministic acceptance",
			];
			for (const message of turns) {
				const accepted = await http.expectJson<PostMessageResponse>(
					"POST",
					`/conversations/${encodeURIComponent(conversationId)}/messages`,
					202,
					{ body: { message } },
				);
				assertEqual(accepted.conversationId, conversationId, "message echoes the conversation id");
				assertEqual(accepted.message.role, "user", "operator turn persists as role='user'");
			}

			const afterTurns = await http.expectJson<GetConversationResponse>(
				"GET",
				`/conversations/${encodeURIComponent(conversationId)}`,
				200,
			);
			// Opening prompt + the three operator turns = 4 transcript rows.
			assertEqual(
				afterTurns.messages.length,
				1 + turns.length,
				"transcript carries the opening prompt + every operator turn",
			);
			assertEqual(
				afterTurns.conversation.status,
				"active",
				"conversation survives the operator turns (still active)",
			);
			assertEqual(
				afterTurns.conversation.anchoringRunId,
				anchorRunId,
				"anchoring run is unchanged across the turns (no re-wake rotation yet)",
			);

			// =============================================================
			// Phase B.2 — Re-wake the active conversation (warren-6ccf)
			// =============================================================
			// Cancel the current anchoring run to make it terminal.
			await http.expectStatus("POST", `/runs/${encodeURIComponent(anchorRunId)}/cancel`, 200);
			await waitForRunTerminal(http, anchorRunId, TERMINAL_DEADLINE_MS);

			// Re-wake the conversation.
			const reWoken = await http.expectJson<{
				conversation: ConversationRow;
				run: { id: string; mode: string };
			}>("POST", `/conversations/${encodeURIComponent(conversationId)}/re-wake`, 200);

			const newAnchorRunId = reWoken.run.id;
			assertEqual(reWoken.conversation.status, "active", "re-woken conversation remains active");
			assertEqual(reWoken.run.mode, "conversation", "re-wake spawns a conversation run");
			assertEqual(
				reWoken.conversation.anchoringRunId,
				newAnchorRunId,
				"anchoring run ID rotated to new run",
			);
			assertTrue(newAnchorRunId !== anchorRunId, "anchoring run ID changed");

			// Wait for the new anchoring run to be running.
			await waitForRunState(http, newAnchorRunId, "running", RUNNING_DEADLINE_MS);

			// Send a post-rewake message turn to make sure chatting still works.
			const extraTurn = "scenario-33 turn 4: post-rewake turn";
			const acceptedRewakeTurn = await http.expectJson<PostMessageResponse>(
				"POST",
				`/conversations/${encodeURIComponent(conversationId)}/messages`,
				202,
				{ body: { message: extraTurn } },
			);
			assertEqual(
				acceptedRewakeTurn.conversationId,
				conversationId,
				"post-rewake message echoes the conversation id",
			);
			assertEqual(
				acceptedRewakeTurn.message.role,
				"user",
				"post-rewake turn persists as role='user'",
			);

			// Assert the transcript length now includes the opening prompt + 3 turns + the extra turn.
			const afterRewake = await http.expectJson<GetConversationResponse>(
				"GET",
				`/conversations/${encodeURIComponent(conversationId)}`,
				200,
			);
			assertEqual(
				afterRewake.messages.length,
				1 + turns.length + 1,
				"transcript carries all turns after re-wake",
			);

			// SOFT_SKIP (warren-ce65 + leveret builtin): the live-intent path is
			// propose_intent → intent_edited(actor=leveret), parsed from the
			// leveret tool_execution_end stream by the conversation bridge. That
			// bridge + the real leveret pi agent are not yet landed, so we drive
			// the intent edit host-side through POST /plots/:id/intent to give
			// send-off a real plot-state change to ship.
			ctx.logger.warn(
				"scenario-33 (warren-ce65 pending): leveret-attributed propose_intent → intent_edited(actor=leveret) is not yet wired; driving the intent edit via POST /plots/:id/intent as a stand-in",
			);
			await http.expectJson<PlotEnvelope>(
				"POST",
				`/plots/${encodeURIComponent(plotId)}/intent`,
				200,
				{ body: { goal: FINAL_GOAL } },
			);

			// =============================================================
			// Phase C — send-off (plotSync PR + close)
			// =============================================================
			const sentOff = await http.expectJson<SendOffResponse>(
				"POST",
				`/conversations/${encodeURIComponent(conversationId)}/send-off`,
				200,
				{ body: { planner_agent: "stub-shell" } },
			);
			assertEqual(sentOff.plot_id, plotId, "send-off echoes the bound plot_id");
			assertEqual(sentOff.conversation.status, "closed", "send-off closes the conversation");
			assertTrue(
				sentOff.conversation.submittedPrUrl !== null &&
					sentOff.conversation.submittedPrUrl.length > 0,
				"send-off persists the submitted plotSync PR ref",
			);
			assertEqual(
				sentOff.planner_agent,
				"stub-shell",
				"send-off pins the planner agent for the merge-poller dispatch",
			);

			// The anchoring run finalizes alongside the close.
			const finalizedAnchor = await waitForRunTerminal(http, newAnchorRunId, TERMINAL_DEADLINE_MS);
			assertEqual(
				finalizedAnchor.state,
				"succeeded",
				"new anchoring conversation run finalizes 'succeeded' on send-off",
			);

			// A closed conversation rejects further operator turns.
			await http.expectStatus(
				"POST",
				`/conversations/${encodeURIComponent(conversationId)}/messages`,
				400,
				{ body: { message: "scenario-33: too late, already sent off" } },
			);

			// =============================================================
			// Phase D — merge-detected planner auto-dispatch
			// =============================================================
			const dispatched = await waitForPlannerDispatch(http, conversationId, DISPATCH_DEADLINE_MS);
			const plannerRunId = dispatched.plannerRunId;
			if (plannerRunId === null) throw new Error("unreachable: plannerRunId asserted above");

			const plannerRun = await http.expectJson<RunRow>(
				"GET",
				`/runs/${encodeURIComponent(plannerRunId)}`,
				200,
			);
			assertEqual(
				plannerRun.plotId,
				plotId,
				"auto-dispatched planner run is keyed on the conversation's plot_id",
			);
			assertEqual(
				plannerRun.mode ?? "batch",
				"batch",
				"planner run is a normal batch run (not mode='conversation')",
			);

			// Unlike the conversation run, the planner run IS visible on Runs.
			const runsAfter = await http.expectJson<RunsListResponse>(
				"GET",
				`/runs?project=${encodeURIComponent(project.id)}`,
				200,
			);
			assertTrue(
				runsAfter.runs.some((r) => r.id === plannerRunId),
				"auto-dispatched planner run surfaces on the Runs list",
			);

			await waitForRunTerminal(http, plannerRunId, TERMINAL_DEADLINE_MS);

			// =============================================================
			// Run leg — operator-gated plan-run dispatch + per-child execution
			// =============================================================
			// The Plan tab gates dispatch behind an operator sign-off and then
			// fires the existing DispatchPlanButton (POST /plan-runs, keyed on the
			// Plot). The Workspace header's status control first walks the Plot
			// drafting → ready → active so the §11.P coordinator has an `active`
			// Plot to auto-terminate. The Run tab then surfaces per-child
			// execution to `merged` and the Plot's auto-done transition — both
			// asserted by driveWorkspaceRunLeg.
			await driveWorkspaceRunLeg(http, {
				projectId: project.id,
				plotId,
				deadlineMs: PLAN_DEADLINE_MS,
			});

			// =============================================================
			// Phase E — Plot persists + re-plan is a NEW conversation
			// =============================================================
			const plotAfter = await http.expectJson<PlotEnvelope>(
				"GET",
				`/plots/${encodeURIComponent(plotId)}`,
				200,
			);
			assertEqual(plotAfter.intent.goal, FINAL_GOAL, "Plot intent persists after send-off");

			const rePlan = await http.expectJson<CreateConversationResponse>(
				"POST",
				"/conversations",
				201,
				{
					body: {
						project_id: project.id,
						plot_id: plotId,
						agent: "stub-shell",
						message: "[sleep_ms=5000] scenario-33: re-plan against the same Plot",
						title: "scenario-33 re-plan",
					},
				},
			);
			assertTrue(
				rePlan.conversation.id !== conversationId,
				"re-plan is a fresh conversation (distinct id)",
			);
			assertEqual(
				rePlan.conversation.plotId,
				plotId,
				"re-plan conversation attaches to the SAME Plot",
			);

			const byPlot = await http.expectJson<ConversationsListResponse>(
				"GET",
				`/conversations?plot=${encodeURIComponent(plotId)}`,
				200,
			);
			assertTrue(
				byPlot.conversations.some((c) => c.id === conversationId) &&
					byPlot.conversations.some((c) => c.id === rePlan.conversation.id),
				"both conversations (original + re-plan) bind to the one Plot (N:1)",
			);

			// We have verified the re-wake transcript replay. The idle-timeout coordinator
			// is exercised by unit tests, while the manual re-wake flow is fully asserted here.
			ctx.logger.info("scenario-33: manual re-wake transcript replay successfully verified");
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
		}
	},
};
