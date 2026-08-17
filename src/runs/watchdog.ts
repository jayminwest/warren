/**
 * Run heartbeat watchdog (warren-285d).
 *
 * A burrow run can go silent-but-busy: the agent launches a tool (e.g.
 * `bun run lint:fix` → biome) that goes runaway and pins CPU without ever
 * emitting another event. Nothing reaps it — burrow keeps the run
 * `running` with `exitCode: null`, the warren row stays `running`, and the
 * stream bridge happily shows it live forever. Without a
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
 *   2. best-effort `POST /runs/:sandbox_run_id/cancel` so burrow stops the
 *      agent turn;
 *   3. `reapRun` with `outcome: "failed"`, `failureReason: "timed_out"` —
 *      reap's final `workspace_destroy` sub-step tears down the burrow
 *      workspace (and with it the runaway bwrap process tree) so orphaned
 *      children stop burning CPU after the run is terminal.
 *
 * Routing the timeout through reap (rather than a bare `finalize`) is
 * deliberate: reap is the only path that destroys the sandbox, pushes any
 * partial workspace branch, and runs the mulch/seeds mirrors, so a
 * timed-out run still preserves whatever work the agent committed before
 * it hung — same philosophy as `cancelRun` (warren-a69a).
 *
 * The single-flight boot wrapper (mx-985743 / mx-094b64) drops an
 * in-flight tick when the next interval fires, isolates per-run errors so
 * one bad row can't tear down the loop, and `stop()` drains the in-flight
 * tick before resolving.
 *
 * On by default (warren-b2dc) —
 * this is a lifecycle-reclaim safety net that must not depend on an
 * operator remembering an env var, so a fresh deploy is protected without
 * one. The built-in budget (`DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS`, 45
 * min) is deliberately generous — well above any legitimately
 * slow-but-silent tool such as a cold `bun install` — and can be tuned via
 * `WARREN_RUN_HEARTBEAT_TIMEOUT_MS`. Opt out entirely with
 * `WARREN_WATCHDOG_DISABLED=1` (or by pinning the budget to 0). The
 * default tick cadence is 30s.
 */

import { formatError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunRow, RunTerminalState } from "../db/schema.ts";
import type { RunHandle, RuntimeProvider } from "../runtime/contract.ts";
import { RuntimeRunNotFoundError } from "../runtime/errors.ts";
import type { RunEventBroker } from "./events.ts";
import type { AutoOpenPrConfig } from "./pr.ts";
import type { ReapRunInput, ReapRunResult } from "./reap/index.ts";
import { type BridgeLogger, bindBridgeLogger } from "./stream/index.ts";
import { hasCancelIntent, maybeReconcileTerminal } from "./watchdog-reconcile.ts";

/**
 * The reap seam the watchdog force-fails a hung run through (warren-1fce). The
 * active runtime provider is threaded in from the watchdog's own deps; reap no
 * longer takes a burrow client (warren-e24d), so this is the plain `ReapRunInput`
 * — the wiring layer binds any provider-derived seams (e.g. the preview sidecar
 * resolver) into the boot closure it supplies as `reap`.
 */
export type WatchdogReap = (input: ReapRunInput) => Promise<ReapRunResult>;

/** Event kind emitted on the run row when the watchdog force-fails a hung run. */
export const WATCHDOG_TIMED_OUT_KIND = "watchdog.timed_out";

/** Default tick cadence for the heartbeat watchdog (ms). */
export const DEFAULT_WATCHDOG_TICK_MS = 30_000;

/**
 * Fast-path reconcile grace (ms) for a run with a recorded CANCEL intent
 * (warren-fe9b). A cancel deletes the pod immediately, but the pod lingers in
 * `Terminating` (phase still `Running`) for its SIGTERM grace, so the cancel
 * path's inline terminal-detect usually reads a non-terminal phase and hands
 * off to this net. Waiting the full 2-min terminal-reconcile grace (plus a
 * 30s tick) stranded cancelled runs `running` for far longer than any poller
 * tolerates — the GKE incident saw ~25 min — while holding an admission slot.
 * Once the run is idle past this shorter grace AND carries a `cancel.requested`
 * event, the tick probes `status()` right away, so a deliberately-deleted pod
 * reconciles to `cancelled` in seconds-to-a-minute. Runs WITHOUT a cancel
 * intent keep the full grace (no extra probes for healthy runs). Override with
 * `WARREN_RUN_CANCEL_RECONCILE_GRACE_MS`; `0` disables the fast path.
 */
export const DEFAULT_WATCHDOG_CANCEL_RECONCILE_GRACE_MS = 15_000;

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
	/**
	 * The active runtime provider (warren-1fce). The tick's graceful cancel of a
	 * hung run routes through `provider.cancel(handle)`, and the same provider is
	 * threaded into the force-fail reap so its finalize + terminate run on the
	 * active backend (in-pod under `WARREN_RUNTIME=k8s`). Required — the watchdog
	 * no longer falls back to a burrow-backed provider it constructs itself.
	 */
	readonly runtimeProvider: RuntimeProvider;
	/**
	 * Heartbeat budget in ms. A `running` run whose newest event (or
	 * `startedAt` fallback) is older than this is force-failed. Must be
	 * positive — the boot wrapper refuses to arm with a non-positive value.
	 */
	readonly heartbeatTimeoutMs: number;
	/**
	 * Grace (ms) for the terminal-reconcile safety net (warren-c433). A `running`
	 * run whose provider `status()` reports terminal-or-gone but whose row is still
	 * non-terminal is force-finalized once its heartbeat age exceeds this. Positive
	 * ⇒ armed; `0` (or omitted) ⇒ the net is off and only the heartbeat force-fail
	 * runs (the pre-warren-c433 behaviour, kept for tests that don't opt in). The
	 * `status()` probe only fires for runs already idle past this grace, so a
	 * healthy run emitting events is never probed.
	 */
	readonly terminalReconcileGraceMs?: number;
	/**
	 * Fast-path grace (ms) for runs with a recorded cancel intent (warren-fe9b).
	 * A run idle past this grace that carries a `cancel.requested` event is
	 * probed immediately rather than waiting out `terminalReconcileGraceMs`, so
	 * an operator cancel reconciles to `cancelled` in seconds-to-a-minute
	 * instead of lingering `running` while holding an admission slot. Only
	 * armed when the reconcile net itself is armed (`terminalReconcileGraceMs`
	 * > 0). Defaults to `DEFAULT_WATCHDOG_CANCEL_RECONCILE_GRACE_MS`; `0`
	 * disables the fast path.
	 */
	readonly cancelReconcileGraceMs?: number;
	readonly broker?: RunEventBroker;
	/** Forwarded to reap so a timed-out run still gets the configured PR/branch handling. */
	readonly autoOpenPr?: AutoOpenPrConfig;
	readonly now?: () => Date;
	readonly logger?: BridgeLogger;
	/**
	 * The reap seam the force-fail routes through (warren-1fce). Bound by the
	 * wiring layer to `reapRun` with the burrow client pre-applied (see
	 * `WatchdogReap`); tests inject their own to capture the call.
	 */
	readonly reap: WatchdogReap;
}

export interface WatchdogTickResult {
	readonly timedOut: readonly { readonly runId: string; readonly idleMs: number }[];
	/**
	 * Runs the terminal-reconcile net force-finalized this tick (warren-c433):
	 * their pod was terminal-or-gone but the row stayed non-terminal past the
	 * grace. Carries the reconciled outcome so callers can distinguish a reclaimed
	 * already-dead run from a heartbeat force-fail.
	 */
	readonly reconciled: readonly {
		readonly runId: string;
		readonly idleMs: number;
		readonly outcome: RunTerminalState;
	}[];
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
	const reconciled: { runId: string; idleMs: number; outcome: RunTerminalState }[] = [];
	const errors: { runId: string; reason: string }[] = [];
	const graceMs = deps.terminalReconcileGraceMs ?? 0;

	let running: RunRow[];
	try {
		running = await deps.repos.runs.listByState("running");
	} catch (err) {
		return {
			timedOut,
			reconciled,
			errors: [{ runId: "<listByState:running>", reason: formatError(err) }],
		};
	}

	for (const run of running) {
		try {
			const action = await evaluateRun(deps, run, now(), graceMs);
			if (action.kind === "timedOut") timedOut.push({ runId: run.id, idleMs: action.idleMs });
			else if (action.kind === "reconciled") {
				reconciled.push({ runId: run.id, idleMs: action.idleMs, outcome: action.outcome });
			}
		} catch (err) {
			errors.push({ runId: run.id, reason: formatError(err) });
			bindBridgeLogger(deps.logger, { run_id: run.id }).error(
				{ event: "watchdog.force_fail_failed", reason: formatError(err) },
				"watchdog force-fail failed",
			);
		}
	}

	return { timedOut, reconciled, errors };
}

/** What the tick did (or didn't do) for one `running` run. */
type TickAction =
	| { kind: "timedOut"; idleMs: number }
	| { kind: "reconciled"; idleMs: number; outcome: RunTerminalState }
	| { kind: "none" };

/**
 * Classify + act on a single `running` run. Split out of `tickWatchdog` to keep
 * that function under the complexity ratchet; the caller owns error isolation and
 * result accumulation.
 */
async function evaluateRun(
	deps: WatchdogTickDeps,
	run: RunRow,
	now: Date,
	graceMs: number,
): Promise<TickAction> {
	const idleMs = await computeIdleMs(deps.repos, run, now);
	if (idleMs === null) return { kind: "none" };
	if (idleMs >= deps.heartbeatTimeoutMs) {
		await forceFail(deps, run, idleMs, now);
		return { kind: "timedOut", idleMs };
	}
	// warren-c433: terminal-reconcile safety net. Below the heartbeat budget but idle
	// past the grace, probe the backend: if the pod is terminal-or-gone yet the row is
	// still `running`, the normal terminal-detect → reap path is wedged (the K8s
	// pod-exit reap hang) — reclaim the already-dead run instead of waiting out the
	// full 45-min heartbeat budget. Only runs already idle past the grace are probed.
	if (graceMs > 0 && idleMs >= graceMs) {
		const outcome = await maybeReconcileTerminal(deps, run, idleMs, now);
		if (outcome !== null) return { kind: "reconciled", idleMs, outcome };
		return { kind: "none" };
	}
	// warren-fe9b: cancel fast path. A run with a recorded cancel intent whose
	// pod warren deleted itself gets probed after the SHORTER cancel grace, so a
	// deliberate stop reconciles to `cancelled` in seconds-to-a-minute rather
	// than waiting out the full reconcile grace while holding an admission slot.
	// The intent query is one indexed row lookup, paid only by runs already idle
	// past the fast-path grace.
	const cancelGraceMs = deps.cancelReconcileGraceMs ?? DEFAULT_WATCHDOG_CANCEL_RECONCILE_GRACE_MS;
	if (graceMs > 0 && cancelGraceMs > 0 && idleMs >= cancelGraceMs) {
		if (await hasCancelIntent(deps.repos, run.id)) {
			const outcome = await maybeReconcileTerminal(deps, run, idleMs, now);
			if (outcome !== null) return { kind: "reconciled", idleMs, outcome };
		}
	}
	return { kind: "none" };
}

async function forceFail(
	deps: WatchdogTickDeps,
	run: RunRow,
	idleMs: number,
	now: Date,
): Promise<void> {
	// warren-9f06: bind run_id (+ sandbox_run_id when present) once per
	// force-fail so the timeout/cancel lines share correlation fields.
	const log = bindBridgeLogger(deps.logger, {
		run_id: run.id,
		...(run.sandboxRunId !== null ? { sandbox_run_id: run.sandboxRunId } : {}),
	});
	await emitTimedOutEvent(deps, run, idleMs, now);
	await cancelBurrowRun(deps, run, log);

	await deps.reap({
		runId: run.id,
		outcome: "failed",
		failureReason: "timed_out",
		repos: deps.repos,
		// warren-a7cb / warren-1fce: route the force-fail reap's finalize + terminate
		// through the active backend (in-pod under WARREN_RUNTIME=k8s). The burrow
		// client reap still needs for its workspace reads is pre-bound by the wiring.
		runtimeProvider: deps.runtimeProvider,
		...(deps.broker !== undefined ? { broker: deps.broker } : {}),
		...(deps.now !== undefined ? { now: deps.now } : {}),
		...(deps.logger !== undefined ? { logger: deps.logger } : {}),
		...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
	});

	log.info(
		{
			event: WATCHDOG_TIMED_OUT_KIND,
			idleMs,
			heartbeatTimeoutMs: deps.heartbeatTimeoutMs,
		},
		"watchdog force-failed hung run",
	);
}

/**
 * Best-effort graceful cancel (seam `provider.cancel`) so the backend stops the
 * agent turn before reap destroys the workspace. Swallows a lost run
 * (`RuntimeRunNotFoundError`, the neutralized backend 404) and transport
 * failures — reap's `workspace_destroy` is the real teardown, and a failed
 * cancel must never block the force-fail.
 */
async function cancelBurrowRun(
	deps: WatchdogTickDeps,
	run: RunRow,
	log: ReturnType<typeof bindBridgeLogger>,
): Promise<void> {
	if (run.sandboxId === null || run.sandboxRunId === null) return;
	const handle: RunHandle = {
		runId: run.id,
		sandboxId: run.sandboxId,
		providerRunId: run.sandboxRunId,
	};
	try {
		await deps.runtimeProvider.cancel(handle, "watchdog heartbeat timeout");
	} catch (err) {
		if (err instanceof RuntimeRunNotFoundError) return;
		log.error(
			{ event: "watchdog.cancel_failed", reason: formatError(err) },
			"watchdog burrow-cancel failed",
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
		sandboxEventSeq: seq,
		ts: now.toISOString(),
		kind: WATCHDOG_TIMED_OUT_KIND,
		stream: "system",
		payload: {
			idleMs,
			heartbeatTimeoutMs: deps.heartbeatTimeoutMs,
			sandboxRunId: run.sandboxRunId,
		},
	});
	deps.broker?.publish(run.id, row);
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
 * overlapping ticks instead of stacking them.
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
			input.logger?.info?.(
				{ event: "watchdog.tick_skipped" },
				"watchdog tick skipped: prior tick still in flight",
			);
			return null;
		}
		const promise = (async () => {
			try {
				const result = await tickWatchdog(input);
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error?.(
					{ event: "watchdog.tick_failed", reason: formatError(err) },
					"watchdog tick failed",
				);
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
