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

import type { PlanRunChildRow, PlanRunRow, RunRow } from "../db/schema.ts";
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

/**
 * Mark the in-flight child + its plan failed and emit `plan_run.failed`.
 * Shared by every terminal-failure arm of handleInFlight so each caller
 * stays a single statement and the whole module clears cognitive-complexity
 * 15 (warren-00c8). `extra` carries arm-specific event fields (`prUrl`,
 * `httpStatus`).
 */
async function failChild(
	input: HandleInFlightInput,
	run: RunRow,
	reason: string,
	extra: Record<string, unknown> = {},
): Promise<HandleInFlightDecision> {
	const { repos, planRun, child, emit, now } = input;
	const endedAt = now().toISOString();
	await repos.planRuns.updateChild({
		planRunId: planRun.id,
		seq: child.seq,
		patch: { state: "failed", endedAt, failureReason: reason },
		now: now(),
	});
	await repos.planRuns.transitionTo(planRun.id, "failed", { endedAt, failureReason: reason });
	await emit(run.id, "plan_run.failed", {
		planRunId: planRun.id,
		failedSeq: child.seq,
		reason,
		...extra,
	});
	return { kind: "result", result: { kind: "plan_failed", failedSeq: child.seq, reason } };
}

/**
 * Non-terminal run: sync child.state with run.state so the UI sees
 * `running` after burrow emits its first event (idempotent write), then
 * wait for the run to terminate.
 */
async function handleNonTerminalRun(
	input: HandleInFlightInput,
	run: RunRow,
): Promise<HandleInFlightDecision> {
	const { repos, planRun, child, now } = input;
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

type PrUrlResolution =
	| { readonly kind: "decision"; readonly decision: HandleInFlightDecision }
	| { readonly kind: "url"; readonly url: string };

/**
 * First observation of a succeeded child whose run carries no PR URL:
 * decide trivial-merge vs. (re)opened PR, retrying the reap-time pr_open
 * within the merge budget (warren-22de).
 */
async function resolveMissingPrUrl(
	input: HandleInFlightInput,
	run: RunRow,
): Promise<PrUrlResolution> {
	const { repos, planRun, child, emit, mergeTimeoutMs, now, reopenPr } = input;
	if (await hasEmptyPushEvent(repos, run.id)) {
		const mergedAt = now().toISOString();
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			patch: { state: "merged", prMergedAt: mergedAt, endedAt: mergedAt },
			now: now(),
		});
		await emit(run.id, "plan_run.merged", {
			planRunId: planRun.id,
			mergedChildSeq: child.seq,
			trivial: true,
			...(await resolveExecutionFields(planRun, child, input.showSeed, input.resolveExecution)),
		});
		return { kind: "decision", decision: { kind: "merged" } };
	}
	const prReopen = await resolveChildPrReopen({ run, mergeTimeoutMs, now, reopenPr });
	if (prReopen.kind === "expired") {
		return {
			kind: "decision",
			decision: await failChild(input, run, "child_succeeded_without_pr"),
		};
	}
	if (prReopen.kind === "pending") {
		await emit(run.id, "plan_run.waiting_for_pr_reopen", { planRunId: planRun.id, seq: child.seq });
		return {
			kind: "decision",
			decision: { kind: "result", result: { kind: "noop", reason: `pr_reopen_pending:${run.id}` } },
		};
	}
	await repos.runs.setPrUrl(run.id, prReopen.url);
	return { kind: "url", url: prReopen.url };
}

type FirstObservation =
	| { readonly kind: "decision"; readonly decision: HandleInFlightDecision }
	| { readonly kind: "continue"; readonly effectivePrUrl: string | null };

/**
 * Advance a succeeded child to `pr_open` (or settle it as a trivial merge /
 * failure). Returns a terminal decision, or `continue` with the PR URL to
 * poll. Children already in `pr_open` fall straight through to polling.
 */
async function handleFirstObservation(
	input: HandleInFlightInput,
	run: RunRow,
): Promise<FirstObservation> {
	const { repos, planRun, child, now } = input;
	if (child.state === "pr_open") {
		return { kind: "continue", effectivePrUrl: run.prUrl };
	}
	let effectivePrUrl = run.prUrl;
	if (effectivePrUrl === null) {
		const resolved = await resolveMissingPrUrl(input, run);
		if (resolved.kind === "decision") {
			return resolved;
		}
		effectivePrUrl = resolved.url;
	}
	// Real PR (or reopened URL) — flip to pr_open and fall through to poll.
	await repos.planRuns.updateChild({
		planRunId: planRun.id,
		seq: child.seq,
		patch: { state: "pr_open" },
		now: now(),
	});
	return { kind: "continue", effectivePrUrl };
}

/**
 * A PR that is still open: fail the plan once it passes the merge budget
 * (warren-3937 — failing checks / BLOCKED / stuck auto-merge), otherwise
 * keep waiting. The clock starts when the child run ended.
 */
async function handleOpenPr(
	input: HandleInFlightInput,
	run: RunRow,
	effectivePrUrl: string,
): Promise<HandleInFlightDecision> {
	const { emit, planRun, child, mergeTimeoutMs, now } = input;
	if (mergeDeadlineExceeded(run.endedAt, now, mergeTimeoutMs)) {
		return await failChild(input, run, "child_pr_merge_timeout", { prUrl: effectivePrUrl });
	}
	await emit(run.id, "plan_run.waiting_for_merge", {
		planRunId: planRun.id,
		seq: child.seq,
		prUrl: effectivePrUrl,
	});
	return { kind: "result", result: { kind: "waiting_for_merge" } };
}

/**
 * Poll the child PR's merge state and settle the child accordingly:
 * merged → fall through to dispatch, open → wait/timeout, closed/fatal →
 * fail, transient → keep waiting.
 */
async function pollMergeState(
	input: HandleInFlightInput,
	run: RunRow,
	effectivePrUrl: string | null,
): Promise<HandleInFlightDecision> {
	const { repos, planRun, child, emit, checkPrMerged, now } = input;
	if (effectivePrUrl === null) {
		return { kind: "result", result: { kind: "noop", reason: `pr_open_without_pr_url:${run.id}` } };
	}
	const polled = await checkPrMerged(effectivePrUrl);
	if (polled.kind === "merged") {
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			patch: { state: "merged", prMergedAt: polled.mergedAt, endedAt: now().toISOString() },
			now: now(),
		});
		await emit(run.id, "plan_run.merged", {
			planRunId: planRun.id,
			mergedChildSeq: child.seq,
			prUrl: effectivePrUrl,
			mergedAt: polled.mergedAt,
			...(await resolveExecutionFields(planRun, child, input.showSeed, input.resolveExecution)),
		});
		return { kind: "merged" };
	}
	if (polled.kind === "open") {
		return await handleOpenPr(input, run, effectivePrUrl);
	}
	if (polled.kind === "closed_unmerged" || isFatalHttpError(polled)) {
		const extra: Record<string, unknown> = { prUrl: effectivePrUrl };
		if (polled.kind === "http_error") {
			extra.httpStatus = polled.status;
		}
		return await failChild(input, run, "pr_closed_without_merge", extra);
	}
	// `missing_token` or transient `http_error` (status 0 or 5xx that
	// survived pr-merge.ts retries) — keep waiting.
	return { kind: "result", result: { kind: "waiting_for_merge" } };
}

export async function handleInFlight(input: HandleInFlightInput): Promise<HandleInFlightDecision> {
	const { child, repos } = input;
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
		return await handleNonTerminalRun(input, run);
	}
	if (run.state === "failed" || run.state === "cancelled") {
		return await failChild(input, run, `child_${run.failureReason ?? run.state}`);
	}
	// run.state === 'succeeded': advance to pr_open, then poll the PR.
	const firstObs = await handleFirstObservation(input, run);
	if (firstObs.kind === "decision") {
		return firstObs.decision;
	}
	return await pollMergeState(input, run, firstObs.effectivePrUrl);
}
