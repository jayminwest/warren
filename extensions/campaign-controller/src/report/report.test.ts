/**
 * Campaign report derivation over a seeded multi-item history
 * (warren-7cd1 acceptance).
 *
 * The store is seeded with two items that opened PRs (one merged, one closed
 * unmerged) and one still-open item, with a reservation ledger covering an
 * initial run plus a follow-up run. The report is derived purely from the
 * store, so reopening the same database after a restart produces the same
 * numbers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import { buildCampaignReport } from "./report.ts";

const NOW = Date.parse("2026-08-25T00:00:00Z");

describe("buildCampaignReport", () => {
	let store: CampaignStateStore;
	let clock: FixedClock;
	let campaignId: string;
	let mergedItemId: string;
	let closedItemId: string;
	let openItemId: string;
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		clock = new FixedClock(NOW);
		dir = mkdtempSync(join(tmpdir(), "campaign-report-"));
		dbPath = join(dir, "state.db");
		store = new CampaignStateStore(dbPath, {
			clock,
			ids: new SequentialIdGenerator(),
		});
		const campaign = store.campaigns.createCampaign({
			manifestDigest: "digest-report",
			manifestJson: "{}",
			budgetCapUsdCents: 100_00,
		});
		campaignId = campaign.id;

		mergedItemId = seedItem(campaign.id, 1, "issue://1", "warren/issue-1", 101);
		closedItemId = seedItem(campaign.id, 2, "issue://2", "warren/issue-2", 102);
		openItemId = seedItem(campaign.id, 3, "issue://3", "warren/issue-3", 103);

		// Merged item: initial run (settled 500c) + one follow-up (settled 300c).
		spendForItem(mergedItemId, "warren:dispatch:1", 500);
		spendForItem(mergedItemId, "warren:dispatch:1-followup", 300);
		// Closed item: initial run only (settled 250c).
		spendForItem(closedItemId, "warren:dispatch:2", 250);

		clock.advance(60_000);
		store.campaigns.recordWorkItemOutcome(mergedItemId, "merged");
		store.campaigns.recordWorkItemOutcome(closedItemId, "closed_unmerged");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function seedItem(
		campaign: string,
		position: number,
		issueRef: string,
		headBranch: string,
		prNumber: number | null,
	): string {
		const item = store.campaigns.addWorkItem({
			campaignId: campaign,
			position,
			issueRef,
		});
		store.events.recordPrIdentity({
			campaignId: campaign,
			workItemId: item.id,
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			forkOwner: "warren-run-bot",
			forkRepo: "openclaw",
			headBranch,
			prNumber,
		});
		return item.id;
	}

	function spendForItem(workItemId: string, actionKey: string, settledUsdCents: number): void {
		const action = store.actions.beginAction({
			actionKey,
			campaignId,
			workItemId,
			actionType: "warren_dispatch",
			requestDigest: `req-${actionKey}`,
		});
		const reservation = store.budget.reserve({
			campaignId,
			amountUsdCents: settledUsdCents,
		});
		store.budget.attachReservation(reservation.id, action.id);
		store.budget.settleReservation(reservation.id, settledUsdCents);
		store.actions.settleAction(action.id, { state: "succeeded" });
	}

	test("derives per-item and campaign totals from a seeded multi-item history", () => {
		const report = buildCampaignReport(store, campaignId);
		expect(report.prsOpened).toBe(3);
		expect(report.prsMerged).toBe(1);
		expect(report.prsClosedUnmerged).toBe(1);
		expect(report.prsStillOpen).toBe(1);
		expect(report.totalSpendUsdCents).toBe(1050);
		expect(report.costPerMergedPrUsdCents).toBe(1050);

		const [merged, closed, open] = report.items;
		expect(merged?.issueRef).toBe("issue://1");
		expect(merged?.prNumber).toBe(101);
		expect(merged?.outcome).toBe("merged");
		expect(merged?.totalSpendUsdCents).toBe(800);
		expect(merged?.followUpIterations).toBe(1);
		expect(merged?.openToTerminalMs).toBe(60_000);
		expect(closed?.outcome).toBe("closed_unmerged");
		expect(closed?.totalSpendUsdCents).toBe(250);
		expect(closed?.followUpIterations).toBe(0);
		expect(open?.outcome).toBeNull();
		expect(open?.openToTerminalMs).toBeNull();
		expect(open?.prNumber).toBe(103);
	});

	test("cost per merged PR is null while nothing has merged", () => {
		store.campaigns.recordWorkItemOutcome(mergedItemId, "merged");
		const fresh = new CampaignStateStore(":memory:", {
			clock,
			ids: new SequentialIdGenerator(),
		});
		const campaign = fresh.campaigns.createCampaign({
			manifestDigest: "digest-empty",
			manifestJson: "{}",
			budgetCapUsdCents: 100_00,
		});
		fresh.campaigns.addWorkItem({
			campaignId: campaign.id,
			position: 1,
			issueRef: "issue://x",
		});
		const report = buildCampaignReport(fresh, campaign.id);
		expect(report.prsMerged).toBe(0);
		expect(report.costPerMergedPrUsdCents).toBeNull();
	});

	test("active reservations count their full amount and released ones count nothing", () => {
		const action = store.actions.beginAction({
			actionKey: "warren:dispatch:3",
			campaignId,
			workItemId: openItemId,
			actionType: "warren_dispatch",
			requestDigest: "req-3",
		});
		const reserved = store.budget.reserve({ campaignId, amountUsdCents: 400 });
		store.budget.attachReservation(reserved.id, action.id);
		const released = store.budget.reserve({ campaignId, amountUsdCents: 100 });
		store.budget.releaseReservation(released.id);
		const report = buildCampaignReport(store, campaignId);
		expect(report.totalSpendUsdCents).toBe(1450);
	});

	test("reopening the same database derives the same report", () => {
		const before = buildCampaignReport(store, campaignId);
		store.close();
		const reopened = new CampaignStateStore(dbPath, { clock, ids: new SequentialIdGenerator() });
		expect(buildCampaignReport(reopened, campaignId)).toEqual(before);
		reopened.close();
	});
});
