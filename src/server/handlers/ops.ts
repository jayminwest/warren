/**
 * Ops-overview handler — `GET /ops/overview` (warren-d850 / pl-7e38 step 12).
 *
 * A thin surface over `buildOpsOverview` (src/ops/overview.ts): the one-poll
 * control-plane snapshot the Operations dashboard (warren-d903) renders.
 * Every aggregate is SQL-side via the boot-wired seams (`deps.dbAdapter`);
 * this handler builds no repos and reads no tables directly.
 *
 * The route policy is `readPublic`, and the body a `readPublic`-only
 * spectator receives is the PUBLIC projection below — the run-state counts
 * and delivery stats already public through `GET /runs` and
 * `GET /analytics/runs`. Spend, inbox, and health are operator-only: the
 * instance-wide USD rollup mirrors `/analytics/cost` (`readOperator`), the
 * inbox counts mirror `/runs/:id/inbox` (`readOperator`), and the health
 * facts mirror `/readyz` (`readOperator`). Acceptance scenario 39 is the
 * leak guard for this reduction.
 */

import { buildOpsOverview, type OpsOverview } from "../../ops/overview.ts";
import { isPublicOnly, pickFields } from "../projection.ts";
import { jsonResponse } from "../response.ts";
import type { Actor, RouteHandler, ServerDeps } from "../types.ts";

/**
 * The ops-overview sections a `readPublic`-only spectator sees. An
 * allowlist, so a section added to `OpsOverview` tomorrow is absent from
 * the public body until someone classifies it here — same rule as
 * `PUBLIC_RUN_FIELDS` and friends.
 */
export const PUBLIC_OPS_OVERVIEW_FIELDS = ["runsByState", "delivery"] as const;

/** The sections the public projection strips (the operator-only halves). */
export const REDACTED_OPS_OVERVIEW_FIELDS = ["spend", "inbox", "health"] as const;

/** The ops-overview snapshot as a `readPublic`-only caller sees it. */
export type PublicOpsOverview = Pick<OpsOverview, (typeof PUBLIC_OPS_OVERVIEW_FIELDS)[number]>;

/**
 * Narrow one overview for `actor`. The operator gets the snapshot
 * untouched; a `readPublic`-only spectator gets the allowlisted copy.
 */
export function projectOpsOverview(
	overview: OpsOverview,
	actor: Actor | undefined,
): OpsOverview | PublicOpsOverview {
	return isPublicOnly(actor) ? pickFields(overview, PUBLIC_OPS_OVERVIEW_FIELDS) : overview;
}

export function opsOverviewHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const overview = await buildOpsOverview({
			...(deps.dbAdapter !== undefined ? { adapter: deps.dbAdapter } : {}),
			...(deps.db !== undefined ? { db: deps.db } : {}),
			runtimeKind: deps.runtimeProvider.kind,
			eventBusWired: deps.lifecycleStream !== undefined,
			...(deps.now !== undefined ? { now: () => deps.now?.().getTime() ?? Date.now() } : {}),
		});
		return jsonResponse(200, { overview: projectOpsOverview(overview, ctx.actor) });
	};
}
