/**
 * Dispatch-context analytics handler (warren-5423 / pl-a37b Track A step 5).
 *
 * Thin `RouteHandler` over the pure `buildDispatchAnalytics` aggregator.
 * Windows on `dispatch_context.created_at` (via
 * `DispatchContextRepo.listForAnalytics`) so never-started dispatches stay
 * in the report — `RunsRepo.listForAnalytics` clips on `started_at` and
 * would drop them. Reuses `parseAnalyticsWindow` for the shared
 * `?from`/`?to`/`?projectId` contract. Facts and counts only.
 */

import {
	buildDispatchAnalytics,
	type DispatchAnalytics,
} from "../../../runs/analytics/dispatch-analytics.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { parseAnalyticsWindow } from "./analytics.ts";

/** The full `GET /analytics/dispatch` body an operator receives. */
export interface DispatchAnalyticsBody extends DispatchAnalytics {
	readonly filter: { projectId: string | null; from: string | null; to: string | null };
}

/**
 * `GET /analytics/dispatch?from=&to=&projectId=` (warren-5423).
 *
 * Descriptive read surface over the dispatch_context log: joined run
 * outcomes plus grouped counts by origin, retry kind, provider/model, and
 * queue depth at dispatch. No scores, no recommendations.
 */
export function listDispatchAnalyticsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const { echo, filter } = parseAnalyticsWindow(ctx);
		const rows = await deps.repos.dispatchContext.listForAnalytics(filter);
		const analytics = buildDispatchAnalytics(rows);
		const body: DispatchAnalyticsBody = { filter: echo, ...analytics };
		return jsonResponse(200, body);
	};
}
