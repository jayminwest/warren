/**
 * Run heartbeat watchdog (warren-285d).
 *
 * A burrow run can go silent-but-busy: the agent launches a tool (e.g.
 * `bun run lint:fix` → biome) that goes runaway and pins CPU without ever
 * emitting another event. Nothing reaps it — burrow keeps the run
 * `running` with `exitCode: null`, the warren row stays `running`, and the
 * stream bridge happily shows it live forever. `agent.pauseTimeoutMs` only
 * covers `paused`/question turns, not a busy-but-silent tool. Without a
 * wall-clock budget a single hung gate command wedges the run indefinitely
 * (the 2026-06-05 `run_wawgn5tbejkx` incident — biome accumulating ~57
 * CPU-min behind a stuck bash tool call).
 *
 * This detector closes that gap. Each tick scans `running` runs and
 * computes the run's heartbeat — the timestamp of its newest event,
 * falling back to `startedAt`. When the heartbeat is older than the
 * configurable budget the run is force-failed:
 *
 *   1. emit a `watchdog.timed_out` system event on the run's log;
 *   2. best-effort `POST /runs/:burrow_run_id/cancel` so burrow stops the
 *      agent turn;
 *   3. `reapRun` with `outcome: "failed"`, `failureReason: "timed_out"` —
 *      reap's final `workspace_destroy` sub-step tears down the burrow
 *      workspace (and with it the runaway bwrap process tree) so orphaned
 *      children stop burning CPU after the run is terminal.
 *
 * Routing the timeout through reap (rather than a bare `finalize`) is
 * deliberate: reap is the only path that destroys the sandbox, pushes any
 * partial workspace branch, and runs the mulch/seeds/plot mirrors, so a
 * timed-out run still preserves whatever work the agent committed before
 * it hung — same philosophy as `cancelRun` (warren-a69a).
 *
 * The single-flight boot wrapper mirrors `bootPauseDetector`
 * (mx-985743 / mx-094b64): an in-flight tick when the next interval fires
 * is dropped, per-run errors are isolated so one bad row can't tear down
 * the loop, and `stop()` drains the in-flight tick before resolving.
 *
 * On by default (warren-b2dc) — like the conversation-idle coordinator,
 * this is a lifecycle-reclaim safety net that must not depend on an
 * operator remembering an env var, so a fresh deploy is protected without
 * one. The built-in budget (`DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS`, 45
 * min) is deliberately generous — well above any legitimately
 * slow-but-silent tool such as a cold `bun install` — and can be tuned via
 * `WARREN_RUN_HEARTBEAT_TIMEOUT_MS`. Opt out entirely with
 * `WARREN_WATCHDOG_DISABLED=1` (or by pinning the budget to 0). The
 * default tick cadence is 30s.
 */

import { NotFoundError as BurrowNotFoundError } from "@os-eco/burrow-cli";
import { withTransportMapping } from "../burrow-client/client.ts";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import type { RunEventBroker } from "./events.ts";
import type { AutoOpenPrConfig } from "./pr.ts";
import { type ReapRunInput, type ReapRunResult, reapRun } from "./reap/index.ts";
import type { BridgeLogger } from "./stream/index.ts";

/** Event kind emitted on the run row when the watchdog force-fails a hung run. */
export const WATCHDOG_TIMED_OUT_KIND = "watchdog.timed_out";

/** Default tick cadence for the heartbeat watchdog (ms). */
export const DEFAULT_WATCHDOG_TICK_MS = 30_000;

/**
 * Built-in heartbeat budget when the watchdog is left on-by-default
 * (warren-b2dc): 45 minutes. Generous on purpose — comfortably above any
 * legitimately slow-but-silent tool (cold `bun install`, large clone) so a
 * healthy run is never mistaken for a hung one. Override with
 * `WARREN_RUN_HEARTBEAT_TIMEOUT_MS`.
 */
export const DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS = 2_700_000;

export interface WatchdogTickDeps {
	readonly repos: Repos;
	readonly burrowClientPool: BurrowClientPool;
	/**
	 * Heartbeat budget in ms. A `running` run whose newest event (or
	 * `startedAt` fallback) is older than this is force-failed. Must be
	 * positive — the boot wrapper refuses to arm with a non-positive value.
	 */
	readonly heartbeatTimeoutMs: number;
	readonly broker?: RunEventBroker;
	/** Forwarded to reap so a timed-out run still gets the configured PR/branch handling. */
	readonly autoOpenPr?: AutoOpenPrConfig;
	readonly now?: () => Date;
	readonly logger?: BridgeLogger;
	/** Override reap (tests). Defaults to the live `reapRun`. */
	readonly reap?: (input: ReapRunInput) => Promise<ReapRunResult>;
}

export interface WatchdogTickResult {
	readonly timedOut: readonly { readonly runId: string; readonly idleMs: number }[];
	readonly errors: readonly { readonly runId: string; readonly reason: string }[];
}

/**
 * Compute the heartbeat age (ms) of a `running` run: `now` minus the
 * timestamp of its newest event, falling back to `startedAt` when no
 * events have flowed yet. Returns `null` when neither anchor is parseable
 * (a `running` row with no `startedAt` is a programmer error elsewhere; we
 * skip rather than mis-reap it).
 */
export async function computeIdleMs(repos: Repos, run: RunRow, now: Date): Promise<number | null> {
	const tail = await repos.events.listTail(run.id, 1);
	const anchor = tail.length > 0 ? tail[tail.length - 1]?.ts : run.startedAt;
	if (anchor === null || anchor === undefined) return null;
	const anchorMs = Date.parse(anchor);
	if (!Number.isFinite(anchorMs)) return null;
	return now.getTime() - anchorMs;
}

/**
 * One pass of the watchdog. Scans `running` runs and force-fails any whose
 * heartbeat exceeds the budget. Per-run errors are caught so one bad row
 * never blocks the others.
 */
export async function tickWatchdog(deps: WatchdogTickDeps): Promise<WatchdogTickResult> {
	const now = deps.now ?? (() => new Date());
	const timedOut: { runId: string; idleMs: number }[] = [];
	const errors: { runId: string; reason: string }[] = [];

	let running: RunRow[];
	try {
		running = await deps.repos.runs.listByState("running");
	} catch (err) {
		return { timedOut, errors: [{ runId: "<listByState:running>", reason: formatError(err) }] };
	}

	for (const run of running) {
		try {
			// warren-c770: a `conversation` run is deliberately
			// long-lived across turns — the pi-chat runtime suppresses the
			// per-turn terminal envelope, so the run sits idle between operator
			// messages. An armed heartbeat watchdog must not mistake that idle
			// for a hung tool and force-fail it.
			if (run.mode === "conversation") continue;
			const idleMs = await computeIdleMs(deps.repos, run, now());
			if (idleMs === null || idleMs < deps.heartbeatTimeoutMs) continue;
			await forceFail(deps, run, idleMs, now());
			timedOut.push({ runId: run.id, idleMs });
		} catch (err) {
			errors.push({ runId: run.id, reason: formatError(err) });
			deps.logger?.error?.(
				{ runId: run.id, reason: formatError(err) },
				"watchdog.force_fail_failed",
			);
		}
	}

	return { timedOut, errors };
}

async function forceFail(
	deps: WatchdogTickDeps,
	run: RunRow,
	idleMs: number,
	now: Date,
): Promise<void> {
	await emitTimedOutEvent(deps, run, idleMs, now);
	await cancelBurrowRun(deps, run);

	const reap = deps.reap ?? reapRun;
	await reap({
		runId: run.id,
		outcome: "failed",
		failureReason: "timed_out",
		repos: deps.repos,
		burrowClientPool: deps.burrowClientPool,
		...(deps.broker !== undefined ? { broker: deps.broker } : {}),
		...(deps.now !== undefined ? { now: deps.now } : {}),
		...(deps.logger !== undefined ? { logger: deps.logger } : {}),
		...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
	});

	deps.logger?.info?.(
		{ runId: run.id, idleMs, heartbeatTimeoutMs: deps.heartbeatTimeoutMs },
		WATCHDOG_TIMED_OUT_KIND,
	);
}

/**
 * Best-effort `POST /runs/:burrow_run_id/cancel` so burrow stops the
 * agent turn before reap destroys the workspace. Swallows a 404 (ghost
 * run) and transport failures — reap's `workspace_destroy` is the real
 * teardown, and a failed cancel must never block the force-fail.
 */
async function cancelBurrowRun(deps: WatchdogTickDeps, run: RunRow): Promise<void> {
	if (run.burrowId === null || run.burrowRunId === null) return;
	const burrowRunId = run.burrowRunId;
	try {
		const { client } = await deps.burrowClientPool.clientFor({ burrowId: run.burrowId });
		await withTransportMapping(client.config, () =>
			client.http.runs.cancel(burrowRunId, { reason: "watchdog heartbeat timeout" }),
		);
	} catch (err) {
		if (err instanceof BurrowNotFoundError) return;
		deps.logger?.error?.(
			{ runId: run.id, burrowRunId, reason: formatError(err) },
			"watchdog.cancel_failed",
		);
	}
}

async function emitTimedOutEvent(
	deps: WatchdogTickDeps,
	run: RunRow,
	idleMs: number,
	now: Date,
): Promise<void> {
	const seq = ((await deps.repos.events.maxSeqForRun(run.id)) ?? 0) + 1;
	const row = await deps.repos.events.append({
		runId: run.id,
		burrowEventSeq: seq,
		ts: now.toISOString(),
		kind: WATCHDOG_TIMED_OUT_KIND,
		stream: "system",
		payload: {
			idleMs,
			heartbeatTimeoutMs: deps.heartbeatTimeoutMs,
			burrowRunId: run.burrowRunId,
		},
	});
	deps.broker?.publish(run.id, row);
}

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------------- */
/* Env config                                                            */
/* -------------------------------------------------------------------- */

export interface WatchdogConfig {
	/**
	 * Armed unless explicitly opted out (`WARREN_WATCHDOG_DISABLED`) or the
	 * budget is pinned to 0. On by default (warren-b2dc).
	 */
	readonly enabled: boolean;
	readonly heartbeatTimeoutMs: number;
	readonly tickMs: number;
}

interface WatchdogEnvLike {
	readonly WARREN_RUN_HEARTBEAT_TIMEOUT_MS?: string;
	readonly WARREN_WATCHDOG_TICK_MS?: string;
	readonly WARREN_WATCHDOG_DISABLED?: string;
}

/**
 * Resolve watchdog config from env. The detector is on by default
 * (warren-b2dc): when `WARREN_RUN_HEARTBEAT_TIMEOUT_MS` is unset it arms
 * with the generous built-in `DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS`
 * budget. Operators opt out with `WARREN_WATCHDOG_DISABLED=1` (or by
 * pinning the budget to 0). An invalid timeout/tick throws so a typo in a
 * deploy config fails loud rather than silently mis-arming the safety net.
 */
export function loadWatchdogConfigFromEnv(env: WatchdogEnvLike): WatchdogConfig {
	const heartbeatTimeoutMs = parseNonNegativeInt(
		env.WARREN_RUN_HEARTBEAT_TIMEOUT_MS,
		"WARREN_RUN_HEARTBEAT_TIMEOUT_MS",
		DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS,
	);
	const tickMs = parsePositiveInt(
		env.WARREN_WATCHDOG_TICK_MS,
		"WARREN_WATCHDOG_TICK_MS",
		DEFAULT_WATCHDOG_TICK_MS,
	);
	const optedOut = parseDisabledFlag(env.WARREN_WATCHDOG_DISABLED);
	return { enabled: !optedOut && heartbeatTimeoutMs > 0, heartbeatTimeoutMs, tickMs };
}

function parseDisabledFlag(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const t = raw.trim().toLowerCase();
	return t === "1" || t === "true" || t === "yes" || t === "on";
}

function parseNonNegativeInt(raw: string | undefined, name: string, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
	}
	return n;
}

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(`${name} must be a positive integer, got "${raw}"`);
	}
	return n;
}

/* -------------------------------------------------------------------- */
/* Single-flight boot wrapper                                            */
/* -------------------------------------------------------------------- */

export type WatchdogTimerHandle = object;

export interface BootWatchdogInput extends WatchdogTickDeps {
	readonly tickMs: number;
	readonly disabled?: boolean;
	readonly setInterval?: (cb: () => void, ms: number) => WatchdogTimerHandle;
	readonly clearInterval?: (handle: WatchdogTimerHandle) => void;
}

export interface WatchdogHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously, awaiting completion. */
	runOnce(): Promise<WatchdogTickResult | null>;
	/** Diagnostic — number of completed ticks (success or skip). */
	tickCount(): number;
}

const NOOP_HANDLE = Symbol("watchdog-noop-handle") as unknown as WatchdogTimerHandle;

/**
 * Boot the recurring heartbeat tick. Single-flight wrapper drops
 * overlapping ticks instead of stacking them — mirrors
 * `bootPauseDetector` so lifecycle semantics are identical for operators
 * reading logs.
 */
export function bootWatchdog(input: BootWatchdogInput): WatchdogHandle {
	const setIntervalFn: (cb: () => void, ms: number) => WatchdogTimerHandle =
		input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as WatchdogTimerHandle);
	const clearIntervalFn: (handle: WatchdogTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<WatchdogTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const fire = async (): Promise<WatchdogTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info?.({}, "watchdog.tick_skipped");
			return null;
		}
		const promise = (async () => {
			try {
				const result = await tickWatchdog(input);
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error?.({ reason: formatError(err) }, "watchdog.tick_failed");
				return null;
			} finally {
				inFlight = null;
			}
		})();
		inFlight = promise;
		return promise;
	};

	const handle: WatchdogTimerHandle =
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
