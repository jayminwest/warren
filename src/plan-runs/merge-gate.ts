/**
 * Parent-merge gate + merge-wait helpers for the PlanRun coordinator
 * (warren-d9a2 gate, warren-3937 bounded timeout). Extracted from
 * coordinator.ts to keep that module under the file-size ratchet.
 *
 * `checkParentRunMerged` gates an auto-plan-run's first child on the
 * parent run's PR being merged. `mergeDeadlineExceeded` bounds both the
 * parent gate and the child `waiting_for_merge` branch so an
 * open-but-unmergeable PR fails the plan rather than hanging forever.
 */

import { type PlanRunRow, RUN_TERMINAL_STATES, type RunRow } from "../db/schema.ts";
import type { AdvanceResult, CoordinatorEmitFn, CoordinatorRepos } from "./coordinator.ts";
import type { PrMergeChecker } from "./pr-merge.ts";

/**
 * Gate auto-plan-runs on the parent run's PR being merged (warren-d9a2).
 * Returns null when the gate passes (proceed to child dispatch) or an
 * AdvanceResult when the gate blocks or fails the plan-run.
 */
export async function checkParentRunMerged(input: {
	readonly planRun: PlanRunRow;
	readonly repos: CoordinatorRepos;
	readonly checkPrMerged: PrMergeChecker;
	readonly emit: CoordinatorEmitFn;
	readonly mergeTimeoutMs: number;
	readonly now: () => Date;
}): Promise<AdvanceResult | null> {
	const { planRun, repos, checkPrMerged, emit, mergeTimeoutMs, now } = input;
	const parentRunId = planRun.parentRunId;
	if (parentRunId === null) return null;

	const parentRun = await repos.runs.get(parentRunId);
	if (parentRun === null) {
		// Parent run row deleted — treat as gate-passed (best-effort).
		return null;
	}

	if (parentRun.prUrl === null) {
		// No PR — check for trivial (empty push) merge.
		const trivial = await hasEmptyPushEvent(repos, parentRunId);
		if (trivial) return null;
		// Parent still running or hasn't pushed yet — wait.
		if (!isTerminalRun(parentRun)) return { kind: "waiting_for_parent_merge" };
		// Terminal with no PR and no empty-push → nothing to merge from.
		// Fail the plan-run so it doesn't hang indefinitely.
		return failParentGate({
			planRun,
			repos,
			emit,
			parentRunId,
			now,
			reason: "parent_pr_not_merged",
		});
	}

	const polled = await checkPrMerged(parentRun.prUrl);
	if (polled.kind === "merged") return null;
	if (polled.kind === "open") {
		// warren-3937: an open-but-unmergeable parent PR (failing required
		// checks, BLOCKED mergeStateStatus, stuck auto-merge) would otherwise
		// block the plan forever. Bound the wait by a wall-clock budget that
		// starts when the parent run ended (PR-open time), then fail.
		if (mergeDeadlineExceeded(parentRun.endedAt, now, mergeTimeoutMs)) {
			return failParentGate({
				planRun,
				repos,
				emit,
				parentRunId,
				now,
				reason: "parent_pr_merge_timeout",
				prUrl: parentRun.prUrl,
			});
		}
		return { kind: "waiting_for_parent_merge" };
	}
	if (polled.kind === "closed_unmerged" || isFatalHttpError(polled)) {
		return failParentGate({
			planRun,
			repos,
			emit,
			parentRunId,
			now,
			reason: "parent_pr_not_merged",
			prUrl: parentRun.prUrl,
		});
	}
	// Transient error / missing token — keep waiting.
	return { kind: "waiting_for_parent_merge" };
}

/**
 * Fail a plan-run that's blocked on its parent run's PR (warren-3937).
 * Transitions the plan-run to `failed` and surfaces the reason as a
 * `plan_run.failed` system event on the parent run's stream — the only
 * run with events at this point, since no child has been dispatched.
 */
async function failParentGate(input: {
	readonly planRun: PlanRunRow;
	readonly repos: CoordinatorRepos;
	readonly emit: CoordinatorEmitFn;
	readonly parentRunId: string;
	readonly now: () => Date;
	readonly reason: string;
	readonly prUrl?: string;
}): Promise<AdvanceResult> {
	const { planRun, repos, emit, parentRunId, now, reason, prUrl } = input;
	const endedAt = now().toISOString();
	await repos.planRuns.transitionTo(planRun.id, "failed", { endedAt, failureReason: reason });
	await emit(parentRunId, "plan_run.failed", {
		planRunId: planRun.id,
		failedSeq: 0,
		reason,
		...(prUrl !== undefined ? { prUrl } : {}),
	});
	return { kind: "plan_failed", failedSeq: 0, reason };
}

/**
 * Has a PR exceeded its merge-wait budget (warren-3937)? The clock starts
 * when the producing run ended (the PR-open moment). Returns false when the
 * timeout is disabled (≤ 0), the run hasn't ended, or the timestamp is
 * unparseable — i.e. err toward waiting rather than a spurious failure.
 */
export function mergeDeadlineExceeded(
	endedAt: string | null,
	now: () => Date,
	timeoutMs: number,
): boolean {
	if (timeoutMs <= 0) return false;
	if (endedAt === null) return false;
	const ended = Date.parse(endedAt);
	if (Number.isNaN(ended)) return false;
	return now().getTime() - ended >= timeoutMs;
}

export function isFatalHttpError(result: {
	kind: string;
	status?: number;
}): result is { kind: "http_error"; status: number; message: string } {
	return (
		result.kind === "http_error" &&
		typeof result.status === "number" &&
		result.status >= 400 &&
		result.status < 500
	);
}

export function isTerminalRun(run: RunRow): boolean {
	return (RUN_TERMINAL_STATES as readonly string[]).includes(run.state);
}

/**
 * Walk warren's persisted event stream for the child's run looking for the
 * `reap.empty_push` system event (mx-ab8532). Presence ⇒ commitsAhead===0,
 * which is the trivial-merge signal the coordinator advances on directly.
 *
 * Listed in increasing seq order; the event always lands once per run if it
 * fires, so a linear scan with no limit is fine — runs that produce
 * thousands of events have already paid the persistence cost.
 */
export async function hasEmptyPushEvent(repos: CoordinatorRepos, runId: string): Promise<boolean> {
	const events = await repos.events.listByRun(runId);
	for (const ev of events) {
		if (ev.kind === "reap.empty_push") return true;
	}
	return false;
}
