import { COST_ANALYTICS_NONE_KEY, type CostBucket } from "../../api/client.ts";
import type { TokenBreakdown } from "../../api/types.ts";

/**
 * Derivation helpers for the telemetry economics tab (warren-cc6c).
 * Pure functions, unit-tested in economics-helpers.test.ts — the panels
 * stay presentational.
 */

/** Buckets sorted by spend, most expensive first. */
export function sortBucketsDesc(buckets: readonly CostBucket[]): CostBucket[] {
	return [...buckets].sort((a, b) => b.costUsd - a.costUsd);
}

/** The `n` most expensive buckets in descending order. */
export function topCostBuckets(buckets: readonly CostBucket[], n: number): CostBucket[] {
	return sortBucketsDesc(buckets).slice(0, n);
}

/**
 * Spend-over-time series: date buckets ordered oldest → newest so the
 * meter rows read left-to-right chronologically top-to-bottom.
 */
export function dateSpendSeries(buckets: readonly CostBucket[]): CostBucket[] {
	return [...buckets].sort((a, b) => a.key.localeCompare(b.key));
}

/** Human label for a date key (`2026-09-03` → `09-03`, sentinel → text). */
export function dateBucketLabel(key: string): string {
	if (key === COST_ANALYTICS_NONE_KEY) return "(unattributed)";
	const m = /^\d{4}-(\d{2}-\d{2})$/.exec(key);
	return m?.[1] ?? key;
}

/** Meter-row fill ramp shared with the economics side panels. */
export const ECONOMICS_FILL_RAMP = [
	"opacity-80",
	"opacity-60",
	"opacity-50",
	"opacity-45",
] as const;

/**
 * Cache-hit share: cacheRead / (input + cacheRead). Null when the
 * breakdown is absent (spectator-redacted body) or the denominator is
 * zero — no prompt tokens to hit against.
 */
export function cacheHitShare(totals: TokenBreakdown | undefined): number | null {
	if (totals === undefined) return null;
	const denominator = totals.input + totals.cacheRead;
	if (denominator <= 0) return null;
	return totals.cacheRead / denominator;
}
