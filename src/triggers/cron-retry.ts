/**
 * Bounded in-slot retry state for cron triggers (warren-a0a2).
 *
 * `dispatchCronTrigger` retries a transient spawn failure (burrow briefly
 * down, DB hiccup) on the next 60s tick within the same cron slot — that is
 * the brief-outage recovery behaviour we must keep (pl-2f15 risk #5). Left
 * unbounded, a persistently-unreachable runtime (the pre-warren-1ca1 K8s
 * misconfig, or burrow down for hours) retries every tick forever, minting one
 * `never_started` run row per tick (~200 rows in 3h observed on GKE).
 *
 * This tracker gives the dispatcher a small per-trigger memory so it can cap
 * those consecutive transient failures. State is **in-memory only** — one
 * instance lives on the scheduler for its process lifetime. A warren restart
 * resets every counter, which is acceptable: the worst case is one extra
 * bounded burst of `MAX_CRON_TRANSIENT_RETRIES` attempts after a restart, not
 * unbounded retries.
 *
 * The slot is identified by the trigger row's `lastFiredAt` string: it does
 * not change while a slot's attempts keep failing (the row is left untouched
 * on a transient failure), and it advances the instant a slot fires or is
 * consumed — so a fresh slot naturally resets the counter via {@link
 * CronRetryTracker.forSlot}.
 */

/**
 * Number of consecutive transient spawn failures tolerated within one cron
 * slot before the dispatcher gives up on that slot: it consumes the slot
 * (advances the trigger row) and emits a `scheduler.cron_gave_up` log instead
 * of retrying every tick indefinitely. Five 60s ticks ≈ a five-minute outage
 * window per slot — comfortably past a brief blip, well short of "forever".
 */
export const MAX_CRON_TRANSIENT_RETRIES = 5;

export interface CronRetryState {
	/**
	 * The trigger row's `lastFiredAt` at the time of the current slot's
	 * attempts. When the row advances (a genuine new slot, a fire, or a
	 * give-up) this changes and the counter resets.
	 */
	slotKey: string;
	/** Consecutive transient spawn failures observed within the current slot. */
	consecutiveFailures: number;
	/**
	 * The `never_started` run id minted by the most recent failed attempt in
	 * this slot, if any. Carried so the next attempt (or a recovery) can GC it,
	 * leaving at most one never_started row per failed slot. Null when the most
	 * recent failure happened before the run row was created (e.g. a pre-row
	 * refresh failure).
	 */
	lastFailedRunId: string | null;
}

/**
 * Per-trigger consecutive-transient-failure memory, keyed by
 * `<projectId>\0<triggerId>`. Not persisted — see the module header.
 */
export class CronRetryTracker {
	private readonly byTrigger = new Map<string, CronRetryState>();

	private key(projectId: string, triggerId: string): string {
		return `${projectId}\u0000${triggerId}`;
	}

	/**
	 * Return the retry state for a trigger's current slot, creating (or
	 * resetting) it whenever the slot advanced since the last observation. The
	 * returned object is live — the caller mutates `consecutiveFailures` /
	 * `lastFailedRunId` in place.
	 */
	forSlot(projectId: string, triggerId: string, slotKey: string): CronRetryState {
		const k = this.key(projectId, triggerId);
		const existing = this.byTrigger.get(k);
		if (existing !== undefined && existing.slotKey === slotKey) return existing;
		const fresh: CronRetryState = { slotKey, consecutiveFailures: 0, lastFailedRunId: null };
		this.byTrigger.set(k, fresh);
		return fresh;
	}

	/** Drop a trigger's slot memory (after a fire or a give-up). */
	clear(projectId: string, triggerId: string): void {
		this.byTrigger.delete(this.key(projectId, triggerId));
	}
}
