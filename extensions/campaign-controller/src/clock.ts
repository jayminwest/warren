/**
 * Shared time and identity primitives for the campaign controller.
 *
 * Everything downstream (journal timestamps, dedupe keys, reconciliation
 * cursors) must run on an injectable clock and an injectable id generator so
 * the deterministic fake-infrastructure tests of plan pl-91b6 never depend on
 * wall time or on Bun's randomUUID for reproducibility. V0 deliberately stops
 * at the interfaces plus the production defaults — no scheduling, no
 * monotonic sequencing, no persistence (later steps).
 *
 * Boundary contract (enforced by scripts/check-layers.ts): this package
 * imports nothing from warren's `src/` or `scripts/`.
 */

/** Read-only view of "now", injectable so tests pin time exactly. */
export interface Clock {
	/** Current time as epoch milliseconds. */
	nowMs(): number;
}

/** Injectable id source, so tests correlate ids without racing entropy. */
export interface IdGenerator {
	/** A fresh opaque identifier, unique for the lifetime of the generator. */
	newId(): string;
}

/** The production clock: real wall time. */
export class SystemClock implements Clock {
	nowMs(): number {
		return Date.now();
	}
}

/**
 * The production id generator. Ids are `cc-<uuid v4>` so a controller-owned
 * row is recognizable in logs and journals without decoding a schema.
 */
export class UuidIdGenerator implements IdGenerator {
	newId(): string {
		return `cc-${crypto.randomUUID()}`;
	}
}

/** A fully deterministic clock/id pair for tests and fakes. */
export class FixedClock implements Clock {
	private currentMs: number;

	constructor(startMs: number) {
		this.currentMs = startMs;
	}

	nowMs(): number {
		return this.currentMs;
	}

	/** Advance the pinned time; only fakes call this. */
	advance(ms: number): void {
		this.currentMs += ms;
	}
}

/** Sequential ids (`seq-1`, `seq-2`, ...) for deterministic tests. */
export class SequentialIdGenerator implements IdGenerator {
	private next = 0;

	newId(): string {
		this.next += 1;
		return `seq-${String(this.next)}`;
	}
}
