/**
 * Public projection for `GET /analytics/runs` (warren-4f6c / pl-b82d step 15;
 * split out of `analytics.ts` to hold the file-size budget).
 *
 * The public analytics body is a run-count and state-distribution view: how
 * much work this instance does, how much of it lands, and how many tokens it
 * burns doing so. Three allowlists, one per nesting level, so a field added
 * to `RunMetrics`, `RunTotals` or `RunGroupBucket` tomorrow is absent from
 * the public body until someone classifies it — see `src/server/projection.ts`.
 */

import type {
	CostPerMergedPr,
	CostPerMergedPrBucket,
	DimensionTokenSeries,
	RunGroupBucket,
	RunMetrics,
	RunOutcomes,
	RunTotals,
	TokenBreakdown,
	TokenDayBucket,
} from "../../../runs/index.ts";
import { isPublicOnly, pickFields } from "../../projection.ts";
import type { Actor } from "../../types.ts";

/**
 * Structured token section added to `GET /analytics/runs` (warren-1244 / pl-d1a2).
 * Groups all token analytics — aggregate totals, per-model/provider summaries,
 * and daily time series — into a single nested object so the UI can render
 * token charts without picking fields off multiple top-level keys.
 */
export interface RunAnalyticsTokensSection {
	/** Aggregate token breakdown across all runs in the window. */
	readonly totals: TokenBreakdown;
	/** Per-model aggregate token totals, sorted by total tokens desc. */
	readonly byModel: readonly { readonly key: string; readonly tokens: TokenBreakdown }[];
	/** Per-provider aggregate token totals, sorted by total tokens desc. */
	readonly byProvider: readonly { readonly key: string; readonly tokens: TokenBreakdown }[];
	/** Overall daily token series, one bucket per calendar day (YYYY-MM-DD). */
	readonly timeSeries: readonly TokenDayBucket[];
	/** Per-model daily token series, top-5 + OTHER_KEY fold + NONE_KEY. */
	readonly byModelTimeSeries: readonly DimensionTokenSeries[];
	/** Per-provider daily token series, top-5 + OTHER_KEY fold + NONE_KEY. */
	readonly byProviderTimeSeries: readonly DimensionTokenSeries[];
}

/** The full `GET /analytics/runs` body an operator receives. */
export interface RunAnalyticsBody extends RunMetrics {
	readonly filter: { projectId: string | null; from: string | null; to: string | null };
	readonly tokens: RunAnalyticsTokensSection;
	/** Outcome-joined rollup (warren-be04): steering deltas + cost per merged PR. */
	readonly outcomes: RunOutcomes;
	/**
	 * Count of `budget.exceeded` events (warren-ea4e). `RUN_FAILURE_REASONS`
	 * carries no cost-cap member, so the event scan is the only signal a
	 * run stopped because it hit its spend cap.
	 */
	readonly capHits: number;
}

/**
 * The `GET /analytics/runs` sections a `readPublic`-only spectator sees
 * (warren-4f6c / pl-b82d step 15). See the module doc above.
 */
export const PUBLIC_RUN_ANALYTICS_FIELDS = [
	"filter",
	"totals",
	"timeSeries",
	"byAgent",
	"byModel",
	"byProvider",
	"byFailureReason",
	"tokenTimeSeries",
	"tokenByModelSeries",
	"tokenByProviderSeries",
	"tokens",
	// warren-bc9c: the delivery timing block — medians over push/PR/merge
	// gaps, same posture as queueWaitMs (load shape, not a private fact).
	"delivery",
	// warren-be04: rates + counts are public (same call as the warren-bd57
	// landed-work fields); the cost halves inside are redacted one level
	// down — see PUBLIC_COST_PER_MERGED_PR_*_FIELDS below. warren-97ae:
	// the exception is the instance-wide cost/merged-PR ratio, which is
	// public on the overall shape — the buckets keep it redacted because a
	// ratio × its merged count reconstructs spend.
	"outcomes",
] as const satisfies readonly (keyof RunAnalyticsBody)[];

/**
 * The complement of `PUBLIC_RUN_ANALYTICS_FIELDS`.
 *
 * - `topSeedsByContext` — a leaderboard of the instance's own issue ids
 *   ranked by context burn. Reads as internal backlog triage, and the
 *   seed ids only mean anything to the operator.
 */
export const REDACTED_RUN_ANALYTICS_FIELDS = [
	"topSeedsByContext",
	// warren-ea4e: how often runs stop on their spend cap reads as an
	// operator's burn-control posture, not a spectator fact.
	"capHits",
] as const satisfies readonly (keyof RunAnalyticsBody)[];

/** `RunTotals` minus the windowed USD rollup. */
export const PUBLIC_RUN_TOTALS_FIELDS = [
	"runs",
	"succeeded",
	"failed",
	"cancelled",
	"active",
	"successRate",
	"durationMs",
	// warren-0af9: queue wait is a load-shape signal (how backed-up the
	// instance is), not a private fact — same posture as durationMs.
	"queueWaitMs",
	// warren-bd57: how much dispatched work actually lands is the public
	// posture's own headline ("how much of it lands") — a rate, not a
	// private fact.
	"prStateKnown",
	"prsMerged",
	"mergedPrRate",
	"contextTokens",
	"tokens",
] as const satisfies readonly (keyof RunTotals)[];

/**
 * - `cost` — the windowed `{total, avg, priced}` USD rollup. Same call as
 *   `costTotalUsd` on `GET /runs` (warren-946f): per-run cost on a run
 *   detail is a deliberate exception, an aggregate headline is not.
 * - `costUsd` — the per-run cost distribution (warren-ea4e): a cost
 *   figure for every run in the window, so it rides the same redaction.
 */
export const REDACTED_RUN_TOTALS_FIELDS = [
	"cost",
	"costUsd",
] as const satisfies readonly (keyof RunTotals)[];

/** `RunGroupBucket` minus the per-group USD rollup. */
export const PUBLIC_RUN_GROUP_FIELDS = [
	"key",
	"runs",
	"succeeded",
	"failed",
	"cancelled",
	"successRate",
	// warren-bd57: per-bucket landed-work rate, public on the same call as
	// the totals fields.
	"prStateKnown",
	"prsMerged",
	"mergedPrRate",
	"contextTokensTotal",
	"avgContextTokens",
	"tokens",
	"avgDurationMs",
] as const satisfies readonly (keyof RunGroupBucket)[];

/**
 * - `costUsd` / `priced` — per-agent / per-model / per-provider spend.
 *   Summing them reconstructs the aggregate `totals.cost` the projection
 *   just dropped, so they go together or not at all.
 */
export const REDACTED_RUN_GROUP_FIELDS = [
	"costUsd",
	"priced",
] as const satisfies readonly (keyof RunGroupBucket)[];

/**
 * `CostPerMergedPrBucket` minus its USD figures (warren-be04). The merged
 * counts and resolved denominators are public on the warren-bd57 call;
 * the cost numerator, the priced-run count, and the resulting ratio are
 * cost figures and go the way of `totals.cost`.
 */
export const PUBLIC_COST_PER_MERGED_PR_BUCKET_FIELDS = [
	"key",
	"prStateKnown",
	"prsMerged",
] as const satisfies readonly (keyof CostPerMergedPrBucket)[];

export const REDACTED_COST_PER_MERGED_PR_BUCKET_FIELDS = [
	"costUsd",
	"priced",
	"costPerMergedPrUsd",
] as const satisfies readonly (keyof CostPerMergedPrBucket)[];

/**
 * The keyless `overall` shape shares the bucket's classification minus `key`.
 * warren-97ae: unlike the per-group buckets, the instance-wide ratio is
 * public (`costPerMergedPrUsd`) — there is no per-group table alongside it
 * to multiply back through, so the ratio alone reconstructs nothing about
 * `totals.cost`. The numerator (`costUsd`) and the priced-run count still
 * stay redacted.
 */
export const PUBLIC_COST_PER_MERGED_PR_OVERALL_FIELDS = [
	"prStateKnown",
	"prsMerged",
	"costPerMergedPrUsd",
] as const satisfies readonly (keyof CostPerMergedPr["overall"])[];

export const REDACTED_COST_PER_MERGED_PR_OVERALL_FIELDS = [
	"costUsd",
	"priced",
] as const satisfies readonly (keyof CostPerMergedPr["overall"])[];

/** The `GET /analytics/runs` body as a `readPublic`-only caller sees it. */
type PublicCostPerMergedPrBucket = Pick<
	CostPerMergedPrBucket,
	(typeof PUBLIC_COST_PER_MERGED_PR_BUCKET_FIELDS)[number]
>;

/**
 * `RunOutcomes` as a spectator sees it: steering intact, USD figures gone —
 * except the instance-wide cost/merged-PR ratio (warren-97ae, see the
 * allowlist comment above). The per-group buckets stay fully redacted.
 */
export type PublicRunOutcomes = Omit<RunOutcomes, "costPerMergedPr"> & {
	readonly costPerMergedPr: Omit<
		CostPerMergedPr,
		"overall" | "byAgent" | "byModel" | "byProvider"
	> & {
		readonly overall: Pick<
			CostPerMergedPr["overall"],
			(typeof PUBLIC_COST_PER_MERGED_PR_OVERALL_FIELDS)[number]
		>;
		readonly byAgent: readonly PublicCostPerMergedPrBucket[];
		readonly byModel: readonly PublicCostPerMergedPrBucket[];
		readonly byProvider: readonly PublicCostPerMergedPrBucket[];
	};
};

export type PublicRunAnalytics = Omit<
	Pick<RunAnalyticsBody, (typeof PUBLIC_RUN_ANALYTICS_FIELDS)[number]>,
	"totals" | "byAgent" | "byModel" | "byProvider" | "outcomes"
> & {
	readonly totals: Pick<RunTotals, (typeof PUBLIC_RUN_TOTALS_FIELDS)[number]>;
	readonly byAgent: readonly Pick<RunGroupBucket, (typeof PUBLIC_RUN_GROUP_FIELDS)[number]>[];
	readonly byModel: readonly Pick<RunGroupBucket, (typeof PUBLIC_RUN_GROUP_FIELDS)[number]>[];
	readonly byProvider: readonly Pick<RunGroupBucket, (typeof PUBLIC_RUN_GROUP_FIELDS)[number]>[];
	readonly outcomes: PublicRunOutcomes;
};

/**
 * Narrow the analytics body for `actor`. The operator gets the body
 * untouched, so the public body is provably the operator body minus
 * fields — one construction site, no drift.
 */
export function projectRunAnalytics(
	body: RunAnalyticsBody,
	actor: Actor | undefined,
): RunAnalyticsBody | PublicRunAnalytics {
	if (!isPublicOnly(actor)) return body;
	const groups = (buckets: readonly RunGroupBucket[]) =>
		buckets.map((b) => pickFields(b, PUBLIC_RUN_GROUP_FIELDS));
	const costBuckets = (buckets: readonly CostPerMergedPrBucket[]) =>
		buckets.map((b) => pickFields(b, PUBLIC_COST_PER_MERGED_PR_BUCKET_FIELDS));
	const costPerMergedPr = body.outcomes.costPerMergedPr;
	const outcomes: PublicRunOutcomes = {
		steering: body.outcomes.steering,
		autonomy: body.outcomes.autonomy,
		costPerMergedPr: {
			overall: pickFields(costPerMergedPr.overall, PUBLIC_COST_PER_MERGED_PR_OVERALL_FIELDS),
			byAgent: costBuckets(costPerMergedPr.byAgent),
			byModel: costBuckets(costPerMergedPr.byModel),
			byProvider: costBuckets(costPerMergedPr.byProvider),
			confidence: costPerMergedPr.confidence,
		},
	};
	return {
		...pickFields(body, PUBLIC_RUN_ANALYTICS_FIELDS),
		totals: pickFields(body.totals, PUBLIC_RUN_TOTALS_FIELDS),
		byAgent: groups(body.byAgent),
		byModel: groups(body.byModel),
		byProvider: groups(body.byProvider),
		outcomes,
	};
}
