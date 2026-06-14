import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertEqual, assertTrue } from "../../lib/assert.ts";
import type { WarrenHttp } from "../../lib/http.ts";
import { runIn, withGitIdentity } from "./git-helpers.ts";
import { sleep, waitForPlanState } from "./poll-helpers.ts";
import type { CreatePlanRunResponse, RunRow } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* Wire shapes (Workspace flow legs)                                        */
/* ----------------------------------------------------------------------- */

export interface ProjectRow {
	id: string;
	gitUrl: string;
	localPath: string;
	defaultBranch: string;
	hasSeeds?: boolean;
	hasPlot?: boolean;
}

export interface ConversationRow {
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

export interface MessageRow {
	id: string;
	seq: number;
	role: string;
	content: string;
}

export interface CreateConversationResponse {
	readonly conversation: ConversationRow;
	readonly run: { readonly id: string; readonly mode: string };
	readonly burrow: { readonly id: string; readonly workspacePath: string };
}

export interface GetConversationResponse {
	readonly conversation: ConversationRow;
	readonly messages: readonly MessageRow[];
}

export interface PostMessageResponse {
	readonly conversationId: string;
	readonly message: { readonly id: string; readonly seq: number; readonly role: string };
	readonly steerMessageId: string;
}

export interface SendOffResponse {
	readonly conversation: ConversationRow;
	readonly plot_id: string;
	readonly pr: { readonly url: string; readonly number: number | null; readonly branch: string };
	readonly planner_agent: string | null;
}

export interface PlotEnvelope {
	id: string;
	status: string;
	intent: { readonly goal: string };
	project_id: string;
}

export interface RunsListResponse {
	readonly runs: readonly RunRow[];
}

export interface ConversationsListResponse {
	readonly conversations: readonly ConversationRow[];
}

const POLL_INTERVAL_MS = 250;

/** Poll a conversation until `plannerRunId` is stamped (merge poller fired). */
export async function waitForPlannerDispatch(
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

/* ----------------------------------------------------------------------- */
/* Run leg — plan + child seeds + dispatch + per-child execution           */
/* ----------------------------------------------------------------------- */

/**
 * Workspace-flow Run-leg constants for scenario 33. The plan + its two open
 * child seeds are appended to the conversation fixture (built by the scenario
 * 32 helper) so the Plan tab's operator-gated dispatch has a real seeds plan to
 * drive and the Run tab has per-child execution to surface.
 */
export const PLAN_ID_33 = "pl-acc-33-workspace";
export const SEED_33_A = "ah-acc-33-a";
export const SEED_33_B = "ah-acc-33-b";
const SEED_TS = "2026-05-18T00:00:00.000Z";

function seedRowOpen(id: string): string {
	return `${JSON.stringify({
		id,
		title: `scenario-33 ${id}`,
		status: "open",
		type: "task",
		priority: 3,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
	})}\n`;
}

function planRow(id: string, children: readonly string[]): string {
	return `${JSON.stringify({
		id,
		seed: "warren-acc-33",
		template: "feature",
		status: "approved",
		revision: 1,
		sections: {
			context: `scenario-33 acceptance plan ${id}`,
			approach: "dispatch child seeds via the plan-run coordinator",
			steps: children.map((s) => ({ title: `close ${s}` })),
		},
		children,
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		name: `scenario-33 ${id}`,
	})}\n`;
}

/**
 * Extend the scenario-33 conversation fixture with a plan + open child seeds and
 * re-commit, so a clone of the fixture carries the plan the Run leg dispatches.
 * Must run AFTER `buildFixture` (which initialises the git repo) and BEFORE the
 * project is registered/cloned by warren.
 */
export async function extendFixtureWithPlan(fixturePath: string): Promise<void> {
	const seedsDir = join(fixturePath, ".seeds");
	await appendFile(
		join(seedsDir, "issues.jsonl"),
		`${seedRowOpen(SEED_33_A)}${seedRowOpen(SEED_33_B)}`,
	);
	await writeFile(join(seedsDir, "plans.jsonl"), planRow(PLAN_ID_33, [SEED_33_A, SEED_33_B]));

	const env = withGitIdentity();
	await runIn(fixturePath, ["git", "add", "."], env, "scenario-33 fixture plan add");
	await runIn(
		fixturePath,
		["git", "commit", "-m", "scenario-33: add Run-leg plan + child seeds"],
		env,
		"scenario-33 fixture plan commit",
	);
}

/**
 * Drive the Workspace Plan→Run leg: transition the Plot drafting → ready →
 * active (the operator status control in the Workspace header), then dispatch
 * the plan over the unchanged `/plan-runs` path (mirroring the Plan tab's
 * operator-gated DispatchPlanButton) and assert the Run-tab contract — every
 * child reaches `merged` and the Plot auto-transitions to `done` (SPEC §11.P).
 */
export async function driveWorkspaceRunLeg(
	http: WarrenHttp,
	input: { readonly projectId: string; readonly plotId: string; readonly deadlineMs: number },
): Promise<void> {
	const statusUrl = `/plots/${encodeURIComponent(input.plotId)}/status`;
	await http.expectStatus("POST", statusUrl, 200, { body: { next: "ready" } });
	await http.expectStatus("POST", statusUrl, 200, { body: { next: "active" } });

	const created = await http.expectJson<CreatePlanRunResponse>("POST", "/plan-runs", 201, {
		body: {
			project: input.projectId,
			planId: PLAN_ID_33,
			agent: "claude-code",
			promptTemplate: "closeseed {seed_id}",
			plotId: input.plotId,
		},
	});
	assertEqual(
		created.planRun.plotId,
		input.plotId,
		"Run leg: dispatched plan-run is bound to the conversation's Plot",
	);
	assertEqual(created.children.length, 2, "Run leg: plan-run fans out one child per open seed");

	const finished = await waitForPlanState(http, created.planRun.id, "succeeded", input.deadlineMs);
	for (const child of finished.children) {
		assertEqual(
			child.state,
			"merged",
			`Run leg: child seq=${child.seq} (seed=${child.seedId}) reached 'merged'`,
		);
	}

	const plot = await http.expectJson<{ status: string }>(
		"GET",
		`/plots/${encodeURIComponent(input.plotId)}`,
		200,
	);
	assertTrue(
		plot.status === "done",
		`Run leg: Plot auto-transitioned to 'done' once every child merged (got '${plot.status}')`,
	);
}
