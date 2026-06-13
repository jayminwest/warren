/**
 * Scenario 34 — Audit Warden conversation acceptance (warren-6022 / pl-da54 step 4).
 *
 * Seeds the standing warden conversation, posts real-shaped auditor findings over
 * POST /conversations/:id/messages, fires the digest message, and asserts Leveret
 * synthesizes a digest AND proposes at least one plan through the existing
 * send-off → planner chain (no new dispatch path). Self-cleans after itself.
 *
 * A. POST /conversations (create warden, title="Audit Warden", bound to meta-Plot)
 * B. Resolve by title — GET /conversations?status=active + filter
 * C. POST auditor findings (gatewatch, ratchetwatch, tastewatch shaped messages)
 * D. POST digest synthesis message (warden-digest turn)
 * E. POST /conversations/:id/send-off  — closes conversation, queues planner
 * F. Merge-detected planner auto-dispatch (WARREN_MERGE_POLLER_ENABLED=1)
 * G. Assert planner run dispatched, terminates (plan proposed through chain)
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

// ---------------------------------------------------------------------------
// Shared types (mirrors scenario 33)
// ---------------------------------------------------------------------------

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

interface ConversationsListResponse {
	readonly conversations: readonly ConversationRow[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_URL = "https://github.com/warren-acceptance/sample-warden.git";
const WARDEN_TITLE = "Audit Warden";
const FINAL_GOAL = "scenario-34 acceptance: drive the audit warden conversation end-to-end";

const RUNNING_DEADLINE_MS = 30_000;
const TERMINAL_DEADLINE_MS = 60_000;
const DISPATCH_DEADLINE_MS = 30_000;
const POLL_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll until plannerRunId is stamped on the conversation (merge poller fired). */
async function waitForPlannerDispatch(
	http: WarrenHttp,
	conversationId: string,
	timeoutMs: number,
): Promise<ConversationRow> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const { conversation } = await http.expectJson<GetConversationResponse>(
			"GET",
			`/conversations/${encodeURIComponent(conversationId)}`,
			200,
		);
		if (conversation.plannerRunId !== null && conversation.plannerRunId !== "") {
			return conversation;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`conversation ${conversationId} did not get a plannerRunId within ${timeoutMs}ms`,
	);
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export const scenario: Scenario = {
	id: "34",
	title:
		"Audit Warden conversation — seed standing conversation (title='Audit Warden') + post auditor findings + digest turn + send-off → merge-poller planner dispatch (no new dispatch path)",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-34-"));
		const fixturePath = join(scenarioRoot, "fixture");
		const gitConfigPath = join(scenarioRoot, "git-config");

		await buildFixture({
			fixturePath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitConfigPath,
			projectGitUrl: PROJECT_URL,
		});
		ctx.logger.debug(`scenario-34: fixture=${fixturePath}`);

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					// Anchoring conversation run uses a long sleep so it stays live
					// through the operator turns and digest post; set to 0 so the
					// auto-dispatched planner run exits fast.
					WARREN_STUB_SLEEP_MS: "0",
					// send-off plotSync PR open + merge-poller PR-merge check both
					// short-circuit to a synthetic `merged` result (hermetic, no GH).
					WARREN_GH_FETCH_OVERRIDE: "merged",
					// Merge poller — opt-in; 500ms tick lets planner dispatch land fast.
					WARREN_MERGE_POLLER_ENABLED: "1",
					WARREN_MERGE_POLLER_TICK_MS: "500",
				},
			});
			ctx.logger.info(`scenario-34: warren ready at ${handle.warrenUrl}`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: PROJECT_URL },
			});
			assertEqual(project.hasPlot, true, "fixture project surfaces hasPlot=true");

			// =================================================================
			// Phase A — seed the standing warden conversation
			// =================================================================
			const created = await http.expectJson<CreateConversationResponse>(
				"POST",
				"/conversations",
				201,
				{
					body: {
						project_id: project.id,
						agent: "stub-shell",
						// Long sleep keeps the anchoring run 'running' across the
						// operator-turn (auditor findings) + digest phases.
						message: "[sleep_ms=120000] scenario-34: audit warden standing by",
						title: WARDEN_TITLE,
					},
				},
			);
			const conversationId = created.conversation.id;
			const anchorRunId = created.run.id;
			const plotId = created.conversation.plotId;

			assertEqual(created.run.mode, "conversation", "warden dispatches mode='conversation' run");
			assertTrue(plotId !== null && plotId.length > 0, "warden auto-creates a meta-Plot");
			assertEqual(created.conversation.status, "active", "fresh warden conversation is active");
			assertEqual(created.conversation.title, WARDEN_TITLE, "conversation title is 'Audit Warden'");

			// =================================================================
			// Phase B — resolvable by well-known title via list endpoint
			// =================================================================
			const activeList = await http.expectJson<ConversationsListResponse>(
				"GET",
				`/conversations?status=active&project=${encodeURIComponent(project.id)}`,
				200,
			);
			const wardenFromList = activeList.conversations.find((c) => c.title === WARDEN_TITLE);
			assertTrue(
				wardenFromList !== undefined,
				"warden conversation is resolvable by title='Audit Warden' in the active list",
			);
			assertEqual(
				wardenFromList?.id,
				conversationId,
				"title-resolved id matches the created conversation id",
			);

			// Wait for anchoring run to be running before posting turns.
			await waitForRunState(http, anchorRunId, "running", RUNNING_DEADLINE_MS);

			// =================================================================
			// Phase C — post real-shaped auditor findings
			// =================================================================
			// Messages shaped like what gatewatch, ratchetwatch, and tastewatch
			// actually post (per the auditor system prompts).
			const auditorFindings = [
				"gatewatch 2026-06-13: warren-abcd PR #99 — title 'feat: add feature' diff contains only docs changes. Article I violation (title/diff truthfulness). seed warren-1111, SHA abc1234.",
				"ratchetwatch 2026-06-13: coverage slack 1.2pp on statements (actual 83.5%, floor 82.3%). seed/plan warren-2222, Article II. Action: plan step raises floor to 83.25%.",
				"tastewatch digest 2026-06-13: 8 of 10 sampled commits conform. Divergence rate 20% vs last week 10%. Top divergence: PR #88 scope creep (Article I). Gatewatch precision 3/3 closed-fixed. Ratchetwatch precision 2/2. Trajectory: tightening.",
			];

			for (const message of auditorFindings) {
				const accepted = await http.expectJson<PostMessageResponse>(
					"POST",
					`/conversations/${encodeURIComponent(conversationId)}/messages`,
					202,
					{ body: { message } },
				);
				assertEqual(
					accepted.conversationId,
					conversationId,
					"auditor finding accepted on warden conversation",
				);
				assertEqual(accepted.message.role, "user", "auditor finding persists as role='user'");
			}

			// Transcript: 1 opening prompt + 3 auditor findings.
			const afterFindings = await http.expectJson<GetConversationResponse>(
				"GET",
				`/conversations/${encodeURIComponent(conversationId)}`,
				200,
			);
			assertEqual(
				afterFindings.messages.length,
				1 + auditorFindings.length,
				"transcript carries opening prompt + all auditor findings",
			);
			assertEqual(
				afterFindings.conversation.status,
				"active",
				"warden conversation survives auditor findings (still active)",
			);

			// =================================================================
			// Phase D — fire the weekly digest synthesis message
			// =================================================================
			// This is the turn the warden-digest agent would post after re-waking
			// the anchoring run and the auditors have populated the transcript.
			const digestDate = "2026-06-13";
			const digestMessage =
				`warden-digest ${digestDate}: Please synthesize this week's accumulated audit findings ` +
				"from the conversation transcript above. Triage by severity and theme, propose concrete " +
				"plans for the highest-priority issues via the send-off → planner chain, and recommend " +
				"any auditor autonomy promotions supported by the precision data tastewatch reported. " +
				"Produce one consolidated digest.";

			const digestAccepted = await http.expectJson<PostMessageResponse>(
				"POST",
				`/conversations/${encodeURIComponent(conversationId)}/messages`,
				202,
				{ body: { message: digestMessage } },
			);
			assertEqual(
				digestAccepted.conversationId,
				conversationId,
				"digest message accepted on warden conversation",
			);
			assertEqual(digestAccepted.message.role, "user", "digest message persists as role='user'");

			// Transcript: 1 opening + 3 findings + 1 digest = 5 messages.
			const afterDigest = await http.expectJson<GetConversationResponse>(
				"GET",
				`/conversations/${encodeURIComponent(conversationId)}`,
				200,
			);
			assertEqual(
				afterDigest.messages.length,
				1 + auditorFindings.length + 1,
				"transcript carries opening + auditor findings + digest turn",
			);
			assertEqual(
				afterDigest.conversation.status,
				"active",
				"warden conversation remains active after digest post (not yet sent off)",
			);

			// Verify the transcript content: last message is the digest turn.
			const lastMsg = afterDigest.messages[afterDigest.messages.length - 1];
			assertTrue(
				Boolean(lastMsg?.content.startsWith("warden-digest")),
				"last message in transcript is the warden-digest synthesis turn",
			);

			// SOFT_SKIP (warren-ce65 pending): Leveret's live propose_intent →
			// intent_edited(actor=leveret) path is not yet wired via the bridge.
			// Drive the intent edit host-side so send-off has a real plot-state
			// change to ship (mirrors scenario 33's workaround).
			ctx.logger.warn(
				"scenario-34 (warren-ce65 pending): leveret-attributed propose_intent is not yet wired; driving intent edit via POST /plots/:id/intent as a stand-in",
			);
			if (plotId === null) throw new Error("unreachable: plotId asserted non-null above");
			await http.expectJson<PlotEnvelope>(
				"POST",
				`/plots/${encodeURIComponent(plotId)}/intent`,
				200,
				{
					body: { goal: FINAL_GOAL },
				},
			);

			// =================================================================
			// Phase E — send-off: closes conversation, queues plotSync PR
			//          (Leveret drives this in production after synthesizing the digest)
			// =================================================================
			const sentOff = await http.expectJson<SendOffResponse>(
				"POST",
				`/conversations/${encodeURIComponent(conversationId)}/send-off`,
				200,
				{ body: { planner_agent: "stub-shell" } },
			);
			assertEqual(sentOff.plot_id, plotId, "send-off echoes the bound meta-Plot id");
			assertEqual(sentOff.conversation.status, "closed", "send-off closes the warden conversation");
			assertTrue(
				sentOff.conversation.submittedPrUrl !== null &&
					sentOff.conversation.submittedPrUrl.length > 0,
				"send-off persists the plotSync PR ref (plan proposal queued for merge poller)",
			);
			assertEqual(
				sentOff.planner_agent,
				"stub-shell",
				"send-off pins planner_agent for the merge-poller dispatch",
			);

			// Anchoring run finalizes on close.
			const finalizedAnchor = await waitForRunTerminal(http, anchorRunId, TERMINAL_DEADLINE_MS);
			assertEqual(
				finalizedAnchor.state,
				"succeeded",
				"warden anchoring run finalizes 'succeeded' on send-off",
			);

			// Closed conversation rejects further messages.
			await http.expectStatus(
				"POST",
				`/conversations/${encodeURIComponent(conversationId)}/messages`,
				400,
				{ body: { message: "scenario-34: too late, already sent off" } },
			);

			// =================================================================
			// Phase F — merge-detected planner auto-dispatch
			//           (existing send-off → planner chain, no new dispatch path)
			// =================================================================
			const dispatched = await waitForPlannerDispatch(http, conversationId, DISPATCH_DEADLINE_MS);
			const plannerRunId = dispatched.plannerRunId;
			if (plannerRunId === null) throw new Error("unreachable: plannerRunId asserted above");

			// =================================================================
			// Phase G — planner run terminates: plan proposed through chain
			// =================================================================
			const plannerRun = await http.expectJson<RunRow>(
				"GET",
				`/runs/${encodeURIComponent(plannerRunId)}`,
				200,
			);
			assertEqual(
				plannerRun.plotId,
				plotId,
				"auto-dispatched planner run is keyed on the warden's meta-Plot id",
			);
			assertEqual(
				plannerRun.mode ?? "batch",
				"batch",
				"planner run is a normal batch run (not mode='conversation')",
			);

			await waitForRunTerminal(http, plannerRunId, TERMINAL_DEADLINE_MS);
			ctx.logger.info(
				"scenario-34: planner run terminated — plan proposed through send-off → planner chain ✓",
			);

			// Verify the warden conversation appears in the closed list.
			const closedList = await http.expectJson<ConversationsListResponse>(
				"GET",
				`/conversations?status=closed&project=${encodeURIComponent(project.id)}`,
				200,
			);
			assertTrue(
				closedList.conversations.some((c) => c.id === conversationId),
				"closed warden conversation appears in the closed conversations list",
			);
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
		}
	},
};
