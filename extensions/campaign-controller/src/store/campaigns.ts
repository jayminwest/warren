/**
 * Campaign and work-item persistence.
 *
 * The manifest is immutable by absence of an update path: `manifest_digest`
 * is UNIQUE and `manifest_json` is written once at creation. Approval
 * (`approveCampaign`) stamps `approved_at_ms`; nothing can rebind a digest.
 */
import { StateError } from "../errors.ts";
import { nowMs, type StoreContext } from "./context.ts";
import type {
	CampaignRow,
	CampaignStatus,
	WorkItemOutcome,
	WorkItemRow,
	WorkItemStatus,
} from "./types.ts";

type CampaignDbRow = {
	id: string;
	status: string;
	manifest_digest: string;
	manifest_json: string;
	policy_digest: string | null;
	budget_cap_usd_cents: number | null;
	created_at_ms: number;
	updated_at_ms: number;
	approved_at_ms: number | null;
};

type WorkItemDbRow = {
	id: string;
	campaign_id: string;
	position: number;
	issue_ref: string;
	status: string;
	outcome: string | null;
	outcome_at_ms: number | null;
	created_at_ms: number;
	updated_at_ms: number;
};

function toCampaign(row: CampaignDbRow): CampaignRow {
	return {
		id: row.id,
		status: row.status as CampaignStatus,
		manifestDigest: row.manifest_digest,
		manifestJson: row.manifest_json,
		policyDigest: row.policy_digest,
		budgetCapUsdCents: row.budget_cap_usd_cents,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
		approvedAtMs: row.approved_at_ms,
	};
}

function toWorkItem(row: WorkItemDbRow): WorkItemRow {
	return {
		id: row.id,
		campaignId: row.campaign_id,
		position: row.position,
		issueRef: row.issue_ref,
		status: row.status as WorkItemStatus,
		outcome: (row.outcome as WorkItemOutcome | null) ?? null,
		outcomeAtMs: row.outcome_at_ms ?? null,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
	};
}

export class CampaignStore {
	readonly #ctx: StoreContext;

	constructor(ctx: StoreContext) {
		this.#ctx = ctx;
	}

	createCampaign(input: {
		manifestDigest: string;
		manifestJson: string;
		policyDigest?: string | null;
		budgetCapUsdCents?: number | null;
		status?: CampaignStatus;
	}): CampaignRow {
		const now = nowMs(this.#ctx);
		const id = this.#ctx.ids.newId();
		try {
			this.#ctx.db
				.query(
					`INSERT INTO campaigns
					 (id, status, manifest_digest, manifest_json, policy_digest,
					  budget_cap_usd_cents, created_at_ms, updated_at_ms, approved_at_ms)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
				)
				.run(
					id,
					input.status ?? "draft",
					input.manifestDigest,
					input.manifestJson,
					input.policyDigest ?? null,
					input.budgetCapUsdCents ?? null,
					now,
					now,
				);
		} catch (cause) {
			throw new StateError(`campaign digest already stored: ${input.manifestDigest}`, {
				cause,
			});
		}
		return this.getCampaign(id) as CampaignRow;
	}

	getCampaign(id: string): CampaignRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM campaigns WHERE id = ?")
			.get(id) as CampaignDbRow | null;
		return row === null ? null : toCampaign(row);
	}

	getCampaignByDigest(manifestDigest: string): CampaignRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM campaigns WHERE manifest_digest = ?")
			.get(manifestDigest) as CampaignDbRow | null;
		return row === null ? null : toCampaign(row);
	}

	setCampaignStatus(id: string, status: CampaignStatus): void {
		this.#ctx.db
			.query("UPDATE campaigns SET status = ?, updated_at_ms = ? WHERE id = ?")
			.run(status, nowMs(this.#ctx), id);
	}

	/** Stamp approval over the immutable manifest. Idempotent per campaign. */
	approveCampaign(id: string): CampaignRow {
		const now = nowMs(this.#ctx);
		this.#ctx.db
			.query(
				"UPDATE campaigns SET approved_at_ms = COALESCE(approved_at_ms, ?), updated_at_ms = ? WHERE id = ?",
			)
			.run(now, now, id);
		const row = this.getCampaign(id);
		if (row === null) throw new StateError(`unknown campaign: ${id}`);
		return row;
	}

	listCampaigns(): CampaignRow[] {
		const rows = this.#ctx.db
			.query("SELECT * FROM campaigns ORDER BY created_at_ms, id")
			.all() as CampaignDbRow[];
		return rows.map(toCampaign);
	}

	/**
	 * A bound field of the campaign's manifest changed: the approval bound
	 * the old digest, so it no longer authorizes anything. The row returns
	 * to `awaiting_approval` and loses its approval stamp (warren-a252).
	 */
	invalidateApproval(id: string): void {
		this.#ctx.db
			.query(
				"UPDATE campaigns SET status = 'awaiting_approval', approved_at_ms = NULL, updated_at_ms = ? WHERE id = ?",
			)
			.run(nowMs(this.#ctx), id);
	}

	/**
	 * The amendment flow (warren-35c4): apply a digest-bound, approved
	 * amendment as a new campaign version IN PLACE. The row id, status,
	 * and history survive; only the bound manifest content and the derived
	 * budget cap change. No superseded attention row is emitted here.
	 */
	updateManifestInPlace(
		id: string,
		input: { manifestDigest: string; manifestJson: string; budgetCapUsdCents: number },
	): void {
		this.#ctx.db
			.query(
				"UPDATE campaigns SET manifest_digest = ?, manifest_json = ?, budget_cap_usd_cents = ?, updated_at_ms = ? WHERE id = ?",
			)
			.run(input.manifestDigest, input.manifestJson, input.budgetCapUsdCents, nowMs(this.#ctx), id);
	}

	/** Stamp approval at an explicit time (the amendment's approval time). */
	stampApproval(id: string, approvedAtMs: number): void {
		this.#ctx.db
			.query(
				"UPDATE campaigns SET approved_at_ms = COALESCE(approved_at_ms, ?), updated_at_ms = ? WHERE id = ?",
			)
			.run(approvedAtMs, nowMs(this.#ctx), id);
	}

	addWorkItem(input: {
		campaignId: string;
		position: number;
		issueRef: string;
		status?: WorkItemStatus;
	}): WorkItemRow {
		const now = nowMs(this.#ctx);
		const id = this.#ctx.ids.newId();
		try {
			this.#ctx.db
				.query(
					`INSERT INTO work_items (id, campaign_id, position, issue_ref, status, created_at_ms, updated_at_ms)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					input.campaignId,
					input.position,
					input.issueRef,
					input.status ?? "candidate",
					now,
					now,
				);
		} catch (cause) {
			throw new StateError(
				`work item position ${input.position} already exists in campaign ${input.campaignId}`,
				{ cause },
			);
		}
		return this.getWorkItem(id) as WorkItemRow;
	}

	getWorkItem(id: string): WorkItemRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM work_items WHERE id = ?")
			.get(id) as WorkItemDbRow | null;
		return row === null ? null : toWorkItem(row);
	}

	listWorkItems(campaignId: string): WorkItemRow[] {
		const rows = this.#ctx.db
			.query("SELECT * FROM work_items WHERE campaign_id = ? ORDER BY position")
			.all(campaignId) as WorkItemDbRow[];
		return rows.map(toWorkItem);
	}

	setWorkItemStatus(id: string, status: WorkItemStatus): void {
		this.#ctx.db
			.query("UPDATE work_items SET status = ?, updated_at_ms = ? WHERE id = ?")
			.run(status, nowMs(this.#ctx), id);
	}

	/**
	 * Flip a work item to its terminal PR outcome (warren-7cd1). Exactly
	 * once: an outcome already recorded wins, whatever the caller observed,
	 * so a re-delivered reconcile can never rewrite history. The status
	 * moves to `merged` or `terminal` alongside the outcome column.
	 */
	recordWorkItemOutcome(
		id: string,
		outcome: WorkItemOutcome,
	): { recorded: boolean; item: WorkItemRow } {
		const item = this.getWorkItem(id);
		if (item === null) throw new StateError(`unknown work item: ${id}`);
		if (item.outcome !== null) {
			return { recorded: false, item };
		}
		const now = nowMs(this.#ctx);
		const status: WorkItemStatus = outcome === "merged" ? "merged" : "terminal";
		this.#ctx.db
			.query(
				"UPDATE work_items SET outcome = ?, outcome_at_ms = ?, status = ?, updated_at_ms = ? WHERE id = ?",
			)
			.run(outcome, now, status, now, id);
		return { recorded: true, item: this.getWorkItem(id) as WorkItemRow };
	}
}
