/**
 * Shared stat-summary primitives (warren-bc9c file-size split). The
 * avg/median/p95 shape and its nearest-rank percentile used by the
 * run-metrics rollup and the delivery block.
 */

/** avg/median/p95 over the non-null sample, or all-null when the sample is empty. */
export interface StatSummary {
	readonly avg: number | null;
	readonly median: number | null;
	readonly p95: number | null;
	/** number of rows that contributed a non-null value. */
	readonly count: number;
}

export function summarize(values: readonly number[]): StatSummary {
	if (values.length === 0) return { avg: null, median: null, p95: null, count: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	let sum = 0;
	for (const v of sorted) sum += v;
	return {
		avg: sum / sorted.length,
		median: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		count: sorted.length,
	};
}

/** Nearest-rank percentile over a pre-sorted (ascending) array. */
export function percentile(sorted: readonly number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const rank = Math.ceil((p / 100) * sorted.length);
	const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[idx] ?? null;
}
