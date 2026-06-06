/**
 * Tokens-over-time aggregation helpers (warren-d3cd / pl-d1a2 step 2).
 *
 * Builds two shapes from a flat RunMetricsRow list:
 *
 *   - Overall daily token series: one TokenDayBucket per calendar-day (UTC
 *     YYYY-MM-DD), counting all four token kinds.
 *
 *   - Per-dimension daily series (model or provider): same per-day buckets, one
 *     series per distinct key value. The response is capped at top-5 by total
 *     tokens over the window; remaining keys are folded into an OTHER_KEY series.
 *     The NONE_KEY (null model/provider) is always kept distinct from OTHER_KEY
 *     so the two can be styled / labelled differently in the UI.
 *
 * Day-bucketing uses startedAt.slice(0,10) — the same convention as the runs
 * time-series — so token series align with the existing run-count series.
 * Null startedAt → NONE_KEY so in-flight rows never produce NaN.
 * Null token columns → 0 (tokenBreakdownOf convention, warren-18f5).
 */

import {
	type DimensionTokenSeries,
	NONE_KEY,
	OTHER_KEY,
	type RunMetricsRow,
	type TokenDayBucket,
	tokenBreakdownOf,
} from "./run-metrics.ts";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

type MutableTokens = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

function mzero(): MutableTokens {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addTk(b: MutableTokens, row: RunMetricsRow): void {
	const tk = tokenBreakdownOf(row);
	b.input += tk.input;
	b.output += tk.output;
	b.cacheRead += tk.cacheRead;
	b.cacheWrite += tk.cacheWrite;
}

function finalizeTk(date: string, b: MutableTokens): TokenDayBucket {
	return { date, ...b, total: b.input + b.output + b.cacheRead + b.cacheWrite };
}

function sortByDate(a: string, b: string): number {
	if (a === NONE_KEY) return b === NONE_KEY ? 0 : 1;
	if (b === NONE_KEY) return -1;
	return a < b ? -1 : a > b ? 1 : 0;
}

function dateOf(r: RunMetricsRow): string {
	return r.startedAt?.slice(0, 10) ?? NONE_KEY;
}

function topKeysForDim(rows: readonly RunMetricsRow[], dim: "model" | "provider"): Set<string> {
	const totals = new Map<string, number>();
	for (const r of rows) {
		const k = (dim === "model" ? r.model : r.provider) ?? NONE_KEY;
		totals.set(k, (totals.get(k) ?? 0) + tokenBreakdownOf(r).total);
	}
	const top = [...totals.entries()]
		.filter(([k]) => k !== NONE_KEY)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([k]) => k);
	return new Set(top);
}

// ---------------------------------------------------------------------------
// Exported aggregators
// ---------------------------------------------------------------------------

/**
 * Overall daily token series. One bucket per calendar day (NONE_KEY for rows
 * with no startedAt), sorted chronologically with NONE_KEY last.
 */
export function buildTokenTimeSeries(rows: readonly RunMetricsRow[]): TokenDayBucket[] {
	const acc = new Map<string, MutableTokens>();
	for (const r of rows) {
		const date = dateOf(r);
		let b = acc.get(date);
		if (b === undefined) {
			b = mzero();
			acc.set(date, b);
		}
		addTk(b, r);
	}
	const out = [...acc.entries()].map(([date, b]) => finalizeTk(date, b));
	return out.sort((a, b) => sortByDate(a.date, b.date));
}

/**
 * Per-dimension daily token series (model or provider). Capped at the top-5
 * keys by total tokens; the remainder folds into OTHER_KEY. NONE_KEY (null
 * dimension value) is kept distinct. Sorted: top-5 by total desc, then
 * OTHER_KEY, then NONE_KEY.
 */
export function buildTokenDimSeries(
	rows: readonly RunMetricsRow[],
	dim: "model" | "provider",
): DimensionTokenSeries[] {
	const topKeys = topKeysForDim(rows, dim);
	const resolve = (raw: string) =>
		raw === NONE_KEY ? NONE_KEY : topKeys.has(raw) ? raw : OTHER_KEY;

	// Accumulate per resolved-key per-day
	const acc = new Map<string, Map<string, MutableTokens>>();
	for (const r of rows) {
		const key = resolve((dim === "model" ? r.model : r.provider) ?? NONE_KEY);
		const date = dateOf(r);
		let dayMap = acc.get(key);
		if (dayMap === undefined) {
			dayMap = new Map();
			acc.set(key, dayMap);
		}
		let b = dayMap.get(date);
		if (b === undefined) {
			b = mzero();
			dayMap.set(date, b);
		}
		addTk(b, r);
	}

	// Compute per-key totals for final sort order (top keys first)
	const keyTotals = new Map<string, number>();
	for (const [key, dayMap] of acc) {
		let t = 0;
		for (const b of dayMap.values()) t += b.input + b.output + b.cacheRead + b.cacheWrite;
		keyTotals.set(key, t);
	}

	const out: DimensionTokenSeries[] = [];
	for (const [key, dayMap] of acc) {
		const series = [...dayMap.entries()]
			.map(([date, b]) => finalizeTk(date, b))
			.sort((a, b) => sortByDate(a.date, b.date));
		out.push({ key, series });
	}

	// top-5 by total desc, then OTHER_KEY, then NONE_KEY
	out.sort((a, b) => {
		if (a.key === NONE_KEY) return 1;
		if (b.key === NONE_KEY) return -1;
		if (a.key === OTHER_KEY) return 1;
		if (b.key === OTHER_KEY) return -1;
		return (keyTotals.get(b.key) ?? 0) - (keyTotals.get(a.key) ?? 0);
	});
	return out;
}
