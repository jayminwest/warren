/**
 * Bridge-logger binding helpers (warren-9f06 / pl-f700 step 5).
 *
 * The run-lifecycle entry points (`runWithReconnect`, `reapRun`, the
 * watchdog detector) used to hand-thread `{ runId, burrowRunId }` onto
 * every single log call and guard each one with `logger?.x?.()`. This
 * module replaces that with a structural pass:
 *
 *   - {@link NOOP_BRIDGE_LOGGER} is a non-optional `BridgeLogger` whose
 *     methods are no-ops, so an entry point can bind once and then call
 *     `log.info(...)` unconditionally — no `?.` ceremony.
 *   - {@link bindBridgeLogger} binds the per-run correlation fields
 *     (`run_id`, `burrow_run_id`, optional `worker`) via the caller's
 *     pino `.child(...)` exactly once at the entry point, falling back to
 *     the no-op when the caller wired nothing.
 *
 * Downstream log lines then carry the correlation fields for free and
 * only add their own `event: "subsystem.action"` discriminator, matching
 * the spawn-flow convention established in warren-c686 (`spawn.placement`,
 * `spawn.provisioned`, …).
 */

import type { BridgeLogger } from "./types.ts";

/**
 * A `BridgeLogger` with all three log methods present (non-optional).
 * Entry points bind to this so call sites drop the `?.` guards.
 */
export type BoundBridgeLogger = Required<Pick<BridgeLogger, "info" | "warn" | "error">> &
	Pick<BridgeLogger, "child">;

/**
 * No-op `BoundBridgeLogger`. Lets a lifecycle entry point log
 * unconditionally even when the caller wired no logger. Returns itself
 * from `child` so a bound child is always a real logger too.
 */
export const NOOP_BRIDGE_LOGGER: BoundBridgeLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	child() {
		return NOOP_BRIDGE_LOGGER;
	},
};

/**
 * Per-run correlation fields bound once at a lifecycle entry point.
 * `worker` is omitted when the entry point can't resolve the owning
 * burrow worker (e.g. reap from a bare run id).
 */
export interface BridgeLoggerBindings {
	readonly run_id: string;
	readonly burrow_run_id?: string;
	readonly worker?: string;
}

/**
 * Bind the per-run correlation fields onto the caller's logger (or the
 * no-op) exactly once. Undefined binding values are dropped so the log
 * line doesn't carry `worker: undefined`.
 */
export function bindBridgeLogger(
	logger: BridgeLogger | undefined,
	bindings: BridgeLoggerBindings,
): BoundBridgeLogger {
	const base = logger ?? NOOP_BRIDGE_LOGGER;
	const filtered: Record<string, string> = { run_id: bindings.run_id };
	if (bindings.burrow_run_id !== undefined) filtered.burrow_run_id = bindings.burrow_run_id;
	if (bindings.worker !== undefined) filtered.worker = bindings.worker;
	const child = base.child?.(filtered);
	if (child !== undefined) return asBound(child);
	return asBound(base);
}

/**
 * Narrow an arbitrary `BridgeLogger` to a `BoundBridgeLogger` by filling
 * any absent method with a no-op. Used so a caller-supplied logger that
 * only implements a subset (the type allows it) is still safe to call
 * unconditionally after binding.
 */
function asBound(logger: BridgeLogger): BoundBridgeLogger {
	return {
		info: logger.info?.bind(logger) ?? (() => {}),
		warn: logger.warn?.bind(logger) ?? (() => {}),
		error: logger.error?.bind(logger) ?? (() => {}),
		...(logger.child !== undefined ? { child: logger.child.bind(logger) } : {}),
	};
}
