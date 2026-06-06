/**
 * Repository for the `conversations` table (LEVERET.md §0.5 / warren-0b91).
 *
 * One row per leveret conversation. N conversations bind to one Plot (N:1).
 * The anchoring `mode:'conversation'` run rotates on re-wake (warren-6ccf),
 * so `anchoringRunId` is mutable and nullable — the conversation itself
 * survives the run going terminal. The turn-by-turn transcript lives in the
 * sibling `messages` table (see `MessagesRepo`), NOT here; the run-anchored
 * `events` table stays single-writer (the bridge).
 *
 * Unlike RunsRepo / PlanRunsRepo there is no per-row state machine to guard
 * beyond the `active → closed` one-way flip: `close()` is idempotent and
 * `rotateAnchor()` simply repoints the live run.
 */

import { and, desc, eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { ConversationRow, ConversationState } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export interface CreateConversationInput {
	/** Conversation id; generated (`conv_...`) when omitted. */
	id?: string;
	/** Owning project (REQUIRED in v1; nullable in schema for orphan-on-delete). */
	projectId: string;
	/** Plot the conversation binds to (v1 always sets it). */
	plotId?: string | null;
	/** Anchoring mode:'conversation' run; set once the run is spawned. */
	anchoringRunId?: string | null;
	title?: string | null;
	now?: Date;
}

export class ConversationsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get conversations() {
		return this.adapter.schema.conversations;
	}

	async create(input: CreateConversationInput): Promise<ConversationRow> {
		const now = (input.now ?? new Date()).toISOString();
		const row: ConversationRow = {
			id: input.id ?? generateId("conversation"),
			projectId: input.projectId,
			plotId: input.plotId ?? null,
			anchoringRunId: input.anchoringRunId ?? null,
			status: "active",
			title: input.title ?? null,
			submittedPrUrl: null,
			submittedPrNumber: null,
			plannerAgent: null,
			createdAt: now,
			lastActivityAt: now,
			closedAt: null,
		};
		await this.adapter.runWrite(this.db.insert(this.conversations).values(row));
		return row;
	}

	async get(id: string): Promise<ConversationRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.conversations).where(eq(this.conversations.id, id)),
		);
		return row ?? null;
	}

	async require(id: string): Promise<ConversationRow> {
		const row = await this.get(id);
		if (!row) throw new NotFoundError(`conversation not found: ${id}`);
		return row;
	}

	/**
	 * Conversations for a project, most-recent-activity first. Optional
	 * `status` narrows to `active` / `closed`. The `conversations_project`
	 * index covers the predicate; ordering is in-memory on `lastActivityAt`.
	 */
	async listByProject(projectId: string, status?: ConversationState): Promise<ConversationRow[]> {
		const where =
			status !== undefined
				? and(eq(this.conversations.projectId, projectId), eq(this.conversations.status, status))
				: eq(this.conversations.projectId, projectId);
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.conversations)
				.where(where)
				.orderBy(desc(this.conversations.lastActivityAt)),
		);
	}

	/** Every conversation, most-recent-activity first (the top-level list page). */
	async listAll(status?: ConversationState): Promise<ConversationRow[]> {
		const base = this.db.select().from(this.conversations);
		const scoped = status !== undefined ? base.where(eq(this.conversations.status, status)) : base;
		return this.adapter.pickAll(scoped.orderBy(desc(this.conversations.lastActivityAt)));
	}

	/** Conversations bound to a Plot (N:1), most-recent-activity first. */
	async listByPlotId(plotId: string): Promise<ConversationRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.conversations)
				.where(eq(this.conversations.plotId, plotId))
				.orderBy(desc(this.conversations.lastActivityAt)),
		);
	}

	/**
	 * Repoint the anchoring run (re-wake, warren-6ccf) and stamp activity.
	 * Idempotent last-writer-wins; throws NotFound if the row is gone.
	 */
	async rotateAnchor(id: string, anchoringRunId: string, now?: Date): Promise<ConversationRow> {
		const ts = (now ?? new Date()).toISOString();
		await this.require(id);
		await this.adapter.runWrite(
			this.db
				.update(this.conversations)
				.set({ anchoringRunId, lastActivityAt: ts })
				.where(eq(this.conversations.id, id)),
		);
		return this.require(id);
	}

	/** Touch `lastActivityAt` (e.g. on a new operator turn). */
	async touch(id: string, now?: Date): Promise<void> {
		const ts = (now ?? new Date()).toISOString();
		await this.adapter.runWrite(
			this.db
				.update(this.conversations)
				.set({ lastActivityAt: ts })
				.where(eq(this.conversations.id, id)),
		);
	}

	/**
	 * Record a "Send to planner" send-off (LEVERET.md §0.0.B / §0.7 /
	 * warren-756d) and CLOSE the conversation in one write. Stamps the
	 * submitted plotSync PR ref + planner agent so the merge poller
	 * (warren-b872) can auto-dispatch the planner run keyed on `plot_id`
	 * once the PR merges, flips `status → closed`, and sets `closed_at` /
	 * `last_activity_at`. Idempotent: a second send-off on an already-closed
	 * conversation re-stamps the submission fields without re-closing.
	 */
	async recordSubmission(
		id: string,
		input: {
			prUrl: string;
			prNumber?: number | null;
			plannerAgent?: string | null;
		},
		now?: Date,
	): Promise<ConversationRow> {
		const ts = (now ?? new Date()).toISOString();
		const existing = await this.require(id);
		await this.adapter.runWrite(
			this.db
				.update(this.conversations)
				.set({
					submittedPrUrl: input.prUrl,
					submittedPrNumber: input.prNumber ?? null,
					plannerAgent: input.plannerAgent ?? null,
					status: "closed",
					closedAt: existing.closedAt ?? ts,
					lastActivityAt: ts,
				})
				.where(eq(this.conversations.id, id)),
		);
		return this.require(id);
	}

	/** Flip the conversation to `closed` (send-off / operator close). Idempotent. */
	async close(id: string, now?: Date): Promise<ConversationRow> {
		const ts = (now ?? new Date()).toISOString();
		const existing = await this.require(id);
		if (existing.status === "closed") return existing;
		await this.adapter.runWrite(
			this.db
				.update(this.conversations)
				.set({ status: "closed", closedAt: ts, lastActivityAt: ts })
				.where(eq(this.conversations.id, id)),
		);
		return this.require(id);
	}
}
