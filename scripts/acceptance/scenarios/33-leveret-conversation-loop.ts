/**
 * Scenario 33 — Leveret conversation loop end-to-end (warren-9f47 / LEVERET.md §0.13).
 * A. POST /conversations (create conversation & Plot)
 * B. POST /conversations/:id/messages (operator turns)
 * B.2 POST /conversations/:id/re-wake (cancel anchoring run, re-wake, post turn)
 * C. POST /conversations/:id/send-off (plotSync PR & close)
 * D. Merge-detected planner auto-dispatch (PR merge poller dispatches planner run)
 * E. Plot persists + re-plan is a NEW conversation on the SAME Plot (§0.0.C)
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
	sleep,
	waitForRunState,
	waitForRunTerminal,
} from "./32-plot-workbench-loop.helpers.ts";

interface ProjectRow {
	id: string;
	gitUrl: string;
	localPath: string;
	defaultBranch: string;
	hasSeeds?: boolean;
	hasPlot?: boolean;
}

interface ConversationRow {
	id: string;
	projectId: string;
	plotId: string | null;
	anchoringRunId: string | null;
	status: "active" | "closed";
	title: string | null;
	submittedPrUrl: string | null;
	plannerAgent: string | null;
	plannerRunId: string | null;
}

interface MessageRow {
	id: string;
	seq: number;
	role: string;
	content: string;
}

interface CreateConversationResponse {
	readonly conversation: ConversationRow;
	readonly run: { readonly id: string; readonly mode: string };
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

interface GetConversationResponse {
	readonly conversation: ConversationRow;
	readonly messages: readonly MessageRow[];
}

interface PostMessageResponse {
	readonly conversationId: string;
	readonly message: { readonly id: string; readonly seq: number; readonly role: string };
	readonly steerMessageId: string;
}

interface SendOffResponse {
	readonly conversation: ConversationRow;
	readonly plot_id: string;
	readonly pr: { readonly url: string; readonly number: number | null; readonly branch: string };
	readonly planner_agent: string | null;
}

interface PlotEnvelope {
	id: string;
	status: string;
	intent: { readonly goal: string };
	project_id: string;
}

interface RunsListResponse {
	readonly runs: readonly RunRow[];
}

interface ConversationsListResponse {
	readonly conversations: readonly ConversationRow[];
}

const PROJECT_URL = "https://github.com/warren-acceptance/sample-leveret.git";
const FINAL_GOAL = "scenario-33 acceptance: drive the leveret conversation loop end-to-end";

const RUNNING_DEADLINE_MS = 30_000;
const TERMINAL_DEADLINE_MS = 60_000;
const DISPATCH_DEADLINE_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/** Poll a conversation until `plannerRunId` is stamped (merge poller fired). */
async function waitForPlannerDispatch(
	http: WarrenHttp,
	conversationId: string,
	timeoutMs: number,
): Promise<ConversationRow> {
	const start = Date.now();
	let last: string | null = null;
	while (Date.now() - start < timeoutMs) {
		const { conversation } = await http.expectJson<GetConversationResponse>(
			"GET",
			`/conversations/${encodeURIComponent(conversationId)}`,
			200,
		);
		if (conversation.plannerRunId !== null && conversation.plannerRunId !== "") {
			return conversation;
		}
		last = conversation.status;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`conversation ${conversationId} did not get a plannerRunId within ${timeoutMs}ms (status='${last}')`,
	);
}

export const scenario: Scenario = {
	id: "33",
	title:
		"Leveret conversation loop — conversation create (hidden from Runs) + operator turns + re-wake (anchoring run rotation) + send-off (plotSync PR + close) + merge-detected planner auto-dispatch + re-plan on same Plot",
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
					// Merge poller — production default is disabled; the 500ms
					// tick lets the planner auto-dispatch land within seconds of
					// the (synthesized) PR merge.
					WARREN_MERGE_POLLER_ENABLED: "1",
					WARREN_MERGE_POLLER_TICK_MS: "500",
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
			if (plotId === null) throw new Error("unreachable: plotId asserted non-null above");
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

			// SOFT_SKIP (warren-6e45 / warren-d622): the operator-gated
			// `/plan-runs/new` dispatch popup + the interactive-mode retirement
			// are exercised elsewhere (scenarios 26/27); the auto-dispatched
			// planner above emits the plan that the operator-gated path would
			// then dispatch.
			ctx.logger.warn(
				"scenario-33 (warren-6e45/warren-d622 pending): operator-gated plan-run dispatch + interactive removal are not re-driven here; the merge-poller planner dispatch stands in for the auto leg",
			);

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
				"re-plan conversation attaches to the SAME Plot (§0.0.C)",
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
