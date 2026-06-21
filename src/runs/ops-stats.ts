/**
 * Periodic operational-stats log line (warren-b2dd / pl-f700 step 6).
 *
 * Every tick this worker emits one structured `ops.stats` info line built
 * entirely from data already in SQLite (plus the in-process bridge
 * registry size): runs grouped by lifecycle state, the number of active
 * stream bridges, cost + token aggregates, and the wall-clock cost of
 * collecting the snapshot. It is pure observability — read-only, never
 * mutates state, and a failed collection is logged + swallowed so the
 * loop survives a transient DB hiccup.
 *
 * Shape mirrors `startWorkspaceGcWorker` (src/runs/reap/gc.ts): env-driven
 * config with conservative defaults, single-flight ticks (a collection in
 * flight when the next interval fires is dropped, not stacked), and a
 * `stop()` that awaits the in-flight tick so teardown doesn't race.
 */

import { ValidationError } from "../core/errors.ts";
import type { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import {
	aggregateRunCost,
	countRunsByState,
	type RunCostAggregate,
} from "../db/repos/runs-stats.ts";
import type { RunState } from "../db/schema.ts";

/* ----------------------------------------------------------------------- */
/* Config                                                                   */
/* ----------------------------------------------------------------------- */

export const WARREN_OPS_STATS_TICK_MS_ENV = "WARREN_OPS_STATS_TICK_MS" as const;
export const WARREN_OPS_STATS_DISABLED_ENV = "WARREN_OPS_STATS_DISABLED" as const;

/** Default cadence; 5m keeps logs informative without flooding. */
export const DEFAULT_OPS_STATS_TICK_MS = 5 * 60_000;

export interface OpsStatsConfig {
	readonly tickMs: number;
	readonly disabled: boolean;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve ops-stats config from env. A malformed tick fails loudly at boot
 * rather than degrading at tick time (mirrors the GC / preview-eviction
 * config loaders).
 */
export function loadOpsStatsConfigFromEnv(env: EnvLike = process.env): OpsStatsConfig {
	const tickMs = parseEnvPositiveInt(env, WARREN_OPS_STATS_TICK_MS_ENV, DEFAULT_OPS_STATS_TICK_MS);
	const disabled = isTruthy(env[WARREN_OPS_STATS_DISABLED_ENV]);
	return { tickMs, disabled };
}

function parseEnvPositiveInt(env: EnvLike, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
		throw new ValidationError(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
	}
	return parsed;
}

function isTruthy(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const lower = raw.trim().toLowerCase();
	return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

/* ----------------------------------------------------------------------- */
/* Snapshot                                                                 */
/* ----------------------------------------------------------------------- */

/**
 * Read-only stats provider the worker pulls from each tick. Backed in
 * production by the standalone `countRunsByState` / `aggregateRunCost`
 * aggregate queries (src/db/repos/runs-stats.ts) bound to a DrizzleAdapter
 * — kept off `RunsRepo` so `runs.ts` stays under its file-size budget.
 */
export interface OpsStatsProvider {
	countByState(): Promise<Record<RunState, number>>;
	aggregateCost(): Promise<RunCostAggregate>;
}

export interface OpsStatsBridgesLike {
	size(): number;
}

export interface OpsStatsLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface OpsStatsSnapshot {
	readonly runsByState: Record<RunState, number>;
	readonly activeBridges: number;
	readonly cost: RunCostAggregate;
	/** Wall-clock ms spent collecting this snapshot. */
	readonly collectMs: number;
}

export interface OpsStatsTickInput {
	readonly stats: OpsStatsProvider;
	readonly bridges: OpsStatsBridgesLike;
	readonly logger?: OpsStatsLogger;
	/** Monotonic clock seam (tests). Defaults to `performance.now()`. */
	readonly clock?: () => number;
}

/**
 * Collect one operational-stats snapshot and emit it as a single
 * `ops.stats` info line. Read-only: the two repo reads are aggregate
 * queries and the bridge count is an in-memory map size, so a tick is
 * cheap even with a large run history.
 */
export async function runOpsStatsTick(input: OpsStatsTickInput): Promise<OpsStatsSnapshot> {
	const clock = input.clock ?? (() => performance.now());
	const start = clock();
	const [runsByState, cost] = await Promise.all([
		input.stats.countByState(),
		input.stats.aggregateCost(),
	]);
	const activeBridges = input.bridges.size();
	const collectMs = Math.round(clock() - start);
	const snapshot: OpsStatsSnapshot = { runsByState, activeBridges, cost, collectMs };

	input.logger?.info(
		{
			runsByState,
			activeBridges,
			costUsd: cost.costUsd,
			tokensInput: cost.tokensInput,
			tokensOutput: cost.tokensOutput,
			collectMs,
		},
		"ops.stats",
	);
	return snapshot;
}

/* ----------------------------------------------------------------------- */
/* Periodic worker                                                          */
/* ----------------------------------------------------------------------- */

export type OpsStatsTimerHandle = object;

export interface OpsStatsWorkerHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously and await completion. */
	runOnce(): Promise<OpsStatsSnapshot | null>;
	/** Test/diagnostic surface — completed tick count. */
	tickCount(): number;
}

export interface StartOpsStatsWorkerInput extends OpsStatsTickInput {
	readonly config: OpsStatsConfig;
	readonly setInterval?: (cb: () => void, ms: number) => OpsStatsTimerHandle;
	readonly clearInterval?: (handle: OpsStatsTimerHandle) => void;
}

const NOOP_HANDLE = Symbol("ops-stats-noop") as unknown as OpsStatsTimerHandle;

/**
 * Boot the periodic operational-stats logger. Single-flight (a tick in
 * flight when the next interval fires is dropped, not stacked) and
 * `stop()` awaits the in-flight tick so teardown doesn't race. When
 * `config.disabled` is set the worker installs no timer and `runOnce()`
 * is a no-op returning `null`.
 */
export function startOpsStatsWorker(input: StartOpsStatsWorkerInput): OpsStatsWorkerHandle {
	const setIntervalFn: (cb: () => void, ms: number) => OpsStatsTimerHandle =
		input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as OpsStatsTimerHandle);
	const clearIntervalFn: (handle: OpsStatsTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<OpsStatsSnapshot | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const runTickAndCount = async (): Promise<OpsStatsSnapshot | null> => {
		try {
			const snapshot = await runOpsStatsTick(input);
			ticks += 1;
			return snapshot;
		} catch (err) {
			input.logger?.error(
				{ err: err instanceof Error ? err.message : String(err) },
				"ops.stats.tick_failed",
			);
			return null;
		} finally {
			inFlight = null;
		}
	};

	const fire = async (): Promise<OpsStatsSnapshot | null> => {
		if (stopped || input.config.disabled) return null;
		if (inFlight !== null) return null;
		const promise = runTickAndCount();
		inFlight = promise;
		return promise;
	};

	const handle: OpsStatsTimerHandle = input.config.disabled
		? NOOP_HANDLE
		: setIntervalFn(() => void fire(), input.config.tickMs);

	return {
		async stop() {
			stopped = true;
			if (handle !== NOOP_HANDLE) clearIntervalFn(handle);
			if (inFlight !== null) {
				try {
					await inFlight;
				} catch {
					// Already logged inside runTickAndCount().
				}
			}
		},
		runOnce: fire,
		tickCount: () => ticks,
	};
}

/**
 * Boot wiring used by `bootServer`: load env config, start the worker,
 * and emit the one-line running/disabled status. Extracted so the boot
 * entry stays under its file-size budget.
 */
export function bootOpsStatsWorker(input: {
	adapter: DrizzleAdapter;
	bridges: OpsStatsBridgesLike;
	logger: OpsStatsLogger;
	env: EnvLike;
}): OpsStatsWorkerHandle {
	const config = loadOpsStatsConfigFromEnv(input.env);
	const stats: OpsStatsProvider = {
		countByState: () => countRunsByState(input.adapter),
		aggregateCost: () => aggregateRunCost(input.adapter),
	};
	const worker = startOpsStatsWorker({
		stats,
		bridges: input.bridges,
		config,
		logger: input.logger,
	});
	input.logger.info(
		{ tickMs: config.tickMs },
		config.disabled
			? "ops stats disabled via WARREN_OPS_STATS_DISABLED"
			: "ops stats worker running",
	);
	return worker;
}
