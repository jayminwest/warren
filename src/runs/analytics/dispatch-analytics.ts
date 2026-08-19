/**
 * Dispatch-context analytics aggregator (warren-5423 / pl-a37b Track A step 5).
 *
 * Pure, dialect-agnostic companion to `run-metrics.ts` / `cost-analytics.ts`.
 * Takes the joined `dispatch_context × runs` rows from
 * `DispatchContextRepo.listForAnalytics` and emits the descriptive report
 * `GET /analytics/dispatch` serves:
 *
 *   - `totals.dispatches` — row count in the window
 *   - `byDispatchOrigin` / `byRetryKind` / `byProviderModel` / `byQueueDepth`
 *     — count buckets only
 *   - `rows` — each dispatch joined to its run outcome
 *
 * Facts and counts only. No scores, no recommendations (agent-analytics
 * §6.1: interpretation is extension-tier). Null dimension values group
 * under {@link NONE_KEY}, never a silent bucket rename.
 */

import type { DispatchContextAnalyticsRow } from "../../db/repos/dispatch-context.ts";

/** Sentinel for a null group key (no origin, no retry kind, etc.). */
export const NONE_KEY = "__none__";

/**
 * One joined dispatch-context + run-outcome row. Re-export of the repo
 * select shape so consumers import from the pure aggregator module.
 */
export type DispatchAnalyticsRow = DispatchContextAnalyticsRow;

/** Count-only bucket used by every breakdown on this report. */
export interface DispatchCountBucket {
	readonly key: string;
	readonly count: number;
}

/** The pure rollup `GET /analytics/dispatch` wraps in a `filter` echo. */
export interface DispatchAnalytics {
	readonly totals: { readonly dispatches: number };
	readonly byDispatchOrigin: readonly DispatchCountBucket[];
	readonly byRetryKind: readonly DispatchCountBucket[];
	readonly byProviderModel: readonly DispatchCountBucket[];
	readonly byQueueDepth: readonly DispatchCountBucket[];
	readonly rows: readonly DispatchAnalyticsRow[];
}

/**
 * Build the dispatch-context report from joined rows. O(rows) — one pass
 * per dimension. Deterministic: each breakdown sorts by count desc, then
 * key ascending so golden/unit tests are stable.
 */
export function buildDispatchAnalytics(rows: readonly DispatchAnalyticsRow[]): DispatchAnalytics {
	return {
		totals: { dispatches: rows.length },
		byDispatchOrigin: countBy(rows, (r) => r.dispatchOrigin),
		byRetryKind: countBy(rows, (r) => r.retryKind),
		byProviderModel: countBy(rows, providerModelKey),
		byQueueDepth: countBy(rows, queueDepthKey),
		rows,
	};
}

function providerModelKey(r: DispatchAnalyticsRow): string | null {
	if (r.provider === null && r.model === null) return null;
	return `${r.provider ?? NONE_KEY}/${r.model ?? NONE_KEY}`;
}

/**
 * Instance-wide queue depth at the dispatch instant: queued + running.
 * Null when either arm is unknown so a partial snapshot never becomes
 * a synthetic zero.
 */
function queueDepthKey(r: DispatchAnalyticsRow): string | null {
	if (r.queueQueuedRuns === null || r.queueRunningRuns === null) return null;
	return String(r.queueQueuedRuns + r.queueRunningRuns);
}

function countBy(
	rows: readonly DispatchAnalyticsRow[],
	keyOf: (r: DispatchAnalyticsRow) => string | null,
): readonly DispatchCountBucket[] {
	const acc = new Map<string, number>();
	for (const r of rows) {
		const key = keyOf(r) ?? NONE_KEY;
		acc.set(key, (acc.get(key) ?? 0) + 1);
	}
	const out: DispatchCountBucket[] = [];
	for (const [key, count] of acc) {
		out.push({ key, count });
	}
	out.sort((a, b) => {
		if (b.count !== a.count) return b.count - a.count;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
	return out;
}
