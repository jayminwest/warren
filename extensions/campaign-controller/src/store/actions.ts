/**
 * The action journal: the controller's restart boundary.
 *
 * Every external side effect is a row in `planned` state, committed before
 * the caller performs any I/O (design record §6.3, plan pl-91b6 risk 2).
 * Deterministic `action_key`s make a re-planned effect after a crash land on
 * the existing row instead of a duplicate. One active attempt (planned or
 * executing) is allowed per work item at a time; a second begin fails closed.
 */
import { StateError } from "../errors.ts";
import { nowMs, type StoreContext } from "./context.ts";
import {
	type ActionErrorClass,
	type ActionRow,
	type ActionState,
	TERMINAL_ACTION_STATES,
} from "./types.ts";

type ActionDbRow = {
	id: string;
	action_key: string;
	campaign_id: string;
	work_item_id: string | null;
	action_type: string;
	request_digest: string;
	policy_digest: string | null;
	state: string;
	attempt: number;
	reserved_usd_cents: number | null;
	started_at_ms: number | null;
	settled_at_ms: number | null;
	result_run_id: string | null;
	result_plan_run_id: string | null;
	result_branch: string | null;
	result_pr_number: number | null;
	error_class: string | null;
	error_json: string | null;
	created_at_ms: number;
	updated_at_ms: number;
};

const COLUMNS =
	"id, action_key, campaign_id, work_item_id, action_type, request_digest, policy_digest, state, attempt, reserved_usd_cents, started_at_ms, settled_at_ms, result_run_id, result_plan_run_id, result_branch, result_pr_number, error_class, error_json, created_at_ms, updated_at_ms";

function toAction(row: ActionDbRow): ActionRow {
	return {
		id: row.id,
		actionKey: row.action_key,
		campaignId: row.campaign_id,
		workItemId: row.work_item_id,
		actionType: row.action_type,
		requestDigest: row.request_digest,
		policyDigest: row.policy_digest,
		state: row.state as ActionState,
		attempt: row.attempt,
		reservedUsdCents: row.reserved_usd_cents,
		startedAtMs: row.started_at_ms,
		settledAtMs: row.settled_at_ms,
		resultRunId: row.result_run_id,
		resultPlanRunId: row.result_plan_run_id,
		resultBranch: row.result_branch,
		resultPrNumber: row.result_pr_number,
		errorClass: row.error_class as ActionErrorClass | null,
		errorJson: row.error_json,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
	};
}

export interface SettleActionInput {
	readonly state: "succeeded" | "uncertain" | "retryable_failure" | "permanent_failure";
	readonly errorClass?: ActionErrorClass | null;
	readonly errorJson?: string | null;
	readonly resultRunId?: string | null;
	readonly resultPlanRunId?: string | null;
	readonly resultBranch?: string | null;
	readonly resultPrNumber?: number | null;
}

export class ActionStore {
	readonly #ctx: StoreContext;

	constructor(ctx: StoreContext) {
		this.#ctx = ctx;
	}

	/**
	 * Persist a `planned` intent. Idempotent on `actionKey`: replanning the
	 * same key with the same request digest returns the existing row, so a
	 * crash between commit and I/O never doubles the journal. A different
	 * digest under the same key is a policy violation and fails closed.
	 */
	beginAction(input: {
		actionKey: string;
		campaignId: string;
		workItemId?: string | null;
		actionType: string;
		requestDigest: string;
		policyDigest?: string | null;
		attempt?: number;
		reservedUsdCents?: number | null;
	}): ActionRow {
		const existing = this.getActionByKey(input.actionKey);
		if (existing !== null) {
			if (existing.requestDigest !== input.requestDigest) {
				throw new StateError(
					`action key ${input.actionKey} already bound to a different request digest`,
				);
			}
			if (existing.state !== "planned") {
				throw new StateError(
					`action key ${input.actionKey} is already ${existing.state}; cannot replan`,
				);
			}
			return existing;
		}
		const workItemId = input.workItemId ?? null;
		if (workItemId !== null) {
			this.#assertNoActiveAttempt(workItemId, input.actionKey);
		}
		const now = nowMs(this.#ctx);
		const id = this.#ctx.ids.newId();
		this.#ctx.db
			.query(
				`INSERT INTO actions (id, action_key, campaign_id, work_item_id, action_type,
				 request_digest, policy_digest, state, attempt, reserved_usd_cents,
				 created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.actionKey,
				input.campaignId,
				workItemId,
				input.actionType,
				input.requestDigest,
				input.policyDigest ?? null,
				input.attempt ?? 1,
				input.reservedUsdCents ?? null,
				now,
				now,
			);
		return this.getAction(id) as ActionRow;
	}

	getAction(id: string): ActionRow | null {
		const row = this.#ctx.db
			.query(`SELECT ${COLUMNS} FROM actions WHERE id = ?`)
			.get(id) as ActionDbRow | null;
		return row === null ? null : toAction(row);
	}

	getActionByKey(actionKey: string): ActionRow | null {
		const row = this.#ctx.db
			.query(`SELECT ${COLUMNS} FROM actions WHERE action_key = ?`)
			.get(actionKey) as ActionDbRow | null;
		return row === null ? null : toAction(row);
	}

	/** planned → executing, stamped just before the caller performs I/O. */
	markExecuting(id: string): ActionRow {
		const action = this.requireAction(id);
		if (action.state !== "planned") {
			throw new StateError(`action ${id} is ${action.state}; only planned can execute`);
		}
		this.#update(id, { state: "executing", started_at_ms: nowMs(this.#ctx) });
		return this.getAction(id) as ActionRow;
	}

	/**
	 * Settle into a terminal state. Reachable from `planned` as well as
	 * `executing`: a lost dispatch response settles `planned` to `uncertain`
	 * without ever having observed execution. Terminal rows are frozen.
	 */
	settleAction(id: string, input: SettleActionInput): ActionRow {
		const action = this.requireAction(id);
		if (TERMINAL_ACTION_STATES.includes(action.state)) {
			throw new StateError(`action ${id} already settled as ${action.state}`);
		}
		if (action.state !== "planned" && action.state !== "executing") {
			throw new StateError(`action ${id} is ${action.state}; cannot settle`);
		}
		this.#update(id, {
			state: input.state,
			settled_at_ms: nowMs(this.#ctx),
			started_at_ms: action.startedAtMs ?? nowMs(this.#ctx),
			result_run_id: input.resultRunId ?? action.resultRunId,
			result_plan_run_id: input.resultPlanRunId ?? action.resultPlanRunId,
			result_branch: input.resultBranch ?? action.resultBranch,
			result_pr_number: input.resultPrNumber ?? action.resultPrNumber,
			error_class: input.errorClass ?? null,
			error_json: input.errorJson ?? null,
		});
		return this.getAction(id) as ActionRow;
	}

	/**
	 * Backfill a settled succeeded action's null `result_branch` from a safe
	 * re-read of the run (warren-5255): a dispatch that settled against a
	 * warren predating the run-wire `branch` field journaled null. Fills
	 * null → value only; a recorded branch is frozen — a mismatch is a
	 * StateError, never an overwrite.
	 */
	backfillResultBranch(id: string, branch: string): ActionRow {
		const action = this.requireAction(id);
		if (action.state !== "succeeded") {
			throw new StateError(
				`action ${id} is ${action.state}; only a succeeded row backfills a branch`,
			);
		}
		if (action.resultBranch !== null) {
			if (action.resultBranch !== branch) {
				throw new StateError(
					`action ${id} already recorded branch '${action.resultBranch}'; refusing to overwrite with '${branch}'`,
				);
			}
			return action;
		}
		this.#update(id, { result_branch: branch });
		return this.getAction(id) as ActionRow;
	}

	listActionsForWorkItem(workItemId: string): ActionRow[] {
		const rows = this.#ctx.db
			.query(`SELECT ${COLUMNS} FROM actions WHERE work_item_id = ? ORDER BY created_at_ms, id`)
			.all(workItemId) as ActionDbRow[];
		return rows.map(toAction);
	}

	listActionsForCampaign(campaignId: string): ActionRow[] {
		const rows = this.#ctx.db
			.query(`SELECT ${COLUMNS} FROM actions WHERE campaign_id = ? ORDER BY created_at_ms, id`)
			.all(campaignId) as ActionDbRow[];
		return rows.map(toAction);
	}

	listAllActions(): ActionRow[] {
		const rows = this.#ctx.db
			.query(`SELECT ${COLUMNS} FROM actions ORDER BY created_at_ms, id`)
			.all() as ActionDbRow[];
		return rows.map(toAction);
	}

	listUnfinishedActions(): ActionRow[] {
		const rows = this.#ctx.db
			.query(
				`SELECT ${COLUMNS} FROM actions WHERE state IN ('planned', 'executing') ORDER BY created_at_ms, id`,
			)
			.all() as ActionDbRow[];
		return rows.map(toAction);
	}

	requireAction(id: string): ActionRow {
		const action = this.getAction(id);
		if (action === null) throw new StateError(`unknown action: ${id}`);
		return action;
	}

	#assertNoActiveAttempt(workItemId: string, actionKey: string): void {
		const rows = this.listActionsForWorkItem(workItemId);
		for (const row of rows) {
			if ((row.state === "planned" || row.state === "executing") && row.actionKey !== actionKey) {
				throw new StateError(
					`work item ${workItemId} already has an active attempt (action ${row.id}, ${row.state})`,
				);
			}
		}
	}

	#update(id: string, patch: Record<string, string | number | null>): void {
		const keys = Object.keys(patch);
		const assignments = keys.map((key) => `${key} = ?`).join(", ");
		this.#ctx.db
			.query(`UPDATE actions SET ${assignments}, updated_at_ms = ? WHERE id = ?`)
			.run(...keys.map((key) => patch[key] as string | number | null), nowMs(this.#ctx), id);
	}
}
