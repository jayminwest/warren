/**
 * The phase-3 mutation journal (warren-094b; design record §6.3).
 *
 * Every mutation execution follows the same contract as `pr_execute`:
 *
 * 1. The intent is journaled `planned` with a canonical request digest
 *    BEFORE any I/O, under a deterministic action key so a crash between
 *    commit and I/O replans onto the same row instead of duplicating.
 * 2. `planned → executing` is journaled immediately before the request.
 * 3. A transport failure after the request may have been sent settles
 *    `uncertain` (never re-sent blind), raises durable attention, and the
 *    row is frozen. A definitive GitHub refusal settles `permanent_failure`.
 * 4. Terminal states never transition again; a re-drive sees an
 *    `already_settled` outcome instead of replaying the mutation.
 */

import { canonicalJson, sha256Hex } from "../digest.ts";
import { GithubMutationUncertainError, type MutationIntent } from "../github/pr-mutations.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import type { ActionRow } from "../store/types.ts";

/** Action types persisted for each phase-3 mutation intent. */
export const UPDATE_PULL_REQUEST_ACTION_TYPE = "pr_update";
export const POST_COMMENT_ACTION_TYPE = "pr_comment";
export const UPDATE_BRANCH_ACTION_TYPE = "pr_update_branch";
export const FOLLOW_UP_PUSH_ACTION_TYPE = "follow_up_push";

/** Attention reasons per mutation, mirroring `pr_create_uncertain`. */
export const MUTATION_UNCERTAIN_REASON = "mutation_uncertain";
export const MUTATION_FAILED_REASON = "mutation_failed";

/** The canonical request digest over a journaled mutation intent. */
export function mutationRequestDigest(intent: MutationIntent): string {
	return sha256Hex(canonicalJson(intent));
}

export interface JournalMutationIntentInput {
	/** Deterministic key: one intent row per logical effect. */
	readonly actionKey: string;
	readonly campaignId: string;
	readonly workItemId?: string | null;
	/** One of the phase-3 `*_ACTION_TYPE` constants. */
	readonly actionType: string;
	readonly intent: MutationIntent;
	readonly policyDigest?: string | null;
	readonly attempt?: number;
}

export interface JournalMutationIntentResult {
	readonly action: ActionRow;
	readonly requestDigest: string;
	/** True when this call journaled the row; false on an idempotent replay. */
	readonly created: boolean;
}

/**
 * Journal the intent `planned` with its canonical request digest before any
 * I/O. Idempotent on `actionKey`: replanning the same key with the same
 * digest returns the existing row; a different digest under the same key
 * fails closed (the store enforces it).
 */
export function journalMutationIntent(
	store: CampaignStateStore,
	input: JournalMutationIntentInput,
): JournalMutationIntentResult {
	const requestDigest = mutationRequestDigest(input.intent);
	const existing = store.actions.getActionByKey(input.actionKey);
	const action = store.actions.beginAction({
		actionKey: input.actionKey,
		campaignId: input.campaignId,
		workItemId: input.workItemId ?? null,
		actionType: input.actionType,
		requestDigest,
		policyDigest: input.policyDigest ?? null,
		attempt: input.attempt,
	});
	return { action, requestDigest, created: existing === null };
}

/** One execute attempt's machine-readable outcome. */
export interface MutationExecuteOutcome {
	readonly status:
		| "succeeded"
		| "already_settled"
		| "uncertain_blocked"
		| "failed_blocked"
		| "settled_uncertain"
		| "settled_failed";
}

export interface ExecuteMutationInput {
	readonly campaignId: string;
	/** The row returned by `journalMutationIntent`. */
	readonly action: ActionRow;
}

/** Result facts a successful I/O may carry into the settled row. */
export interface MutationIoResult {
	readonly resultPrNumber?: number | null;
	readonly resultBranch?: string | null;
}

/**
 * Execute the journaled mutation: `executing` is journaled before the
 * caller's I/O runs, and the settle transitions are identical to
 * `pr_execute`. The I/O is the caller's exact transport call on the
 * journaled intent — this function never builds a request.
 */
export async function executeJournaledMutation(
	store: CampaignStateStore,
	input: ExecuteMutationInput,
	io: () => Promise<MutationIoResult>,
): Promise<MutationExecuteOutcome> {
	const action = store.actions.getAction(input.action.id);
	if (action === null) {
		return { status: "failed_blocked" };
	}
	switch (action.state) {
		case "succeeded":
		case "uncertain":
		case "permanent_failure":
		case "retryable_failure":
			return { status: "already_settled" };
		case "executing":
			// A crash mid-I/O on an earlier tick: the outcome is unknown and
			// the caller must recover through a safe read, never a replay.
			return { status: "uncertain_blocked" };
		default:
			break;
	}

	store.actions.markExecuting(action.id);
	try {
		const result = await io();
		store.actions.settleAction(action.id, {
			state: "succeeded",
			resultPrNumber: result.resultPrNumber ?? null,
			resultBranch: result.resultBranch ?? null,
		});
		return { status: "succeeded" };
	} catch (error) {
		if (error instanceof GithubMutationUncertainError) {
			store.transaction(() => {
				store.actions.settleAction(action.id, {
					state: "uncertain",
					errorClass: "ambiguous_response",
					errorJson: canonicalJson({ message: error.message }),
				});
				if (action.workItemId !== null) {
					store.events.addAttentionOnce({
						campaignId: input.campaignId,
						workItemId: action.workItemId,
						reason: MUTATION_UNCERTAIN_REASON,
						detailJson: canonicalJson({
							key: `action:${action.id}`,
							actionId: action.id,
							actionType: action.actionType,
						}),
					});
				}
			});
			return { status: "settled_uncertain" };
		}
		const message = error instanceof Error ? error.message : String(error);
		store.transaction(() => {
			store.actions.settleAction(action.id, {
				state: "permanent_failure",
				errorClass: "github_rejected",
				errorJson: canonicalJson({ message }),
			});
			if (action.workItemId !== null) {
				store.events.addAttentionOnce({
					campaignId: input.campaignId,
					workItemId: action.workItemId,
					reason: MUTATION_FAILED_REASON,
					detailJson: canonicalJson({
						key: `action:${action.id}`,
						actionId: action.id,
						actionType: action.actionType,
					}),
				});
			}
		});
		return { status: "settled_failed" };
	}
}
