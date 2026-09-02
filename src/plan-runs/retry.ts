/**
 * Automatic child retry decision (warren-6de9).
 *
 * A transient provider 5xx on ONE plan-run child used to fail the entire
 * plan-run terminally (`child_provider_error`), costing a full operator
 * re-dispatch per occurrence (observed live on pl-61a4). The coordinator
 * now re-dispatches the failed child ONCE automatically — fresh run, same
 * seed, same prompt — before declaring the plan-run failed.
 *
 * The decision is factored into two pure predicates so a second retryable
 * failure cause joins by appending to {@link RETRYABLE_CHILD_FAILURE_REASONS}
 * — no coordinator surgery required. warren-4af7 did exactly that: an
 * infra-lost child run (`sandbox_run_lost` — the sandbox/pod vanished under a
 * healthy run) earns the same single automatic re-dispatch. The run-level
 * retry (`src/runs/retry/infra-lost-retry.ts`) stands down on plan-run children (it checks
 * `planRuns.findChildByRunId`) so a child never double-retries.
 *
 * The retry budget is per-child, not per-plan, and is persisted on the
 * child row (`plan_run_children.retry_count`) so a coordinator restart or
 * a re-driven tick never grants a child a fresh retry.
 */

import type { RunFailureReason } from "../core/wire.ts";
import type { PlanRunChildRow } from "../db/schema.ts";

/**
 * Failure causes that justify one automatic child re-dispatch. A
 * `provider_error` (warren-edc3) means the agent's terminal model turn
 * ended on an upstream provider fault — the workspace, prompt, and seed
 * are all still valid, so a fresh run has a real chance of succeeding.
 */
export const RETRYABLE_CHILD_FAILURE_REASONS = [
	"provider_error",
	// warren-4af7: infra-lost — the sandbox/pod disappeared mid-run with the
	// warren row still live. The workspace is gone but the failure says
	// nothing about the prompt or seed, so a fresh run has a real chance.
	// warren-4af7: infra-lost — the sandbox/pod disappeared mid-run with the
	// warren row still live. The workspace is gone but the failure says
	// nothing about the prompt or seed, so a fresh run has a real chance.
	"sandbox_run_lost",
	// warren-ea4b: Spot preemption — the same substrate-lost shape (the pod
	// died because GKE reclaimed its node), kept a distinct reason so
	// telemetry can tell capacity reclamation apart from a generic loss.
	"preempted",
] as const satisfies readonly RunFailureReason[];

export type RetryableChildFailureReason = (typeof RETRYABLE_CHILD_FAILURE_REASONS)[number];

/** One automatic retry per child per plan-run (warren-6de9). */
export const MAX_CHILD_RETRIES = 1;

/** Is this run failure cause worth one automatic child re-dispatch? */
export function isRetryableChildFailure(
	reason: RunFailureReason | null,
): reason is RetryableChildFailureReason {
	return reason !== null && (RETRYABLE_CHILD_FAILURE_REASONS as readonly string[]).includes(reason);
}

/** Has the child still got an automatic retry left? */
export function hasChildRetryBudget(child: PlanRunChildRow): boolean {
	return child.retryCount < MAX_CHILD_RETRIES;
}

/**
 * The single retry decision the coordinator narrows against: retry the
 * child iff its run failed with a retryable cause AND its persisted
 * budget is not yet spent.
 */
export function shouldRetryChild(child: PlanRunChildRow, reason: RunFailureReason | null): boolean {
	return isRetryableChildFailure(reason) && hasChildRetryBudget(child);
}
