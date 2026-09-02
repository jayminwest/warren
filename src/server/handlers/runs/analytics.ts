/**
 * Run analytics handlers (warren-0692 / pl-ad0f step 2).
 *
 * Thin `RouteHandler` factories over the pure `buildRunMetrics`
 * aggregator (`src/runs/analytics/run-metrics.ts`). Mirrors the cost
 * analytics handler exactly: parse + validate the `?from`/`?to`/
 * `?projectId` window, fetch the matching `runs` rows via
 * `RunsRepo.listForAnalytics`, hydrate usage so bridge-died terminal
 * runs still carry cost/token totals, map each row into a flat
 * `RunMetricsRow` (reading the `provider`/`model` columns frozen at
 * dispatch — warren-2ede), then emit the rollup wrapped in the resolved
 * `filter` echo.
 */

import type { RuntimeId } from "../../../core/wire.ts";
import { DEFAULT_RUNTIME_ID } from "../../../registry/schema.ts";
import type { RunRow } from "../../../runs/index.ts";
import {
	buildRunMetrics,
	buildRunOutcomes,
	type CostPerMergedPr,
	type CostPerMergedPrBucket,
	type DimensionTokenSeries,
	type DirectoryToolCallRow,
	hydrateRunsUsage,
	type RunGroupBucket,
	type RunMetrics,
	type RunMetricsRow,
	type RunOutcomes,
	type RunTotals,
	type TokenBreakdown,
	type TokenDayBucket,
	type ToolCallMiningRow,
} from "../../../runs/index.ts";
import { isPublicOnly, pickFields } from "../../projection.ts";
import { jsonResponse } from "../../response.ts";
import type { Actor, RouteHandler, ServerDeps } from "../../types.ts";
import {
	extractProviderModel,
	parseAnalyticsDateBound,
	resolveAnalyticsWindow as resolveAnalyticsWindowBounds,
} from "./lifecycle.ts";

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

/** Resolved `?from`/`?to`/`?projectId` analytics window. */
interface AnalyticsWindow {
	projectId?: string;
	from?: string;
	to?: string;
}

/**
 * Parse + resolve the shared `?from`/`?to`/`?projectId` window. Defaults the
 * `from` bound to the last 30 days whenever it is absent and clamps the span
 * to 90 days, matching `GET /analytics/cost` (warren-30cc). Both bounds and
 * `projectId` are validated lightly — a malformed date is a 400 because the
 * lexicographic ISO8601 compare in `listForAnalytics` would silently produce
 * surprising results otherwise.
 */
export function parseAnalyticsWindow(ctx: { url: URL }): {
	echo: { projectId: string | null; from: string | null; to: string | null };
	filter: AnalyticsWindow;
} {
	const projectId = ctx.url.searchParams.get("projectId") ?? undefined;
	const from = parseAnalyticsDateBound(ctx, "from");
	const to = parseAnalyticsDateBound(ctx, "to");
	const window = resolveAnalyticsWindowBounds(from, to);
	const filter: AnalyticsWindow = { from: window.from, to: window.to };
	if (projectId !== undefined) filter.projectId = projectId;
	return {
		echo: { projectId: projectId ?? null, from: window.from, to: window.to },
		filter,
	};
}

/**
 * Map hydrated `runs` rows into the flat aggregator input shape.
 *
 * warren-2ede / pl-103e: `provider`/`model` come from the real columns
 * written at dispatch. `extractProviderModel` survives only as the
 * historical-row fallback — rows written before the columns existed have
 * NULL and get one re-parse of `rendered_agent_json`; rows whose agent
 * genuinely declares no provider/model stay null, group under NONE_KEY
 * ("unknown"), and are excluded from the real buckets' denominators.
 */
export function toMetricsRows(rows: readonly RunRow[]): RunMetricsRow[] {
	return rows.map((r) => {
		const fallback =
			r.provider === null || r.model === null ? extractProviderModel(r.renderedAgentJson) : {};
		return {
			runId: r.id,
			projectId: r.projectId,
			agentName: r.agentName,
			provider: r.provider ?? fallback.provider ?? null,
			model: r.model ?? fallback.model ?? null,
			seedId: r.seedId,
			state: r.state,
			failureReason: r.failureReason,
			costUsd: r.costUsd,
			tokensInput: r.tokensInput,
			tokensCacheRead: r.tokensCacheRead,
			tokensOutput: r.tokensOutput,
			tokensCacheWrite: r.tokensCacheWrite,
			startedAt: r.startedAt,
			endedAt: r.endedAt,
			createdAt: r.createdAt,
			// warren-bd57: the merge-watcher column feeds landed-work rates
			// directly — no rendered_agent_json re-parse in this path.
			prState: r.prState,
		};
	});
}

/**
 * Fetch + hydrate the `runs` rows for an analytics window and compute the
 * run-level rollup. Shared by `GET /analytics/runs` (the rollup is the
 * response) and `GET /analytics/behavior` (the rollup feeds the derived
 * insights layer). Returns the hydrated rows too so the behavior handler can
 * derive the run-id set for its event scan without a second query.
 */
export async function loadRunMetrics(
	deps: ServerDeps,
	filter: AnalyticsWindow,
): Promise<{ rows: RunRow[]; metrics: RunMetrics }> {
	const rowsRaw = await deps.repos.runs.listForAnalytics(filter);
	// Hydrate so terminal runs with bridge-died usage still count.
	const rows = await hydrateRunsUsage(rowsRaw, deps.repos.events, deps.repos.runs);
	return { rows, metrics: buildRunMetrics(toMetricsRows(rows)) };
}

/**
 * Build the outcome-joined `outcomes` section (warren-be04 / pl-103e step
 * 12) from the hydrated rows + run-metrics rollup. Shared by
 * `GET /analytics/runs` (the section ships on the body) and
 * `GET /analytics/behavior` (the same bundle feeds the two outcome-joined
 * insight kinds). Fetches the uncapped `steer.sent` trace for the window's
 * runs — the same query the behavior handler already runs for
 * {@link SteeringSignals}.
 */
async function loadRunOutcomes(
	deps: ServerDeps,
	rows: readonly RunRow[],
	metrics: RunMetrics,
): Promise<RunOutcomes> {
	const steeringRows = await deps.repos.events.listSteeringEventsForRuns(rows.map((r) => r.id));
	return buildRunOutcomes(toMetricsRows(rows), steeringRows, metrics);
}

/**
 * Read the structured `tool_calls` rollup (warren-7746) into the mining
 * input shape, attaching each row's runtime id. Unlike the retired raw
 * event scan, a capped read REPORTS truncation via the returned flag —
 * the response surfaces it as `truncated: true`, never silent.
 */
export async function loadToolCallRows(
	deps: ServerDeps,
	runIds: readonly string[],
	runtimeByRunId: ReadonlyMap<string, RuntimeId>,
): Promise<{
	rows: ToolCallMiningRow[];
	directoryRows: DirectoryToolCallRow[];
	truncated: boolean;
}> {
	const { rows, truncated } = await deps.repos.toolCalls.listForRuns(runIds);
	return {
		rows: rows.map((r) => ({
			runId: r.runId,
			seq: r.seq,
			toolName: r.toolName,
			command: r.command,
			toolUseId: r.toolUseId,
			isError: r.isError,
			resultBytes: r.resultBytes,
			runtime: runtimeByRunId.get(r.runId) ?? DEFAULT_RUNTIME_ID,
		})),
		// warren-8f1b: the same rollup rows, reduced to the directory-join
		// shape. `filePaths` is the JSON column the fileShape extractor
		// wrote at rollup time; narrow defensively since drizzle types the
		// json mode as unknown.
		directoryRows: rows.map((r) => ({
			runId: r.runId,
			seq: r.seq,
			toolName: r.toolName,
			isError: r.isError,
			filePaths: Array.isArray(r.filePaths)
				? r.filePaths.filter((p): p is string => typeof p === "string")
				: [],
		})),
		truncated,
	};
}

/**
 * Build the `tokens` section for `GET /analytics/runs` from the already-computed
 * `RunMetrics`. Extracts per-model and per-provider token totals (the static
 * breakdown) and wires the time-series fields produced by warren-d3cd.
 */
function buildTokensSection(metrics: RunMetrics): RunAnalyticsTokensSection {
	return {
		totals: metrics.totals.tokens,
		byModel: metrics.byModel.map((b) => ({ key: b.key, tokens: b.tokens })),
		byProvider: metrics.byProvider.map((b) => ({ key: b.key, tokens: b.tokens })),
		timeSeries: metrics.tokenTimeSeries,
		byModelTimeSeries: metrics.tokenByModelSeries,
		byProviderTimeSeries: metrics.tokenByProviderSeries,
	};
}

/** The full `GET /analytics/runs` body an operator receives. */
export interface RunAnalyticsBody extends RunMetrics {
	readonly filter: { projectId: string | null; from: string | null; to: string | null };
	readonly tokens: RunAnalyticsTokensSection;
	/** Outcome-joined rollup (warren-be04): steering deltas + cost per merged PR. */
	readonly outcomes: RunOutcomes;
}

/**
 * The `GET /analytics/runs` sections a `readPublic`-only spectator sees
 * (warren-4f6c / pl-b82d step 15). Public analytics is a run-count and
 * state-distribution view: how much work this instance does, how much of
 * it lands, and how many tokens it burns doing so.
 *
 * Three allowlists, one per nesting level, so a field added to `RunMetrics`,
 * `RunTotals` or `RunGroupBucket` tomorrow is absent from the public body
 * until someone classifies it — see `src/server/projection.ts`.
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
	// warren-be04: rates + counts are public (same call as the warren-bd57
	// landed-work fields); the cost halves inside are redacted one level
	// down — see PUBLIC_COST_PER_MERGED_PR_*_FIELDS below.
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
 */
export const REDACTED_RUN_TOTALS_FIELDS = ["cost"] as const satisfies readonly (keyof RunTotals)[];

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

/** The keyless `overall` shape shares the bucket's classification minus `key`. */
export const PUBLIC_COST_PER_MERGED_PR_OVERALL_FIELDS = [
	"prStateKnown",
	"prsMerged",
] as const satisfies readonly (keyof CostPerMergedPr["overall"])[];

export const REDACTED_COST_PER_MERGED_PR_OVERALL_FIELDS = [
	"costUsd",
	"priced",
	"costPerMergedPrUsd",
] as const satisfies readonly (keyof CostPerMergedPr["overall"])[];

/** The `GET /analytics/runs` body as a `readPublic`-only caller sees it. */
type PublicCostPerMergedPrBucket = Pick<
	CostPerMergedPrBucket,
	(typeof PUBLIC_COST_PER_MERGED_PR_BUCKET_FIELDS)[number]
>;

/** `RunOutcomes` as a spectator sees it: steering intact, USD figures gone. */
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
function projectRunAnalytics(
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

/**
 * `GET /analytics/runs?from=&to=&projectId=` (warren-0692 / pl-ad0f step 2;
 * tokens section added by warren-1244 / pl-d1a2 step 3).
 *
 * Window defaults to the last 30 days when neither bound is supplied,
 * matching `GET /analytics/cost`. Both bounds and `projectId` are
 * validated lightly — a malformed date is a 400 because the
 * lexicographic ISO8601 compare in `listForAnalytics` would silently
 * produce surprising results otherwise.
 *
 * The response includes all `RunMetrics` fields at the top level PLUS a
 * structured `tokens` section that groups token analytics into a single
 * nested object for convenient UI consumption.
 */
export function listRunAnalyticsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const { echo, filter } = parseAnalyticsWindow(ctx);
		const { rows, metrics } = await loadRunMetrics(deps, filter);
		const tokens = buildTokensSection(metrics);
		const outcomes = await loadRunOutcomes(deps, rows, metrics);
		const body: RunAnalyticsBody = { filter: echo, ...metrics, tokens, outcomes };
		return jsonResponse(200, projectRunAnalytics(body, ctx.actor));
	};
}
