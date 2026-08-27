/**
 * Journaled cross-fork PR execution (Phase 2, warren-84da; design record
 * §15 Phase 2).
 *
 * Executes the exact `pr_intent` action the intender journaled — never a
 * request built ad hoc. The caller hands in the fresh `PrIntentResult`
 * from `renderAndJournalPrIntent`, which has already re-verified every
 * render invariant (policy digest binding, caps, protected paths) against
 * live upstream facts this tick, and whose request digest is pinned to the
 * journaled row, so a drifted fact can never reach the wire.
 *
 * The spend discipline mirrors the warren dispatcher exactly:
 *
 * - `planned → executing` is journaled BEFORE the POST;
 * - a transport failure after the request may have been sent settles the
 *   action `uncertain`, raises durable attention, and is NEVER re-POSTed —
 *   not this tick, not after a restart (a duplicate create is duplicate
 *   upstream noise the maintainers see);
 * - an `executing` row found on a later tick is a crash mid-POST: it
 *   recovers through a safe read (list open upstream PRs for the fork
 *   head) and settles succeeded or uncertain, never a second POST;
 * - GitHub's 422 "already exists" recovers through the same read.
 *
 * After a settle-succeeded the PR identity row carries the real number
 * and URL, so the existing read-only reconciler takes over: it re-reads
 * the created PR and stops at attention for all review feedback.
 */

import { canonicalJson } from "../digest.ts";
import type { ReadOnlyGithubClient } from "../github/client.ts";
import {
	GithubPrAlreadyExistsError,
	type GithubPrCreateTransport,
	GithubPrCreateUncertainError,
} from "../github/pr-create.ts";
import type { GithubPullRequestSnapshot } from "../github/types.ts";
import type { CampaignManifest } from "../manifest.ts";
import type { PrIntentResult } from "../pr-intent/intender.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import type { CampaignRow } from "../store/types.ts";

/** Attention reason for a create whose outcome is unknown. Stop condition. */
export const PR_CREATE_UNCERTAIN_REASON = "pr_create_uncertain";

/** Attention reason for a create GitHub definitively refused. */
export const PR_CREATE_FAILED_REASON = "pr_create_failed";

/** One execute attempt's machine-readable outcome. */
export interface PrExecuteOutcome {
	readonly status:
		| "created"
		| "recovered_existing"
		| "already_executed"
		| "uncertain_blocked"
		| "failed_blocked"
		| "settled_uncertain"
		| "settled_failed";
	readonly prNumber: number | null;
	readonly prUrl: string | null;
}

export interface PrExecuteDeps {
	readonly store: CampaignStateStore;
	readonly github: ReadOnlyGithubClient;
	readonly prCreator: GithubPrCreateTransport;
}

export interface PrExecuteInput {
	readonly campaign: CampaignRow;
	readonly manifest: CampaignManifest;
	/** The fresh render of the SAME journaled intent, verified this tick. */
	readonly intentResult: PrIntentResult;
}

/** Execute (or recover) the journaled intent. Never POSTs twice. */
export async function executeJournaledPrIntent(
	deps: PrExecuteDeps,
	input: PrExecuteInput,
): Promise<PrExecuteOutcome> {
	const { store } = deps;
	const { intentResult } = input;
	// Re-read the row: the render result may be a replay of an older row
	// whose state has since advanced.
	const action = store.actions.getAction(intentResult.action.id);
	if (action === null) {
		return { status: "failed_blocked", prNumber: null, prUrl: null };
	}
	switch (action.state) {
		case "succeeded":
			return {
				status: "already_executed",
				prNumber: action.resultPrNumber,
				prUrl: identityPrUrl(deps, input),
			};
		case "uncertain":
			return { status: "uncertain_blocked", prNumber: null, prUrl: null };
		case "permanent_failure":
			return { status: "failed_blocked", prNumber: null, prUrl: null };
		case "executing":
			// Crash mid-POST on an earlier tick: safe-read recovery only.
			return await recoverThroughRead(deps, input, "crashed mid-create on an earlier tick");
		default:
			break;
	}

	// Idempotent pre-flight: if the PR already exists upstream (an earlier
	// uncertain outcome, or an operator acted manually), recover it through
	// the read instead of POSTing a duplicate.
	const existing = await findExistingUpstreamPr(deps, input);
	if (existing !== null) {
		settleSucceeded(deps, input, existing.number, existing.htmlUrl);
		return { status: "recovered_existing", prNumber: existing.number, prUrl: existing.htmlUrl };
	}

	store.actions.markExecuting(action.id);
	try {
		const created = await deps.prCreator.createPullRequest(intentResult.intent);
		settleSucceeded(deps, input, created.prNumber, created.prUrl);
		return { status: "created", prNumber: created.prNumber, prUrl: created.prUrl };
	} catch (error) {
		if (error instanceof GithubPrAlreadyExistsError) {
			return await recoverThroughRead(deps, input, "GitHub reported the PR already exists");
		}
		if (error instanceof GithubPrCreateUncertainError) {
			settleUncertain(deps, input, error.message);
			return { status: "settled_uncertain", prNumber: null, prUrl: null };
		}
		settleFailed(deps, input, error);
		return { status: "settled_failed", prNumber: null, prUrl: null };
	}
}

/** Safe-read recovery: list open upstream PRs and match the fork head. */
async function recoverThroughRead(
	deps: PrExecuteDeps,
	input: PrExecuteInput,
	why: string,
): Promise<PrExecuteOutcome> {
	const existing = await findExistingUpstreamPr(deps, input);
	if (existing !== null) {
		settleSucceeded(deps, input, existing.number, existing.htmlUrl);
		return { status: "recovered_existing", prNumber: existing.number, prUrl: existing.htmlUrl };
	}
	settleUncertain(deps, input, `${why}, and no matching open upstream PR was found by the read`);
	return { status: "settled_uncertain", prNumber: null, prUrl: null };
}

async function findExistingUpstreamPr(
	deps: PrExecuteDeps,
	input: PrExecuteInput,
): Promise<GithubPullRequestSnapshot | null> {
	const { manifest, intentResult } = input;
	const headBranch = intentResult.identity.headBranch;
	const forkFullName = `${manifest.fork.owner}/${manifest.fork.repo}`;
	const page = await deps.github.listPullRequests(manifest.upstream.owner, manifest.upstream.repo);
	return (
		page.items.find((pr) => pr.headRef === headBranch && pr.headRepoFullName === forkFullName) ??
		null
	);
}

function settleSucceeded(
	deps: PrExecuteDeps,
	input: PrExecuteInput,
	prNumber: number,
	prUrl: string,
): void {
	const { store } = deps;
	const { campaign, manifest, intentResult } = input;
	store.transaction(() => {
		store.actions.settleAction(intentResult.action.id, {
			state: "succeeded",
			resultPrNumber: prNumber,
		});
		store.events.recordPrIdentity({
			campaignId: campaign.id,
			workItemId: intentResult.action.workItemId ?? intentResult.identity.workItemId,
			upstreamOwner: manifest.upstream.owner,
			upstreamRepo: manifest.upstream.repo,
			forkOwner: manifest.fork.owner,
			forkRepo: manifest.fork.repo,
			headBranch: intentResult.identity.headBranch,
			title: intentResult.identity.title,
			bodyDigest: intentResult.identity.bodyDigest,
			prNumber,
			prUrl,
		});
	});
}

function settleUncertain(deps: PrExecuteDeps, input: PrExecuteInput, message: string): void {
	const { store } = deps;
	const { campaign, intentResult } = input;
	store.transaction(() => {
		store.actions.settleAction(intentResult.action.id, {
			state: "uncertain",
			errorClass: "ambiguous_response",
			errorJson: canonicalJson({ message }),
		});
		store.events.addAttentionOnce({
			campaignId: campaign.id,
			workItemId: intentResult.action.workItemId,
			reason: PR_CREATE_UNCERTAIN_REASON,
			detailJson: canonicalJson({
				key: `action:${intentResult.action.id}`,
				actionId: intentResult.action.id,
				headBranch: intentResult.identity.headBranch,
			}),
		});
	});
}

function settleFailed(deps: PrExecuteDeps, input: PrExecuteInput, error: unknown): void {
	const { store } = deps;
	const { campaign, intentResult } = input;
	const message = error instanceof Error ? error.message : String(error);
	store.transaction(() => {
		store.actions.settleAction(intentResult.action.id, {
			state: "permanent_failure",
			errorClass: "github_rejected",
			errorJson: canonicalJson({ message }),
		});
		store.events.addAttentionOnce({
			campaignId: campaign.id,
			workItemId: intentResult.action.workItemId,
			reason: PR_CREATE_FAILED_REASON,
			detailJson: canonicalJson({
				key: `action:${intentResult.action.id}`,
				actionId: intentResult.action.id,
				headBranch: intentResult.identity.headBranch,
			}),
		});
	});
}

function identityPrUrl(deps: PrExecuteDeps, input: PrExecuteInput): string | null {
	const identity = deps.store.events.getPrIdentity(input.intentResult.identity.id);
	return identity?.prUrl ?? null;
}
