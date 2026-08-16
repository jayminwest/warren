/**
 * Same-row plan-run resume (warren-1eff, Option A).
 *
 * A plan-run fails terminally when a PR waits on a HUMAN merge longer
 * than the merge-wait budget (warren-3937): the child shape
 * (`child_pr_merge_timeout`, the in-flight PR poll in in-flight.ts) or
 * the parent-gate shape (`parent_pr_merge_timeout`, merge-gate.ts
 * checkParentRunMerged). The SPEC §11.P re-dispatch resume doesn't fit:
 * the failed child's seed is already CLOSED while its PR is still
 * unmerged, so a fresh POST /plan-runs would skip it and bypass the
 * per-child merge gate.
 *
 * `resumePlanRun` re-drives the SAME plan-run row instead:
 *
 *   - failed → running, stamping `resumedAt` to now. The merge clock
 *     derives from the later of run.endedAt and planRun.resumedAt
 *     (mergeWaitBaseline in merge-gate.ts), so the stamp re-arms the
 *     budget instead of instantly re-timing out.
 *   - child shape: the timed-out child flips failed → pr_open, keeping
 *     its runId (and thereby its prUrl on the run row). The coordinator's
 *     next tick re-polls the EXISTING PR: merged → advance to the next
 *     child; still open → wait within the fresh budget.
 *   - parent shape: no child exists yet (failedSeq 0), so only the
 *     plan-run row resets; the gate re-polls the parent run's PR.
 *
 * Only the two merge-timeout failure reasons are resumable.
 * pr_closed_without_merge, dispatch_failed, child_seed_not_found and
 * every other failure are genuine failures, not human-merge stalls, and
 * get a typed 409 with no state change.
 */

import { StateTransitionError } from "../core/errors.ts";
import type { PlanRunRow } from "../db/schema.ts";
import type { CoordinatorEmitFn, CoordinatorRepos } from "./coordinator.ts";

/** Failure reasons a same-row resume accepts (warren-1eff). */
export const RESUMABLE_PLAN_RUN_FAILURE_REASONS = [
	"child_pr_merge_timeout",
	"parent_pr_merge_timeout",
] as const;
export type ResumablePlanRunFailureReason = (typeof RESUMABLE_PLAN_RUN_FAILURE_REASONS)[number];

export function isResumablePlanRunFailure(
	reason: string | null,
): reason is ResumablePlanRunFailureReason {
	return (
		reason !== null && (RESUMABLE_PLAN_RUN_FAILURE_REASONS as readonly string[]).includes(reason)
	);
}

export interface ResumePlanRunInput {
	readonly planRunId: string;
	readonly repos: CoordinatorRepos;
	/** Optional system-event seam; mirrors the coordinator's emit wiring. */
	readonly emit?: CoordinatorEmitFn;
	readonly now?: () => Date;
}

export interface ResumePlanRunResult {
	readonly planRun: PlanRunRow;
	readonly reason: ResumablePlanRunFailureReason;
	/** The reset child (child shape only); null for the parent-gate shape. */
	readonly resumedChild: { readonly seq: number; readonly runId: string | null } | null;
}

export async function resumePlanRun(input: ResumePlanRunInput): Promise<ResumePlanRunResult> {
	const nowFn = input.now ?? (() => new Date());
	const planRun = await input.repos.planRuns.require(input.planRunId);
	if (planRun.state !== "failed") {
		throw new StateTransitionError(
			`plan_run not resumable: state is '${planRun.state}', expected 'failed' with a merge-timeout reason`,
		);
	}
	if (!isResumablePlanRunFailure(planRun.failureReason)) {
		throw new StateTransitionError(
			`plan_run not resumable: failureReason '${planRun.failureReason ?? "null"}' is not a merge timeout`,
		);
	}
	const reason = planRun.failureReason;

	let resumedChild: ResumePlanRunResult["resumedChild"] = null;
	if (reason === "child_pr_merge_timeout") {
		const children = await input.repos.planRuns.listChildren(planRun.id);
		const child = children.find((c) => c.state === "failed" && c.failureReason === reason);
		if (child === undefined) {
			throw new StateTransitionError(`plan_run not resumable: no failed child carries '${reason}'`);
		}
		const updated = await input.repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			// Back to pr_open with the runId (and the run row's prUrl)
			// preserved; clear the failure marker + stale endedAt.
			patch: { state: "pr_open", failureReason: null, endedAt: null },
			now: nowFn(),
		});
		resumedChild = { seq: updated.seq, runId: updated.runId };
	}

	const resumedAt = nowFn().toISOString();
	const resumed = await input.repos.planRuns.transitionTo(planRun.id, "running", {
		endedAt: null,
		failureReason: null,
		resumedAt,
	});

	// Surface the resume on the run stream the operator is already tailing:
	// the timed-out child's run, or the parent run for the gate shape.
	const anchor = resumedChild?.runId ?? planRun.parentRunId;
	if (anchor !== null && input.emit !== undefined) {
		await input.emit(anchor, "plan_run.resumed", {
			planRunId: planRun.id,
			reason,
			...(resumedChild !== null ? { seq: resumedChild.seq } : {}),
		});
	}

	return { planRun: resumed, reason, resumedChild };
}
