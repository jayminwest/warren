/**
 * Ops-overview handler — `GET /ops/overview` (pl-7e38 step 12 / warren-d850).
 *
 * Thin surface over `buildOpsOverview` (`src/runs/ops-overview.ts`): the
 * domain module owns the SQL aggregation, this file only injects the
 * boot-wired service facts and applies the public projection.
 *
 * Public projection (plan risk 1): a `WARREN_AUTH=public` spectator gets a
 * deliberately reduced body — run lifecycle counts only, the same facts the
 * `readPublic` `/runs` listing already discloses. Spend (the instance-wide
 * USD rollup `/analytics/cost` gates as `readOperator`), delivery stats,
 * steering-inbox backlog, and service-health internals are operator-only.
 * The reduction rides `isPublicOnly` + `pickFields`, the same allowlist
 * pattern every other public projection uses (pl-b82d); adding a field to
 * `OpsOverview` tomorrow leaks nothing until it is named here.
 */

import { buildOpsOverview, type OpsOverview, type OpsRunCounts } from "../../runs/ops-overview.ts";
import { isPublicOnly, pickFields } from "../projection.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";

/** The reduced body a `readPublic`-only caller sees. */
export interface PublicOpsOverview {
	readonly runs: Pick<OpsRunCounts, "byState" | "nonTerminal" | "total">;
	readonly generatedAt: string;
}

/** Allowlist projection of the operator body for spectators. */
export function toPublicOpsOverview(body: OpsOverview): PublicOpsOverview {
	return {
		runs: pickFields(body.runs, ["byState", "nonTerminal", "total"]),
		generatedAt: body.generatedAt,
	};
}

export function opsOverviewHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await buildOpsOverview(deps.dbAdapter, {
			runtime: deps.runtimeProvider.kind,
			lifecycleStream: deps.lifecycleStream !== undefined,
		});
		const projected = isPublicOnly(ctx.actor) ? toPublicOpsOverview(body) : body;
		return jsonResponse(200, projected);
	};
}
