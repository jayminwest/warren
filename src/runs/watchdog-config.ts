/**
 * Env-config resolution for the run heartbeat watchdog (extracted from
 * `./watchdog.ts` to keep both files under the per-file size budget). See
 * that module's header for the detector's purpose; this module owns only the
 * `WARREN_RUN_*` / `WARREN_WATCHDOG_*` env parsing and the `WatchdogConfig`
 * shape the boot wiring (`src/server/main/detector-wiring.ts`) consumes.
 */

import {
	DEFAULT_WATCHDOG_CANCEL_RECONCILE_GRACE_MS,
	DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS,
	DEFAULT_WATCHDOG_TICK_MS,
} from "./watchdog.ts";
import { DEFAULT_WATCHDOG_TERMINAL_RECONCILE_GRACE_MS } from "./watchdog-reconcile.ts";

export interface WatchdogConfig {
	/**
	 * Armed unless explicitly opted out (`WARREN_WATCHDOG_DISABLED`) or the
	 * budget is pinned to 0. On by default (warren-b2dc).
	 */
	readonly enabled: boolean;
	readonly heartbeatTimeoutMs: number;
	readonly tickMs: number;
	/**
	 * Terminal-reconcile grace (ms) for the warren-c433 safety net. Defaults to
	 * `DEFAULT_WATCHDOG_TERMINAL_RECONCILE_GRACE_MS`; `0` disables the net.
	 */
	readonly terminalReconcileGraceMs: number;
	/**
	 * Fast-path reconcile grace (ms) for cancel-intent runs (warren-fe9b).
	 * Defaults to `DEFAULT_WATCHDOG_CANCEL_RECONCILE_GRACE_MS`; `0` disables the
	 * fast path.
	 */
	readonly cancelReconcileGraceMs: number;
}

interface WatchdogEnvLike {
	readonly WARREN_RUN_HEARTBEAT_TIMEOUT_MS?: string;
	readonly WARREN_WATCHDOG_TICK_MS?: string;
	readonly WARREN_WATCHDOG_DISABLED?: string;
	readonly WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS?: string;
	readonly WARREN_RUN_CANCEL_RECONCILE_GRACE_MS?: string;
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
	const terminalReconcileGraceMs = parseNonNegativeInt(
		env.WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS,
		"WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS",
		DEFAULT_WATCHDOG_TERMINAL_RECONCILE_GRACE_MS,
	);
	const cancelReconcileGraceMs = parseNonNegativeInt(
		env.WARREN_RUN_CANCEL_RECONCILE_GRACE_MS,
		"WARREN_RUN_CANCEL_RECONCILE_GRACE_MS",
		DEFAULT_WATCHDOG_CANCEL_RECONCILE_GRACE_MS,
	);
	const optedOut = parseDisabledFlag(env.WARREN_WATCHDOG_DISABLED);
	return {
		enabled: !optedOut && heartbeatTimeoutMs > 0,
		heartbeatTimeoutMs,
		tickMs,
		terminalReconcileGraceMs,
		cancelReconcileGraceMs,
	};
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
