/**
 * Run-level analytics aggregator (warren-368e / pl-ad0f step 1).
 *
 * Pure, dialect-agnostic companion to `src/runs/cost-analytics.ts`. Takes a
 * flat list of "run metric rows" — one per `runs` row, carrying the columns
 * the dashboard needs plus a `provider` / `model` pair already extracted from
 * `renderedAgentJson.frontmatter` — and emits the KPIs + breakdowns the
 * `GET /analytics/runs` endpoint (step 2) serves:
 *
 *   - `totals`: run count, terminal-state counts, success rate, duration
 *     percentiles (avg/median/p95), context-token + cost summaries
 *   - `timeSeries`: one bucket per calendar day (UTC `YYYY-MM-DD`), with
 *     per-state run counts and total context tokens, sorted chronologically
 *   - `byAgent` / `byModel` / `byProvider`: per-group rollups
 *   - `byFailureReason`: failed-run counts grouped by `failureReason`
 *   - `topSeedsByContext`: seed-originated runs ranked by total context tokens
 *
 * Context tokens = `tokensInput + tokensCacheRead` (the bytes an agent re-reads
 * each turn — the "how much context did this burn" question the cost view can't
 * answer). Per pl-ad0f risk #3, token/cost columns are best-effort and null for
 * agents that emit neither pi `turn_end` nor claude-code `result`; null rows are
 * excluded from averages rather than counted as zero. Per risk #4, `seedId` is
 * null for ad-hoc runs, so `topSeedsByContext` excludes nulls — it covers
 * seed-originated runs only.
 *
 * Determinism: time-series is sorted by date ascending (NONE_KEY last); every
 * other breakdown is sorted by its primary metric descending with ties broken
 * by run count then key ascending, so golden/unit tests are stable.
 */

import type { RunFailureReason, RunState } from "../../db/schema.ts";

/** Sentinel for a null group key (no startedAt, no failureReason, etc.). */
export const NONE_KEY = "__none__";

export interface RunMetricsRow {
	readonly runId: string;
	readonly projectId: string | null;
	readonly agentName: string;
	readonly provider: string | null;
	readonly model: string | null;
	readonly seedId: string | null;
	readonly state: RunState;
	readonly failureReason: RunFailureReason | null;
	readonly costUsd: number | null;
	readonly tokensInput: number | null;
	readonly tokensCacheRead: number | null;
	readonly tokensOutput: number | null;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
}

/** avg/median/p95 over the non-null sample, or all-null when the sample is empty. */
export interface StatSummary {
	readonly avg: number | null;
	readonly median: number | null;
	readonly p95: number | null;
	/** number of rows that contributed a non-null value. */
	readonly count: number;
}

export interface RunTotals {
	readonly runs: number;
	readonly succeeded: number;
	readonly failed: number;
	readonly cancelled: number;
	/** queued + running + paused — non-terminal at query time. */
	readonly active: number;
	/** succeeded / (succeeded + failed + cancelled), or null when no terminal runs. */
	readonly successRate: number | null;
	readonly durationMs: StatSummary;
	readonly contextTokens: StatSummary;
	readonly cost: {
		readonly total: number;
		readonly avg: number | null;
		/** rows whose costUsd was non-null. */
		readonly priced: number;
	};
}

export interface RunDayBucket {
	readonly key: string;
	readonly runs: number;
	readonly succeeded: number;
	readonly failed: number;
	readonly cancelled: number;
	readonly active: number;
	readonly contextTokensTotal: number;
}

export interface RunGroupBucket {
	readonly key: string;
	readonly runs: number;
	readonly succeeded: number;
	readonly failed: number;
	readonly successRate: number | null;
	readonly contextTokensTotal: number;
	readonly avgContextTokens: number | null;
	readonly costUsd: number;
	readonly priced: number;
	readonly avgDurationMs: number | null;
}

export interface FailureBucket {
	readonly key: string;
	readonly runs: number;
}

export interface SeedContextBucket {
	readonly seedId: string;
	readonly runs: number;
	readonly contextTokensTotal: number;
	readonly avgContextTokens: number | null;
}

export interface RunMetrics {
	readonly totals: RunTotals;
	readonly timeSeries: readonly RunDayBucket[];
	readonly byAgent: readonly RunGroupBucket[];
	readonly byModel: readonly RunGroupBucket[];
	readonly byProvider: readonly RunGroupBucket[];
	readonly byFailureReason: readonly FailureBucket[];
	readonly topSeedsByContext: readonly SeedContextBucket[];
}

export type GroupDimension = "agent" | "model" | "provider";

/**
 * Context tokens for a row: `tokensInput + tokensCacheRead`. Returns null when
 * BOTH inputs are null (no token data at all) so the value is excluded from
 * averages; when at least one is present the missing half counts as 0.
 */
export function contextTokensOf(row: RunMetricsRow): number | null {
	if (row.tokensInput === null && row.tokensCacheRead === null) return null;
	return (row.tokensInput ?? 0) + (row.tokensCacheRead ?? 0);
}

/** Duration in milliseconds, or null unless both timestamps are present + valid. */
export function durationMsOf(row: RunMetricsRow): number | null {
	if (row.startedAt === null || row.endedAt === null) return null;
	const start = Date.parse(row.startedAt);
	const end = Date.parse(row.endedAt);
	if (Number.isNaN(start) || Number.isNaN(end)) return null;
	const delta = end - start;
	return delta < 0 ? null : delta;
}

function summarize(values: readonly number[]): StatSummary {
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
function percentile(sorted: readonly number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const rank = Math.ceil((p / 100) * sorted.length);
	const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[idx] ?? null;
}

function computeTotals(rows: readonly RunMetricsRow[]): RunTotals {
	let succeeded = 0;
	let failed = 0;
	let cancelled = 0;
	let active = 0;
	let costTotal = 0;
	let priced = 0;
	const durations: number[] = [];
	const contexts: number[] = [];
	for (const r of rows) {
		if (r.state === "succeeded") succeeded += 1;
		else if (r.state === "failed") failed += 1;
		else if (r.state === "cancelled") cancelled += 1;
		else active += 1;
		if (r.costUsd !== null) {
			priced += 1;
			costTotal += r.costUsd;
		}
		const dur = durationMsOf(r);
		if (dur !== null) durations.push(dur);
		const ctx = contextTokensOf(r);
		if (ctx !== null) contexts.push(ctx);
	}
	const terminal = succeeded + failed + cancelled;
	return {
		runs: rows.length,
		succeeded,
		failed,
		cancelled,
		active,
		successRate: terminal === 0 ? null : succeeded / terminal,
		durationMs: summarize(durations),
		contextTokens: summarize(contexts),
		cost: { total: costTotal, avg: priced === 0 ? null : costTotal / priced, priced },
	};
}

function buildTimeSeries(rows: readonly RunMetricsRow[]): RunDayBucket[] {
	const acc = new Map<string, { -readonly [K in keyof RunDayBucket]: RunDayBucket[K] }>();
	for (const r of rows) {
		const key = r.startedAt === null ? NONE_KEY : r.startedAt.slice(0, 10);
		let b = acc.get(key);
		if (b === undefined) {
			b = { key, runs: 0, succeeded: 0, failed: 0, cancelled: 0, active: 0, contextTokensTotal: 0 };
			acc.set(key, b);
		}
		b.runs += 1;
		if (r.state === "succeeded") b.succeeded += 1;
		else if (r.state === "failed") b.failed += 1;
		else if (r.state === "cancelled") b.cancelled += 1;
		else b.active += 1;
		b.contextTokensTotal += contextTokensOf(r) ?? 0;
	}
	const out = [...acc.values()];
	out.sort((a, b) => {
		if (a.key === NONE_KEY) return b.key === NONE_KEY ? 0 : 1;
		if (b.key === NONE_KEY) return -1;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
	return out;
}

function keyForGroup(r: RunMetricsRow, dim: GroupDimension): string | null {
	switch (dim) {
		case "agent":
			return r.agentName;
		case "model":
			return r.model;
		case "provider":
			return r.provider;
	}
}

interface GroupAcc {
	runs: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	contextTotal: number;
	contextCount: number;
	costUsd: number;
	priced: number;
	durations: number[];
}

function emptyGroupAcc(): GroupAcc {
	return {
		runs: 0,
		succeeded: 0,
		failed: 0,
		cancelled: 0,
		contextTotal: 0,
		contextCount: 0,
		costUsd: 0,
		priced: 0,
		durations: [],
	};
}

function accumulateGroup(g: GroupAcc, r: RunMetricsRow): void {
	g.runs += 1;
	if (r.state === "succeeded") g.succeeded += 1;
	else if (r.state === "failed") g.failed += 1;
	else if (r.state === "cancelled") g.cancelled += 1;
	if (r.costUsd !== null) {
		g.priced += 1;
		g.costUsd += r.costUsd;
	}
	const ctx = contextTokensOf(r);
	if (ctx !== null) {
		g.contextTotal += ctx;
		g.contextCount += 1;
	}
	const dur = durationMsOf(r);
	if (dur !== null) g.durations.push(dur);
}

function finalizeGroup(key: string, g: GroupAcc): RunGroupBucket {
	const terminal = g.succeeded + g.failed + g.cancelled;
	return {
		key,
		runs: g.runs,
		succeeded: g.succeeded,
		failed: g.failed,
		successRate: terminal === 0 ? null : g.succeeded / terminal,
		contextTokensTotal: g.contextTotal,
		avgContextTokens: g.contextCount === 0 ? null : g.contextTotal / g.contextCount,
		costUsd: g.costUsd,
		priced: g.priced,
		avgDurationMs: g.durations.length === 0 ? null : summarize(g.durations).avg,
	};
}

function buildGroup(rows: readonly RunMetricsRow[], dim: GroupDimension): RunGroupBucket[] {
	const acc = new Map<string, GroupAcc>();
	for (const r of rows) {
		const key = keyForGroup(r, dim) ?? NONE_KEY;
		let g = acc.get(key);
		if (g === undefined) {
			g = emptyGroupAcc();
			acc.set(key, g);
		}
		accumulateGroup(g, r);
	}
	const out: RunGroupBucket[] = [];
	for (const [key, g] of acc) out.push(finalizeGroup(key, g));
	// Most context-hungry first; ties by run count then key for determinism.
	out.sort((a, b) => {
		if (b.contextTokensTotal !== a.contextTokensTotal) {
			return b.contextTokensTotal - a.contextTokensTotal;
		}
		if (b.runs !== a.runs) return b.runs - a.runs;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
	return out;
}

function buildFailureReasons(rows: readonly RunMetricsRow[]): FailureBucket[] {
	const acc = new Map<string, number>();
	for (const r of rows) {
		if (r.state !== "failed") continue;
		const key = r.failureReason ?? NONE_KEY;
		acc.set(key, (acc.get(key) ?? 0) + 1);
	}
	const out: FailureBucket[] = [];
	for (const [key, runs] of acc) out.push({ key, runs });
	out.sort((a, b) => {
		if (b.runs !== a.runs) return b.runs - a.runs;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
	return out;
}

function buildTopSeeds(rows: readonly RunMetricsRow[]): SeedContextBucket[] {
	const acc = new Map<string, { runs: number; total: number; count: number }>();
	for (const r of rows) {
		if (r.seedId === null) continue; // seed-originated runs only (risk #4)
		let s = acc.get(r.seedId);
		if (s === undefined) {
			s = { runs: 0, total: 0, count: 0 };
			acc.set(r.seedId, s);
		}
		s.runs += 1;
		const ctx = contextTokensOf(r);
		if (ctx !== null) {
			s.total += ctx;
			s.count += 1;
		}
	}
	const out: SeedContextBucket[] = [];
	for (const [seedId, s] of acc) {
		out.push({
			seedId,
			runs: s.runs,
			contextTokensTotal: s.total,
			avgContextTokens: s.count === 0 ? null : s.total / s.count,
		});
	}
	out.sort((a, b) => {
		if (b.contextTokensTotal !== a.contextTokensTotal) {
			return b.contextTokensTotal - a.contextTokensTotal;
		}
		if (b.runs !== a.runs) return b.runs - a.runs;
		return a.seedId < b.seedId ? -1 : a.seedId > b.seedId ? 1 : 0;
	});
	return out;
}

/**
 * Build the full run-metrics rollup from `rows`. O(rows) per breakdown — a
 * handful of single passes, microseconds for the V1 default window.
 */
export function buildRunMetrics(rows: readonly RunMetricsRow[]): RunMetrics {
	return {
		totals: computeTotals(rows),
		timeSeries: buildTimeSeries(rows),
		byAgent: buildGroup(rows, "agent"),
		byModel: buildGroup(rows, "model"),
		byProvider: buildGroup(rows, "provider"),
		byFailureReason: buildFailureReasons(rows),
		topSeedsByContext: buildTopSeeds(rows),
	};
}
