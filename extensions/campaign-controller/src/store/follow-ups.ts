/**
 * Per-work-item follow-up progress (plan pl-096b, warren-0ad3).
 *
 * One row per work item with an open PR tracks the follow-up loop: how
 * many follow-up runs already responded (the iteration cap), which
 * feedback rows the last response covered (so re-ticks resume, never
 * duplicate), the fingerprint of the findings already responded to
 * (repeat-finding detection), and the currently active follow-up action
 * (one active follow-up per work item).
 */
import type { SQLQueryBindings } from "bun:sqlite";
import { StateError } from "../errors.ts";
import { nowMs, type StoreContext } from "./context.ts";
import type { FollowUpProgressRow } from "./types.ts";

type FollowUpProgressDbRow = {
	work_item_id: string;
	campaign_id: string;
	addressed_feedback_ids_json: string;
	last_responded_fingerprint: string | null;
	iteration: number;
	active_action_id: string | null;
	run_id: string | null;
	head_branch: string | null;
	created_at_ms: number;
	updated_at_ms: number;
};

function toProgress(row: FollowUpProgressDbRow): FollowUpProgressRow {
	return {
		workItemId: row.work_item_id,
		campaignId: row.campaign_id,
		addressedFeedbackIds: JSON.parse(row.addressed_feedback_ids_json) as string[],
		lastRespondedFingerprint: row.last_responded_fingerprint,
		iteration: row.iteration,
		activeActionId: row.active_action_id,
		runId: row.run_id,
		headBranch: row.head_branch,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
	};
}

export class FollowUpStore {
	readonly #ctx: StoreContext;

	constructor(ctx: StoreContext) {
		this.#ctx = ctx;
	}

	getProgress(workItemId: string): FollowUpProgressRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM follow_up_progress WHERE work_item_id = ?")
			.get(workItemId) as FollowUpProgressDbRow | null;
		return row === null ? null : toProgress(row);
	}

	/**
	 * Record that a follow-up dispatch started: the journaled action id,
	 * the PR head branch, and the run id once warren confirmed the POST.
	 * Exactly-once start: refuses when an active action is already recorded.
	 */
	recordStarted(input: {
		campaignId: string;
		workItemId: string;
		actionId: string;
		headBranch: string;
		runId: string | null;
	}): FollowUpProgressRow {
		const existing = this.getProgress(input.workItemId);
		if (existing !== null && existing.activeActionId !== null) {
			throw new StateError(
				`work item ${input.workItemId} already has an active follow-up action (${existing.activeActionId})`,
			);
		}
		if (existing === null) {
			this.#ctx.db
				.query(
					`INSERT INTO follow_up_progress (
						work_item_id, campaign_id, addressed_feedback_ids_json,
						last_responded_fingerprint, iteration, active_action_id,
						run_id, head_branch, created_at_ms, updated_at_ms
					) VALUES (?, ?, '[]', NULL, 0, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.workItemId,
					input.campaignId,
					input.actionId,
					input.runId,
					input.headBranch,
					nowMs(this.#ctx),
					nowMs(this.#ctx),
				);
			return this.getProgress(input.workItemId) as FollowUpProgressRow;
		}
		this.#update(input.workItemId, {
			active_action_id: input.actionId,
			head_branch: input.headBranch,
			run_id: input.runId,
		});
		return this.getProgress(input.workItemId) as FollowUpProgressRow;
	}

	/** Attach the confirmed run id to the active follow-up. */
	recordRunId(workItemId: string, runId: string): void {
		const progress = this.requireProgress(workItemId);
		if (progress.activeActionId === null) {
			throw new StateError(`work item ${workItemId} has no active follow-up to correlate`);
		}
		this.#update(workItemId, { run_id: runId });
	}

	/**
	 * The push landed: mark the covered feedback addressed, bump the
	 * iteration count, remember the findings fingerprint, clear the active
	 * action. The next tick can plan a fresh follow-up for new findings.
	 */
	recordResponded(input: {
		workItemId: string;
		feedbackIds: readonly string[];
		fingerprint: string;
	}): FollowUpProgressRow {
		const progress = this.requireProgress(input.workItemId);
		if (progress.activeActionId === null) {
			throw new StateError(`work item ${input.workItemId} has no active follow-up to settle`);
		}
		const addressed = new Set([...progress.addressedFeedbackIds, ...input.feedbackIds]);
		this.#update(input.workItemId, {
			addressed_feedback_ids_json: JSON.stringify([...addressed].sort()),
			last_responded_fingerprint: input.fingerprint,
			iteration: progress.iteration + 1,
			active_action_id: null,
		});
		return this.getProgress(input.workItemId) as FollowUpProgressRow;
	}

	/** Clear the active follow-up after a failed/uncertain dispatch attempt. */
	clearActive(workItemId: string): void {
		this.requireProgress(workItemId);
		this.#update(workItemId, { active_action_id: null });
	}

	requireProgress(workItemId: string): FollowUpProgressRow {
		const progress = this.getProgress(workItemId);
		if (progress === null) {
			throw new StateError(`no follow-up progress row for work item ${workItemId}`);
		}
		return progress;
	}

	#update(workItemId: string, patch: Record<string, SQLQueryBindings>): void {
		const entries = Object.entries(patch);
		const sets = entries.map(([key]) => `${key} = ?`).join(", ");
		const values = entries.map(([, value]) => value);
		const result = this.#ctx.db
			.query(`UPDATE follow_up_progress SET ${sets}, updated_at_ms = ? WHERE work_item_id = ?`)
			.run(...values, nowMs(this.#ctx), workItemId);
		if (result.changes === 0) {
			throw new StateError(`no follow-up progress row for work item ${workItemId}`);
		}
	}
}
