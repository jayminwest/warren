/**
 * Restart budget for a supervised child (docs/design/runtime-and-supervisor.md).
 *
 * The supervisor restarts `burrow serve` on non-zero exit, but a misbehaving
 * burrow (bad config, bwrap bringup failure, kernel mismatch) shouldn't put
 * the supervisor into a tight loop. The budget is `5 restarts in 60s`: after
 * the budget is exhausted, the supervisor exits non-zero and lets the
 * orchestrator's (Docker's) outer restart policy take over.
 *
 * Pure data structure with a sliding window keyed on the supplied `now`. The
 * caller passes `now()` so tests pin the clock.
 */

export class RestartBudget {
	private timestamps: number[] = [];

	constructor(
		readonly maxRestarts: number,
		readonly windowMs: number,
	) {
		if (!Number.isInteger(maxRestarts) || maxRestarts <= 0) {
			throw new Error(`maxRestarts must be a positive integer (got ${maxRestarts})`);
		}
		if (!Number.isFinite(windowMs) || windowMs <= 0) {
			throw new Error(`windowMs must be a positive number (got ${windowMs})`);
		}
	}

	/**
	 * Try to record a restart at `now`. Returns true if the budget allows it
	 * (and records the restart); returns false if the budget is exhausted.
	 */
	tryRecord(now: number): boolean {
		this.prune(now);
		if (this.timestamps.length >= this.maxRestarts) return false;
		this.timestamps.push(now);
		return true;
	}

	/** Number of restarts within the window ending at `now`. */
	recentCount(now: number): number {
		this.prune(now);
		return this.timestamps.length;
	}

	private prune(now: number): void {
		const cutoff = now - this.windowMs;
		this.timestamps = this.timestamps.filter((t) => t > cutoff);
	}
}

/**
 * Exponential backoff: attempt N waits `min(baseMs * 2^(N-1), capMs)`.
 * Attempts are 1-indexed. The 5-attempt budget at 1s base / 16s cap totals
 * 1+2+4+8+16 = 31s, comfortably inside the 60s window.
 */
export function backoffMs(attempt: number, baseMs: number = 1000, capMs: number = 16000): number {
	if (attempt < 1) return 0;
	return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}
