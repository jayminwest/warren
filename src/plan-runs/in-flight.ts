/**
 * In-flight child handling + execution-routing helpers for the PlanRun
 * coordinator (extracted from coordinator.ts to keep that file under its
 * size budget; pl-fb43 step 5 / warren-d9f3).
 *
 * `handleInFlight` is the merge/PR-poll half of the coordinator's decision
 * loop: given the one in-flight child, it advances the child's state
 * (running → pr_open → merged / failed) and returns either `{kind:"merged"}`
 * (so the caller falls through to dispatch the next child) or a terminal
 * `AdvanceResult`. The execution-routing helpers (`executionFields`,
 * `resolveExecutionFields`, `defaultResolveExecution`, `failChildAndPlan`)
 * are shared between this module and the dispatch arm in coordinator.ts.
 */

import type { PlanRunChildRow, PlanRunRow } from "../db/schema.ts";
import type {
	AdvanceResult,
	ChildExecution,
	CoordinatorEmitFn,
	CoordinatorRepos,
	CoordinatorResolveExecutionFn,
	CoordinatorShowSeedFn,
} from "./coordinator.ts";
import {
	type CoordinatorReopenPrFn,
	hasEmptyPushEvent,
	isFatalHttpError,
	isTerminalRun,
	mergeDeadlineExceeded,
	resolveChildPrReopen,
} from "./merge-gate.ts";
import type { PrMergeChecker } from "./pr-merge.ts";

export const defaultResolveExecution: CoordinatorResolveExecutionFn = async (planRun) => ({
	executionProjectId: planRun.projectId,
	repoRef: null,
});

/**
 * Legibility fields stamped onto `plan_run.dispatched/advanced/merged`
 * event payloads (and the Plot mirror) so a human tailing events — or an
 * agent reading the coordination Plot — can see which repo each child
 * targeted without cross-referencing the run row (pl-fb43 step 5).
 */
export function executionFields(execution: ChildExecution): Record<string, unknown> {
	return {
		executionProjectId: execution.executionProjectId,
		...(execution.repoRef !== null ? { repo: execution.repoRef } : {}),
	};
}

/**
 * Best-effort execution fields for events emitted after the dispatch tick
 * (the `merged` payloads in handleInFlight). The child was dispatched in a
 * prior tick so the spawn-time `ChildExecution` is no longer in hand;
 * re-resolve from the seed. Legibility-only — any failure yields `{}` so a
 * transient seed read never fails an already-merged child.
 */
async function resolveExecutionFields(
	planRun: PlanRunRow,
	child: PlanRunChildRow,
	showSeed: CoordinatorShowSeedFn,
	resolveExecution: CoordinatorResolveExecutionFn,
): Promise<Record<string, unknown>> {
	try {
		const seed = await showSeed(planRun.projectId, child.seedId);
		return executionFields(await resolveExecution(planRun, seed.extensions));
	} catch {
		return {};
	}
}

export interface FailChildAndPlanInput {
	readonly repos: CoordinatorRepos;
	readonly planRun: PlanRunRow;
	readonly seq: number;
	readonly anchorRunId: string | null;
	readonly reason: string;
	readonly emit: CoordinatorEmitFn;
	readonly now: () => Date;
}

/**
 * Mark a child + its plan failed and emit `plan_run.failed` on the anchor
 * run (when one exists). Shared by the dispatch-time failure paths
 * (pl-fb43 step 5 unresolved-repo) so advancePlanRun stays under the
 * cognitive-complexity ceiling.
 */
export async function failChildAndPlan(input: FailChildAndPlanInput): Promise<AdvanceResult> {
	const endedAt = input.now().toISOString();
	await input.repos.planRuns.updateChild({
		planRunId: input.planRun.id,
		seq: input.seq,
		patch: { state: "failed", failureReason: input.reason, endedAt },
		now: input.now(),
	});
	await input.repos.planRuns.transitionTo(input.planRun.id, "failed", {
		endedAt,
		failureReason: input.reason,
	});
	if (input.anchorRunId !== null) {
		await input.emit(input.anchorRunId, "plan_run.failed", {
			planRunId: input.planRun.id,
			failedSeq: input.seq,
			reason: input.reason,
		});
	}
	return { kind: "plan_failed", failedSeq: input.seq, reason: input.reason };
}

export interface HandleInFlightInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly repos: CoordinatorRepos;
	readonly checkPrMerged: PrMergeChecker;
	readonly emit: CoordinatorEmitFn;
	readonly showSeed: CoordinatorShowSeedFn;
	readonly resolveExecution: CoordinatorResolveExecutionFn;
	readonly mergeTimeoutMs: number;
	readonly now: () => Date;
	readonly reopenPr?: CoordinatorReopenPrFn; // warren-22de: (re)open PR before failing
}

export type HandleInFlightDecision =
	| { readonly kind: "merged" }
	| { readonly kind: "result"; readonly result: AdvanceResult };

export async function handleInFlight(input: HandleInFlightInput): Promise<HandleInFlightDecision> {
	const { planRun, child, repos, checkPrMerged, emit, mergeTimeoutMs, now, reopenPr } = input;
	const { showSeed, resolveExecution } = input;
	if (child.runId === null) {
		return {
			kind: "result",
			result: { kind: "noop", reason: `in_flight_child_missing_run_id:${child.seq}` },
		};
	}
	const run = await repos.runs.get(child.runId);
	if (run === null) {
		return {
			kind: "result",
			result: { kind: "noop", reason: `in_flight_child_run_not_found:${child.runId}` },
		};
	}

	if (!isTerminalRun(run)) {
		// Sync child.state with run.state so the UI sees `running` after
		// burrow emits its first event. Idempotent — the repo's updateChild
		// is a plain write.
		if (run.state === "running" && child.state === "dispatched") {
			await repos.planRuns.updateChild({
				planRunId: planRun.id,
				seq: child.seq,
				patch: { state: "running" },
				now: now(),
			});
		}
		return { kind: "result", result: { kind: "waiting_for_run" } };
	}

	if (run.state === "failed" || run.state === "cancelled") {
		const detail = run.failureReason ?? run.state;
		const reason = `child_${detail}`;
		const endedAt = now().toISOString();
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			patch: { state: "failed", endedAt, failureReason: reason },
			now: now(),
		});
		await repos.planRuns.transitionTo(planRun.id, "failed", {
			endedAt,
			failureReason: reason,
		});
		await emit(child.runId, "plan_run.failed", {
			planRunId: planRun.id,
			failedSeq: child.seq,
			reason,
		});
		return {
			kind: "result",
			result: { kind: "plan_failed", failedSeq: child.seq, reason },
		};
	}

	// run.state === 'succeeded': effectivePrUrl updated by reopenPr (warren-22de) falls through to polling.
	let effectivePrUrl = run.prUrl;

	if (child.state !== "pr_open") {
		// First observation. Decide pr_open vs trivial-merge.
		if (effectivePrUrl === null) {
			const trivial = await hasEmptyPushEvent(repos, child.runId);
			if (trivial) {
				const mergedAt = now().toISOString();
				await repos.planRuns.updateChild({
					planRunId: planRun.id,
					seq: child.seq,
					patch: { state: "merged", prMergedAt: mergedAt, endedAt: mergedAt },
					now: now(),
				});
				await emit(child.runId, "plan_run.merged", {
					planRunId: planRun.id,
					mergedChildSeq: child.seq,
					trivial: true,
					...(await resolveExecutionFields(planRun, child, showSeed, resolveExecution)),
				});
				return { kind: "merged" };
			}
			// warren-22de: reap's pr_open may fail transiently; retry within budget.
			const prReopen = await resolveChildPrReopen({ run, mergeTimeoutMs, now, reopenPr });
			if (prReopen.kind === "expired") {
				const reason = "child_succeeded_without_pr";
				const endedAt = now().toISOString();
				await repos.planRuns.updateChild({
					planRunId: planRun.id,
					seq: child.seq,
					patch: { state: "failed", endedAt, failureReason: reason },
					now: now(),
				});
				await repos.planRuns.transitionTo(planRun.id, "failed", { endedAt, failureReason: reason });
				await emit(child.runId, "plan_run.failed", {
					planRunId: planRun.id,
					failedSeq: child.seq,
					reason,
				});
				return { kind: "result", result: { kind: "plan_failed", failedSeq: child.seq, reason } };
			}
			if (prReopen.kind === "pending") {
				await emit(child.runId, "plan_run.waiting_for_pr_reopen", {
					planRunId: planRun.id,
					seq: child.seq,
				});
				return { kind: "result", result: { kind: "noop", reason: `pr_reopen_pending:${run.id}` } };
			}
			await repos.runs.setPrUrl(run.id, prReopen.url);
			effectivePrUrl = prReopen.url;
		}
		// Real PR (or reopened URL) — flip to pr_open and fall through to poll.
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			patch: { state: "pr_open" },
			now: now(),
		});
	}

	// pr_open: poll merge state.
	if (effectivePrUrl === null) {
		return {
			kind: "result",
			result: { kind: "noop", reason: `pr_open_without_pr_url:${child.runId}` },
		};
	}
	const polled = await checkPrMerged(effectivePrUrl);
	if (polled.kind === "merged") {
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			patch: { state: "merged", prMergedAt: polled.mergedAt, endedAt: now().toISOString() },
			now: now(),
		});
		await emit(child.runId, "plan_run.merged", {
			planRunId: planRun.id,
			mergedChildSeq: child.seq,
			prUrl: effectivePrUrl,
			mergedAt: polled.mergedAt,
			...(await resolveExecutionFields(planRun, child, showSeed, resolveExecution)),
		});
		return { kind: "merged" };
	}
	if (polled.kind === "open") {
		// warren-3937: a PR that stays open past the merge budget (failing
		// required checks / BLOCKED / stuck auto-merge) fails the plan rather
		// than waiting forever. The clock starts when the child run ended.
		if (mergeDeadlineExceeded(run.endedAt, now, mergeTimeoutMs)) {
			const reason = "child_pr_merge_timeout";
			const endedAt = now().toISOString();
			await repos.planRuns.updateChild({
				planRunId: planRun.id,
				seq: child.seq,
				patch: { state: "failed", endedAt, failureReason: reason },
				now: now(),
			});
			await repos.planRuns.transitionTo(planRun.id, "failed", {
				endedAt,
				failureReason: reason,
			});
			await emit(child.runId, "plan_run.failed", {
				planRunId: planRun.id,
				failedSeq: child.seq,
				reason,
				prUrl: effectivePrUrl,
			});
			return {
				kind: "result",
				result: { kind: "plan_failed", failedSeq: child.seq, reason },
			};
		}
		await emit(child.runId, "plan_run.waiting_for_merge", {
			planRunId: planRun.id,
			seq: child.seq,
			prUrl: effectivePrUrl,
		});
		return { kind: "result", result: { kind: "waiting_for_merge" } };
	}
	if (polled.kind === "closed_unmerged" || isFatalHttpError(polled)) {
		const reason = "pr_closed_without_merge";
		const endedAt = now().toISOString();
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			patch: { state: "failed", endedAt, failureReason: reason },
			now: now(),
		});
		await repos.planRuns.transitionTo(planRun.id, "failed", {
			endedAt,
			failureReason: reason,
		});
		await emit(child.runId, "plan_run.failed", {
			planRunId: planRun.id,
			failedSeq: child.seq,
			reason,
			prUrl: effectivePrUrl,
			...(polled.kind === "http_error" ? { httpStatus: polled.status } : {}),
		});
		return {
			kind: "result",
			result: { kind: "plan_failed", failedSeq: child.seq, reason },
		};
	}
	// `missing_token` or transient `http_error` (status 0 or 5xx that
	// survived pr-merge.ts retries) — keep waiting.
	return { kind: "result", result: { kind: "waiting_for_merge" } };
}
