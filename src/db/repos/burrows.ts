/**
 * Repository for the `burrows` table (warren-135b / pl-9ba1 step 2, parent
 * warren-6747).
 *
 * Source of truth for `{burrow_id → worker_id}` — the mapping that lets
 * `BurrowClient.clientFor({burrowId})` (step 3) pick the worker that
 * owns a burrow's sandbox + burrow-side SQLite row. One row is created at
 * burrow-provision time (step 4 wires the spawn flow); the row outlives the
 * burrow's lifecycle on the warren side so reap / pr_open / fan-out reads
 * for a destroyed burrow still resolve to the worker that hosted it.
 *
 * `worker_id` is plain text (no FK to `workers.name`) so zero-config single-
 * worker deploys — which use a synthetic local worker not materialized in
 * the `workers` table — still write valid rows here. Step 7's loader is the
 * only path that puts real worker rows in `workers`.
 */

import { asc, eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { BurrowRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export interface CreateBurrowInput {
	id: string;
	workerId: string;
	now?: Date;
}

export class BurrowsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get burrows() {
		return this.adapter.schema.burrows;
	}

	/**
	 * Record a freshly-provisioned burrow's owning worker. `id` is burrow's
	 * `bur_xxx` handle returned by `POST /burrows`; collisions are an
	 * invariant violation (warren only ever sees a burrow id once per
	 * `provisionBurrow` call), so we surface duplicates as the constraint
	 * error rather than papering over with an upsert.
	 */
	async create(input: CreateBurrowInput): Promise<BurrowRow> {
		const row: BurrowRow = {
			id: input.id,
			workerId: input.workerId,
			addedAt: (input.now ?? new Date()).toISOString(),
		};
		await this.adapter.runWrite(this.db.insert(this.burrows).values(row));
		return row;
	}

	async get(id: string): Promise<BurrowRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.burrows).where(eq(this.burrows.id, id)),
		);
		return row ?? null;
	}

	async require(id: string): Promise<BurrowRow> {
		const row = await this.get(id);
		if (!row) {
			throw new NotFoundError(`burrow not found: ${id}`, {
				recoveryHint: "warren has no placement record for this burrow id",
			});
		}
		return row;
	}

	async listAll(): Promise<BurrowRow[]> {
		return this.adapter.pickAll(
			this.db.select().from(this.burrows).orderBy(asc(this.burrows.addedAt), asc(this.burrows.id)),
		);
	}

	async listByWorker(workerId: string): Promise<BurrowRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.burrows)
				.where(eq(this.burrows.workerId, workerId))
				.orderBy(asc(this.burrows.addedAt), asc(this.burrows.id)),
		);
	}

	async delete(id: string): Promise<void> {
		await this.adapter.runWrite(this.db.delete(this.burrows).where(eq(this.burrows.id, id)));
	}
}
