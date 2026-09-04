/**
 * Branch freshness on reconcile (plan pl-096b, warren-3d92).
 *
 * A draft PR that sits through review iterations goes stale against its
 * base: behind-base or conflicted merge state blocks CI and merging. After
 * each read-only reconciliation pass, the caller feeds the observed PR
 * snapshot into `handleBranchFreshness`, which classifies the merge state
 * and drives exactly one of:
 *
 * - **fresh** — nothing happens;
 * - **behind_base, clean merge** — a policy-gated `updateBranch` PUT
 *   (upstream merges base into the head branch), journaled planned
 *   BEFORE the I/O and executed through the shared mutation journal;
 * - **behind_base, policy disabled** — no mutation object exists to call;
 *   a durable attention item is opened instead;
 * - **conflicted** — `updateBranch` cannot help (the PUT refuses on a
 *   dirty merge), so a conflict-repair follow-up run is journaled and
 *   dispatched onto the existing PR head branch through the follow-up
 *   coordinator's dispatch contract, under the same `followUpPush` gate
 *   and the same journal-planned-before-I/O intent pattern.
 *
 * Idempotence: the action keys are derived from the observed base SHA, so
 * a re-tick against unchanged facts replans onto the same row (replay /
 * already-settled) instead of duplicating the mutation; a pending update
 * or an executing repair run suppresses re-trigger.
 */

import { canonicalJson, sha256Hex } from "../digest.ts";
import { UNTRUSTED_FINDINGS_BANNER } from "../follow-up/coordinator.ts";
import {
	type GithubBranchUpdaterTransport,
	renderUpdateBranchIntent,
} from "../github/pr-mutations.ts";
import type { GithubPullRequestSnapshot } from "../github/types.ts";
import {
	executeJournaledMutation,
	journalMutationIntent,
	UPDATE_BRANCH_ACTION_TYPE,
} from "../pr-execute/mutation-journal.ts";
import type { CampaignStateStore } from "../store/state-store.ts";

/** The classification of one observed PR against its base. */
export type BranchFreshness = "fresh" | "behind_base" | "conflicted";

/** The follow-up action type reused for conflict-repair run intents. */
export const CONFLICT_REPAIR_ACTION_TYPE = "follow_up_run";

/** Attention reason when the update is wanted but the policy forbids it. */
export const BRANCH_UPDATE_POLICY_BLOCKED_REASON = "branch_update_policy_blocked";

/** Attention reason when the update-branch transport call definitively failed. */
export const BRANCH_UPDATE_FAILED_REASON = "branch_update_failed";

/**
 * Classify one PR snapshot. Pure: `mergeable_state` is GitHub's own
 * rollup; `dirty` is the conflicted state, `behind` means out-of-date but
 * mergeable, everything else (including `null`/unknown) is fresh.
 */
export function classifyBranchFreshness(pr: GithubPullRequestSnapshot): BranchFreshness {
	const state = pr.mergeableState ?? null;
	if (state === "dirty") return "conflicted";
	if (state === "behind") return "behind_base";
	return "fresh";
}

/** Deterministic action key for one base-merge update. */
export function branchUpdateActionKey(campaignId: string, pr: GithubPullRequestSnapshot): string {
	return `branch-update:${campaignId}:${pr.number}:${pr.baseSha}`;
}

/** Deterministic action key for one conflict-repair follow-up run. */
export function conflictRepairActionKey(campaignId: string, pr: GithubPullRequestSnapshot): string {
	return `conflict-repair:${campaignId}:${pr.number}:${pr.baseSha}`;
}

/** The conflict-repair prompt is composed from controller-owned facts only. */
export function renderConflictRepairPrompt(input: {
	issueRef: string;
	headBranch: string;
	baseRef: string;
}): string {
	return [
		"You are repairing merge conflicts on an existing PR branch.",
		"",
		`Issue: ${input.issueRef}`,
		`Branch to repair: ${input.headBranch}`,
		`Base branch it conflicts with: ${input.baseRef}`,
		"",
		"Merge the base branch into the existing head branch, resolve every",
		"conflict conservatively, and push the resolution to the existing",
		"branch. Do not rebase, do not force-push, do not open a new PR.",
		"",
		UNTRUSTED_FINDINGS_BANNER,
		"- [merge_conflict] the pull request reports mergeable_state=dirty against its base",
		"",
		"Resolve the conflicts and commit the repair to the existing branch.",
	].join("\n");
}

/** Everything one freshness decision consumes. All caller-collected. */
export interface BranchFreshnessInput {
	readonly campaignId: string;
	readonly workItemId: string | null;
	/** The PR snapshot observed by the reconcile pass this follows. */
	readonly pr: GithubPullRequestSnapshot;
	readonly issueRef: string;
	/** The follow-up dispatch coordinates (conflict path only). */
	readonly project?: string;
	readonly agent?: string;
	readonly maxCostUsd?: number;
	readonly policyDigest?: string | null;
}

/** The dispatch contract is the follow-up coordinator's own shape. */
export type BranchFreshnessDispatchFn = (input: {
	project: string;
	agent: string;
	prompt: string;
	maxCostUsd: number;
	existingBranch: string;
	idempotencyKey: string;
}) => Promise<{ runId: string }>;

export interface BranchFreshnessDeps {
	readonly store: CampaignStateStore;
	/**
	 * The updateBranch transport. Constructed only from a policy whose
	 * `updateBranch` flag is `true` (the transport constructor refuses
	 * otherwise), so a disabled flag leaves no object to call — the
	 * mutation is structurally impossible, not merely discouraged.
	 */
	readonly branchUpdater: GithubBranchUpdaterTransport | null;
	/** The follow-up dispatch POST; required only for the conflict path. */
	readonly dispatch: BranchFreshnessDispatchFn | null;
	/** True when the policy enables `followUpPush` (conflict-path gate). */
	readonly followUpPushEnabled: boolean;
}

/** One freshness handling outcome. All fields are JSON-safe. */
export type BranchFreshnessOutcome =
	| { readonly status: "fresh" }
	| {
			readonly status: "attention_opened";
			readonly reason: typeof BRANCH_UPDATE_POLICY_BLOCKED_REASON;
			readonly actionId: null;
	  }
	| {
			readonly status:
				| "update_branch_planned"
				| "update_branch_succeeded"
				| "update_branch_already_settled"
				| "update_branch_uncertain"
				| "update_branch_failed";
			readonly actionId: string | null;
	  }
	| {
			readonly status:
				| "conflict_repair_dispatched"
				| "conflict_repair_suppressed"
				| "conflict_repair_dispatch_failed"
				| "conflict_repair_gate_blocked";
			readonly actionId: string | null;
			readonly runId: string | null;
	  };

/** Non-terminal action states that suppress a re-trigger. */
const PENDING_STATES = new Set(["planned", "executing"]);

/**
 * Feed one reconciled PR snapshot through the freshness decision. Call
 * after each successful reconcile pass, with the same observation.
 */
export async function handleBranchFreshness(
	deps: BranchFreshnessDeps,
	input: BranchFreshnessInput,
): Promise<BranchFreshnessOutcome> {
	const freshness = classifyBranchFreshness(input.pr);
	if (freshness === "fresh") return { status: "fresh" };
	if (freshness === "conflicted") {
		return await handleConflictRepair(deps, input);
	}
	return await handleBehindBase(deps, input);
}

/** behind_base + clean: journal the update intent, then PUT when enabled. */
async function handleBehindBase(
	deps: BranchFreshnessDeps,
	input: BranchFreshnessInput,
): Promise<BranchFreshnessOutcome> {
	const intent = renderUpdateBranchIntent({
		upstreamOwner: input.pr.baseRepoFullName.split("/")[0] ?? "",
		upstreamRepo: input.pr.baseRepoFullName.split("/")[1] ?? "",
		prNumber: input.pr.number,
	});
	const actionKey = branchUpdateActionKey(input.campaignId, input.pr);

	// Disabled policy: no transport object exists, so the PUT is
	// structurally impossible. Open attention once and stop.
	const branchUpdater = deps.branchUpdater;
	if (branchUpdater === null) {
		deps.store.events.addAttentionOnce({
			campaignId: input.campaignId,
			workItemId: input.workItemId,
			reason: BRANCH_UPDATE_POLICY_BLOCKED_REASON,
			detailJson: canonicalJson({
				key: `branch-update-blocked:${input.campaignId}:${input.pr.number}:${input.pr.baseSha}`,
				prNumber: input.pr.number,
				headBranch: input.pr.headRef,
				detail: "pull request is behind base but the policy does not enable mutations.updateBranch",
			}),
		});
		return {
			status: "attention_opened",
			reason: BRANCH_UPDATE_POLICY_BLOCKED_REASON,
			actionId: null,
		};
	}

	// Idempotent pre-check: same base SHA replans onto the same row — a
	// pending update suppresses re-trigger; a settled row is a replay.
	const existing = deps.store.actions.getActionByKey(actionKey);
	if (existing !== null) {
		if (PENDING_STATES.has(existing.state)) {
			return { status: "update_branch_planned", actionId: existing.id };
		}
		return { status: "update_branch_already_settled", actionId: existing.id };
	}

	// Journal planned BEFORE any I/O.
	const { action } = journalMutationIntent(deps.store, {
		actionKey,
		campaignId: input.campaignId,
		workItemId: input.workItemId,
		actionType: UPDATE_BRANCH_ACTION_TYPE,
		intent,
		policyDigest: input.policyDigest ?? null,
	});

	const outcome = await executeJournaledMutation(
		deps.store,
		{ campaignId: input.campaignId, action },
		async () => {
			// The transport's `message` is GitHub's human-readable echo; the
			// journal records only result facts, and updateBranch yields none.
			await branchUpdater.updateBranch(intent);
			return {};
		},
	);
	switch (outcome.status) {
		case "succeeded":
			return { status: "update_branch_succeeded", actionId: action.id };
		case "already_settled":
			return { status: "update_branch_already_settled", actionId: action.id };
		case "settled_uncertain":
			return { status: "update_branch_uncertain", actionId: action.id };
		default:
			return { status: "update_branch_failed", actionId: action.id };
	}
}

/** conflicted: journal a follow_up_run intent, then dispatch the repair run. */
async function handleConflictRepair(
	deps: BranchFreshnessDeps,
	input: BranchFreshnessInput,
): Promise<BranchFreshnessOutcome> {
	if (!deps.followUpPushEnabled || deps.dispatch === null) {
		deps.store.events.addAttentionOnce({
			campaignId: input.campaignId,
			workItemId: input.workItemId,
			reason: BRANCH_UPDATE_POLICY_BLOCKED_REASON,
			detailJson: canonicalJson({
				key: `conflict-repair-blocked:${input.campaignId}:${input.pr.number}:${input.pr.baseSha}`,
				prNumber: input.pr.number,
				headBranch: input.pr.headRef,
				detail:
					"pull request is conflicted but the policy does not enable mutations.followUpPush for a repair run",
			}),
		});
		return { status: "conflict_repair_gate_blocked", actionId: null, runId: null };
	}

	const prompt = renderConflictRepairPrompt({
		issueRef: input.issueRef,
		headBranch: input.pr.headRef,
		baseRef: input.pr.baseRef,
	});
	const actionKey = conflictRepairActionKey(input.campaignId, input.pr);
	const requestDigest = sha256Hex(
		canonicalJson({
			kind: CONFLICT_REPAIR_ACTION_TYPE,
			issueRef: input.issueRef,
			headBranch: input.pr.headRef,
			baseRef: input.pr.baseRef,
			baseSha: input.pr.baseSha,
			prompt,
		}),
	);

	// Idempotent pre-check: an already-journaled repair row (pending or
	// settled) suppresses re-trigger — a failed attempt needs operator
	// attention, not an automatic retry loop.
	const existing = deps.store.actions.getActionByKey(actionKey);
	if (existing !== null) {
		return { status: "conflict_repair_suppressed", actionId: existing.id, runId: null };
	}

	// Journal planned BEFORE the dispatch POST (journal-before-I/O).
	const action = deps.store.actions.beginAction({
		actionKey,
		campaignId: input.campaignId,
		workItemId: input.workItemId,
		actionType: CONFLICT_REPAIR_ACTION_TYPE,
		requestDigest,
		policyDigest: input.policyDigest ?? null,
	});
	deps.store.actions.markExecuting(action.id);
	try {
		const { runId } = await deps.dispatch({
			project: input.project ?? "",
			agent: input.agent ?? "",
			prompt,
			maxCostUsd: input.maxCostUsd ?? 0,
			existingBranch: input.pr.headRef,
			idempotencyKey: actionKey,
		});
		return { status: "conflict_repair_dispatched", actionId: action.id, runId };
	} catch (error) {
		deps.store.actions.settleAction(action.id, {
			state: "permanent_failure",
			errorClass: "dispatch_rejected",
			errorJson: canonicalJson({ message: error instanceof Error ? error.message : String(error) }),
		});
		return { status: "conflict_repair_dispatch_failed", actionId: action.id, runId: null };
	}
}
