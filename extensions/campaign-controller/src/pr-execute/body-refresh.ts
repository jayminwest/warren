/**
 * The updatePullRequest body-refresh mutation (warren-09d2, plan pl-096b).
 *
 * After a follow-up lands — a follow-up push plus its completed run, or an
 * operator attaching external proof — the controller re-renders the PR body
 * from the profile's PR-body contract with refreshed facts: evidence lines
 * from the follow-up, a response-summary section listing each addressed
 * finding (structured titles only), and the known-gap slot updated or
 * cleared per the evidence-tier step (warren-4dc1).
 *
 * Discipline, identical to every other mutation (warren-094b):
 *
 * 1. The PATCH intent is journaled `planned` with its canonical request
 *    digest BEFORE any I/O, under a deterministic action key derived from
 *    the refreshed body's digest — same facts re-plan onto the same row
 *    (idempotent replay), changed facts are a new logical effect.
 * 2. The whole body is rendered from controller-owned state. The
 *    controller is the single writer of its own PR body: if a safe read
 *    shows the live body diverged from the last rendered state (someone
 *    hand-edited), the refresh raises durable attention and refuses to
 *    clobber unless the operator passes the override flag.
 * 3. Execution goes through the shared mutation journal
 *    (`executeJournaledMutation`): uncertain settles and is never re-sent
 *    blind, definitive refusals settle permanent_failure with attention.
 *
 * Determinism: the refreshed body is a pure function of the contract and
 * the facts, so goldens pin it byte for byte.
 */
import { canonicalJson, sha256Hex } from "../digest.ts";
import {
	type GithubPrUpdateTransport,
	renderUpdatePullRequestIntent,
	type UpdatePullRequestIntent,
} from "../github/pr-mutations.ts";
import type { PrBodyFacts } from "../pr-intent/pr-body.ts";
import { renderPrBody } from "../pr-intent/pr-body.ts";
import type { PrBodyContract } from "../repository-policy.ts";
import {
	journalMutationIntent,
	MUTATION_FAILED_REASON,
	MUTATION_UNCERTAIN_REASON,
} from "./mutation-journal.ts";

export { MUTATION_FAILED_REASON, MUTATION_UNCERTAIN_REASON };

/** Attention reason when the live body no longer matches the last render. */
export const BODY_REFRESH_DIVERGED_REASON = "pr_body_diverged";

export const UPDATE_PULL_REQUEST_BODY_REFRESH_ACTION_TYPE = "pr_body_refresh";

/**
 * The follow-up facts layered onto the base render. Everything is
 * controller-collected or operator-approved; nothing is quoted from
 * upstream comments (untrusted-input discipline).
 */
export interface PrBodyRefreshFacts {
	/** The follow-up run's id, when the refresh follows a landed follow-up run. */
	readonly followUpRunId: string | null;
	/** New validation-evidence lines produced by the follow-up; appended to base evidence, deduped in order. */
	readonly newEvidence: readonly string[];
	/** Structured titles only of findings the follow-up addressed. */
	readonly addressedFindings: readonly string[];
	/** The updated known gap; `null` clears the slot (proof attached or tier resolved). */
	readonly knownGap: string | null;
}

export interface RenderAndJournalBodyRefreshInput {
	readonly campaignId: string;
	readonly workItemId: string;
	readonly prNumber: number;
	readonly upstreamOwner: string;
	readonly upstreamRepo: string;
	/** The profile's body contract (heading data); never source-declared. */
	readonly contract: PrBodyContract;
	/** The controller-owned base facts the original body rendered from. */
	readonly baseFacts: PrBodyFacts;
	readonly refresh: PrBodyRefreshFacts;
	/**
	 * The body the controller last rendered and successfully wrote (the
	 * created body, or the body of the most recent settled refresh).
	 * `null` means no prior render is known — divergence is then
	 * undetectable and the refresh proceeds.
	 */
	readonly lastRenderedBody: string | null;
	/** The live body from a safe read-only GET; `null` means not readable. */
	readonly liveBody: string | null;
	/** Operator override allowing a clobber of a hand-edited body. */
	readonly operatorOverride?: boolean;
	readonly policyDigest?: string | null;
}

/** One render-and-journal outcome. All fields are JSON-safe. */
export type BodyRefreshJournalResult =
	| {
			readonly status: "diverged_refused";
			readonly actionId: null;
			readonly refreshedBody: string | null;
	  }
	| {
			readonly status: "rendered" | "already_journaled";
			readonly actionId: string;
			readonly requestDigest: string;
			readonly intent: UpdatePullRequestIntent;
			readonly refreshedBody: string;
	  };

/**
 * The controller's last-rendered digest convention: the sha256 over the
 * canonical JSON of `{ body }`. Divergence compares this shape, never raw
 * equality, so the convention is pinned next to its only consumers.
 */
export function renderedBodyDigest(body: string): string {
	return sha256Hex(canonicalJson({ body }));
}

/** True when a safe read shows the live body no longer matches the last render. */
export function bodyHasDiverged(lastRenderedBody: string | null, liveBody: string | null): boolean {
	if (lastRenderedBody === null || liveBody === null) return false;
	return renderedBodyDigest(lastRenderedBody) !== renderedBodyDigest(liveBody);
}

/** Merge base and follow-up evidence: order-preserving, deduped, non-empty. */
export function mergeEvidence(base: readonly string[], followUp: readonly string[]): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const line of [...base, ...followUp]) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		merged.push(trimmed);
	}
	return merged;
}

/**
 * Render the refreshed body from the profile contract: base facts with
 * follow-up evidence appended, the response-summary titles set, the
 * known-gap slot updated or cleared, and the follow-up run referenced.
 * Deterministic — the golden pins it.
 */
export function renderRefreshedPrBody(
	contract: PrBodyContract,
	baseFacts: PrBodyFacts,
	refresh: PrBodyRefreshFacts,
): string {
	const facts: PrBodyFacts = {
		...baseFacts,
		evidence: mergeEvidence(baseFacts.evidence, refresh.newEvidence),
		addressedFindings: refresh.addressedFindings,
		followUpRunId: refresh.followUpRunId ?? undefined,
		knownGap: refresh.knownGap ?? undefined,
	};
	return renderPrBody(contract, facts);
}

/** Deterministic action key: one row per campaign work item per body state. */
export function bodyRefreshActionKey(campaignId: string, workItemId: string, body: string): string {
	return `pr-body-refresh:${campaignId}:${workItemId}:${renderedBodyDigest(body).slice(0, 16)}`;
}

/**
 * Divergence gate, then render + journal the PATCH intent `planned` with
 * its canonical request digest before any I/O. A diverged live body raises
 * durable attention once and refuses unless `operatorOverride` is set.
 */
export function renderAndJournalBodyRefresh(
	deps: { store: import("../store/state-store.ts").CampaignStateStore },
	input: RenderAndJournalBodyRefreshInput,
): BodyRefreshJournalResult {
	const { store } = deps;
	const refreshedBody = renderRefreshedPrBody(input.contract, input.baseFacts, input.refresh);
	if (bodyHasDiverged(input.lastRenderedBody, input.liveBody) && input.operatorOverride !== true) {
		store.events.addAttentionOnce({
			campaignId: input.campaignId,
			workItemId: input.workItemId,
			reason: BODY_REFRESH_DIVERGED_REASON,
			detailJson: canonicalJson({
				prNumber: input.prNumber,
				lastRenderedDigest: renderedBodyDigest(input.lastRenderedBody as string),
				liveDigest: renderedBodyDigest(input.liveBody as string),
				override: false,
			}),
		});
		return { status: "diverged_refused", actionId: null, refreshedBody: null };
	}
	const intent = renderUpdatePullRequestIntent({
		upstreamOwner: input.upstreamOwner,
		upstreamRepo: input.upstreamRepo,
		prNumber: input.prNumber,
		body: refreshedBody,
	});
	const planned = journalMutationIntent(store, {
		actionKey: bodyRefreshActionKey(input.campaignId, input.workItemId, refreshedBody),
		campaignId: input.campaignId,
		workItemId: input.workItemId,
		actionType: UPDATE_PULL_REQUEST_BODY_REFRESH_ACTION_TYPE,
		intent,
		policyDigest: input.policyDigest ?? null,
	});
	return {
		status: planned.created ? "rendered" : "already_journaled",
		actionId: planned.action.id,
		requestDigest: planned.requestDigest,
		intent,
		refreshedBody,
	};
}

export interface ExecuteBodyRefreshInput {
	readonly campaignId: string;
	/** The action row returned by `renderAndJournalBodyRefresh` (re-rendered
	 * deterministically on any later tick that finds the row still `planned`). */
	readonly action: import("../store/types.ts").ActionRow;
	/** The exact intent returned beside that action row — never rebuilt ad hoc. */
	readonly intent: UpdatePullRequestIntent;
}

/** Execute the journaled PATCH through the shared mutation-journal settle discipline. */
export async function executeJournaledBodyRefresh(
	store: import("../store/state-store.ts").CampaignStateStore,
	input: ExecuteBodyRefreshInput,
	updater: GithubPrUpdateTransport,
): Promise<import("./mutation-journal.ts").MutationExecuteOutcome> {
	const action = store.actions.getAction(input.action.id);
	if (action === null) {
		return { status: "failed_blocked" };
	}
	const { executeJournaledMutation } = await import("./mutation-journal.ts");
	return await executeJournaledMutation(
		store,
		{
			campaignId: input.campaignId,
			action,
		},
		async () => {
			const updated = await updater.updatePullRequest(input.intent);
			return { resultUpdatedAt: updated.updatedAt };
		},
	);
}
