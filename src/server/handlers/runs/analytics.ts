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

import { buildRunMetrics, hydrateRunsUsage, type RunMetricsRow } from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import {
	extractProviderModel,
	parseAnalyticsDateBound,
	resolveAnalyticsFrom,
} from "./lifecycle.ts";

/**
 * `GET /analytics/runs?from=&to=&projectId=` (warren-0692 / pl-ad0f step 2).
 *
 * Window defaults to the last 30 days when neither bound is supplied,
 * matching `GET /analytics/cost`. Both bounds and `projectId` are
 * validated lightly — a malformed date is a 400 because the
 * lexicographic ISO8601 compare in `listForAnalytics` would silently
 * produce surprising results otherwise.
 */
export function listRunAnalyticsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const projectId = ctx.url.searchParams.get("projectId") ?? undefined;
		const from = parseAnalyticsDateBound(ctx, "from");
		const to = parseAnalyticsDateBound(ctx, "to");
		const defaultFrom = resolveAnalyticsFrom(from, to);
		const filter: { projectId?: string; from?: string; to?: string } = {};
		if (projectId !== undefined) filter.projectId = projectId;
		if (defaultFrom !== undefined) filter.from = defaultFrom;
		if (to !== undefined) filter.to = to;
		const rowsRaw = await deps.repos.runs.listForAnalytics(filter);
		// Hydrate so terminal runs with bridge-died usage still count.
		const rows = await hydrateRunsUsage(rowsRaw, deps.repos.events);
		const metricsRows: RunMetricsRow[] = rows.map((r) => {
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
				startedAt: r.startedAt,
				endedAt: r.endedAt,
			};
		});
		const metrics = buildRunMetrics(metricsRows);
		return jsonResponse(200, {
			filter: {
				projectId: projectId ?? null,
				from: defaultFrom ?? null,
				to: to ?? null,
			},
			...metrics,
		});
	};
}
