/**
 * Per-PlanRun decision loop (pl-a258 step 5 / warren-2623).
 *
 * `advancePlanRun` is the load-bearing state machine. One call examines
 * the current PlanRun, decides exactly one of:
 *
 *   - dispatch the next pending child
 *   - wait for the in-flight child's run to finish
 *   - wait for the in-flight child's PR to merge
 *   - advance: previous child merged, dispatch the next (or succeed)
 *   - fail the plan (terminal child run, PR closed unmerged, dispatch error)
 *   - succeed the plan (every child reached merged / skipped)
 *   - noop (something unexpected — return diagnostic, don't crash)
 *
 * The state machine is described in warren-2623 step (a)/(b)/(c). Resume
 * semantics (warren-fcc9): a seed that's already `closed` at dispatch
 * time gets flipped to `skipped` without spawning a run, so re-dispatching
 * the same plan id picks up where the prior PlanRun left off.
 *
 * Trivial-merge (mx-fd8619): when the child run terminal-succeeds with
 * `run.prUrl === null` AND reap emitted a `reap.empty_push` system event
 * (commitsAhead === 0), the coordinator advances directly to `merged`
 * without GitHub polling. Dropped commits (warren-72b9) reap `failed` first.
 *
 * Events fire via `emit(runId, kind, payload)` on the most recently
 * dispatched child run; callers wire it to `repos.events.append`
 * (mirrors the scheduler's `trigger.*` system events in
 * src/triggers/tick.ts).
 *
 * The coordinator itself never throws — every failure path is encoded
 * in the AdvanceResult union. The tick wrapper (tick.ts) still wraps
 * calls in try/catch so a programmer error in the repo or spawn seam
 * can't tear down the loop.
 */

import type { Repos } from "../db/repos/index.ts";
import {
	PLAN_RUN_CHILD_TERMINAL_STATES,
	type PlanRunChildRow,
	type PlanRunChildState,
	type PlanRunRow,
	RUN_TERMINAL_STATES,
	type RunRow,
} from "../db/schema.ts";
import type { SeedShowResult } from "../seeds-cli/index.ts";
import type { AutoTransitionResult } from "./plot-transition.ts";
import type { PrMergeChecker } from "./pr-merge.ts";

export type CoordinatorRepos = Pick<Repos, "planRuns" | "runs" | "events">;

export type CoordinatorShowSeedFn = (projectId: string, seedId: string) => Promise<SeedShowResult>;

export interface CoordinatorSpawnInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly prompt: string;
}

export interface CoordinatorSpawnResult {
	readonly runId: string;
}

export type CoordinatorSpawnFn = (input: CoordinatorSpawnInput) => Promise<CoordinatorSpawnResult>;

export type CoordinatorEmitFn = (
	runId: string,
	kind: PlanRunEventKind,
	payload: Record<string, unknown>,
) => Promise<void>;

/**
 * Optional Plot auto-done hook (warren-b290 / pl-7937 step 5). Called once
 * when the coordinator transitions a PlanRun to `succeeded` AND the row
 * carries a non-null `plot_id`. The implementation owns reading the Plot,
 * gating on `status === 'active'`, calling `setStatus('done')`, and
 * logging — the coordinator just maps the returned `AutoTransitionResult`
 * onto a `plan_run.plot_*` system event on the anchor child run. Default
 * is a no-op, so tests that don't care about Plot wiring get the same
 * behavior as the pre-pl-7937 baseline.
 */
export type CoordinatorTransitionPlotFn = (planRun: PlanRunRow) => Promise<AutoTransitionResult>;

export const PLAN_RUN_EVENT_KINDS = [
	"plan_run.advanced",
	"plan_run.dispatched",
	"plan_run.waiting_for_merge",
	"plan_run.merged",
	"plan_run.failed",
	"plan_run.succeeded",
	"plan_run.plot_auto_done",
	"plan_run.plot_status_skipped",
	"plan_run.plot_auto_done_failed",
] as const;
export type PlanRunEventKind = (typeof PLAN_RUN_EVENT_KINDS)[number];

export type AdvanceResult =
	| { readonly kind: "dispatched"; readonly childRunId: string }
	| { readonly kind: "waiting_for_run" }
	| { readonly kind: "waiting_for_merge" }
	| { readonly kind: "waiting_for_parent_merge" }
	| {
			readonly kind: "advanced";
			readonly mergedChildSeq: number;
			readonly dispatchedChildSeq?: number;
	  }
	| { readonly kind: "plan_failed"; readonly failedSeq: number; readonly reason: string }
	| { readonly kind: "plan_succeeded" }
	| { readonly kind: "noop"; readonly reason: string };

export interface AdvancePlanRunInput {
	readonly planRun: PlanRunRow;
	readonly repos: CoordinatorRepos;
	readonly showSeed: CoordinatorShowSeedFn;
	readonly checkPrMerged: PrMergeChecker;
	readonly spawn: CoordinatorSpawnFn;
	readonly emit: CoordinatorEmitFn;
	/**
	 * Optional Plot auto-done hook (warren-b290). Fires once on the
	 * plan_succeeded transition when `planRun.plot_id !== null`. Omit to
	 * skip — tests that don't exercise Plot wiring leave it unwired.
	 */
	readonly transitionPlot?: CoordinatorTransitionPlotFn;
	readonly now?: () => Date;
}

const IN_FLIGHT_STATES: readonly PlanRunChildState[] = ["dispatched", "running", "pr_open"];

export async function advancePlanRun(input: AdvancePlanRunInput): Promise<AdvanceResult> {
	const nowFn = input.now ?? (() => new Date());
	let planRun = input.planRun;

	// (a) Queued → running.
	if (planRun.state === "queued") {
		const startedAt = nowFn().toISOString();
		planRun = await input.repos.planRuns.transitionTo(planRun.id, "running", { startedAt });
	}

	// warren-d9a2: gate on parent run's PR being merged before dispatching
	// the first child. Auto-plan-runs carry parentRunId — the parent's
	// branch has the seeds state the children need on main.
	if (planRun.parentRunId !== null) {
		const gateResult = await checkParentRunMerged({
			planRun,
			repos: input.repos,
			checkPrMerged: input.checkPrMerged,
			now: nowFn,
		});
		if (gateResult !== null) return gateResult;
	}

	let mergedChildSeq: number | undefined;

	// Loop until we hit a terminal/waiting decision. Each iteration reloads
	// children so a merge/skip can fall through to the dispatch arm.
	for (;;) {
		const children = await input.repos.planRuns.listChildren(planRun.id);
		const inFlight = children.find((c) => IN_FLIGHT_STATES.includes(c.state));

		if (inFlight !== undefined) {
			const decision = await handleInFlight({
				planRun,
				child: inFlight,
				repos: input.repos,
				checkPrMerged: input.checkPrMerged,
				emit: input.emit,
				now: nowFn,
			});
			if (decision.kind === "merged") {
				mergedChildSeq = inFlight.seq;
				continue;
			}
			if (decision.kind === "result") {
				return decision.result;
			}
		}

		// (c) Pick the next pending child.
		const next = await input.repos.planRuns.pickNextPending(planRun.id);
		if (next === null) {
			// All children terminal — succeed the plan.
			const endedAt = nowFn().toISOString();
			await input.repos.planRuns.transitionTo(planRun.id, "succeeded", { endedAt });
			const anchor = mostRecentDispatchedRunId(children);
			if (anchor !== null) {
				await input.emit(anchor, "plan_run.succeeded", { planRunId: planRun.id });
			}
			// warren-b290 / pl-7937 step 5: auto-transition the bound Plot
			// from `active` → `done`. Best-effort — every outcome surfaces
			// as a `plan_run.plot_*` system event on the anchor child run
			// (when one exists). Skipped entirely when no plot_id is set
			// on the PlanRun or no hook is wired in (tests).
			if (planRun.plotId !== null && input.transitionPlot !== undefined) {
				const transitionResult = await input.transitionPlot(planRun);
				if (anchor !== null) {
					const eventKind = transitionPlotEventKind(transitionResult);
					await input.emit(anchor, eventKind, {
						planRunId: planRun.id,
						plotId: planRun.plotId,
						...transitionPlotEventPayload(transitionResult),
					});
				}
			}
			return { kind: "plan_succeeded" };
		}

		// Resume semantics — closed seed → skip without dispatch.
		let seedShow: SeedShowResult;
		try {
			seedShow = await input.showSeed(planRun.projectId, next.seedId);
		} catch (err) {
			return {
				kind: "noop",
				reason: `show_seed_failed:${formatError(err)}`,
			};
		}
		if (seedShow.status === "closed") {
			await input.repos.planRuns.updateChild({
				planRunId: planRun.id,
				seq: next.seq,
				patch: { state: "skipped", endedAt: nowFn().toISOString() },
				now: nowFn(),
			});
			continue;
		}

		// Dispatch the next child.
		const prompt = substituteSeedId(planRun.promptTemplate, next.seedId);
		let spawnResult: CoordinatorSpawnResult;
		try {
			spawnResult = await input.spawn({ planRun, child: next, prompt });
		} catch (err) {
			const reason = `dispatch_failed:${formatError(err)}`;
			const endedAt = nowFn().toISOString();
			await input.repos.planRuns.updateChild({
				planRunId: planRun.id,
				seq: next.seq,
				patch: { state: "failed", failureReason: reason, endedAt },
				now: nowFn(),
			});
			await input.repos.planRuns.transitionTo(planRun.id, "failed", {
				endedAt,
				failureReason: reason,
			});
			const anchor = mostRecentDispatchedRunId(children);
			if (anchor !== null) {
				await input.emit(anchor, "plan_run.failed", {
					planRunId: planRun.id,
					failedSeq: next.seq,
					reason,
				});
			}
			return { kind: "plan_failed", failedSeq: next.seq, reason };
		}

		await input.repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: next.seq,
			patch: {
				runId: spawnResult.runId,
				state: "dispatched",
				startedAt: nowFn().toISOString(),
			},
			now: nowFn(),
		});
		await input.emit(spawnResult.runId, "plan_run.dispatched", {
			planRunId: planRun.id,
			seq: next.seq,
			seedId: next.seedId,
		});
		if (mergedChildSeq !== undefined) {
			await input.emit(spawnResult.runId, "plan_run.advanced", {
				planRunId: planRun.id,
				mergedChildSeq,
				dispatchedChildSeq: next.seq,
			});
			return {
				kind: "advanced",
				mergedChildSeq,
				dispatchedChildSeq: next.seq,
			};
		}
		return { kind: "dispatched", childRunId: spawnResult.runId };
	}
}

interface HandleInFlightInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly repos: CoordinatorRepos;
	readonly checkPrMerged: PrMergeChecker;
	readonly emit: CoordinatorEmitFn;
	readonly now: () => Date;
}

type HandleInFlightDecision =
	| { readonly kind: "merged" }
	| { readonly kind: "result"; readonly result: AdvanceResult };

async function handleInFlight(input: HandleInFlightInput): Promise<HandleInFlightDecision> {
	const { planRun, child, repos, checkPrMerged, emit, now } = input;
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

	// run.state === 'succeeded'. Three sub-cases on (child.state, run.prUrl):
	if (child.state !== "pr_open") {
		// First observation. Decide pr_open vs trivial-merge.
		if (run.prUrl === null) {
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
				});
				return { kind: "merged" };
			}
			// Succeeded with no PR and no empty-push event → reap probably
			// hit a transient error before pr_open ran. We can't verify a
			// merge from here. Surface as plan_failed so the operator can
			// inspect; otherwise the plan would hang indefinitely.
			const reason = "child_succeeded_without_pr";
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
		// Real PR — flip to pr_open and fall through to poll on this tick.
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			patch: { state: "pr_open" },
			now: now(),
		});
	}

	// pr_open: poll merge state.
	if (run.prUrl === null) {
		return {
			kind: "result",
			result: { kind: "noop", reason: `pr_open_without_pr_url:${child.runId}` },
		};
	}
	const polled = await checkPrMerged(run.prUrl);
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
			prUrl: run.prUrl,
			mergedAt: polled.mergedAt,
		});
		return { kind: "merged" };
	}
	if (polled.kind === "open") {
		await emit(child.runId, "plan_run.waiting_for_merge", {
			planRunId: planRun.id,
			seq: child.seq,
			prUrl: run.prUrl,
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
			prUrl: run.prUrl,
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

/**
 * Gate auto-plan-runs on the parent run's PR being merged (warren-d9a2).
 * Returns null when the gate passes (proceed to child dispatch) or an
 * AdvanceResult when the gate blocks or fails the plan-run.
 */
async function checkParentRunMerged(input: {
	readonly planRun: PlanRunRow;
	readonly repos: CoordinatorRepos;
	readonly checkPrMerged: PrMergeChecker;
	readonly now: () => Date;
}): Promise<AdvanceResult | null> {
	const { planRun, repos, checkPrMerged, now } = input;
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
		const reason = "parent_pr_not_merged";
		const endedAt = now().toISOString();
		await repos.planRuns.transitionTo(planRun.id, "failed", { endedAt, failureReason: reason });
		return { kind: "plan_failed", failedSeq: 0, reason };
	}

	const polled = await checkPrMerged(parentRun.prUrl);
	if (polled.kind === "merged") return null;
	if (polled.kind === "open") return { kind: "waiting_for_parent_merge" };
	if (polled.kind === "closed_unmerged" || isFatalHttpError(polled)) {
		const reason = "parent_pr_not_merged";
		const endedAt = now().toISOString();
		await repos.planRuns.transitionTo(planRun.id, "failed", { endedAt, failureReason: reason });
		return { kind: "plan_failed", failedSeq: 0, reason };
	}
	// Transient error / missing token — keep waiting.
	return { kind: "waiting_for_parent_merge" };
}

function isFatalHttpError(result: {
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

function isTerminalRun(run: RunRow): boolean {
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
async function hasEmptyPushEvent(repos: CoordinatorRepos, runId: string): Promise<boolean> {
	const events = await repos.events.listByRun(runId);
	for (const ev of events) {
		if (ev.kind === "reap.empty_push") return true;
	}
	return false;
}

function mostRecentDispatchedRunId(children: readonly PlanRunChildRow[]): string | null {
	for (let i = children.length - 1; i >= 0; i -= 1) {
		const child = children[i];
		if (child !== undefined && child.runId !== null) return child.runId;
	}
	return null;
}

function substituteSeedId(template: string, seedId: string): string {
	return template.replace(/\{seed_id\}/g, seedId);
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Exported for the API handler (warren-f923) to compute "is this plan-run
 * still advancing?" without re-loading every child.
 */
export function isChildTerminal(state: PlanRunChildState): boolean {
	return (PLAN_RUN_CHILD_TERMINAL_STATES as readonly string[]).includes(state);
}

function transitionPlotEventKind(result: AutoTransitionResult): PlanRunEventKind {
	if (result.kind === "transitioned") return "plan_run.plot_auto_done";
	if (result.kind === "skipped") return "plan_run.plot_status_skipped";
	return "plan_run.plot_auto_done_failed";
}

function transitionPlotEventPayload(result: AutoTransitionResult): Record<string, unknown> {
	if (result.kind === "skipped") return { currentStatus: result.currentStatus };
	if (result.kind === "failed") return { reason: result.reason };
	return {};
}
