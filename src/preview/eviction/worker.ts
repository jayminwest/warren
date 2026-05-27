/**
 * Periodic scheduling for the preview eviction tick (warren-d0a9 split
 * of src/preview/eviction.ts). Single-flight (mirrors `startScheduler`
 * in `src/triggers/tick.ts`): a tick in flight when the next interval
 * fires is skipped instead of stacking, so a slow tick degrades cadence
 * but never causes double eviction. `stop()` awaits the in-flight tick
 * so teardown doesn't race the next `sidecars.delete`.
 */

import { runPreviewEvictionTick } from "./tick.ts";
import type { PreviewEvictionTickInput, PreviewEvictionTickResult } from "./types.ts";

function buildTickInput(input: StartPreviewEvictionWorkerInput): PreviewEvictionTickInput {
	return {
		db: input.db,
		repos: input.repos,
		burrowClientPool: input.burrowClientPool,
		warrenConfigs: input.warrenConfigs,
		config: input.config,
		...(input.broker !== undefined ? { broker: input.broker } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
		...(input.logger !== undefined ? { logger: input.logger } : {}),
		...(input.resolveSidecar !== undefined ? { resolveSidecar: input.resolveSidecar } : {}),
		...(input.previews !== undefined ? { previews: input.previews } : {}),
	};
}

export type EvictionTimerHandle = object;

export interface PreviewEvictionWorkerHandle {
	stop(): Promise<void>;
	/** Test seam — fire one tick synchronously and await completion. */
	runOnce(): Promise<PreviewEvictionTickResult | null>;
	/** Test/diagnostic surface — completed tick count. */
	tickCount(): number;
}

export interface StartPreviewEvictionWorkerInput extends Omit<PreviewEvictionTickInput, "now"> {
	readonly now?: () => Date;
	readonly setInterval?: (cb: () => void, ms: number) => EvictionTimerHandle;
	readonly clearInterval?: (handle: EvictionTimerHandle) => void;
}

const NOOP_HANDLE = Symbol("preview-eviction-noop") as unknown as EvictionTimerHandle;

/**
 * Boot the eviction tick. Mirrors `startScheduler`'s contract: single-flight
 * (overlapping ticks are dropped, not stacked), `stop()` awaits the in-flight
 * tick to drain so a teardown doesn't race the next sidecar.delete.
 */
export function startPreviewEvictionWorker(
	input: StartPreviewEvictionWorkerInput,
): PreviewEvictionWorkerHandle {
	const setIntervalFn: (cb: () => void, ms: number) => EvictionTimerHandle =
		input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as EvictionTimerHandle);
	const clearIntervalFn: (handle: EvictionTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<PreviewEvictionTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const tickInput = buildTickInput(input);

	const runTickAndCount = async (): Promise<PreviewEvictionTickResult | null> => {
		try {
			const result = await runPreviewEvictionTick(tickInput);
			ticks += 1;
			return result;
		} catch (err) {
			input.logger?.error(
				{ err: err instanceof Error ? err.message : String(err) },
				"preview_eviction.tick_failed",
			);
			return null;
		} finally {
			inFlight = null;
		}
	};

	const fire = async (): Promise<PreviewEvictionTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info({}, "preview_eviction.tick_skipped");
			return null;
		}
		const promise = runTickAndCount();
		inFlight = promise;
		return promise;
	};

	const handle: EvictionTimerHandle = input.config.disabled
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
					// Already logged inside fire().
				}
			}
		},
		runOnce: fire,
		tickCount: () => ticks,
	};
}
