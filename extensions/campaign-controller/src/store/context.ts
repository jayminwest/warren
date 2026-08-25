/**
 * Shared store context: one `bun:sqlite` Database plus the injected clock
 * and id generator. Splitting the context into its own module lets every
 * focused sub-store depend on it without importing the composition root.
 */
import type { Database } from "bun:sqlite";
import type { Clock, IdGenerator } from "../clock.ts";

/** Injectable dependencies every sub-store shares. */
export interface StoreContext {
	readonly db: Database;
	readonly clock: Clock;
	readonly ids: IdGenerator;
}

/** Current time from the injected clock, in epoch milliseconds. */
export function nowMs(ctx: StoreContext): number {
	return ctx.clock.nowMs();
}
