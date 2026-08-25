/**
 * Normalization of upstream GitHub observations into durable source events
 * (plan pl-91b6 step 9, warren-323d).
 *
 * Every normalized event carries a *durable key*: repository full name +
 * event kind + node id + a content digest. Exact re-deliveries (reordered
 * pagination, replayed notification wake-ups, restart re-polls) collide on
 * the key and store exactly once; an edit changes the content digest and
 * therefore produces a *new* source fact, per plan risk 3. Body text is
 * copied verbatim as untrusted data — nothing here interprets it.
 */

import { canonicalJson, sha256Hex } from "../digest.ts";
import type {
	GithubCheckRunSnapshot,
	GithubCombinedStatusSnapshot,
	GithubIssueCommentSnapshot,
	GithubPullRequestSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
} from "../github/types.ts";

/** Durable source-event kinds the reconciler can record. */
export type GithubEventKind =
	| "pull_request"
	| "issue_comment"
	| "review"
	| "review_comment"
	| "check_run"
	| "combined_status"
	| "policy_digest";

/** One normalized, deduplicable upstream source event. */
export interface NormalizedGithubEvent {
	/** Durable dedupe key: repo|kind|nodeId|contentDigest. */
	readonly key: string;
	readonly eventKind: GithubEventKind;
	readonly nodeId: string;
	/** Canonical JSON payload — untrusted upstream text rides as data only. */
	readonly payloadJson: string;
}

function event(
	repoFullName: string,
	eventKind: GithubEventKind,
	nodeId: string,
	payload: Record<string, unknown>,
): NormalizedGithubEvent {
	const payloadJson = canonicalJson({ ...payload, repo: repoFullName, kind: eventKind });
	const contentDigest = sha256Hex(payloadJson).slice(0, 16);
	return {
		key: `${repoFullName}|${eventKind}|${nodeId}|${contentDigest}`,
		eventKind,
		nodeId,
		payloadJson,
	};
}

/** Pull-request state. A new head sha / state / merge is a new fact. */
export function normalizePullRequest(
	repoFullName: string,
	pr: GithubPullRequestSnapshot,
): NormalizedGithubEvent {
	return event(repoFullName, "pull_request", pr.nodeId, {
		number: pr.number,
		state: pr.state,
		draft: pr.draft,
		title: pr.title,
		authorLogin: pr.authorLogin,
		headRef: pr.headRef,
		headSha: pr.headSha,
		baseRef: pr.baseRef,
		mergedAt: pr.mergedAt,
		closedAt: pr.closedAt,
		updatedAt: pr.updatedAt,
		htmlUrl: pr.htmlUrl,
	});
}

/** Issue comment. An edit (new updatedAt/body) is a new fact. */
export function normalizeIssueComment(
	repoFullName: string,
	comment: GithubIssueCommentSnapshot,
): NormalizedGithubEvent {
	return event(repoFullName, "issue_comment", comment.nodeId, {
		id: comment.id,
		authorLogin: comment.authorLogin,
		authorAssociation: comment.authorAssociation,
		body: comment.body,
		createdAt: comment.createdAt,
		updatedAt: comment.updatedAt,
		htmlUrl: comment.htmlUrl,
	});
}

/** Submitted review (including requested changes). */
export function normalizeReview(
	repoFullName: string,
	review: GithubReviewSnapshot,
): NormalizedGithubEvent {
	return event(repoFullName, "review", review.nodeId, {
		id: review.id,
		authorLogin: review.authorLogin,
		authorAssociation: review.authorAssociation,
		state: review.state,
		body: review.body,
		submittedAt: review.submittedAt,
		commitId: review.commitId,
		htmlUrl: review.htmlUrl,
	});
}

/** Code review comment. An edit is a new fact. */
export function normalizeReviewComment(
	repoFullName: string,
	comment: GithubReviewCommentSnapshot,
): NormalizedGithubEvent {
	return event(repoFullName, "review_comment", comment.nodeId, {
		id: comment.id,
		authorLogin: comment.authorLogin,
		authorAssociation: comment.authorAssociation,
		body: comment.body,
		createdAt: comment.createdAt,
		updatedAt: comment.updatedAt,
		htmlUrl: comment.htmlUrl,
	});
}

/** One check run. A status/conclusion transition is a new fact. */
export function normalizeCheckRun(
	repoFullName: string,
	ref: string,
	check: GithubCheckRunSnapshot,
): NormalizedGithubEvent {
	return event(repoFullName, "check_run", check.nodeId, {
		ref,
		id: check.id,
		name: check.name,
		status: check.status,
		conclusion: check.conclusion,
		startedAt: check.startedAt,
		completedAt: check.completedAt,
		detailsUrl: check.detailsUrl,
		htmlUrl: check.htmlUrl,
	});
}

/** Combined commit status rollup, keyed by sha + state. */
export function normalizeCombinedStatus(
	repoFullName: string,
	status: GithubCombinedStatusSnapshot,
): NormalizedGithubEvent {
	return event(repoFullName, "combined_status", `status-${status.sha}`, {
		sha: status.sha,
		state: status.state,
		totalCount: status.totalCount,
		contexts: status.contexts,
	});
}

/**
 * Repository policy content digest. The node id is synthetic ("policy") so
 * each distinct digest is one durable event; a *changed* digest is what the
 * reconciler turns into a policy-change attention item.
 */
export function normalizePolicyDigest(
	repoFullName: string,
	policyPath: string,
	digest: string,
): NormalizedGithubEvent {
	return event(repoFullName, "policy_digest", "policy", {
		policyPath,
		digest,
	});
}

/**
 * Fold a batch of normalized events into first-occurrence order, dropping
 * in-batch key duplicates (reordered pages, at-least-once delivery).
 */
export function dedupeEvents(events: readonly NormalizedGithubEvent[]): {
	items: NormalizedGithubEvent[];
	duplicateCount: number;
} {
	const seen = new Set<string>();
	const items: NormalizedGithubEvent[] = [];
	let duplicateCount = 0;
	for (const entry of events) {
		if (seen.has(entry.key)) {
			duplicateCount += 1;
			continue;
		}
		seen.add(entry.key);
		items.push(entry);
	}
	return { items, duplicateCount };
}
