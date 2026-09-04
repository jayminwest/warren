import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { canonicalJson, sha256Hex } from "../digest.ts";
import {
	GithubMutationUncertainError,
	renderUpdateBranchIntent,
	type UpdateBranchIntent,
} from "../github/pr-mutations.ts";
import type { GithubPullRequestSnapshot } from "../github/types.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import {
	BRANCH_UPDATE_POLICY_BLOCKED_REASON,
	type BranchFreshnessDeps,
	branchUpdateActionKey,
	classifyBranchFreshness,
	conflictRepairActionKey,
	handleBranchFreshness,
	renderConflictRepairPrompt,
} from "./branch-freshness.ts";

const clock = new FixedClock(1_000_000);
const UPSTREAM = { owner: "openclaw", repo: "openclaw" };

let dir: string;
let store: CampaignStateStore;
let campaignId: string;
let workItemId: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "branch-freshness-"));
	store = new CampaignStateStore(join(dir, "state.db"), {
		clock,
		ids: new SequentialIdGenerator(),
	});
	const campaign = store.campaigns.createCampaign({
		manifestDigest: "digest-freshness",
		manifestJson: "{}",
		budgetCapUsdCents: 100_00,
	});
	campaignId = campaign.id;
	workItemId = store.campaigns.addWorkItem({
		campaignId,
		position: 1,
		issueRef: "issue://42",
	}).id;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function snapshot(mergeableState: string | null): GithubPullRequestSnapshot {
	return {
		nodeId: "PR_fresh",
		number: 7,
		state: "open",
		draft: false,
		title: "Fix the thing",
		body: null,
		authorLogin: "warren-run-bot",
		headRef: "warren/issue-42",
		headSha: "abc123",
		headRepoFullName: "warren-run-bot/openclaw",
		baseRef: "main",
		baseSha: "def456",
		baseRepoFullName: `${UPSTREAM.owner}/${UPSTREAM.repo}`,
		mergedAt: null,
		closedAt: null,
		createdAt: "2026-08-01T00:00:00Z",
		updatedAt: "2026-08-02T00:00:00Z",
		htmlUrl: `https://github.com/${UPSTREAM.owner}/${UPSTREAM.repo}/pull/7`,
		mergeableState,
	};
}

/** Counting fake branch updater; the real class refuses a disabled flag. */
class FakeBranchUpdater {
	calls: UpdateBranchIntent[] = [];
	async updateBranch(intent: UpdateBranchIntent): Promise<{ message: string | null }> {
		this.calls.push(intent);
		return { message: null };
	}
}

/** Counting fake dispatch, shaped like the follow-up coordinator's. */
function fakeDispatch(calls: { existingBranch: string; prompt: string }[] = []) {
	return async (input: {
		project: string;
		agent: string;
		prompt: string;
		maxCostUsd: number;
		existingBranch: string;
		idempotencyKey: string;
	}): Promise<{ runId: string }> => {
		calls.push({ existingBranch: input.existingBranch, prompt: input.prompt });
		return { runId: `run-${calls.length}` };
	};
}

function deps(
	updater: FakeBranchUpdater | null,
	dispatch: ReturnType<typeof fakeDispatch> | null,
): BranchFreshnessDeps {
	return {
		store,
		branchUpdater:
			updater === null
				? null
				: {
						updateBranch: (intent) => {
							// The real transport verifies the policy-bound URL.
							const expected = renderUpdateBranchIntent({
								upstreamOwner: UPSTREAM.owner,
								upstreamRepo: UPSTREAM.repo,
								prNumber: 7,
							});
							if (intent.url !== expected.url || intent.method !== expected.method) {
								console.error("INTENT MISMATCH", intent, expected);
								throw new Error("intent not policy-bound");
							}
							return updater.updateBranch(intent);
						},
					},
		dispatch,
		followUpPushEnabled: dispatch !== null,
	};
}

function baseInput(mergeableState: string | null) {
	return {
		campaignId,
		workItemId,
		pr: snapshot(mergeableState),
		issueRef: "issue://42",
		project: "openclaw",
		agent: "pi",
		maxCostUsd: 2,
		policyDigest: "policy-digest-1",
	};
}

describe("classifyBranchFreshness", () => {
	test("treats clean, unknown, and null merge states as fresh", () => {
		expect(classifyBranchFreshness(snapshot("clean"))).toBe("fresh");
		expect(classifyBranchFreshness(snapshot(null))).toBe("fresh");
		expect(classifyBranchFreshness(snapshot("blocked"))).toBe("fresh");
	});
	test("classifies behind and dirty merge states", () => {
		expect(classifyBranchFreshness(snapshot("behind"))).toBe("behind_base");
		expect(classifyBranchFreshness(snapshot("dirty"))).toBe("conflicted");
	});
});

describe("handleBranchFreshness", () => {
	test("a fresh PR does nothing at all", async () => {
		const updater = new FakeBranchUpdater();
		const dispatchCalls: { existingBranch: string; prompt: string }[] = [];
		const outcome = await handleBranchFreshness(deps(updater, fakeDispatch(dispatchCalls)), {
			...baseInput("clean"),
		});
		expect(outcome).toEqual({ status: "fresh" });
		expect(updater.calls).toHaveLength(0);
		expect(dispatchCalls).toHaveLength(0);
		expect(store.events.listOpenAttention(campaignId)).toHaveLength(0);
	});

	test("disabled updateBranch flag makes the mutation structurally impossible", async () => {
		// With no transport object in existence the PUT cannot be issued;
		// the outcome is a durable attention item and zero journaled rows.
		const dispatchCalls: { existingBranch: string; prompt: string }[] = [];
		const outcome = await handleBranchFreshness(deps(null, fakeDispatch(dispatchCalls)), {
			...baseInput("behind"),
		});
		expect(outcome.status).toBe("attention_opened");
		expect(store.actions.listActionsForWorkItem(workItemId)).toHaveLength(0);
		const attention = store.events.listOpenAttention(campaignId);
		expect(attention).toHaveLength(1);
		expect(attention[0]?.reason).toBe(BRANCH_UPDATE_POLICY_BLOCKED_REASON);
	});

	test("behind-base + clean journals the intent then calls updateBranch once", async () => {
		const updater = new FakeBranchUpdater();
		const outcome = await handleBranchFreshness(deps(updater, null), baseInput("behind"));
		expect(outcome.status).toBe("update_branch_succeeded");
		expect(updater.calls).toHaveLength(1);
		expect(updater.calls[0]?.url).toBe(
			`/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/7/update-branch`,
		);
		expect(updater.calls[0]?.body).toEqual({ update_method: "merge" });
		const action = store.actions.getActionByKey(
			branchUpdateActionKey(campaignId, snapshot("behind")),
		);
		if (action?.state !== "succeeded") console.error("ACTION", action);
		expect(action?.state).toBe("succeeded");
		expect(action?.actionType).toBe("pr_update_branch");
		// The intent was journaled planned with the digest of its request.
		expect(action?.requestDigest).not.toBeNull();
		// Idempotent: a re-tick against unchanged facts does not re-PUT.
		const again = await handleBranchFreshness(deps(updater, null), baseInput("behind"));
		expect(again.status).toBe("update_branch_already_settled");
		expect(updater.calls).toHaveLength(1);
	});

	test("conflicted dispatches a conflict-repair follow-up run, no update-branch call", async () => {
		const updater = new FakeBranchUpdater();
		const dispatchCalls: { existingBranch: string; prompt: string }[] = [];
		const outcome = await handleBranchFreshness(
			deps(updater, fakeDispatch(dispatchCalls)),
			baseInput("dirty"),
		);
		expect(outcome.status).toBe("conflict_repair_dispatched");
		if (outcome.status !== "conflict_repair_dispatched") throw new Error("unreachable");
		expect(outcome.runId).toBe("run-1");
		expect(updater.calls).toHaveLength(0);
		expect(dispatchCalls).toHaveLength(1);
		expect(dispatchCalls[0]?.existingBranch).toBe("warren/issue-42");
		expect(dispatchCalls[0]?.prompt).toContain("merge conflicts");
		const action = store.actions.getActionByKey(
			conflictRepairActionKey(campaignId, snapshot("dirty")),
		);
		expect(action?.state).toBe("executing");
		expect(action?.actionType).toBe("follow_up_run");
		// A re-tick while the repair run is active suppresses re-trigger.
		const again = await handleBranchFreshness(
			deps(updater, fakeDispatch(dispatchCalls)),
			baseInput("dirty"),
		);
		expect(again.status).toBe("conflict_repair_suppressed");
		expect(dispatchCalls).toHaveLength(1);
	});

	test("a definitively refused updateBranch settles permanent failure with attention", async () => {
		const outcome = await handleBranchFreshness(
			{
				store,
				branchUpdater: {
					updateBranch: async () => {
						throw new Error("HTTP 422 update-branch refused");
					},
				},
				dispatch: null,
				followUpPushEnabled: false,
			},
			baseInput("behind"),
		);
		expect(outcome.status).toBe("update_branch_failed");
		const action = store.actions.getActionByKey(
			branchUpdateActionKey(campaignId, snapshot("behind")),
		);
		expect(action?.state).toBe("permanent_failure");
		const attention = store.events.listOpenAttention(campaignId);
		expect(attention.some((a) => a.reason === "mutation_failed")).toBe(true);
	});

	test("a refused conflict-repair dispatch settles the journaled intent, no active run", async () => {
		const outcome = await handleBranchFreshness(
			{
				store,
				branchUpdater: null,
				dispatch: async () => {
					throw new Error("dispatch rejected");
				},
				followUpPushEnabled: true,
			},
			baseInput("dirty"),
		);
		expect(outcome.status).toBe("conflict_repair_dispatch_failed");
		const action = store.actions.getActionByKey(
			conflictRepairActionKey(campaignId, snapshot("dirty")),
		);
		expect(action?.state).toBe("permanent_failure");
		// A re-tick against the same base SHA suppresses, never auto-retries.
		const calls: { existingBranch: string; prompt: string }[] = [];
		const again = await handleBranchFreshness(
			{ store, branchUpdater: null, dispatch: fakeDispatch(calls), followUpPushEnabled: true },
			baseInput("dirty"),
		);
		expect(again.status).toBe("conflict_repair_suppressed");
		expect(calls).toHaveLength(0);
	});

	test("a pending update-branch row from an earlier tick suppresses re-trigger", async () => {
		const intent = renderUpdateBranchIntent({
			upstreamOwner: UPSTREAM.owner,
			upstreamRepo: UPSTREAM.repo,
			prNumber: 7,
		});
		const key = branchUpdateActionKey(campaignId, snapshot("behind"));
		store.actions.beginAction({
			actionKey: key,
			campaignId,
			workItemId,
			actionType: "pr_update_branch",
			requestDigest: sha256Hex(canonicalJson(intent)),
			policyDigest: "policy-digest-1",
		});
		const updater = new FakeBranchUpdater();
		const outcome = await handleBranchFreshness(deps(updater, null), baseInput("behind"));
		expect(outcome.status).toBe("update_branch_planned");
		expect(updater.calls).toHaveLength(0);
	});

	test("an ambiguous updateBranch transport failure settles uncertain, never re-sent", async () => {
		const outcome = await handleBranchFreshness(
			{
				store,
				branchUpdater: {
					updateBranch: async () => {
						throw new GithubMutationUncertainError("transport failed after send", {
							path: "/repos/openclaw/openclaw/pulls/7/update-branch",
						});
					},
				},
				dispatch: null,
				followUpPushEnabled: false,
			},
			baseInput("behind"),
		);
		expect(outcome.status).toBe("update_branch_uncertain");
		const action = store.actions.getActionByKey(
			branchUpdateActionKey(campaignId, snapshot("behind")),
		);
		expect(action?.state).toBe("uncertain");
		// A re-tick sees the frozen uncertain row and never re-sends.
		const again = await handleBranchFreshness(
			{
				store,
				branchUpdater: { updateBranch: async () => ({ message: null }) },
				dispatch: null,
				followUpPushEnabled: false,
			},
			baseInput("behind"),
		);
		expect(again).toEqual({
			status: "update_branch_already_settled",
			actionId: action?.id ?? null,
		});
	});

	test("conflicted with the followUpPush gate closed opens attention, no dispatch", async () => {
		const dispatchCalls: { existingBranch: string; prompt: string }[] = [];
		const outcome = await handleBranchFreshness(
			{
				store,
				branchUpdater: null,
				dispatch: fakeDispatch(dispatchCalls),
				followUpPushEnabled: false,
			},
			baseInput("dirty"),
		);
		expect(outcome.status).toBe("conflict_repair_gate_blocked");
		expect(dispatchCalls).toHaveLength(0);
		expect(store.actions.listActionsForWorkItem(workItemId)).toHaveLength(0);
		expect(store.events.listOpenAttention(campaignId)).toHaveLength(1);
	});
});

describe("renderConflictRepairPrompt", () => {
	test("names the branches and never carries untrusted instructions", () => {
		const prompt = renderConflictRepairPrompt({
			issueRef: "issue://42",
			headBranch: "warren/issue-42",
			baseRef: "main",
		});
		expect(prompt).toContain("warren/issue-42");
		expect(prompt).toContain("main");
		expect(prompt).toContain("Do not rebase, do not force-push");
	});
});
