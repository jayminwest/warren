/**
 * PlanRun coordinator tick loop (pl-a258 step 5 / warren-2623).
 *
 * `runPlanRunTick` lists every active (queued/running) PlanRun and calls
 * `advancePlanRun` on each. Per-PlanRun errors are caught so one bad row
 * can't tear down the whole tick (mirrors `runProjectTick` in
 * src/triggers/tick.ts — pl-2f15 risk #9).
 *
 * `bootPlanRunCoordinator` schedules `runPlanRunTick` on a recurring
 * interval and wraps it in the same single-flight guard `bootScheduler`
 * uses: a tick already in flight when the next interval fires is dropped,
 * so a slow tick degrades effective cadence but never duplicates work.
 *
 * Env contract (see ./config.ts):
 *   WARREN_PLAN_RUN_TICK_MS     interval in ms — default 10_000 (10s).
 *                                Faster than the cron scheduler (60s) because
 *                                plan progression is the operator's
 *                                interactive loop — they want a child to
 *                                dispatch within seconds of the previous
 *                                merge, not a minute.
 *   WARREN_PLAN_RUN_DISABLED    disable the coordinator entirely — same
 *                                truthy set as WARREN_SCHEDULER_DISABLED.
 */

import type { Repos } from "../db/repos/index.ts";
import type { PlanRunRow } from "../db/schema.ts";
import {
	type AdvanceResult,
	advancePlanRun,
	type CoordinatorEmitFn,
	type CoordinatorReopenPrFn,
	type CoordinatorRepos,
	type CoordinatorResolveExecutionFn,
	type CoordinatorShowSeedFn,
	type CoordinatorSpawnFn,
	type CoordinatorTransitionPlotFn,
	type PlanRunEventKind,
} from "./coordinator.ts";
import type { PrMergeChecker } from "./pr-merge.ts";

export interface PlanRunTickLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface PlanRunTickDeps {
	readonly repos: Pick<Repos, "planRuns" | "runs" | "events">;
	readonly showSeed: CoordinatorShowSeedFn;
	readonly checkPrMerged: PrMergeChecker;
	readonly spawn: CoordinatorSpawnFn;
	/** pl-fb43 step 5: per-child execution-repo resolver (default = coordination project). */
	readonly resolveExecution?: CoordinatorResolveExecutionFn;
	readonly now?: () => Date;
	readonly logger?: PlanRunTickLogger;
	/** Test seam — defaults to {@link defaultEmit} writing to events table. */
	readonly emit?: CoordinatorEmitFn;
	/**
	 * Optional Plot auto-done hook (warren-b290 / pl-7937 step 5). When
	 * wired, the coordinator calls it on the plan_succeeded transition
	 * for any PlanRun that carries a non-null `plot_id`. Omit to skip
	 * — tests and deployments without `.plot/` projects leave it unwired.
	 */
	readonly transitionPlot?: CoordinatorTransitionPlotFn;
	/**
	 * Bounded wall-clock merge-wait budget (ms) forwarded to
	 * {@link advancePlanRun} (warren-3937). Omit to use the coordinator
	 * default ({@link DEFAULT_MERGE_TIMEOUT_MS}); 0 disables the timeout.
	 */
	readonly mergeTimeoutMs?: number;
	/**
	 * Optional PR-(re)open seam (warren-22de). When provided, the
	 * coordinator attempts to reopen a missing PR before failing terminally
	 * on a child that succeeded with no prUrl and no empty-push event.
	 */
	readonly reopenPr?: CoordinatorReopenPrFn;
}

export interface PlanRunAdvanceLog {
	readonly planRunId: string;
	readonly result: AdvanceResult;
}

export interface PlanRunTickResult {
	readonly advances: readonly PlanRunAdvanceLog[];
	readonly errors: readonly { readonly planRunId: string; readonly reason: string }[];
}

export async function runPlanRunTick(deps: PlanRunTickDeps): Promise<PlanRunTickResult> {
	const advances: PlanRunAdvanceLog[] = [];
	const errors: { planRunId: string; reason: string }[] = [];
	const emit = deps.emit ?? buildDefaultEmit(deps.repos as CoordinatorRepos, deps.now);

	const active: PlanRunRow[] = await deps.repos.planRuns.listActive();
	for (const planRun of active) {
		try {
			const result = await advancePlanRun({
				planRun,
				repos: deps.repos as CoordinatorRepos,
				showSeed: deps.showSeed,
				checkPrMerged: deps.checkPrMerged,
				spawn: deps.spawn,
				...(deps.resolveExecution !== undefined ? { resolveExecution: deps.resolveExecution } : {}),
				emit,
				...(deps.transitionPlot !== undefined ? { transitionPlot: deps.transitionPlot } : {}),
				...(deps.mergeTimeoutMs !== undefined ? { mergeTimeoutMs: deps.mergeTimeoutMs } : {}),
				...(deps.reopenPr !== undefined ? { reopenPr: deps.reopenPr } : {}),
				...(deps.now !== undefined ? { now: deps.now } : {}),
			});
			advances.push({ planRunId: planRun.id, result });
			logAdvance(deps.logger, planRun.id, result);
		} catch (err) {
			const reason = formatError(err);
			errors.push({ planRunId: planRun.id, reason });
			deps.logger?.error({ planRunId: planRun.id, reason }, "plan_run.advance_failed");
		}
	}

	return { advances, errors };
}

function logAdvance(
	logger: PlanRunTickLogger | undefined,
	planRunId: string,
	result: AdvanceResult,
): void {
	if (logger === undefined) return;
	if (result.kind === "plan_failed") {
		logger.warn(
			{ planRunId, failedSeq: result.failedSeq, reason: result.reason },
			"plan_run.failed",
		);
		return;
	}
	if (result.kind === "noop") {
		logger.warn({ planRunId, reason: result.reason }, "plan_run.noop");
		return;
	}
	logger.info({ planRunId, kind: result.kind }, "plan_run.advanced");
}

/**
 * Default emit: append a `plan_run.*` system event onto the target child
 * run's events stream (mx-c88f10 / scheduler.trigger.*). Best-effort —
 * a write failure is logged via the coordinator's own try/catch and the
 * tick continues.
 */
function buildDefaultEmit(repos: CoordinatorRepos, now?: () => Date): CoordinatorEmitFn {
	return async (runId: string, kind: PlanRunEventKind, payload: Record<string, unknown>) => {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		const ts = (now?.() ?? new Date()).toISOString();
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts,
			kind,
			stream: "system",
			payload,
		});
	};
}

/* ----------------------------------------------------------------------- */
/* Single-flight wrapper                                                    */
/* ----------------------------------------------------------------------- */

export type PlanRunCoordinatorTimerHandle = object;

export interface BootPlanRunCoordinatorInput extends PlanRunTickDeps {
	readonly tickMs: number;
	readonly disabled?: boolean;
	readonly setInterval?: (cb: () => void, ms: number) => PlanRunCoordinatorTimerHandle;
	readonly clearInterval?: (handle: PlanRunCoordinatorTimerHandle) => void;
}

export interface PlanRunCoordinatorHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously, awaiting completion. */
	runOnce(): Promise<PlanRunTickResult | null>;
	/** Diagnostic surface — number of ticks completed (success or skip). */
	tickCount(): number;
}

const NOOP_HANDLE = Symbol(
	"plan-run-coordinator-noop-handle",
) as unknown as PlanRunCoordinatorTimerHandle;

/**
 * Boot the recurring PlanRun tick. Single-flight wrapper drops overlapping
 * ticks instead of stacking them — mirrors `bootScheduler` so the
 * lifecycle semantics are identical for operators reading logs.
 */
export function bootPlanRunCoordinator(
	input: BootPlanRunCoordinatorInput,
): PlanRunCoordinatorHandle {
	const setIntervalFn: (cb: () => void, ms: number) => PlanRunCoordinatorTimerHandle =
		input.setInterval ??
		((cb, ms) => globalThis.setInterval(cb, ms) as PlanRunCoordinatorTimerHandle);
	const clearIntervalFn: (handle: PlanRunCoordinatorTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<PlanRunTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const fire = async (): Promise<PlanRunTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info({}, "plan_run.tick_skipped");
			return null;
		}
		const promise = (async () => {
			try {
				const result = await runPlanRunTick(input);
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error({ reason: formatError(err) }, "plan_run.tick_failed");
				return null;
			} finally {
				inFlight = null;
			}
		})();
		inFlight = promise;
		return promise;
	};

	const handle: PlanRunCoordinatorTimerHandle =
		input.disabled === true ? NOOP_HANDLE : setIntervalFn(() => void fire(), input.tickMs);

	return {
		async stop() {
			stopped = true;
			if (handle !== NOOP_HANDLE) clearIntervalFn(handle);
			if (inFlight !== null) {
				try {
					await inFlight;
				} catch {
					// already logged in fire()
				}
			}
		},
		runOnce: fire,
		tickCount: () => ticks,
	};
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
