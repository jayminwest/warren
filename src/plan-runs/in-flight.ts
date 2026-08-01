/**
 * In-flight child handling for the PlanRun coordinator (extracted from
 * coordinator.ts to keep that file under its size budget).
 *
 * `handleInFlight` is the merge/PR-poll half of the coordinator's decision
 * loop: given the one in-flight child, it advances the child's state
 * (running → pr_open → merged / failed) and returns either `{kind:"merged"}`
 * (so the caller falls through to dispatch the next child) or a terminal
 * `AdvanceResult`.
 */

import type { PlanRunChildRow, PlanRunRow, RunRow } from "../db/schema.ts";
import { SeedNotFoundError } from "../seeds-cli/index.ts";
import type {
	AdvanceResult,
	CoordinatorCloseChildSeedFn,
	CoordinatorEmitFn,
	CoordinatorRepos,
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

export interface HandleInFlightInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly repos: CoordinatorRepos;
	readonly checkPrMerged: PrMergeChecker;
	readonly emit: CoordinatorEmitFn;
	readonly showSeed: CoordinatorShowSeedFn;
	readonly mergeTimeoutMs: number;
	readonly now: () => Date;
	readonly reopenPr?: CoordinatorReopenPrFn; // warren-22de: (re)open PR before failing
	readonly closeChildSeed?: CoordinatorCloseChildSeedFn; // warren-3806: host-side seed close on merge
}

/**
 * warren-3806: fire the host-side child-seed close the instant a child
 * transitions to `merged`. Best-effort — the seam owns its own error
 * handling, so this never throws into the coordinator loop.
 */
async function fireCloseChildSeed(input: HandleInFlightInput): Promise<void> {
	if (input.closeChildSeed === undefined) return;
	await input.closeChildSeed({ planRun: input.planRun, child: input.child });
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
		return await resolveEmptyPush(input, run);
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

type ChildSeedResolution = "resolved" | "unresolved" | "transient";

/**
 * warren-2a8c: is the in-flight child's seed still resolvable? An empty
 * push is only a *trivial merge* when the agent had a real work item and
 * legitimately produced no diff. A child whose seed does not resolve
 * (the K8s durability failure of warren-486c, a typo'd id, a wrong repo,
 * an unmerged branch) pushed nothing because it *could not do the work* —
 * that must fail with a typed reason, not be scored a phantom success.
 *
 * Only a definitive `SeedNotFoundError` is terminal; any other (transient:
 * timeout / lock / malformed) failure stays retryable so a flaky seed
 * store never converts a genuine trivial merge into a spurious failure.
 * This mirrors the dispatch-arm semantics in coordinator.ts.
 */
async function resolveChildSeed(input: HandleInFlightInput): Promise<ChildSeedResolution> {
	try {
		await input.showSeed(input.planRun.projectId, input.child.seedId);
		return "resolved";
	} catch (err) {
		return err instanceof SeedNotFoundError ? "unresolved" : "transient";
	}
}

/**
 * Settle a succeeded child that pushed nothing (`reap.empty_push`). Merges
 * trivially only when the child's seed resolved (warren-2a8c); otherwise
 * fails terminally with `child_seed_not_resolved:<seedId>` (unresolved) or
 * retries next tick (transient seed-store failure).
 */
async function resolveEmptyPush(input: HandleInFlightInput, run: RunRow): Promise<PrUrlResolution> {
	const { repos, planRun, child, emit, now } = input;
	const seed = await resolveChildSeed(input);
	if (seed === "unresolved") {
		return {
			kind: "decision",
			decision: await failChild(input, run, `child_seed_not_resolved:${child.seedId}`),
		};
	}
	if (seed === "transient") {
		return {
			kind: "decision",
			decision: {
				kind: "result",
				result: { kind: "noop", reason: `seed_check_failed:${run.id}` },
			},
		};
	}
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
	});
	await fireCloseChildSeed(input);
	return { kind: "decision", decision: { kind: "merged" } };
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
		});
		await fireCloseChildSeed(input);
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
	// `missing_token`, `rate_limited` (429 that survived pr-merge.ts
	// retries), or transient `http_error` (status 0 or 5xx) — keep waiting.
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
