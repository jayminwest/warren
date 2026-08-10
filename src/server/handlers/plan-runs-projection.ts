/**
 * Public projections for `GET /plan-runs` and `GET /plan-runs/:id`
 * (warren-8793 / pl-61a4 step 3).
 *
 * The plan-run handlers were the last `readPublic` bodies served with no
 * field allowlist: a spectator got the raw `plan_runs` and
 * `plan_run_children` rows, including `promptTemplate` (prompt IP),
 * `dispatcherHandle` (who dispatched), the provider/model overrides, and
 * `failureReason` — a raw internal error string built as
 * `dispatch_failed:${formatError(err)}` that can carry host paths
 * (`src/plan-runs/coordinator.ts`). That is the warren-4385 disclosure
 * class arriving through an unprojected wire field rather than an error
 * envelope.
 *
 * Same rules as every other projection (`src/server/projection.ts`):
 * allowlist never denylist, one construction site, two audiences. A
 * column added to either table tomorrow is absent from the public body
 * until someone classifies it here.
 */

import type { PlanRunChildRow, PlanRunRow } from "../../db/schema.ts";
import { isPublicOnly, pickFields } from "../projection.ts";
import type { Actor } from "../types.ts";

/**
 * The `plan_runs` columns a `readPublic`-only spectator sees. Enough to
 * render "here's the plan, here's how far it got": the row identity, the
 * plan/project/agent it belongs to, its lifecycle state and timestamps.
 */
export const PUBLIC_PLAN_RUN_FIELDS = [
	"id",
	"planId",
	"projectId",
	"agentName",
	"ref",
	"trigger",
	"parentRunId",
	"state",
	"createdAt",
	"startedAt",
	"endedAt",
] as const satisfies readonly (keyof PlanRunRow)[];

/**
 * The complement of `PUBLIC_PLAN_RUN_FIELDS`, spelled out so the
 * classification is a decision on record and
 * `plan-runs.projection.test.ts` can assert the two partition
 * `PlanRunRow`.
 *
 * - `promptTemplate` — the rendered prompt skeleton. Prompt engineering
 *   is the IP here, same posture as `renderedAgentJson` on runs.
 * - `dispatcherHandle` — who kicked the plan-run off. Operator identity
 *   is not spectator business.
 * - `providerOverride` / `modelOverride` / `maxCostUsd` — dispatch-time
 *   config the operator set; noise to a spectator and a hint about
 *   internal provider plumbing and budgets.
 * - `failureReason` — a raw internal error string
 *   (`dispatch_failed:${formatError(err)}`) that can interpolate
 *   subprocess stderr and host paths. Withheld wholesale: the body/log
 *   split (warren-4385) puts that text in the operator logs, not on the
 *   wire. `state: "failed"` already tells the spectator it failed.
 */
export const REDACTED_PLAN_RUN_FIELDS = [
	"promptTemplate",
	"providerOverride",
	"modelOverride",
	"maxCostUsd",
	"dispatcherHandle",
	"failureReason",
] as const satisfies readonly (keyof PlanRunRow)[];

/**
 * The `plan_run_children` columns a spectator sees. The whole row is
 * progress bookkeeping over ids that are already public (`seedId`,
 * `runId`), minus the raw failure text.
 */
export const PUBLIC_PLAN_RUN_CHILD_FIELDS = [
	"planRunId",
	"seq",
	"seedId",
	"runId",
	"state",
	"createdAt",
	"updatedAt",
	"startedAt",
	"endedAt",
	"prMergedAt",
] as const satisfies readonly (keyof PlanRunChildRow)[];

/**
 * The complement of `PUBLIC_PLAN_RUN_CHILD_FIELDS`.
 *
 * - `failureReason` — same raw-error-string posture as the parent row:
 *   logs for operators, never the wire for spectators.
 */
export const REDACTED_PLAN_RUN_CHILD_FIELDS = [
	"failureReason",
] as const satisfies readonly (keyof PlanRunChildRow)[];

/** A `plan_runs` row as a `readPublic`-only caller sees it. */
export type PublicPlanRun = Pick<PlanRunRow, (typeof PUBLIC_PLAN_RUN_FIELDS)[number]>;

/** A `plan_run_children` row as a `readPublic`-only caller sees it. */
export type PublicPlanRunChild = Pick<
	PlanRunChildRow,
	(typeof PUBLIC_PLAN_RUN_CHILD_FIELDS)[number]
>;

/** Narrow one plan-run row for `actor`. Operator: row untouched. */
export function projectPlanRun(
	row: PlanRunRow,
	actor: Actor | undefined,
): PlanRunRow | PublicPlanRun {
	return isPublicOnly(actor) ? pickFields(row, PUBLIC_PLAN_RUN_FIELDS) : row;
}

/** Narrow one plan-run child row for `actor`. Operator: row untouched. */
export function projectPlanRunChild(
	row: PlanRunChildRow,
	actor: Actor | undefined,
): PlanRunChildRow | PublicPlanRunChild {
	return isPublicOnly(actor) ? pickFields(row, PUBLIC_PLAN_RUN_CHILD_FIELDS) : row;
}
