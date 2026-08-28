import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import {
	DEFAULT_MAX_FOLLOW_UPS_PER_PR,
	FOLLOW_UP_ACTION_TYPE,
	FOLLOW_UP_STOPPED_REASON,
	FollowUpCoordinator,
	type FollowUpDispatchFn,
	type FollowUpPolicy,
	type FollowUpStoreDeps,
	type FollowUpWorkItemContext,
	renderFollowUpPrompt,
} from "./coordinator.ts";

const clock = new FixedClock(1_000_000);

let dir: string;
let store: CampaignStateStore;
let deps: FollowUpStoreDeps;
let campaignId: string;
let workItemId: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "follow-up-coordinator-"));
	store = new CampaignStateStore(join(dir, "state.db"), {
		clock,
		ids: new SequentialIdGenerator(),
	});
	const campaign = store.campaigns.createCampaign({
		manifestDigest: "digest-follow-up",
		manifestJson: "{}",
		budgetCapUsdCents: 100_00,
	});
	campaignId = campaign.id;
	workItemId = store.campaigns.addWorkItem({
		campaignId,
		position: 1,
		issueRef: "issue://42",
	}).id;
	deps = {
		listFeedback: (cid) => store.events.listFeedback(cid),
		listActionsForWorkItem: (wid) => store.actions.listActionsForWorkItem(wid),
		beginAction: (input) => store.actions.beginAction(input),
		markExecuting: (id) => store.actions.markExecuting(id),
		settleAction: (id, input) => store.actions.settleAction(id, input),
		addAttention: (input) => store.events.addAttention(input),
		followUps: store.followUps,
	};
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<FollowUpWorkItemContext> = {}): FollowUpWorkItemContext {
	return {
		campaignId,
		workItemId,
		issueRef: "issue://42",
		project: "openclaw",
		agent: "pi",
		headBranch: "warren/issue-42",
		maxCostUsd: 2,
		budgetHeadroomUsdCents: 100_00,
		...overrides,
	};
}

function policy(overrides: Partial<FollowUpPolicy> = {}): FollowUpPolicy {
	return { followUpPush: true, ...overrides };
}

function fakeDispatch(
	calls: { prompt: string; existingBranch: string }[] = [],
): FollowUpDispatchFn {
	return async (input) => {
		calls.push({ prompt: input.prompt, existingBranch: input.existingBranch });
		return { runId: `run-${calls.length}` };
	};
}

let findingSeq = 0;
function addFinding(category: string, fields: Record<string, unknown> = {}): string {
	findingSeq += 1;
	const id = `FB_${findingSeq}`;
	store.events.addFeedbackOnce({
		id,
		campaignId,
		workItemId,
		category,
		sourceEventNodeId: `EV_${findingSeq}`,
		fieldsJson: JSON.stringify(fields),
	});
	return id;
}

describe("FollowUpCoordinator", () => {
	test("disabled followUpPush flag is structurally impossible", async () => {
		const calls: unknown[] = [];
		const coordinator = new FollowUpCoordinator({
			store: deps,
			dispatch: async (i) => {
				calls.push(i);
				return { runId: "x" };
			},
		});
		await expect(coordinator.coordinate(ctx(), policy({ followUpPush: false }))).rejects.toThrow(
			"structurally impossible",
		);
		expect(calls).toHaveLength(0);
	});

	test("no actionable feedback dispatches nothing", async () => {
		const calls: { prompt: string; existingBranch: string }[] = [];
		const coordinator = new FollowUpCoordinator({ store: deps, dispatch: fakeDispatch(calls) });
		const outcome = await coordinator.coordinate(ctx(), policy());
		expect(outcome.status).toBe("no_actionable_feedback");
		expect(calls).toHaveLength(0);
	});

	test("findings dispatch exactly one journaled follow-up run on the existing branch", async () => {
		addFinding("needs_test", { file: "a.ts" });
		addFinding("nitpick", { file: "b.ts" });
		const calls: { prompt: string; existingBranch: string }[] = [];
		const coordinator = new FollowUpCoordinator({ store: deps, dispatch: fakeDispatch(calls) });
		const outcome = await coordinator.coordinate(ctx(), policy());
		expect(outcome.status).toBe("dispatched");
		if (outcome.status !== "dispatched") throw new Error("unreachable");
		expect(outcome.runId).toBe("run-1");
		expect(outcome.iteration).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.existingBranch).toBe("warren/issue-42");
		expect(calls[0]?.prompt).toContain("UNTRUSTED DATA");
		// The intent is journaled executing with the reserved budget.
		const action = store.actions.getAction(outcome.actionId as string);
		expect(action?.state).toBe("executing");
		expect(action?.actionType).toBe(FOLLOW_UP_ACTION_TYPE);
		// A re-tick while the run is active resumes, never duplicates.
		const again = await coordinator.coordinate(ctx(), policy());
		expect(again.status).toBe("already_active");
		expect(calls).toHaveLength(1);
	});

	test("iteration cap opens attention instead of dispatching", async () => {
		for (let i = 0; i < DEFAULT_MAX_FOLLOW_UPS_PER_PR; i += 1) {
			const action = deps.beginAction({
				actionKey: `seed-${i}`,
				campaignId,
				workItemId,
				actionType: FOLLOW_UP_ACTION_TYPE,
				requestDigest: `digest-${i}`,
			});
			deps.followUps.recordStarted({
				campaignId,
				workItemId,
				actionId: action.id,
				headBranch: "warren/issue-42",
				runId: null,
			});
			deps.followUps.recordResponded({ workItemId, feedbackIds: [], fingerprint: `fp-${i}` });
			deps.settleAction(action.id, { state: "succeeded" });
			deps.followUps.clearActive(workItemId);
		}
		addFinding("needs_test");
		const calls: { prompt: string; existingBranch: string }[] = [];
		const coordinator = new FollowUpCoordinator({ store: deps, dispatch: fakeDispatch(calls) });
		const outcome = await coordinator.coordinate(ctx(), policy());
		expect(outcome.status).toBe("cap_blocked");
		expect(calls).toHaveLength(0);
		const attention = store.events.listOpenAttention(campaignId);
		expect(attention.some((a) => a.reason === FOLLOW_UP_STOPPED_REASON)).toBe(true);
	});

	test("budget shortfall refuses closed", async () => {
		addFinding("needs_test");
		const coordinator = new FollowUpCoordinator({
			store: deps,
			dispatch: fakeDispatch(),
		});
		await expect(
			coordinator.coordinate(ctx({ budgetHeadroomUsdCents: 1 }), policy()),
		).rejects.toThrow("follow-up run needs");
	});

	test("missing head branch refuses closed", async () => {
		addFinding("needs_test");
		const coordinator = new FollowUpCoordinator({
			store: deps,
			dispatch: fakeDispatch(),
		});
		await expect(coordinator.coordinate(ctx({ headBranch: null }), policy())).rejects.toThrow(
			"no open-PR head branch",
		);
	});

	test("a refused dispatch settles permanent failure and clears the active slot", async () => {
		addFinding("needs_test");
		const coordinator = new FollowUpCoordinator({
			store: deps,
			dispatch: async () => {
				throw new Error("dispatch rejected");
			},
		});
		const outcome = await coordinator.coordinate(ctx(), policy());
		expect(outcome.status).toBe("dispatch_failed");
		const action = store.actions.getAction(outcome.actionId as string);
		expect(action?.state).toBe("permanent_failure");
		// The active slot is cleared: the stop is journaled, not left open.
		expect(deps.followUps.getProgress(workItemId)?.activeActionId).toBeNull();
	});

	test("reconcilePushedFollowUp settles the run and marks the feedback addressed", async () => {
		addFinding("needs_test", { file: "a.ts" });
		const coordinator = new FollowUpCoordinator({ store: deps, dispatch: fakeDispatch() });
		const outcome = await coordinator.coordinate(ctx(), policy());
		expect(outcome.status).toBe("dispatched");
		const settled = coordinator.reconcilePushedFollowUp({
			workItemId,
			pushedBranch: "warren/issue-42",
		});
		expect(settled?.iteration).toBe(1);
		const progress = deps.followUps.getProgress(workItemId);
		expect(progress?.activeActionId).toBeNull();
		expect(progress?.addressedFeedbackIds).toContain(outcome.feedbackIds[0]);
		// A push to a different branch reconciles nothing.
		expect(coordinator.reconcilePushedFollowUp({ workItemId, pushedBranch: "other" })).toBeNull();
	});
});

describe("renderFollowUpPrompt", () => {
	test("frames findings as untrusted data with the branch to extend", () => {
		const prompt = renderFollowUpPrompt({
			kind: "follow_up_run",
			issueRef: "issue://42",
			headBranch: "warren/issue-42",
			agentGuidance: null,
			instruction: "Extend the existing branch.",
			untrustedFindings: [{ feedbackId: "f1", category: "nit", fields: { file: "a.ts" } }],
		});
		expect(prompt).toContain("warren/issue-42");
		expect(prompt).toContain("UNTRUSTED DATA");
		expect(prompt).toContain("[nit] (f1)");
	});
});
