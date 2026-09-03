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
import type { EventRow, RunRow } from "../../../runs/index.ts";
import {
	buildRunMetrics,
	buildRunOutcomes,
	type DirectoryToolCallRow,
	hydrateRunsUsage,
	type RunMetrics,
	type RunMetricsRow,
	type RunOutcomes,
	type ToolCallMiningRow,
} from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import {
	projectRunAnalytics,
	type RunAnalyticsBody,
	type RunAnalyticsTokensSection,
} from "./analytics.projection.ts";
import {
	extractProviderModel,
	parseAnalyticsDateBound,
	resolveAnalyticsWindow as resolveAnalyticsWindowBounds,
} from "./lifecycle.ts";

// The projection surface (field allowlists, spectator types, and the
// projector) lives in analytics.projection.ts; re-exported here so every
// existing import path keeps resolving.
export {
	PUBLIC_COST_PER_MERGED_PR_BUCKET_FIELDS,
	PUBLIC_COST_PER_MERGED_PR_OVERALL_FIELDS,
	PUBLIC_RUN_ANALYTICS_FIELDS,
	PUBLIC_RUN_GROUP_FIELDS,
	PUBLIC_RUN_TOTALS_FIELDS,
	type PublicRunAnalytics,
	type PublicRunOutcomes,
	REDACTED_COST_PER_MERGED_PR_BUCKET_FIELDS,
	REDACTED_COST_PER_MERGED_PR_OVERALL_FIELDS,
	REDACTED_RUN_ANALYTICS_FIELDS,
	REDACTED_RUN_GROUP_FIELDS,
	REDACTED_RUN_TOTALS_FIELDS,
	type RunAnalyticsBody,
	type RunAnalyticsTokensSection,
} from "./analytics.projection.ts";

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
export function toMetricsRows(
	rows: readonly RunRow[],
	deliveryEvents: readonly EventRow[] = [],
): RunMetricsRow[] {
	// warren-bc9c: newest event ts per (runId, kind) for the two delivery
	// markers; ordered scan makes the last write the newest.
	const branchPushedAt = new Map<string, string>();
	const prOpenedAt = new Map<string, string>();
	for (const e of deliveryEvents) {
		if (e.kind === "reap.branch_pushed") branchPushedAt.set(e.runId, e.ts);
		else if (e.kind === "reap.pr_opened") prOpenedAt.set(e.runId, e.ts);
	}
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
			// warren-bd57: the merge-watcher columns feed landed-work rates
			// directly — no rendered_agent_json re-parse in this path.
			prState: r.prState,
			// warren-bc9c: autonomy + delivery inputs.
			parentRunId: r.parentRunId,
			retryOf: r.retryOf,
			prMergedAt: r.prMergedAt,
			branchPushedAt: branchPushedAt.get(r.id) ?? null,
			prOpenedAt: prOpenedAt.get(r.id) ?? null,
		};
	});
}

const ANALYTICS_DELIVERY_EVENT_KINDS = ["reap.branch_pushed", "reap.pr_opened"] as const;

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
	// warren-bc9c: the persisted `reap.branch_pushed` / `reap.pr_opened`
	// timestamps feed the delivery block; one capped query for the window.
	const deliveryEvents = await deps.repos.events.listEventsByKindsForRuns(
		rows.map((r) => r.id),
		ANALYTICS_DELIVERY_EVENT_KINDS,
	);
	return { rows, metrics: buildRunMetrics(toMetricsRows(rows, deliveryEvents)) };
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
		// warren-ea4e: the cap-hit count comes from the event log, not a run
		// column — there is no cost-cap failure reason to group on.
		const capHitEvents = await deps.repos.events.listByKind("budget.exceeded");
		const body: RunAnalyticsBody = {
			filter: echo,
			...metrics,
			tokens,
			outcomes,
			capHits: capHitEvents.length,
		};
		return jsonResponse(200, projectRunAnalytics(body, ctx.actor));
	};
}
