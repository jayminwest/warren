/**
 * Worker probe loop (warren-0f0c / pl-9ba1 step 6, parent warren-6747).
 *
 * Runs every `WARREN_WORKER_PROBE_INTERVAL_MS` (default 30s), asks every
 * registered client in the {@link BurrowClientPool} for a `/healthz`,
 * and flips the `workers.state` column based on the result:
 *
 *   - probe ok      ⇒ `healthy`     (transitioning back from `unreachable`)
 *   - probe failed  ⇒ `unreachable`
 *   - `draining`    ⇒ untouched     (operator-initiated state always
 *                                    wins over probe result; draining
 *                                    only clears via re-drain `false`)
 *
 * The loop is shaped like the trigger scheduler in `triggers/tick.ts`:
 * single-flight (a slow probe degrades effective cadence but never
 * overlaps with itself), `disabled` flag so `bootServer` can wire it
 * unconditionally, `runOnce` test seam so a test can fire one tick
 * synchronously without juggling timers. The loop swallows per-worker
 * exceptions — the pool's `probe()` already collects rejections into
 * `{ok: false, error}` results, so the only way the tick itself can
 * fail is a SQLite error setting the worker's state. That fails
 * loudly as `worker_probe.tick_failed` rather than killing the loop.
 *
 * Why this lives next to bridges.ts / scheduler.ts: like those, it is a
 * boot-time background loop that depends on the same `BurrowClientPool`
 * / `WorkersRepo` seams, has its own stop() on the teardown chain, and
 * exposes a `runOnce` test surface. Probe is read-only from the pool's
 * POV; it never mutates the pool.
 */

import type { BurrowClientPool, ProbeResult } from "../burrow-client/pool.ts";
import type { WorkersRepo } from "../db/repos/workers.ts";
import type { WorkerState } from "../db/schema.ts";
import { parseTrueEnv } from "./main/utils.ts";

/** Default probe cadence — matches plan approach prose ("every 30s"). */
export const DEFAULT_WORKER_PROBE_INTERVAL_MS = 30_000;

/** Default per-probe timeout (forwarded to `BurrowClient.probe`). */
export const DEFAULT_WORKER_PROBE_TIMEOUT_MS = 2_000;

export interface WorkerProbeLogger {
	info?(obj: object, msg?: string): void;
	warn?(obj: object, msg?: string): void;
	error?(obj: object, msg?: string): void;
	debug?(obj: object, msg?: string): void;
}

export interface WorkerProbeConfig {
	/** Tick cadence in ms. Defaults to {@link DEFAULT_WORKER_PROBE_INTERVAL_MS}. */
	readonly intervalMs?: number;
	/** Per-worker probe timeout. Defaults to {@link DEFAULT_WORKER_PROBE_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
	/** No-op loop when true. `bootServer` can pass through an env flag. */
	readonly disabled?: boolean;
}

/**
 * Env contract:
 *   WARREN_WORKER_PROBE_INTERVAL_MS  tick cadence (default 30000)
 *   WARREN_WORKER_PROBE_TIMEOUT_MS   per-probe timeout (default 2000)
 *   WARREN_WORKER_PROBE_DISABLED     '1'/'true' to disable the loop
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

export function loadWorkerProbeConfigFromEnv(env: EnvLike = process.env): WorkerProbeConfig {
	const intervalMs = parsePositiveInt(
		env.WARREN_WORKER_PROBE_INTERVAL_MS,
		"WARREN_WORKER_PROBE_INTERVAL_MS",
	);
	const timeoutMs = parsePositiveInt(
		env.WARREN_WORKER_PROBE_TIMEOUT_MS,
		"WARREN_WORKER_PROBE_TIMEOUT_MS",
	);
	const disabled = parseTrueEnv(env.WARREN_WORKER_PROBE_DISABLED);
	return {
		...(intervalMs !== undefined ? { intervalMs } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		disabled,
	};
}

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || n <= 0 || String(n) !== raw) {
		throw new Error(`${label} must be a positive integer; got '${raw}'`);
	}
	return n;
}

export type WorkerProbeTimerHandle = object;

export interface StartWorkerProbeInput {
	readonly pool: BurrowClientPool;
	readonly workers: WorkersRepo;
	readonly config?: WorkerProbeConfig;
	readonly logger?: WorkerProbeLogger;
	/** Override setInterval (tests). */
	readonly setInterval?: (cb: () => void, ms: number) => WorkerProbeTimerHandle;
	readonly clearInterval?: (handle: WorkerProbeTimerHandle) => void;
}

export interface WorkerProbeTickResult {
	readonly probes: readonly ProbeResult[];
	readonly transitions: readonly WorkerProbeTransition[];
}

export interface WorkerProbeTransition {
	readonly workerName: string;
	readonly from: WorkerState;
	readonly to: WorkerState;
	readonly reason: "probe_ok" | "probe_failed";
}

export interface WorkerProbeHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously. */
	runOnce(): Promise<WorkerProbeTickResult | null>;
	/** Test/diagnostic surface — number of ticks completed. */
	tickCount(): number;
}

const NOOP_HANDLE = Symbol("noop-probe-handle") as unknown as WorkerProbeTimerHandle;

/**
 * Boot the probe loop. The returned handle goes on the server's stop
 * chain so `bootServer` can drain an in-flight probe before tearing down
 * the pool + db.
 */
export function startWorkerProbe(input: StartWorkerProbeInput): WorkerProbeHandle {
	const intervalMs = input.config?.intervalMs ?? DEFAULT_WORKER_PROBE_INTERVAL_MS;
	const timeoutMs = input.config?.timeoutMs ?? DEFAULT_WORKER_PROBE_TIMEOUT_MS;
	const disabled = input.config?.disabled === true;

	const setIntervalFn: (cb: () => void, ms: number) => WorkerProbeTimerHandle =
		input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as WorkerProbeTimerHandle);
	const clearIntervalFn: (handle: WorkerProbeTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<WorkerProbeTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const fire = async (): Promise<WorkerProbeTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.debug?.({}, "worker_probe.tick_skipped");
			return null;
		}
		const promise = (async () => {
			try {
				const result = await runProbeTick({
					pool: input.pool,
					workers: input.workers,
					timeoutMs,
					...(input.logger !== undefined ? { logger: input.logger } : {}),
				});
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error?.(
					{ err: err instanceof Error ? err.message : String(err) },
					"worker_probe.tick_failed",
				);
				return null;
			} finally {
				inFlight = null;
			}
		})();
		inFlight = promise;
		return promise;
	};

	const handle: WorkerProbeTimerHandle = disabled
		? NOOP_HANDLE
		: setIntervalFn(() => void fire(), intervalMs);

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

interface RunProbeTickInput {
	readonly pool: BurrowClientPool;
	readonly workers: WorkersRepo;
	readonly timeoutMs: number;
	readonly logger?: WorkerProbeLogger;
}

/**
 * One probe pass. Calls `pool.probe()`, then for each result reconciles
 * the corresponding `workers` row's state. Returns the raw probes plus
 * a tidy list of state transitions for tests / observability.
 *
 * Workers in the pool that have no `workers` row (e.g. the synthetic
 * `local` row was deleted out from under us) are skipped — the probe
 * still runs against the client but nothing to write. Workers in the
 * `workers` table with no pool entry are out of scope; the fan-out
 * iterates the pool, not the table.
 */
export async function runProbeTick(input: RunProbeTickInput): Promise<WorkerProbeTickResult> {
	const probes = await input.pool.probe(input.timeoutMs);
	const transitions: WorkerProbeTransition[] = [];

	for (const probe of probes) {
		const row = await input.workers.get(probe.workerName);
		if (row === null) {
			input.logger?.warn?.({ workerName: probe.workerName }, "worker_probe.missing_row");
			continue;
		}
		// Operator-set `draining` is sticky — probe outcome doesn't flip
		// it back to `healthy` or forward to `unreachable`. The drain
		// endpoint is the only way out of `draining` (re-drain `false`).
		if (row.state === "draining") continue;

		const next: WorkerState = probe.ok ? "healthy" : "unreachable";
		if (next === row.state) continue;

		await input.workers.setState(probe.workerName, next);
		const transition: WorkerProbeTransition = {
			workerName: probe.workerName,
			from: row.state,
			to: next,
			reason: probe.ok ? "probe_ok" : "probe_failed",
		};
		transitions.push(transition);
		if (probe.ok) {
			input.logger?.info?.(
				{ workerName: probe.workerName, from: row.state, to: next },
				"worker_probe.recovered",
			);
		} else {
			input.logger?.warn?.(
				{
					workerName: probe.workerName,
					from: row.state,
					to: next,
					err: probe.error?.message,
				},
				"worker_probe.unreachable",
			);
		}
	}

	return { probes, transitions };
}
