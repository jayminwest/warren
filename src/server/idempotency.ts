/**
 * In-memory idempotency window for `POST /runs` (warren-d525).
 *
 * A duplicate delivery of a single logical dispatch — a proxy/LB replay,
 * a scheduler double-fire, or a client that re-retries a timed-out POST —
 * must NOT spawn a second run (a fresh burrow + agent silently ~2x'ing
 * agent spend). The dispatch handler keys each request on its
 * `Idempotency-Key` header scoped to the target project and routes the
 * spawn through this store: the first request for a `(projectId, key)`
 * pair runs the real dispatch and caches its 201 body; any duplicate
 * within the TTL window replays that cached body instead of spawning.
 *
 * The store also folds CONCURRENT duplicates: the cached value is the
 * in-flight dispatch promise itself, so a second request that lands
 * before the first resolves awaits the same spawn rather than racing it.
 * A failed dispatch evicts the entry so the next retry can re-spawn.
 *
 * In-memory is sufficient: the window only needs to cover retries/replays
 * (minutes), warren is single-process per deployment, and a process
 * restart legitimately reopens the window (a post-restart retry hitting a
 * run the previous process already spawned is a far rarer event than the
 * client/proxy retries this guards). Durable cross-restart dedupe is out
 * of scope for V1.
 */

import type { RunRow } from "../db/schema.ts";

/** Default dedupe window: 10 minutes, comfortably covering retry storms. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/**
 * The cached `POST /runs` 201 body. Mirrors the shape the handler returns
 * so a replay is byte-identical to the original response.
 */
export interface IdempotentDispatch {
	readonly run: RunRow;
	readonly sandbox: { readonly id: string; readonly workspacePath: string };
}

interface Entry {
	readonly expiresAt: number;
	readonly result: Promise<IdempotentDispatch>;
}

/**
 * Bounds the map so a flood of distinct keys can't grow it without limit.
 * Sweeps run on every access, so this is only a backstop against a burst
 * of never-expiring-yet entries within one window.
 */
const MAX_ENTRIES = 10_000;

export class IdempotencyStore {
	private readonly entries = new Map<string, Entry>();
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(options?: { ttlMs?: number; now?: () => number }) {
		this.ttlMs = options?.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
		this.now = options?.now ?? Date.now;
	}

	/**
	 * Run `dispatch` at most once per `(projectId, key)` within the TTL
	 * window. On a hit, `dispatch` is NOT invoked and the cached/in-flight
	 * result is returned — so the caller's side effects (bridge start,
	 * user-message append) must live inside `dispatch` to stay deduped.
	 */
	async run(
		projectId: string,
		key: string,
		dispatch: () => Promise<IdempotentDispatch>,
	): Promise<IdempotentDispatch> {
		const mapKey = `${projectId}\u0000${key}`;
		this.sweep();
		const existing = this.entries.get(mapKey);
		if (existing !== undefined && existing.expiresAt > this.now()) {
			return existing.result;
		}
		const result = dispatch();
		this.entries.set(mapKey, { expiresAt: this.now() + this.ttlMs, result });
		try {
			return await result;
		} catch (err) {
			// A failed spawn must not poison the window — let the next retry
			// re-spawn rather than replaying the rejection forever.
			if (this.entries.get(mapKey)?.result === result) this.entries.delete(mapKey);
			throw err;
		}
	}

	private sweep(): void {
		const cutoff = this.now();
		for (const [mapKey, entry] of this.entries) {
			if (entry.expiresAt <= cutoff) this.entries.delete(mapKey);
		}
		if (this.entries.size <= MAX_ENTRIES) return;
		// Over budget even after expiry sweep: evict oldest-inserted first
		// (Map preserves insertion order) until back under the cap.
		const overflow = this.entries.size - MAX_ENTRIES;
		let dropped = 0;
		for (const mapKey of this.entries.keys()) {
			if (dropped >= overflow) break;
			this.entries.delete(mapKey);
			dropped += 1;
		}
	}
}
