/**
 * The `delivery` block on `GET /analytics/runs` (warren-bc9c) — split out of
 * `run-metrics.ts` under the file-size budget. The gaps between dispatch,
 * branch push, PR open, and merge, computed from the persisted
 * `reap.branch_pushed` / `reap.pr_opened` event timestamps and the run
 * row's `pr_merged_at` / `created_at` / `ended_at` columns.
 */

import type { RunMetricsRow } from "./run-metrics.ts";
import { type StatSummary, summarize } from "./stat-summary.ts";

export interface RunDeliveryMetrics {
	/** `reap.pr_opened` ts − `reap.branch_pushed` ts. */
	readonly branchPushToPrOpenMs: StatSummary;
	/** `runs.pr_merged_at` − `reap.pr_opened` ts. */
	readonly prOpenToMergeMs: StatSummary;
	/** `runs.pr_merged_at` − `runs.created_at` (epoch ms). */
	readonly dispatchToMergeMs: StatSummary;
	/** `runs.pr_merged_at` − `runs.ended_at`. */
	readonly endToMergeMs: StatSummary;
}

/** Parse an ISO8601 timestamp to epoch ms, or null when absent/unparseable. */
function epochMs(ts: string | null): number | null {
	if (ts === null) return null;
	const ms = Date.parse(ts);
	return Number.isNaN(ms) ? null : ms;
}

/** `end - start` in ms, or null unless both instants are present + valid. */
function deltaMsOf(end: string | null, start: string | null): number | null {
	const endMs = epochMs(end);
	const startMs = epochMs(start);
	if (endMs === null || startMs === null) return null;
	const delta = endMs - startMs;
	return delta < 0 ? null : delta;
}

/**
 * One pass over the rows; each gap samples only the rows where both of
 * its endpoints are known — null endpoints are excluded, never zero.
 */
export function computeDelivery(rows: readonly RunMetricsRow[]): RunDeliveryMetrics {
	const pushToPrOpen: number[] = [];
	const prOpenToMerge: number[] = [];
	const dispatchToMerge: number[] = [];
	const endToMerge: number[] = [];
	for (const r of rows) {
		const a = deltaMsOf(r.prOpenedAt, r.branchPushedAt);
		if (a !== null) pushToPrOpen.push(a);
		const b = deltaMsOf(r.prMergedAt, r.prOpenedAt);
		if (b !== null) prOpenToMerge.push(b);
		if (r.prMergedAt !== null && r.createdAt !== null) {
			const d = deltaMsOf(r.prMergedAt, new Date(r.createdAt).toISOString());
			if (d !== null) dispatchToMerge.push(d);
		}
		const e = deltaMsOf(r.prMergedAt, r.endedAt);
		if (e !== null) endToMerge.push(e);
	}
	return {
		branchPushToPrOpenMs: summarize(pushToPrOpen),
		prOpenToMergeMs: summarize(prOpenToMerge),
		dispatchToMergeMs: summarize(dispatchToMerge),
		endToMergeMs: summarize(endToMerge),
	};
}
