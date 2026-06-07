/**
 * Run analytics handlers (warren-0692 / pl-ad0f step 2).
 *
 * Thin `RouteHandler` factories over the pure `buildRunMetrics`
 * aggregator (`src/runs/analytics/run-metrics.ts`). Mirrors the cost
 * analytics handler exactly: parse + validate the `?from`/`?to`/
 * `?projectId` window, fetch the matching `runs` rows via
 * `RunsRepo.listForAnalytics`, hydrate usage so bridge-died terminal
 * runs still carry cost/token totals, map each row into a flat
 * `RunMetricsRow` (extracting `provider`/`model` from the rendered
 * agent frontmatter), then emit the rollup wrapped in the resolved
 * `filter` echo.
 */

import type { EventsRepo } from "../../../db/repos/events.ts";
import type { RunRow } from "../../../db/schema.ts";
import {
	buildCommandMining,
	buildInsights,
	buildRunMetrics,
	buildSteeringSignals,
	type DimensionTokenSeries,
	hydrateRunsUsage,
	type RunMetrics,
	type RunMetricsRow,
	type TokenBreakdown,
	type TokenDayBucket,
	type ToolEventRow,
} from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import {
	extractProviderModel,
	parseAnalyticsDateBound,
	resolveAnalyticsFrom,
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
 * `from` bound to the last 30 days when neither bound is supplied, matching
 * `GET /analytics/cost`. Both bounds and `projectId` are validated lightly — a
 * malformed date is a 400 because the lexicographic ISO8601 compare in
 * `listForAnalytics` would silently produce surprising results otherwise.
 */
function resolveAnalyticsWindow(ctx: { url: URL }): {
	echo: { projectId: string | null; from: string | null; to: string | null };
	filter: AnalyticsWindow;
} {
	const projectId = ctx.url.searchParams.get("projectId") ?? undefined;
	const from = parseAnalyticsDateBound(ctx, "from");
	const to = parseAnalyticsDateBound(ctx, "to");
	const defaultFrom = resolveAnalyticsFrom(from, to);
	const filter: AnalyticsWindow = {};
	if (projectId !== undefined) filter.projectId = projectId;
	if (defaultFrom !== undefined) filter.from = defaultFrom;
	if (to !== undefined) filter.to = to;
	return {
		echo: { projectId: projectId ?? null, from: defaultFrom ?? null, to: to ?? null },
		filter,
	};
}

/** Map hydrated `runs` rows into the flat aggregator input shape. */
function toMetricsRows(rows: readonly RunRow[]): RunMetricsRow[] {
	return rows.map((r) => {
		const { provider, model } = extractProviderModel(r.renderedAgentJson);
		return {
			runId: r.id,
			projectId: r.projectId,
			agentName: r.agentName,
			provider: provider ?? null,
			model: model ?? null,
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
async function loadRunMetrics(
	deps: ServerDeps,
	filter: AnalyticsWindow,
): Promise<{ rows: RunRow[]; metrics: RunMetrics }> {
	const rowsRaw = await deps.repos.runs.listForAnalytics(filter);
	// Hydrate so terminal runs with bridge-died usage still count.
	const rows = await hydrateRunsUsage(rowsRaw, deps.repos.events);
	return { rows, metrics: buildRunMetrics(toMetricsRows(rows)) };
}

/** Map capped `tool_use`/`tool_result` event rows into the mining input shape. */
async function loadToolEventRows(
	events: EventsRepo,
	runIds: readonly string[],
): Promise<ToolEventRow[]> {
	const rows = await events.listToolEventsForRuns(runIds);
	return rows.map((e) => ({
		runId: e.runId,
		kind: e.kind,
		seq: e.burrowEventSeq,
		payload: e.payloadJson,
	}));
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
		const { echo, filter } = resolveAnalyticsWindow(ctx);
		const { metrics } = await loadRunMetrics(deps, filter);
		const tokens = buildTokensSection(metrics);
		return jsonResponse(200, { filter: echo, ...metrics, tokens });
	};
}

/**
 * `GET /analytics/behavior?from=&to=&projectId=` (warren-5d50 / pl-ad0f step 9).
 *
 * The heavier companion to `GET /analytics/runs`. Resolves the same window,
 * loads the run-level rollup, then scans the capped `tool_use`/`tool_result`
 * event trace for those runs (`EventsRepo.listToolEventsForRuns`) and mines it
 * for the generalized command-frequency / failure / stuck-loop rankings
 * (`buildCommandMining`). Finally distills the metrics + mining into the
 * ranked, severity-coded callout list (`buildInsights`). The run-level rollup
 * itself stays on `/analytics/runs` — this endpoint returns just the behavior
 * layers (`mining` + `insights`) so the fast view can render independently.
 *
 * Steering / pause event kinds scanned when building {@link SteeringSignals}
 * for `buildInsights`. These three event kinds are lightweight (at most a
 * handful per run) so they are fetched in a separate, uncapped query rather
 * than being mixed into the tool-event cap that bounds command mining.
 */
export function listBehaviorAnalyticsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const { echo, filter } = resolveAnalyticsWindow(ctx);
		const { rows, metrics } = await loadRunMetrics(deps, filter);
		const runIds = rows.map((r) => r.id);
		const [eventRows, steeringRows] = await Promise.all([
			loadToolEventRows(deps.repos.events, runIds),
			deps.repos.events.listSteeringAndPauseEventsForRuns(runIds),
		]);
		const mining = buildCommandMining(eventRows);
		const steering = buildSteeringSignals(steeringRows, rows.length);
		const insights = buildInsights({ metrics, mining, steering });
		return jsonResponse(200, { filter: echo, mining, insights });
	};
}
