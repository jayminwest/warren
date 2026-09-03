/**
 * Outcome-joined analytics rollups (warren-be04 / pl-103e step 12).
 *
 * Pure, dialect-agnostic companion to `run-metrics.ts` and `insights.ts`.
 * Where the run-metrics rollup answers "what happened", this module joins
 * outcomes — the merge watcher's `prState` column and the steering event
 * trace — to answer "what landed", in two shapes:
 *
 *   - {@link SteeringOutcomeComparison} — steered versus unsteered run
 *     cohorts, each with success and merged-PR rates over explicit
 *     denominators. The steering signal comes from the `steer.sent`
 *     events warren already records (`EventsRepo.listSteeringEventsForRuns`).
 *   - {@link CostPerMergedPr} — total priced cost divided by merged-PR
 *     count, overall and per agent / model / provider bucket, from the
 *     `prState` + `costUsd` columns.
 *
 * The two callout kinds in `insights.ts` (`steering-outcome-delta`,
 * `cost-per-merged-pr`) read this bundle; the same bundle ships structured
 * on `GET /analytics/runs` as the `outcomes` section so the Phase-2 UI
 * (warren-25b7) renders tables, not prose.
 *
 * Denominator discipline (the plan's invariant): a run whose `prState` the
 * merge watcher has never resolved is UNKNOWN. It is excluded from every
 * merge-rate and cost-per-merged-PR denominator and never counted as a
 * failure to land. Every rate and ratio therefore ships next to the count
 * that produced it (`prStateKnown`, `prsMerged`, `priced`), and every
 * comparison carries an {@link InsightConfidence} qualifier derived from
 * the smallest denominator behind it.
 */

import type { InsightConfidence } from "../../core/wire.ts";
import type { RunGroupBucket, RunMetrics, RunMetricsRow } from "./run-metrics.ts";

/**
 * Event kind emitted by `steerRun` when a steering message is forwarded to
 * the burrow inbox. Mirrored here (as in `insights.ts`) so the analytics
 * layer does not import from the run-lifecycle module.
 */
const STEER_SENT_KIND = "steer.sent";

/**
 * The minimal steering-event shape this aggregator needs — only the run id
 * matters, so callers can pass full `EventRow`s without a cast.
 */
export interface SteeringOutcomeEventRow {
	readonly runId: string;
	readonly kind: string;
}

/** Outcome tallies for one cohort of runs (steered, unsteered, or all). */
export interface OutcomeTally {
	/** rows in the cohort. */
	readonly runs: number;
	/** succeeded + failed + cancelled — the success-rate denominator. */
	readonly terminal: number;
	readonly succeeded: number;
	/** succeeded / terminal, or null when no terminal runs. */
	readonly successRate: number | null;
	/**
	 * rows whose `prState` the merge watcher resolved — THE merge-rate
	 * denominator. NULL `prState` rows are unknown and excluded.
	 */
	readonly prStateKnown: number;
	readonly prsMerged: number;
	/** prsMerged / prStateKnown, or null when nothing resolved. */
	readonly mergedPrRate: number | null;
}

/** Steered-versus-unsteered outcome comparison over the analytics window. */
export interface SteeringOutcomeComparison {
	readonly steered: OutcomeTally;
	readonly unsteered: OutcomeTally;
	/**
	 * `steered.mergedPrRate - unsteered.mergedPrRate` (signed, -1..1), or
	 * null unless BOTH cohorts have a resolved-PR denominator.
	 */
	readonly mergedPrRateDelta: number | null;
	/**
	 * Confidence in the comparison, derived from the SMALLER cohort's
	 * `prStateKnown` — the number that bounds the delta's meaning.
	 */
	readonly confidence: InsightConfidence;
}

/** One bucket's cost-per-merged-PR rollup. */
export interface CostPerMergedPrBucket {
	readonly key: string;
	/** total priced cost across the bucket's runs. */
	readonly costUsd: number;
	/** rows whose `costUsd` was non-null — the cost denominator. */
	readonly priced: number;
	/** rows with a resolved `prState` — the merge denominator. */
	readonly prStateKnown: number;
	readonly prsMerged: number;
	/** costUsd / prsMerged, or null when nothing merged (ratio undefined). */
	readonly costPerMergedPrUsd: number | null;
}

/** Total cost per merged PR, overall and per agent/model/provider bucket. */
export interface CostPerMergedPr {
	readonly overall: {
		readonly costUsd: number;
		readonly priced: number;
		readonly prStateKnown: number;
		readonly prsMerged: number;
		readonly costPerMergedPrUsd: number | null;
	};
	readonly byAgent: readonly CostPerMergedPrBucket[];
	readonly byModel: readonly CostPerMergedPrBucket[];
	readonly byProvider: readonly CostPerMergedPrBucket[];
	/** Confidence in the overall ratio, derived from `prsMerged`. */
	readonly confidence: InsightConfidence;
}

/** The structured `outcomes` section on `GET /analytics/runs` + `/analytics/behavior`. */
export interface RunOutcomes {
	readonly steering: SteeringOutcomeComparison;
	readonly costPerMergedPr: CostPerMergedPr;
	/**
	 * Autonomy rollup (warren-bc9c): how many of the merged runs needed no
	 * human in the loop — no steering, no infra-retry, no continuation.
	 * "No human commit" is not observable through the Forge seam and is
	 * deliberately out of scope.
	 */
	autonomy: AutonomyRollup;
}

/** Merged count and the unsteered, first-attempt subset of it. */
export interface AutonomyRollup {
	/** rows whose `prState` is `merged` — the rate's denominator. */
	readonly merged: number;
	/** merged rows that were never steered and are first attempts. */
	readonly autonomous: number;
	/** autonomous / merged, or null when nothing merged. */
	rate: number | null;
}

/** Sample size at or above which a denominator earns "medium" confidence. */
export const CONFIDENCE_MEDIUM_SAMPLE = 10;
/** Sample size at or above which a denominator earns "high" confidence. */
export const CONFIDENCE_HIGH_SAMPLE = 30;

/** Qualify a denominator-driven number by the size of the sample behind it. */
export function confidenceForSample(sample: number): InsightConfidence {
	if (sample >= CONFIDENCE_HIGH_SAMPLE) return "high";
	if (sample >= CONFIDENCE_MEDIUM_SAMPLE) return "medium";
	return "low";
}

function tallyRows(rows: readonly RunMetricsRow[]): OutcomeTally {
	let terminal = 0;
	let succeeded = 0;
	let prStateKnown = 0;
	let prsMerged = 0;
	for (const r of rows) {
		if (r.state === "succeeded" || r.state === "failed" || r.state === "cancelled") {
			terminal += 1;
			if (r.state === "succeeded") succeeded += 1;
		}
		if (r.prState !== null) {
			prStateKnown += 1;
			if (r.prState === "merged") prsMerged += 1;
		}
	}
	return {
		runs: rows.length,
		terminal,
		succeeded,
		successRate: terminal === 0 ? null : succeeded / terminal,
		prStateKnown,
		prsMerged,
		mergedPrRate: prStateKnown === 0 ? null : prsMerged / prStateKnown,
	};
}

/**
 * Split `rows` into steered / unsteered cohorts by the `steer.sent` event
 * trace and tally each cohort's outcomes. O(rows + events).
 */
export function buildSteeringOutcomeComparison(
	rows: readonly RunMetricsRow[],
	steeringEvents: readonly SteeringOutcomeEventRow[],
): SteeringOutcomeComparison {
	const steeredIds = new Set<string>();
	for (const e of steeringEvents) {
		if (e.kind === STEER_SENT_KIND) steeredIds.add(e.runId);
	}
	const steered: RunMetricsRow[] = [];
	const unsteered: RunMetricsRow[] = [];
	for (const r of rows) {
		if (steeredIds.has(r.runId)) steered.push(r);
		else unsteered.push(r);
	}
	const s = tallyRows(steered);
	const u = tallyRows(unsteered);
	return {
		steered: s,
		unsteered: u,
		mergedPrRateDelta:
			s.mergedPrRate === null || u.mergedPrRate === null ? null : s.mergedPrRate - u.mergedPrRate,
		confidence: confidenceForSample(Math.min(s.prStateKnown, u.prStateKnown)),
	};
}

function bucketOf(g: RunGroupBucket): CostPerMergedPrBucket {
	return {
		key: g.key,
		costUsd: g.costUsd,
		priced: g.priced,
		prStateKnown: g.prStateKnown,
		prsMerged: g.prsMerged,
		costPerMergedPrUsd: g.prsMerged === 0 ? null : g.costUsd / g.prsMerged,
	};
}

/** Sort by ratio descending, unresolved buckets last, key ascending on ties. */
function compareCostBuckets(a: CostPerMergedPrBucket, b: CostPerMergedPrBucket): number {
	if (a.costPerMergedPrUsd === null) return b.costPerMergedPrUsd === null ? compareKeys(a, b) : 1;
	if (b.costPerMergedPrUsd === null) return -1;
	if (b.costPerMergedPrUsd !== a.costPerMergedPrUsd) {
		return b.costPerMergedPrUsd - a.costPerMergedPrUsd;
	}
	return compareKeys(a, b);
}

function compareKeys(a: { key: string }, b: { key: string }): number {
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Total cost per merged PR, overall and per agent / model / provider bucket,
 * from the already-computed {@link RunMetrics}. Buckets with zero merged PRs
 * carry a null ratio — the cost is real but the denominator is zero, so the
 * number is undefined rather than infinite. O(groups).
 */
export function buildCostPerMergedPr(metrics: RunMetrics): CostPerMergedPr {
	const totals = metrics.totals;
	return {
		overall: {
			costUsd: totals.cost.total,
			priced: totals.cost.priced,
			prStateKnown: totals.prStateKnown,
			prsMerged: totals.prsMerged,
			costPerMergedPrUsd: totals.prsMerged === 0 ? null : totals.cost.total / totals.prsMerged,
		},
		byAgent: metrics.byAgent.map(bucketOf).sort(compareCostBuckets),
		byModel: metrics.byModel.map(bucketOf).sort(compareCostBuckets),
		byProvider: metrics.byProvider.map(bucketOf).sort(compareCostBuckets),
		confidence: confidenceForSample(totals.prsMerged),
	};
}

/**
 * Autonomy rollup (warren-bc9c): of the runs that merged, how many were
 * never steered (`steer.sent` trace) and were first attempts — no
 * `retry_of` back-link and no `parent_run_id` continuation. O(rows + events).
 */
function buildAutonomy(
	rows: readonly RunMetricsRow[],
	steeringEvents: readonly SteeringOutcomeEventRow[],
): AutonomyRollup {
	const steeredIds = new Set<string>();
	for (const e of steeringEvents) {
		if (e.kind === STEER_SENT_KIND) steeredIds.add(e.runId);
	}
	let merged = 0;
	let autonomous = 0;
	for (const r of rows) {
		if (r.prState !== "merged") continue;
		merged += 1;
		if (!steeredIds.has(r.runId) && r.retryOf === null && r.parentRunId === null) {
			autonomous += 1;
		}
	}
	return { merged, autonomous, rate: merged === 0 ? null : autonomous / merged };
}

/**
 * Build the full outcome-joined rollup for an analytics window from the
 * flat run rows, their steering event trace, and the run-metrics rollup.
 */
export function buildRunOutcomes(
	rows: readonly RunMetricsRow[],
	steeringEvents: readonly SteeringOutcomeEventRow[],
	metrics: RunMetrics,
): RunOutcomes {
	return {
		steering: buildSteeringOutcomeComparison(rows, steeringEvents),
		costPerMergedPr: buildCostPerMergedPr(metrics),
		autonomy: buildAutonomy(rows, steeringEvents),
	};
}
