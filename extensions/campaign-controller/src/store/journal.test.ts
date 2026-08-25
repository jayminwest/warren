import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { StateError } from "../errors.ts";
import { CampaignStateStore } from "./state-store.ts";

const clock = new FixedClock(1_000_000);

let dir: string;
let store: CampaignStateStore;
let campaignId: string;
let workItemId: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "campaign-journal-"));
	store = new CampaignStateStore(join(dir, "state.db"), {
		clock,
		ids: new SequentialIdGenerator(),
	});
	const campaign = store.campaigns.createCampaign({
		manifestDigest: "digest-journal",
		manifestJson: "{}",
		budgetCapUsdCents: 100_00,
	});
	campaignId = campaign.id;
	workItemId = store.campaigns.addWorkItem({
		campaignId,
		position: 1,
		issueRef: "issue://1",
	}).id;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function actionIdByKey(key: string): string {
	const action = store.actions.getActionByKey(key);
	if (action === null) throw new Error(`missing action under key ${key}`);
	return action.id;
}

function beginDispatch(key = "warren:dispatch:digest-journal:1") {
	return store.actions.beginAction({
		actionKey: key,
		campaignId,
		workItemId,
		actionType: "warren_dispatch",
		requestDigest: "request-digest-1",
	});
}

describe("action journal", () => {
	test("persists a planned intent before any caller I/O", () => {
		const action = beginDispatch();
		expect(action.state).toBe("planned");
		expect(action.attempt).toBe(1);
		expect(action.startedAtMs).toBeNull();
		expect(action.createdAtMs).toBe(clock.nowMs());
	});

	test("replaying the same deterministic action key is idempotent", () => {
		const first = beginDispatch();
		const replayed = beginDispatch();
		expect(replayed.id).toBe(first.id);
		expect(store.actions.listActionsForWorkItem(workItemId)).toHaveLength(1);
	});

	test("the same key with a different request digest fails closed", () => {
		beginDispatch();
		expect(() =>
			store.actions.beginAction({
				actionKey: "warren:dispatch:digest-journal:1",
				campaignId,
				workItemId,
				actionType: "warren_dispatch",
				requestDigest: "request-digest-OTHER",
			}),
		).toThrow(StateError);
	});

	test("one active attempt per campaign work item", () => {
		beginDispatch();
		expect(() =>
			store.actions.beginAction({
				actionKey: "warren:dispatch:digest-journal:1:retry",
				campaignId,
				workItemId,
				actionType: "warren_dispatch",
				requestDigest: "request-digest-1",
			}),
		).toThrow(/active attempt/);

		store.actions.markExecuting(actionIdByKey("warren:dispatch:digest-journal:1"));
		expect(() =>
			store.actions.beginAction({
				actionKey: "warren:dispatch:digest-journal:1:retry2",
				campaignId,
				workItemId,
				actionType: "warren_dispatch",
				requestDigest: "request-digest-1",
			}),
		).toThrow(/active attempt/);

		// After a terminal settlement a new attempt may begin.
		store.actions.settleAction(actionIdByKey("warren:dispatch:digest-journal:1"), {
			state: "retryable_failure",
			errorClass: "timeout",
		});
		const retry = store.actions.beginAction({
			actionKey: "warren:dispatch:digest-journal:1:retry3",
			campaignId,
			workItemId,
			actionType: "warren_dispatch",
			requestDigest: "request-digest-1",
			attempt: 2,
		});
		expect(retry.state).toBe("planned");
	});

	test("planned → executing → succeeded records results and freezes the row", () => {
		const planned = beginDispatch();
		const executing = store.actions.markExecuting(planned.id);
		expect(executing.state).toBe("executing");
		expect(executing.startedAtMs).toBe(clock.nowMs());
		const succeeded = store.actions.settleAction(planned.id, {
			state: "succeeded",
			resultRunId: "run_123",
			resultBranch: "warren/run_123",
		});
		expect(succeeded.state).toBe("succeeded");
		expect(succeeded.resultRunId).toBe("run_123");
		expect(succeeded.settledAtMs).toBe(clock.nowMs());
		expect(() => store.actions.markExecuting(planned.id)).toThrow(StateError);
		expect(() => store.actions.settleAction(planned.id, { state: "uncertain" })).toThrow(
			/already settled/,
		);
	});

	test("a lost response settles planned → uncertain without observing execution", () => {
		const planned = beginDispatch();
		const settled = store.actions.settleAction(planned.id, {
			state: "uncertain",
			errorClass: "ambiguous_response",
		});
		expect(settled.state).toBe("uncertain");
		expect(settled.errorClass).toBe("ambiguous_response");
		expect(settled.startedAtMs).toBe(clock.nowMs());
	});

	test("listUnfinishedActions exposes the restart-reconciliation set", () => {
		const a = beginDispatch();
		const other = store.actions.beginAction({
			actionKey: "pr:intent:digest-journal:1",
			campaignId,
			actionType: "pr_intent",
			requestDigest: "pr-request-1",
		});
		store.actions.settleAction(other.id, { state: "succeeded" });
		const unfinished = store.actions.listUnfinishedActions();
		expect(unfinished.map((action) => action.id)).toEqual([a.id]);
	});
});

describe("budget ledger", () => {
	test("reserves against the cap and fails closed when it does not fit", () => {
		const reservation = store.budget.reserve({
			campaignId,
			amountUsdCents: 60_00,
		});
		expect(reservation.state).toBe("active");
		expect(store.budget.availableUsdCents(campaignId)).toBe(40_00);

		expect(() => store.budget.reserve({ campaignId, amountUsdCents: 41_00 })).toThrow(
			/insufficient campaign budget/,
		);
		// A fitting second reservation still succeeds.
		store.budget.reserve({ campaignId, amountUsdCents: 40_00 });
		expect(store.budget.availableUsdCents(campaignId)).toBe(0);
	});

	test("settlement replaces the reservation with actual spend", () => {
		const reservation = store.budget.reserve({ campaignId, amountUsdCents: 50_00 });
		const settled = store.budget.settleReservation(reservation.id, 30_00);
		expect(settled.state).toBe("settled");
		expect(settled.settledUsdCents).toBe(30_00);
		expect(store.budget.availableUsdCents(campaignId)).toBe(70_00);
		expect(() => store.budget.settleReservation(reservation.id, 10_00)).toThrow(
			/only active reservations settle/,
		);
	});

	test("releasing a reservation the action never spent frees the ledger", () => {
		const reservation = store.budget.reserve({ campaignId, amountUsdCents: 50_00 });
		const released = store.budget.releaseReservation(reservation.id);
		expect(released.state).toBe("released");
		expect(store.budget.availableUsdCents(campaignId)).toBe(100_00);
	});

	test("a campaign without a cap refuses reservations", () => {
		const uncapped = store.campaigns.createCampaign({
			manifestDigest: "digest-uncapped",
			manifestJson: "{}",
		});
		expect(() => store.budget.reserve({ campaignId: uncapped.id, amountUsdCents: 1 })).toThrow(
			/no budget cap/,
		);
	});
});

describe("campaign and work-item invariants", () => {
	test("a manifest digest can be stored only once", () => {
		expect(() =>
			store.campaigns.createCampaign({ manifestDigest: "digest-journal", manifestJson: "{}" }),
		).toThrow(StateError);
	});

	test("a work-item position is unique inside its campaign", () => {
		store.campaigns.addWorkItem({ campaignId, position: 2, issueRef: "issue://2" });
		expect(() =>
			store.campaigns.addWorkItem({ campaignId, position: 2, issueRef: "issue://2b" }),
		).toThrow(StateError);
		expect(store.campaigns.listWorkItems(campaignId)).toHaveLength(2);
	});

	test("approval stamps the immutable manifest without rebinding it", () => {
		const campaign = store.campaigns.getCampaign(campaignId);
		expect(campaign?.approvedAtMs).toBeNull();
		const approved = store.campaigns.approveCampaign(campaignId);
		expect(approved.approvedAtMs).toBe(clock.nowMs());
		expect(approved.manifestDigest).toBe("digest-journal");
	});
});
