/**
 * Hard-delete write method for the `runs` table (warren-a0a2), extracted
 * from `RunsRepo` to keep `runs.ts` under the file-size budget. Mirrors
 * the `runs-queries.ts` precedent: a free function taking the
 * `DrizzleAdapter`, with a thin `RunsRepo` delegate.
 */

import { eq } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { RunRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/**
 * Hard-delete a run row that never reached the runtime (warren-a0a2).
 *
 * The scheduler's bounded-retry GC calls this to drop the transient
 * `never_started` rows a persistently-unreachable runtime would otherwise
 * mint one-per-tick, so the runs list isn't flooded during an outage. It
 * is deliberately narrow:
 *
 *   - Guarded to `state=failed` + `failureReason=never_started`. Any other
 *     row (a real queued/running/succeeded run, or a `failed` run that
 *     actually dispatched) is left untouched and the method returns false.
 *   - `events.run_id` carries `ON DELETE CASCADE` (since migration 0033),
 *     so the write-through event rows fall away with the run row.
 *     `triggers.last_run_id` / `plan_run_children.run_id`
 *     (both `ON DELETE SET NULL`) and `run_inbox` (`CASCADE`) fall away on
 *     their own; a never_started cron retry has none of them anyway.
 *
 * Returns true when a row was deleted, false when the id was missing or
 * the guard rejected it.
 */
export async function deleteNeverStarted(adapter: DrizzleAdapter, id: string): Promise<boolean> {
	return adapter.runInTransaction(async (tx) => {
		const txDb = tx.drizzle as SqliteDrizzleDb;
		const runs = tx.schema.runs;
		const existing = await tx.pickOne<RunRow>(txDb.select().from(runs).where(eq(runs.id, id)));
		if (!existing) return false;
		if (existing.state !== "failed" || existing.failureReason !== "never_started") {
			return false;
		}
		await tx.runWrite(txDb.delete(runs).where(eq(runs.id, id)));
		return true;
	});
}
