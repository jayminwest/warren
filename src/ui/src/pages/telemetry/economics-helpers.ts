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

/** Human label for a UTC date key (`2026-09-03` → `Sep 3`, sentinel → text). */
export function dateBucketLabel(key: string): string {
	if (key === COST_ANALYTICS_NONE_KEY) return "No date";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
	const d = new Date(`${key}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return key;
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

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
