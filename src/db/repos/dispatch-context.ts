/**
 * Repository for the `dispatch_context` fact table (warren-36e7 / pl-a37b
 * Track A).
 *
 * One insert-only row per dispatched run, keyed by `run_id`. The writer
 * (warren-d6ca) lives beside spawnRun and calls {@link insert} immediately
 * after the runs row lands — before any runtime contact — so never-started
 * failures still get a row. This module deliberately exposes no UPDATE
 * path: the row is a dispatch-time snapshot, not a live projection.
 *
 * Facts only. NULL means unknown, never a bucket. No derived scores.
 */

import { eq } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DispatchContextInsert, DispatchContextRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/**
 * Input for {@link DispatchContextRepo.insert}. Mirrors the table columns
 * minus nothing — every field the writer can observe is optional so a
 * partial snapshot still lands rather than failing the fire-and-log path.
 * `runId` and `createdAt` are required so the PK and analytics window are
 * always present.
 */
export type InsertDispatchContextInput = DispatchContextInsert;

export class DispatchContextRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get dispatchContext() {
		return this.adapter.schema.dispatchContext;
	}

	/**
	 * Insert one dispatch-context row. Idempotent on `run_id` — a second
	 * insert for the same run is a no-op (ON CONFLICT DO NOTHING) so a
	 * retried spawn path cannot dupe the snapshot. Returns the persisted
	 * row when the insert landed, or `null` when a row already existed.
	 * Uses {@link DrizzleAdapter.runReturningAll} (not One) because a
	 * conflict no-op yields zero rows and One would throw.
	 */
	async insert(input: InsertDispatchContextInput): Promise<DispatchContextRow | null> {
		const inserted = await this.adapter.runReturningAll<DispatchContextRow>(
			this.db.insert(this.dispatchContext).values(input).onConflictDoNothing().returning(),
		);
		return inserted[0] ?? null;
	}

	/** Fetch the snapshot for one run, or `undefined` when none was written. */
	async getByRunId(runId: string): Promise<DispatchContextRow | undefined> {
		return await this.adapter.pickOne<DispatchContextRow>(
			this.db.select().from(this.dispatchContext).where(eq(this.dispatchContext.runId, runId)),
		);
	}
}
