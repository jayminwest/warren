/**
 * Scheduler tick loop (R-06).
 *
 * One in-process tick fires every `tickMs` (default 60s), walks every
 * known project, and:
 *
 *   1. Loads `.warren/triggers.yaml` + `.warren/defaults.json` via the
 *      shared cache (R-02). Projects with no `.warren/` are skipped
 *      cheaply — the cache returns a `{triggers: null, defaults: null}`
 *      envelope and the loop is a no-op for them.
 *
 *   2. Dispatches cron entries via `dispatchCronTrigger`. No-catch-up
 *      semantics live in the dispatcher; the tick just feeds it `now`.
 *
 *   3. Walks the tracker's scheduled issues
 *      (`tracker.listScheduledIssues`, warren-6234) and dispatches the
 *      past-due ones via `dispatchScheduledSeed`. Post-dispatch, fires a
 *      single `tracker.mergeIssueMetadata` merge that combines the
 *      scheduled-fire clear (`scheduledFor:null, lastScheduledRun`) with
 *      the warren-namespaced common keys (`role, trigger:'scheduled',
 *      lastRunId, lastRunAt`) so the issue lands in its post-fire state
 *      with one merge (pl-bb70 step 5). Any failure here is surfaced as a
 *      `trigger.cleared_extension_failed` system event on the dispatched
 *      run so the operator sees the lingering extension without tailing
 *      logs (pl-2f15 risk #4).
 *
 * Single-flight: `startScheduler` wraps the tick callback in a guard
 * that drops overlapping ticks instead of stacking them. A slow tick
 * (many projects × slow burrow) degrades effective cadence but never
 * causes duplicate fires (pl-2f15 risk #5).
 *
 * Stop semantics: `startScheduler` returns a `stop()` that clears the
 * interval and waits for any in-flight tick to drain. bootServer wires
 * this into WarrenServerHandle.stop (R-06 step 4).
 */

import { formatError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { ProjectRow } from "../db/schema.ts";
import type {
	IssueTracker,
	MetadataCapableTracker,
	ScheduledIssueCapableTracker,
} from "../tracker/contract.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import { runCiFixerPass, type TickCiFixerDeps } from "./ci-fixer-pass.ts";
import type { CronRetryTracker } from "./cron-retry.ts";
import {
	type DispatchCronResult,
	type DispatchScheduledResult,
	type DispatchSpawnFn,
	dispatchCronTrigger,
} from "./dispatch.ts";
import type { EnsureProjectCloneFn } from "./project-heal.ts";
import { runScheduledSeedsPass } from "./scheduled-pass.ts";

export type {
	TickCiFixerDeps,
	TickCiFixerSpawnFn,
	TickCiFixerSpawnInput,
} from "./ci-fixer-pass.ts";

export type LoadWarrenConfigFn = (
	projectId: string,
	projectPath: string,
) => Promise<LoadedWarrenConfig>;

export interface TickLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
	/** warren-6234: optional debug channel for capability-gated skips. */
	debug?(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Rate-limiter for repeated per-project scheduler notices (warren-1ec7);
 * `ProjectHealTracker` satisfies it. `shouldNotify` returns true the first
 * time a condition is seen and again only once its interval elapses;
 * `clearNotice` resets a resolved condition. Absent ⇒ every notice logs.
 */
export interface SchedulerNoticeGate {
	shouldNotify(key: string, nowMs: number): boolean;
	clearNotice(key: string): void;
}

/**
 * The tracker surface the tick consumes: the base contract plus the
 * optional capability arms the scheduled pass branches on (warren-6234).
 * The capability flags stay authoritative — the arms are only called
 * after the matching flag reads true.
 */
export type TickIssueTracker = IssueTracker &
	Partial<ScheduledIssueCapableTracker & MetadataCapableTracker>;

export interface TickDeps {
	readonly repos: Pick<Repos, "projects" | "triggers" | "runs" | "events">;
	readonly loadWarrenConfig: LoadWarrenConfigFn;
	/**
	 * warren-6234: the scheduled-issues pass routes through the IssueTracker
	 * seam. Omitted, or a tracker without `supportsScheduledIssues`, skips the
	 * pass; the post-fire metadata write additionally requires
	 * `supportsMetadata`.
	 */
	readonly issueTracker?: TickIssueTracker;
	readonly spawn: DispatchSpawnFn;
	readonly ciFixer?: TickCiFixerDeps;
	/**
	 * Per-trigger bounded-retry memory (warren-a0a2). Constructed once by
	 * `bootScheduler` so it survives across ticks; the cron dispatcher caps
	 * consecutive transient spawn failures per slot against it. Omitted in unit
	 * tests that don't exercise the bound.
	 */
	readonly cronRetryTracker?: CronRetryTracker;
	/**
	 * GC seam for the scheduler's transient `never_started` rows (warren-a0a2),
	 * wired to `repos.runs.deleteNeverStarted`. Threaded onto the cron
	 * dispatcher so a failing slot doesn't flood the runs list.
	 */
	readonly deleteNeverStartedRun?: (runId: string) => Promise<void>;
	/**
	 * Self-heal seam (warren-1ec7). Called at the top of each project's tick;
	 * on a missing on-disk clone it re-clones from the row's gitUrl instead of
	 * letting `loadWarrenConfig` throw `project clone missing on disk` every
	 * tick. `skip` ⇒ clone missing and backing off / re-clone failed, so skip
	 * this tick. Omitted ⇒ old behavior (missing clone → `project_failed`).
	 */
	readonly ensureProjectClone?: EnsureProjectCloneFn;
	/**
	 * Rate-limiter for repeated per-project error notices (warren-1ec7:
	 * `project_failed`, `sd_list_failed`). Omitted ⇒ every notice logs.
	 */
	readonly noticeGate?: SchedulerNoticeGate;
	readonly now?: () => Date;
	readonly logger?: TickLogger;
}

/**
 * Gate a per-project notice through the optional rate-limiter. Returns true
 * (always log) when no gate is wired — preserving the legacy every-tick
 * logging that unit tests assert against.
 */
function shouldNotify(deps: Pick<TickDeps, "noticeGate">, key: string, nowMs: number): boolean {
	return deps.noticeGate?.shouldNotify(key, nowMs) ?? true;
}

export interface RunTickResult {
	readonly cron: readonly DispatchCronResult[];
	readonly scheduled: readonly DispatchScheduledResult[];
	readonly projectErrors: readonly { projectId: string; reason: string }[];
}

/**
 * Run one pass over every project. Returned for tests/diagnostics; the
 * production interval (`startScheduler`) discards the value but logs the
 * outcome via the logger.
 */
export async function runTick(deps: TickDeps): Promise<RunTickResult> {
	const now = deps.now?.() ?? new Date();
	const cron: DispatchCronResult[] = [];
	const scheduled: DispatchScheduledResult[] = [];
	const projectErrors: { projectId: string; reason: string }[] = [];

	const nowMs = now.getTime();
	for (const project of await deps.repos.projects.listAll()) {
		try {
			await runProjectTick({
				deps,
				project,
				now,
				cron,
				scheduled,
			});
			// Reached the end cleanly — clear any lingering per-project error
			// gate so a fresh failure logs immediately (warren-1ec7).
			deps.noticeGate?.clearNotice(`project_failed:${project.id}`);
		} catch (err) {
			// pl-2f15 risk #9: project delete races with the tick can leave
			// stale rows in flight. Catch per-project so one bad row can't
			// derail the rest of the tick.
			const reason = formatError(err);
			projectErrors.push({ projectId: project.id, reason });
			// warren-1ec7: gate the error log so a persistently-broken project
			// (e.g. a clone the self-heal couldn't re-materialize) logs once per
			// interval instead of flooding at error level every tick.
			if (shouldNotify(deps, `project_failed:${project.id}`, nowMs)) {
				deps.logger?.error({ projectId: project.id, reason }, "scheduler.project_failed");
			}
		}
	}

	return { cron, scheduled, projectErrors };
}

interface RunProjectTickInput {
	readonly deps: TickDeps;
	readonly project: ProjectRow;
	readonly now: Date;
	readonly cron: DispatchCronResult[];
	readonly scheduled: DispatchScheduledResult[];
}

/**
 * warren-a0a2: the optional bounded-retry seams the cron dispatcher takes.
 * Built once per project tick so the dispatch call site stays flat (keeps
 * `runProjectTick` under the cognitive-complexity gate).
 */
function cronDispatchExtras(
	deps: TickDeps,
): Pick<Parameters<typeof dispatchCronTrigger>[0], "retryTracker" | "deleteNeverStartedRun"> {
	return {
		...(deps.cronRetryTracker !== undefined ? { retryTracker: deps.cronRetryTracker } : {}),
		...(deps.deleteNeverStartedRun !== undefined
			? { deleteNeverStartedRun: deps.deleteNeverStartedRun }
			: {}),
	};
}

async function runProjectTick(input: RunProjectTickInput): Promise<void> {
	const { deps, project, now, cron, scheduled } = input;
	const nowIso = now.toISOString();

	// warren-1ec7: self-heal a missing on-disk clone before anything reads it.
	// `skip` means it's absent and either backing off or its re-clone failed;
	// bail this tick rather than let `loadWarrenConfig` throw clone-missing.
	if (deps.ensureProjectClone !== undefined) {
		const heal = await deps.ensureProjectClone(project);
		if (heal === "skip") return;
	}

	const config = await deps.loadWarrenConfig(project.id, project.localPath);

	// Surface .warren/ parse errors at info-level — the GET /warren-config
	// surface already exposes them, and we don't want every tick to
	// re-warn for the same broken file.
	if (config.errors.length > 0) {
		deps.logger?.info(
			{ projectId: project.id, count: config.errors.length },
			"scheduler.warren_config_errors",
		);
	}

	const cronExtras = cronDispatchExtras(deps);
	for (const trigger of config.triggers ?? []) {
		const result = await dispatchCronTrigger({
			projectId: project.id,
			trigger,
			defaults: config.defaults,
			now,
			repos: deps.repos,
			spawn: deps.spawn,
			...cronExtras,
		});
		cron.push(result);
		logCronResult(deps.logger, project.id, trigger.id, result);
	}

	// warren-0b75: CI-fixer poll. Independent of the seeds shell-out below,
	// so it runs before the `return` on an `sd list` failure can skip it.
	if (deps.ciFixer !== undefined) {
		await runCiFixerPass({
			repos: deps.repos,
			ciFixer: deps.ciFixer,
			project,
			config,
			now,
			...(deps.logger !== undefined ? { logger: deps.logger } : {}),
			...(deps.noticeGate !== undefined ? { noticeGate: deps.noticeGate } : {}),
		});
	}

	await runScheduledSeedsPass({ deps, project, config, now, nowIso, scheduled });
}

function logCronResult(
	logger: TickLogger | undefined,
	projectId: string,
	triggerId: string,
	result: DispatchCronResult,
): void {
	if (result.kind === "fired") {
		logger?.info(
			{ projectId, triggerId, runId: result.runId, nextFireAt: result.nextFireAt?.toISOString() },
			"scheduler.cron_fired",
		);
	} else if (result.kind === "gave_up") {
		// warren-a0a2: N consecutive transient failures consumed the slot.
		// error-level — a persistently-unreachable runtime needs operator eyes,
		// but the noise floor is now once-per-slot, not once-per-tick.
		logger?.error(
			{
				projectId,
				triggerId,
				attempts: result.attempts,
				reason: result.reason,
				nextFireAt: result.nextFireAt?.toISOString(),
			},
			"scheduler.cron_gave_up",
		);
	} else if (result.kind === "error") {
		logger?.warn({ projectId, triggerId, reason: result.reason }, "scheduler.cron_failed");
	}
}

/**
 * Opaque handle returned by setInterval. Both Node and Bun return their
 * own `Timeout`/`Timer` type plus a numeric overload; widening to the
 * intersection here means tests can stub with either side without the
 * type system caring.
 */
export type SchedulerTimerHandle = object;

export interface StartSchedulerInput extends TickDeps {
	readonly tickMs: number;
	readonly disabled?: boolean;
	/** Used by tests to override the timer plumbing. */
	readonly setInterval?: (cb: () => void, ms: number) => SchedulerTimerHandle;
	readonly clearInterval?: (handle: SchedulerTimerHandle) => void;
}

export interface SchedulerHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously, awaiting completion. */
	runOnce(): Promise<RunTickResult | null>;
	/** Test/diagnostic surface — number of ticks completed (success or skip). */
	tickCount(): number;
}

// Marker handle returned when the scheduler is disabled. Cast through
// unknown because there's no public way to manufacture the platform's
// Timer/Timeout type without actually scheduling something.
const NOOP_HANDLE = Symbol("noop-scheduler-handle") as unknown as SchedulerTimerHandle;

/**
 * Boot the recurring tick loop. When `disabled` is true the scheduler is
 * a no-op handle — bootServer can wire this unconditionally without an
 * env-var branch in the boot code path.
 *
 * Single-flight: a tick in progress when the next interval fires is
 * skipped (logged as `scheduler.tick_skipped`). The next interval picks
 * up against fresh state.
 */
export function startScheduler(input: StartSchedulerInput): SchedulerHandle {
	const setIntervalFn: (cb: () => void, ms: number) => SchedulerTimerHandle =
		input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as SchedulerTimerHandle);
	const clearIntervalFn: (handle: SchedulerTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<RunTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const fire = async (): Promise<RunTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info({}, "scheduler.tick_skipped");
			return null;
		}
		const promise = (async () => {
			try {
				const result = await runTick(input);
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error({ reason: formatError(err) }, "scheduler.tick_failed");
				return null;
			} finally {
				inFlight = null;
			}
		})();
		inFlight = promise;
		return promise;
	};

	const handle: SchedulerTimerHandle =
		input.disabled === true ? NOOP_HANDLE : setIntervalFn(() => void fire(), input.tickMs);

	return {
		async stop() {
			stopped = true;
			if (handle !== NOOP_HANDLE) clearIntervalFn(handle);
			if (inFlight !== null) {
				try {
					await inFlight;
				} catch {
					// Already logged inside fire().
				}
			}
		},
		runOnce: fire,
		tickCount: () => ticks,
	};
}
