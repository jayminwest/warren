/**
 * Ops-overview handler — `GET /ops/overview` (pl-7e38 step 12 / warren-d850).
 *
 * Thin surface over `buildOpsOverview` (`src/runs/ops-overview.ts`): the
 * domain module owns the SQL aggregation, this file only parses/validates
 * the query string, injects the boot-wired service facts, and applies the
 * public projection.
 *
 * `?window=24h|7d|30d` (warren-7194) selects the trailing window the spend
 * and delivery buckets cover; the default is `24h` and an unknown token is
 * rejected with the same ValidationError shape the `/events` query uses.
 *
 * Public projection (plan risk 1): a `WARREN_AUTH=public` spectator gets a
 * deliberately reduced body — run lifecycle counts, the windowed run count,
 * delivery stats, and the cheap service facts (all already public elsewhere);
 * the instance-wide USD sums (`/analytics/cost` gates as `readOperator`)
 * stay operator-only. The reduction rides `isPublicOnly` + `pickFields`, the
 * same allowlist pattern every other public projection uses (pl-b82d);
 * adding a field to `OpsOverview` tomorrow leaks nothing until it is named
 * here.
 */

import { ValidationError } from "../../core/errors.ts";
import { OPS_WINDOWS, type OpsWindow } from "../../core/wire.ts";
import {
	buildOpsOverview,
	type OpsDelivery,
	type OpsOverview,
	type OpsRunCounts,
} from "../../runs/ops-overview.ts";
import { isPublicOnly, pickFields } from "../projection.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";

/** The reduced body a `readPublic`-only caller sees. */
export interface PublicOpsOverview {
	readonly runs: Pick<OpsRunCounts, "byState" | "nonTerminal" | "total">;
	readonly window: OpsWindow;
	/** Operator-only except the windowed run count (warren-7194). */
	readonly spend: Pick<OpsOverview["spend"], "windowRuns">;
	readonly delivery: OpsDelivery;
	readonly services: Pick<OpsOverview["services"], "runtime" | "dbReachable" | "lifecycleStream">;
	readonly generatedAt: string;
}

/** Allowlist projection of the operator body for spectators. */
export function toPublicOpsOverview(body: OpsOverview): PublicOpsOverview {
	return {
		runs: pickFields(body.runs, ["byState", "nonTerminal", "total"]),
		window: body.window,
		spend: pickFields(body.spend, ["windowRuns"]),
		delivery: pickFields(body.delivery, ["branchesPushed", "prsOpened", "prsMerged"]),
		services: pickFields(body.services, ["runtime", "dbReachable", "lifecycleStream"]),
		generatedAt: body.generatedAt,
	};
}

/** Parse `?window=24h|7d|30d` (default `24h`), rejecting unknown tokens. */
export function parseOpsWindow(ctx: { url: URL }): OpsWindow {
	const raw = ctx.url.searchParams.get("window");
	if (raw === null || raw === "") return "24h";
	if (!(OPS_WINDOWS as readonly string[]).includes(raw)) {
		throw new ValidationError(`?window must be one of ${OPS_WINDOWS.join(", ")}; got '${raw}'`);
	}
	return raw as OpsWindow;
}

export function opsOverviewHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const window = parseOpsWindow(ctx);
		const body = await buildOpsOverview(
			deps.dbAdapter,
			{
				runtime: deps.runtimeProvider.kind,
				lifecycleStream: deps.lifecycleStream !== undefined,
			},
			{ window },
		);
		const projected = isPublicOnly(ctx.actor) ? toPublicOpsOverview(body) : body;
		return jsonResponse(200, projected);
	};
}
