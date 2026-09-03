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

import type { PullRequestLifecycle, RunFailureReason, RunState } from "../../db/schema.ts";
import {
	buildFailureReasons,
	buildTopSeeds,
	type FailureBucket,
	type SeedContextBucket,
} from "./run-metrics-breakdowns.ts";
import { computeDelivery, type RunDeliveryMetrics } from "./run-metrics-delivery.ts";
import { buildTokenDimSeries, buildTokenTimeSeries } from "./run-metrics-token-series.ts";
import { type StatSummary, summarize } from "./stat-summary.ts";

// The bucket types live in `run-metrics-breakdowns.ts` (file-size split);
// re-export so existing consumers keep importing from this module.
export type { FailureBucket, SeedContextBucket } from "./run-metrics-breakdowns.ts";
export type { StatSummary } from "./stat-summary.ts";

/**
 * Token-kind breakdown for a set of runs. All four counters plus their sum.
 * Null/undefined columns from rows are treated as 0 so the shape is always
 * fully populated.
 */
export interface TokenBreakdown {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

/** Sentinel for a null group key (no startedAt, no failureReason, etc.). */
export const NONE_KEY = "__none__";
/** Sentinel for the folded remainder in per-dimension token series (≥6 keys). */
export const OTHER_KEY = "__other__";

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
	readonly tokensCacheWrite: number | null;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	/**
	 * The queued instant as epoch ms (warren-0af9 / pl-103e step 1). Null on
	 * rows written before the column existed — those are "unknown", excluded
	 * from queue-wait denominators, never counted as zero wait.
	 */
	readonly createdAt: number | null;
	/**
	 * The forge-reported PR lifecycle (warren-3bc6 / pl-103e step 6). Null
	 * means the merge watcher has never resolved this run's PR (historical
	 * rows, no `pr_url`, or a PR not yet polled) — landed-work semantics
	 * (warren-bd57) treat that as "unknown": excluded from merge-rate
	 * denominators, never counted as a failure to land.
	 */
	readonly prState: PullRequestLifecycle | null;
	/**
	 * Continuation back-link (warren-4b11) — the run this row continues.
	 * Non-null rows are continuations, not first attempts (warren-bc9c).
	 */
	readonly parentRunId: string | null;
	/** Infra-lost auto-retry back-link (warren-4af7) — non-null means a retry. */
	readonly retryOf: string | null;
	/** The forge-reported merge instant, or null when the PR has not merged. */
	readonly prMergedAt: string | null;
	/**
	 * The persisted `reap.branch_pushed` event ts (warren-bc9c), or null
	 * when no push event exists for the run (historical rows, cancelled
	 * runs, runs whose push never completed).
	 */
	readonly branchPushedAt: string | null;
	/** The persisted `reap.pr_opened` event ts (warren-bc9c), or null. */
	readonly prOpenedAt: string | null;
}

export interface RunTotals {
	readonly runs: number;
	readonly succeeded: number;
	readonly failed: number;
	readonly cancelled: number;
	/** queued + running — non-terminal at query time. */
	readonly active: number;
	/** succeeded / (succeeded + failed + cancelled), or null when no terminal runs. */
	readonly successRate: number | null;
	/**
	 * Landed-work rollup (warren-bd57): rows whose `prState` the merge
	 * watcher has resolved (the merge-rate denominator), how many of those
	 * merged, and the rate. NULL `prState` rows are unknown and excluded —
	 * `mergedPrRate` is null when no row carries a resolved PR state.
	 */
	readonly prStateKnown: number;
	readonly prsMerged: number;
	readonly mergedPrRate: number | null;
	readonly durationMs: StatSummary;
	/**
	 * Queue wait (`startedAt - createdAt`) over rows where both are known
	 * (warren-0af9). Pre-migration rows (null `createdAt`) and runs that
	 * never left the queue are excluded from the sample — `count` is the
	 * known-row denominator.
	 */
	readonly queueWaitMs: StatSummary;
	readonly contextTokens: StatSummary;
	readonly tokens: TokenBreakdown;
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
	readonly cancelled: number;
	readonly successRate: number | null;
	/** Landed-work rollup for this bucket (warren-bd57) — see `RunTotals`. */
	readonly prStateKnown: number;
	readonly prsMerged: number;
	readonly mergedPrRate: number | null;
	readonly contextTokensTotal: number;
	readonly avgContextTokens: number | null;
	readonly tokens: TokenBreakdown;
	readonly costUsd: number;
	readonly priced: number;
	readonly avgDurationMs: number | null;
}

/** One calendar-day's token counts in a time-series. `date` is YYYY-MM-DD or NONE_KEY. */
export interface TokenDayBucket {
	readonly date: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

/** One key's daily token series in a per-model or per-provider breakdown. */
export interface DimensionTokenSeries {
	readonly key: string;
	readonly series: readonly TokenDayBucket[];
}

export interface RunMetrics {
	readonly totals: RunTotals;
	/**
	 * Delivery-timing rollup (warren-bc9c): the gaps between dispatch,
	 * branch push, PR open, and merge over the runs where both endpoints
	 * of each gap are known. Null endpoints are excluded from each sample,
	 * never counted as zero.
	 */
	readonly delivery: RunDeliveryMetrics;
	readonly timeSeries: readonly RunDayBucket[];
	readonly byAgent: readonly RunGroupBucket[];
	readonly byModel: readonly RunGroupBucket[];
	readonly byProvider: readonly RunGroupBucket[];
	readonly byFailureReason: readonly FailureBucket[];
	readonly topSeedsByContext: readonly SeedContextBucket[];
	/** Overall daily token counts (one bucket per calendar day). */
	readonly tokenTimeSeries: readonly TokenDayBucket[];
	/** Per-model daily series, top-5 by total + OTHER_KEY fold + NONE_KEY. */
	readonly tokenByModelSeries: readonly DimensionTokenSeries[];
	/** Per-provider daily series, top-5 by total + OTHER_KEY fold + NONE_KEY. */
	readonly tokenByProviderSeries: readonly DimensionTokenSeries[];
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

/**
 * Queue wait in milliseconds (`startedAt - createdAt`, warren-0af9), or null
 * unless both instants are present + valid. A null `createdAt` means the row
 * predates the column — its wait is unknown, not zero.
 */
export function queueWaitMsOf(row: RunMetricsRow): number | null {
	if (row.createdAt === null || row.startedAt === null) return null;
	const start = Date.parse(row.startedAt);
	if (Number.isNaN(start)) return null;
	const delta = start - row.createdAt;
	return delta < 0 ? null : delta;
}

export function tokenBreakdownOf(row: RunMetricsRow): TokenBreakdown {
	const input = row.tokensInput ?? 0;
	const output = row.tokensOutput ?? 0;
	const cacheRead = row.tokensCacheRead ?? 0;
	const cacheWrite = row.tokensCacheWrite ?? 0;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function addTokenBreakdowns(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
	const input = a.input + b.input;
	const output = a.output + b.output;
	const cacheRead = a.cacheRead + b.cacheRead;
	const cacheWrite = a.cacheWrite + b.cacheWrite;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

const ZERO_TOKENS: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/**
 * Landed-work tallies for one row (warren-bd57). `known` counts rows whose
 * `prState` is resolved (open / merged / closed_unmerged); `merged` counts
 * the merged subset. NULL `prState` contributes to neither — unknown is not
 * a failure to land.
 */
function landedOf(row: RunMetricsRow): { known: number; merged: number } {
	if (row.prState === null) return { known: 0, merged: 0 };
	return { known: 1, merged: row.prState === "merged" ? 1 : 0 };
}

function computeTotals(rows: readonly RunMetricsRow[]): RunTotals {
	let succeeded = 0;
	let failed = 0;
	let cancelled = 0;
	let active = 0;
	let prStateKnown = 0;
	let prsMerged = 0;
	let costTotal = 0;
	let priced = 0;
	let tokens: TokenBreakdown = ZERO_TOKENS;
	const durations: number[] = [];
	const queueWaits: number[] = [];
	const contexts: number[] = [];
	for (const r of rows) {
		if (r.state === "succeeded") succeeded += 1;
		else if (r.state === "failed") failed += 1;
		else if (r.state === "cancelled") cancelled += 1;
		else active += 1;
		const landed = landedOf(r);
		prStateKnown += landed.known;
		prsMerged += landed.merged;
		if (r.costUsd !== null) {
			priced += 1;
			costTotal += r.costUsd;
		}
		const dur = durationMsOf(r);
		if (dur !== null) durations.push(dur);
		const wait = queueWaitMsOf(r);
		if (wait !== null) queueWaits.push(wait);
		const ctx = contextTokensOf(r);
		if (ctx !== null) contexts.push(ctx);
		tokens = addTokenBreakdowns(tokens, tokenBreakdownOf(r));
	}
	const terminal = succeeded + failed + cancelled;
	return {
		runs: rows.length,
		succeeded,
		failed,
		cancelled,
		active,
		successRate: terminal === 0 ? null : succeeded / terminal,
		prStateKnown,
		prsMerged,
		mergedPrRate: prStateKnown === 0 ? null : prsMerged / prStateKnown,
		durationMs: summarize(durations),
		queueWaitMs: summarize(queueWaits),
		contextTokens: summarize(contexts),
		tokens,
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
	prStateKnown: number;
	prsMerged: number;
	contextTotal: number;
	contextCount: number;
	tokens: TokenBreakdown;
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
		prStateKnown: 0,
		prsMerged: 0,
		contextTotal: 0,
		contextCount: 0,
		tokens: ZERO_TOKENS,
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
	const landed = landedOf(r);
	g.prStateKnown += landed.known;
	g.prsMerged += landed.merged;
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
	g.tokens = addTokenBreakdowns(g.tokens, tokenBreakdownOf(r));
}

function finalizeGroup(key: string, g: GroupAcc): RunGroupBucket {
	const terminal = g.succeeded + g.failed + g.cancelled;
	return {
		key,
		runs: g.runs,
		succeeded: g.succeeded,
		failed: g.failed,
		cancelled: g.cancelled,
		successRate: terminal === 0 ? null : g.succeeded / terminal,
		prStateKnown: g.prStateKnown,
		prsMerged: g.prsMerged,
		mergedPrRate: g.prStateKnown === 0 ? null : g.prsMerged / g.prStateKnown,
		contextTokensTotal: g.contextTotal,
		avgContextTokens: g.contextCount === 0 ? null : g.contextTotal / g.contextCount,
		tokens: g.tokens,
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

/**
 * Build the full run-metrics rollup from `rows`. O(rows) per breakdown — a
 * handful of single passes, microseconds for the V1 default window.
 */
export function buildRunMetrics(rows: readonly RunMetricsRow[]): RunMetrics {
	return {
		totals: computeTotals(rows),
		delivery: computeDelivery(rows),
		timeSeries: buildTimeSeries(rows),
		byAgent: buildGroup(rows, "agent"),
		byModel: buildGroup(rows, "model"),
		byProvider: buildGroup(rows, "provider"),
		byFailureReason: buildFailureReasons(rows),
		topSeedsByContext: buildTopSeeds(rows),
		tokenTimeSeries: buildTokenTimeSeries(rows),
		tokenByModelSeries: buildTokenDimSeries(rows, "model"),
		tokenByProviderSeries: buildTokenDimSeries(rows, "provider"),
	};
}
