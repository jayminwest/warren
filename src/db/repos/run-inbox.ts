/**
 * Repository for the `run_inbox` table (warren-3d0b, pl-829f step 18).
 *
 * The durable steering channel for pod-per-run K8s runs. With no live socket
 * into the sandbox (LocalProvider's burrow inbox has no K8s analogue), warren
 * persists each steering message here; the in-pod agent harness polls
 * `GET /runs/:id/inbox` over the Service-DNS callback URL and drains it.
 *
 * Two operations, matched to the two sides of the channel:
 *
 *   - `enqueue` — the WRITE path (`K8sProvider.sendMessage`). Allocates the
 *     next per-run `seq` (max+1) under a transaction so two simultaneous sends
 *     can't collide (mirrors `MessagesRepo.append`), then inserts an `unread`
 *     row. Returns `null` when the target run row does not exist so the
 *     provider can surface the seam's `RuntimeRunNotFoundError` — the DB layer
 *     stays free of runtime-seam error types (layering).
 *
 *   - `claimForDelivery` — the READ/poll path (`GET /runs/:id/inbox`). Claims
 *     every `unread` row for the run in ONE atomic `UPDATE ... WHERE
 *     state='unread' RETURNING` statement that flips them to `delivered` and
 *     stamps `delivered_at`. Atomicity makes it crash-safe and race-safe: a
 *     concurrent poll's UPDATE re-evaluates `state` (row-locked on pg,
 *     serialized on warren's single sqlite connection) and claims nothing the
 *     first already took — no double-delivery. The returned rows are then
 *     sorted priority-desc then FIFO-by-`seq` in-app (a portable custom sort
 *     drizzle can't express identically across both dialects).
 */

import { and, eq, max } from "drizzle-orm";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { InboxPriority, RunInboxRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export interface EnqueueRunInboxInput {
	/** Target run the steering message is addressed to (FKs `runs.id`). */
	runId: string;
	body: string;
	/** Defaults to `normal` — the DB column default and the seam's default. */
	priority?: InboxPriority;
	/** Defaults to `operator` — the DB column default. */
	fromActor?: string;
	/** Explicit id; auto-generated (`msg_…`) when omitted. */
	id?: string;
	now?: Date;
}

export interface ClaimInboxOptions {
	now?: Date;
}

/** Priority rank for the poll's priority-desc ordering (higher = claimed first). */
const PRIORITY_RANK: Record<InboxPriority, number> = {
	urgent: 3,
	high: 2,
	normal: 1,
	low: 0,
};

export class RunInboxRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get runInbox() {
		return this.adapter.schema.runInbox;
	}

	/**
	 * Enqueue an `unread` steering message for a run, allocating the next
	 * per-run `seq` under a transaction. Returns the persisted row, or `null`
	 * when the target run does not exist (the provider maps that to
	 * `RuntimeRunNotFoundError`). The run-existence check shares the transaction
	 * with the seq allocation + insert so a run deleted mid-enqueue can't strand
	 * an orphan row.
	 */
	async enqueue(input: EnqueueRunInboxInput): Promise<RunInboxRow | null> {
		const now = (input.now ?? new Date()).toISOString();
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			const runs = tx.schema.runs;
			const runInbox = tx.schema.runInbox;

			const existing = await tx.pickOne(
				txDb.select({ id: runs.id }).from(runs).where(eq(runs.id, input.runId)),
			);
			if (existing === undefined) return null;

			const seqRows = await tx.pickAll(
				txDb
					.select({ value: max(runInbox.seq) })
					.from(runInbox)
					.where(eq(runInbox.runId, input.runId)),
			);
			const prior = seqRows[0]?.value;
			const seq = (prior === undefined || prior === null ? 0 : Number(prior)) + 1;

			const row: RunInboxRow = {
				id: input.id ?? generateId("message"),
				runId: input.runId,
				seq,
				body: input.body,
				priority: input.priority ?? "normal",
				fromActor: input.fromActor ?? "operator",
				state: "unread",
				createdAt: now,
				deliveredAt: null,
			};
			await tx.runWrite(txDb.insert(runInbox).values(row));
			return row;
		});
	}

	/**
	 * Atomically claim every `unread` row for a run, flip them to `delivered`,
	 * and return them ordered priority-desc then FIFO-by-`seq`. The single
	 * `UPDATE ... RETURNING` is the race-safety primitive (see module doc); the
	 * ordering is applied in-app on the claimed set.
	 */
	async claimForDelivery(runId: string, opts: ClaimInboxOptions = {}): Promise<RunInboxRow[]> {
		const deliveredAt = (opts.now ?? new Date()).toISOString();
		const claimed = await this.adapter.runReturningAll<RunInboxRow>(
			this.db
				.update(this.runInbox)
				.set({ state: "delivered", deliveredAt })
				.where(and(eq(this.runInbox.runId, runId), eq(this.runInbox.state, "unread")))
				.returning(),
		);
		return claimed.sort(compareForDelivery);
	}

	/** All rows for a run, oldest-first by `seq` (test/inspection helper). */
	async listByRun(runId: string): Promise<RunInboxRow[]> {
		const rows = await this.adapter.pickAll<RunInboxRow>(
			this.db.select().from(this.runInbox).where(eq(this.runInbox.runId, runId)),
		);
		return rows.sort((a, b) => a.seq - b.seq);
	}
}

/** priority-desc, then FIFO (`seq`-asc) within a priority class. */
function compareForDelivery(a: RunInboxRow, b: RunInboxRow): number {
	const byPriority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
	return byPriority !== 0 ? byPriority : a.seq - b.seq;
}
