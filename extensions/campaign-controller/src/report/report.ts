/**
 * Campaign terminal-accounting report (warren-7cd1, plan pl-096b step 12).
 *
 * Purely derivable from the durable store — no live GitHub read, no live
 * warren call — so it works identically on historical campaigns. Per work
 * item: issue ref, PR number, terminal outcome, total spend (initial plus
 * follow-up runs, from the reservation ledger), follow-up iteration count,
 * and open-to-terminal wall clock. Per campaign: PRs opened, merged, closed
 * unmerged, still open, total spend, and cost per merged PR.
 *
 * Spend accounting, per reservation attached to one of the work item's
 * actions: settled reservations count their settled cost, active ones count
 * the conservative reservation amount, released ones count nothing. Total
 * campaign spend sums the same rule over the whole ledger.
 */

import { WARREN_DISPATCH_ACTION_TYPE } from "../dispatch/dispatcher.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import type { WorkItemOutcome, WorkItemRow } from "../store/types.ts";

/** Terminal-accounting row for one work item. */
export interface WorkItemReportRow {
	readonly workItemId: string;
	readonly issueRef: string;
	readonly prNumber: number | null;
	readonly outcome: WorkItemOutcome | null;
	/** Total spend for this item: initial + follow-up runs (usd cents). */
	readonly totalSpendUsdCents: number;
	/** Dispatch runs beyond the first for this item. */
	readonly followUpIterations: number;
	/** Outcome stamp minus work-item creation; null while no outcome. */
	readonly openToTerminalMs: number | null;
}

/** Campaign-level terminal accounting rollup. */
export interface CampaignReport {
	readonly campaignId: string;
	readonly prsOpened: number;
	readonly prsMerged: number;
	readonly prsClosedUnmerged: number;
	readonly prsStillOpen: number;
	readonly totalSpendUsdCents: number;
	/** `totalSpend / prsMerged`, null when nothing merged yet. */
	readonly costPerMergedPrUsdCents: number | null;
	readonly items: WorkItemReportRow[];
}

/** Reservation cost under the report accounting rule. */
function reservationCost(reservation: {
	state: string;
	amountUsdCents: number;
	settledUsdCents: number | null;
}): number {
	if (reservation.state === "settled") return reservation.settledUsdCents ?? 0;
	if (reservation.state === "active") return reservation.amountUsdCents;
	return 0;
}

export function buildCampaignReport(store: CampaignStateStore, campaignId: string): CampaignReport {
	if (store.campaigns.getCampaign(campaignId) === null) {
		throw new Error(`unknown campaign: ${campaignId}`);
	}

	const { prNumbersByWorkItem, prsOpened } = prNumbersByItem(store, campaignId);

	let prsMerged = 0;
	let prsClosedUnmerged = 0;
	const items: WorkItemReportRow[] = [];
	for (const item of store.campaigns.listWorkItems(campaignId)) {
		const row = workItemRow(store, item, prNumbersByWorkItem);
		if (row.outcome === "merged") prsMerged += 1;
		if (row.outcome === "closed_unmerged") prsClosedUnmerged += 1;
		items.push(row);
	}

	let totalSpend = 0;
	for (const reservation of store.budget.listReservations(campaignId)) {
		totalSpend += reservationCost(reservation);
	}

	return {
		campaignId,
		prsOpened,
		prsMerged,
		prsClosedUnmerged,
		prsStillOpen: prsOpened - prsMerged - prsClosedUnmerged,
		totalSpendUsdCents: totalSpend,
		costPerMergedPrUsdCents: prsMerged > 0 ? Math.round(totalSpend / prsMerged) : null,
		items,
	};
}

/** PR number per work item from the campaign's PR identities, plus open count. */
function prNumbersByItem(
	store: CampaignStateStore,
	campaignId: string,
): { prNumbersByWorkItem: Map<string, number>; prsOpened: number } {
	const prNumbersByWorkItem = new Map<string, number>();
	let prsOpened = 0;
	for (const identity of store.events.listPrIdentities(campaignId)) {
		if (identity.prNumber === null) continue;
		prsOpened += 1;
		if (!prNumbersByWorkItem.has(identity.workItemId)) {
			prNumbersByWorkItem.set(identity.workItemId, identity.prNumber);
		}
	}
	return { prNumbersByWorkItem, prsOpened };
}

/** One work-item report row, derived from its row, actions, and ledger. */
function workItemRow(
	store: CampaignStateStore,
	item: WorkItemRow,
	prNumbersByWorkItem: Map<string, number>,
): WorkItemReportRow {
	const actions = store.actions.listActionsForWorkItem(item.id);
	let spend = 0;
	for (const action of actions) {
		const reservation = store.budget.getReservationByAction(action.id);
		if (reservation !== null) spend += reservationCost(reservation);
	}
	const dispatchCount = actions.filter(
		(action) => action.actionType === WARREN_DISPATCH_ACTION_TYPE,
	).length;
	return {
		workItemId: item.id,
		issueRef: item.issueRef,
		prNumber: prNumbersByWorkItem.get(item.id) ?? null,
		outcome: item.outcome,
		totalSpendUsdCents: spend,
		followUpIterations: Math.max(0, dispatchCount - 1),
		openToTerminalMs:
			item.outcomeAtMs === null ? null : Math.max(0, item.outcomeAtMs - item.createdAtMs),
	};
}
