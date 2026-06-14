/**
 * Repository for the `messages` table (warren-0b91).
 *
 * The conversation transcript, one row per turn, `seq` monotonic per
 * conversation. The re-wake primitive (warren-6ccf) reads this back oldest-
 * first to replay a conversation into a fresh pi session, so ordering by
 * `seq` is load-bearing. `append` allocates the next `seq` under a
 * transaction so concurrent turns don't collide (mirrors EventsRepo's
 * per-run seq discipline).
 *
 * `content` is free-form TEXT (a turn body or a JSON-encoded tool payload);
 * `runId` optionally back-links the anchoring run that produced the turn.
 */

import { asc, eq, max } from "drizzle-orm";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { MessageRole, MessageRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export interface AppendMessageInput {
	id?: string;
	conversationId: string;
	role: MessageRole;
	content: string;
	runId?: string | null;
	/** Explicit seq; auto-allocated (max+1 per conversation) when omitted. */
	seq?: number;
	now?: Date;
}

export class MessagesRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get messages() {
		return this.adapter.schema.messages;
	}

	/** Highest `seq` written for a conversation, or null if none. */
	async maxSeq(conversationId: string): Promise<number | null> {
		const rows = await this.adapter.pickAll(
			this.db
				.select({ value: max(this.messages.seq) })
				.from(this.messages)
				.where(eq(this.messages.conversationId, conversationId)),
		);
		const value = rows[0]?.value;
		return value === undefined || value === null ? null : Number(value);
	}

	/**
	 * Append a turn, auto-allocating the next `seq` (max+1) under a
	 * transaction so two simultaneous turns can't claim the same slot.
	 */
	async append(input: AppendMessageInput): Promise<MessageRow> {
		const now = (input.now ?? new Date()).toISOString();
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			const messages = tx.schema.messages;
			let seq = input.seq;
			if (seq === undefined) {
				const rows = await tx.pickAll(
					txDb
						.select({ value: max(messages.seq) })
						.from(messages)
						.where(eq(messages.conversationId, input.conversationId)),
				);
				const value = rows[0]?.value;
				seq = (value === undefined || value === null ? 0 : Number(value)) + 1;
			}
			const row: MessageRow = {
				id: input.id ?? generateId("message"),
				conversationId: input.conversationId,
				seq,
				role: input.role,
				content: input.content,
				runId: input.runId ?? null,
				createdAt: now,
			};
			await tx.runWrite(txDb.insert(messages).values(row));
			return row;
		});
	}

	/** Full transcript for a conversation, oldest-first (ascending `seq`). */
	async listByConversation(conversationId: string): Promise<MessageRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.messages)
				.where(eq(this.messages.conversationId, conversationId))
				.orderBy(asc(this.messages.seq)),
		);
	}
}
