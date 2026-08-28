/**
 * Correlation and observation rows: Warren run links, prospective cross-fork
 * PR identity, deduplicated GitHub source events, and attention items.
 *
 * GitHub events are keyed by their stable node id: re-ingesting the same
 * observed fact is a no-op, which is what makes at-least-once polling safe
 * (design record §10.1). PR identities stay controller-local because Warren's
 * Forge cannot express a cross-fork PR (§14.8).
 */
import { StateError } from "../errors.ts";
import { nowMs, type StoreContext } from "./context.ts";
import type {
	AttentionItemRow,
	GithubEventRow,
	PrIdentityRow,
	ReviewFeedbackRow,
	RunLinkRow,
} from "./types.ts";

type RunLinkDbRow = {
	run_id: string;
	plan_run_id: string | null;
	campaign_id: string;
	work_item_id: string | null;
	action_id: string | null;
	branch: string | null;
	linked_at_ms: number;
};

type PrIdentityDbRow = {
	id: string;
	campaign_id: string;
	work_item_id: string;
	upstream_owner: string;
	upstream_repo: string;
	fork_owner: string;
	fork_repo: string;
	head_branch: string;
	title: string | null;
	body_digest: string | null;
	pr_number: number | null;
	pr_url: string | null;
	created_at_ms: number;
};

type GithubEventDbRow = {
	node_id: string;
	campaign_id: string;
	event_kind: string;
	payload_json: string;
	observed_at_ms: number;
};

type AttentionDbRow = {
	id: string;
	campaign_id: string;
	work_item_id: string | null;
	reason: string;
	detail_json: string | null;
	created_at_ms: number;
	resolved_at_ms: number | null;
};

type ReviewFeedbackDbRow = {
	id: string;
	campaign_id: string;
	work_item_id: string | null;
	category: string;
	source_event_node_id: string;
	fields_json: string;
	created_at_ms: number;
};

export class EventStore {
	readonly #ctx: StoreContext;

	constructor(ctx: StoreContext) {
		this.#ctx = ctx;
	}

	/**
	 * Link a Warren run (and optionally its plan-run) to campaign state.
	 * Idempotent on `run_id`: correlating a known run again returns the
	 * existing row unchanged, so restart reconciliation cannot fork history.
	 */
	correlateRun(input: {
		runId: string;
		campaignId: string;
		workItemId?: string | null;
		actionId?: string | null;
		planRunId?: string | null;
		branch?: string | null;
	}): RunLinkRow {
		const existing = this.getRunLink(input.runId);
		if (existing !== null) return existing;
		this.#ctx.db
			.query(
				`INSERT INTO run_links (run_id, plan_run_id, campaign_id, work_item_id, action_id, branch, linked_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.runId,
				input.planRunId ?? null,
				input.campaignId,
				input.workItemId ?? null,
				input.actionId ?? null,
				input.branch ?? null,
				nowMs(this.#ctx),
			);
		return this.getRunLink(input.runId) as RunLinkRow;
	}

	/** The run link bound to one action, if a confirmed run exists for it. */
	getRunLinkByAction(actionId: string): RunLinkRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM run_links WHERE action_id = ?")
			.get(actionId) as RunLinkDbRow | null;
		return row === null ? null : this.#toRunLink(row);
	}

	getRunLink(runId: string): RunLinkRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM run_links WHERE run_id = ?")
			.get(runId) as RunLinkDbRow | null;
		return row === null ? null : this.#toRunLink(row);
	}

	#toRunLink(row: RunLinkDbRow): RunLinkRow {
		return {
			runId: row.run_id,
			planRunId: row.plan_run_id,
			campaignId: row.campaign_id,
			workItemId: row.work_item_id,
			actionId: row.action_id,
			branch: row.branch,
			linkedAtMs: row.linked_at_ms,
		};
	}

	/**
	 * Upsert the prospective cross-fork PR identity for a work item. The
	 * prospective (pre-post) row carries fork/upstream coordinates and the
	 * rendered request digest; upstream fields update once a PR exists.
	 */
	recordPrIdentity(input: {
		campaignId: string;
		workItemId: string;
		upstreamOwner: string;
		upstreamRepo: string;
		forkOwner: string;
		forkRepo: string;
		headBranch: string;
		title?: string | null;
		bodyDigest?: string | null;
		prNumber?: number | null;
		prUrl?: string | null;
	}): PrIdentityRow {
		const existing = this.#ctx.db
			.query("SELECT id FROM pr_identities WHERE campaign_id = ? AND work_item_id = ?")
			.get(input.campaignId, input.workItemId) as { id: string } | null;
		if (existing === null) {
			const id = this.#ctx.ids.newId();
			this.#ctx.db
				.query(
					`INSERT INTO pr_identities (id, campaign_id, work_item_id, upstream_owner, upstream_repo,
					 fork_owner, fork_repo, head_branch, title, body_digest, pr_number, pr_url, created_at_ms)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					input.campaignId,
					input.workItemId,
					input.upstreamOwner,
					input.upstreamRepo,
					input.forkOwner,
					input.forkRepo,
					input.headBranch,
					input.title ?? null,
					input.bodyDigest ?? null,
					input.prNumber ?? null,
					input.prUrl ?? null,
					nowMs(this.#ctx),
				);
			return this.getPrIdentity(id) as PrIdentityRow;
		}
		this.#ctx.db
			.query(
				`UPDATE pr_identities SET head_branch = ?, title = COALESCE(?, title),
				 body_digest = COALESCE(?, body_digest), pr_number = COALESCE(?, pr_number),
				 pr_url = COALESCE(?, pr_url) WHERE id = ?`,
			)
			.run(
				input.headBranch,
				input.title ?? null,
				input.bodyDigest ?? null,
				input.prNumber ?? null,
				input.prUrl ?? null,
				existing.id,
			);
		return this.getPrIdentity(existing.id) as PrIdentityRow;
	}

	getPrIdentity(id: string): PrIdentityRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM pr_identities WHERE id = ?")
			.get(id) as PrIdentityDbRow | null;
		if (row === null) return null;
		return {
			id: row.id,
			campaignId: row.campaign_id,
			workItemId: row.work_item_id,
			upstreamOwner: row.upstream_owner,
			upstreamRepo: row.upstream_repo,
			forkOwner: row.fork_owner,
			forkRepo: row.fork_repo,
			headBranch: row.head_branch,
			title: row.title,
			bodyDigest: row.body_digest,
			prNumber: row.pr_number,
			prUrl: row.pr_url,
			createdAtMs: row.created_at_ms,
		};
	}

	listPrIdentities(campaignId: string): PrIdentityRow[] {
		const rows = this.#ctx.db
			.query("SELECT * FROM pr_identities WHERE campaign_id = ?")
			.all(campaignId) as PrIdentityDbRow[];
		return rows.map((row) => this.getPrIdentity(row.id) as PrIdentityRow);
	}

	/**
	 * Ingest an upstream source event keyed by its stable GitHub node id.
	 * Returns true when the event is new, false when it was already stored —
	 * duplicated polling delivers exactly once.
	 */
	recordGithubEvent(input: {
		nodeId: string;
		campaignId: string;
		eventKind: string;
		payloadJson: string;
	}): boolean {
		const result = this.#ctx.db
			.query(
				`INSERT INTO github_events (node_id, campaign_id, event_kind, payload_json, observed_at_ms)
				 VALUES (?, ?, ?, ?, ?) ON CONFLICT(node_id) DO NOTHING`,
			)
			.run(input.nodeId, input.campaignId, input.eventKind, input.payloadJson, nowMs(this.#ctx));
		return result.changes === 1;
	}

	getGithubEvent(nodeId: string): GithubEventRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM github_events WHERE node_id = ?")
			.get(nodeId) as GithubEventDbRow | null;
		if (row === null) return null;
		return {
			nodeId: row.node_id,
			campaignId: row.campaign_id,
			eventKind: row.event_kind,
			payloadJson: row.payload_json,
			observedAtMs: row.observed_at_ms,
		};
	}

	listGithubEvents(campaignId: string): GithubEventRow[] {
		const rows = this.#ctx.db
			.query("SELECT * FROM github_events WHERE campaign_id = ? ORDER BY observed_at_ms, node_id")
			.all(campaignId) as GithubEventDbRow[];
		return rows.map((row) => ({
			nodeId: row.node_id,
			campaignId: row.campaign_id,
			eventKind: row.event_kind,
			payloadJson: row.payload_json,
			observedAtMs: row.observed_at_ms,
		}));
	}

	addAttention(input: {
		campaignId: string;
		reason: string;
		workItemId?: string | null;
		detailJson?: string | null;
	}): AttentionItemRow {
		const id = this.#ctx.ids.newId();
		this.#ctx.db
			.query(
				`INSERT INTO attention_items (id, campaign_id, work_item_id, reason, detail_json, created_at_ms, resolved_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
			)
			.run(
				id,
				input.campaignId,
				input.workItemId ?? null,
				input.reason,
				input.detailJson ?? null,
				nowMs(this.#ctx),
			);
		return this.getAttentionItem(id) as AttentionItemRow;
	}

	getAttentionItem(id: string): AttentionItemRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM attention_items WHERE id = ?")
			.get(id) as AttentionDbRow | null;
		if (row === null) return null;
		return {
			id: row.id,
			campaignId: row.campaign_id,
			workItemId: row.work_item_id,
			reason: row.reason,
			detailJson: row.detail_json,
			createdAtMs: row.created_at_ms,
			resolvedAtMs: row.resolved_at_ms,
		};
	}

	listOpenAttention(campaignId: string): AttentionItemRow[] {
		const rows = this.#ctx.db
			.query(
				"SELECT * FROM attention_items WHERE campaign_id = ? AND resolved_at_ms IS NULL ORDER BY created_at_ms, id",
			)
			.all(campaignId) as AttentionDbRow[];
		return rows.map((row) => this.getAttentionItem(row.id) as AttentionItemRow);
	}

	/** Every attention item of the campaign, open first, optionally resolved. */
	listAttention(campaignId: string, includeResolved: boolean): AttentionItemRow[] {
		const sql = includeResolved
			? "SELECT * FROM attention_items WHERE campaign_id = ? ORDER BY resolved_at_ms IS NOT NULL, created_at_ms, id"
			: "SELECT * FROM attention_items WHERE campaign_id = ? AND resolved_at_ms IS NULL ORDER BY created_at_ms, id";
		const rows = this.#ctx.db.query(sql).all(campaignId) as AttentionDbRow[];
		return rows.map((row) => this.getAttentionItem(row.id) as AttentionItemRow);
	}

	/**
	 * Insert an attention item only when no open item with the same
	 * campaign, reason, and detail JSON exists. The reconciler derives a
	 * deterministic detail (stable subject key, no wall-clock noise), so
	 * re-deriving the same attention across ticks and restarts is a no-op.
	 */
	addAttentionOnce(input: {
		campaignId: string;
		reason: string;
		workItemId?: string | null;
		detailJson?: string | null;
	}): { row: AttentionItemRow; created: boolean } {
		const detailJson = input.detailJson ?? null;
		const existing = this.#ctx.db
			.query(
				`SELECT id FROM attention_items
				 WHERE campaign_id = ? AND reason = ? AND detail_json IS ? AND resolved_at_ms IS NULL`,
			)
			.get(input.campaignId, input.reason, detailJson) as { id: string } | null;
		if (existing !== null) {
			return { row: this.getAttentionItem(existing.id) as AttentionItemRow, created: false };
		}
		return { row: this.addAttention({ ...input, detailJson }), created: true };
	}

	resolveAttention(id: string): void {
		const result = this.#ctx.db
			.query(
				"UPDATE attention_items SET resolved_at_ms = ? WHERE id = ? AND resolved_at_ms IS NULL",
			)
			.run(nowMs(this.#ctx), id);
		if (result.changes === 0) {
			throw new StateError(`attention item ${id} is missing or already resolved`);
		}
	}

	/**
	 * Insert a classified feedback row only when no row with the same id
	 * (source event node id + category) exists — reclassification of the
	 * same source event is a no-op.
	 */
	addFeedbackOnce(input: {
		id: string;
		campaignId: string;
		workItemId?: string | null;
		category: string;
		sourceEventNodeId: string;
		fieldsJson: string;
	}): { created: boolean } {
		const result = this.#ctx.db
			.query(
				`INSERT INTO review_feedback (id, campaign_id, work_item_id, category, source_event_node_id, fields_json, created_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
			)
			.run(
				input.id,
				input.campaignId,
				input.workItemId ?? null,
				input.category,
				input.sourceEventNodeId,
				input.fieldsJson,
				nowMs(this.#ctx),
			);
		return { created: result.changes === 1 };
	}

	getFeedback(id: string): ReviewFeedbackRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM review_feedback WHERE id = ?")
			.get(id) as ReviewFeedbackDbRow | null;
		return row === null ? null : this.#toFeedbackRow(row);
	}

	listFeedback(campaignId: string): ReviewFeedbackRow[] {
		const rows = this.#ctx.db
			.query("SELECT * FROM review_feedback WHERE campaign_id = ? ORDER BY created_at_ms, id")
			.all(campaignId) as ReviewFeedbackDbRow[];
		return rows.map((row) => this.#toFeedbackRow(row));
	}

	#toFeedbackRow(row: ReviewFeedbackDbRow): ReviewFeedbackRow {
		return {
			id: row.id,
			campaignId: row.campaign_id,
			workItemId: row.work_item_id,
			category: row.category,
			sourceEventNodeId: row.source_event_node_id,
			fieldsJson: row.fields_json,
			createdAtMs: row.created_at_ms,
		};
	}
}
