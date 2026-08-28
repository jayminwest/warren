/**
 * Attention derivation from reconciled upstream PR state
 * (plan pl-91b6 step 9, warren-323d).
 *
 * Pure and deterministic: snapshots in, stable attention candidates out.
 * Each candidate carries a `key` embedded in its detail JSON, so the
 * durable `addAttentionOnce` dedupe (campaign + reason + detail) collapses
 * re-derivations across ticks, reordered polls, and restarts. Comment and
 * review *text* is never inspected — only authors, associations, states,
 * and timestamps drive classification, so untrusted text can never act as
 * a controller command.
 */

import type {
	GithubCheckRunSnapshot,
	GithubCombinedStatusSnapshot,
	GithubIssueCommentSnapshot,
	GithubPullRequestSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
} from "../github/types.ts";

/** Every attention category the V0 reconciler derives. */
export type AttentionReason =
	| "requested_changes"
	| "maintainer_comment"
	| "failing_checks"
	| "policy_changed"
	| "human_takeover"
	| "stale_author_action"
	| "unresolved_ambiguity";

/** Review states the reconciler understands; anything else is ambiguous. */
const KNOWN_REVIEW_STATES = new Set([
	"APPROVED",
	"CHANGES_REQUESTED",
	"COMMENTED",
	"DISMISSED",
	"PENDING",
]);

/**
 * Author associations that classify a comment as bot-placeholder noise
 * rather than actionable human feedback (warren-b853). Review bots post
 * process markers ("review started", checklist updates) that each used to
 * open a maintainer_comment attention item; until the profile-declared
 * classifier (warren-2ec3) lands, association grammar is the untrusted-text
 * discipline-safe proxy: BOT and NONE associations are never actionable.
 */
const PLACEHOLDER_ASSOCIATIONS = new Set(["BOT", "NONE"]);

/** Check-run conclusions that mean the branch is red. */
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/** Check-run conclusions the reconciler understands. */
const KNOWN_CONCLUSIONS = new Set([
	"success",
	"failure",
	"neutral",
	"skipped",
	"timed_out",
	"cancelled",
	"action_required",
	"stale",
]);

/** Check-run lifecycle statuses the reconciler understands. */
const KNOWN_CHECK_STATUSES = new Set(["queued", "in_progress", "completed"]);

/** One derived attention candidate with a stable dedupe key. */
export interface AttentionCandidate {
	readonly reason: AttentionReason;
	/** Stable subject key — part of the durable detail, hence the dedupe. */
	readonly key: string;
	/** Deterministic detail object (no wall-clock noise). */
	readonly detail: Record<string, unknown>;
}

/** Inputs the derivation runs over. All snapshots come from one PR read. */
export interface AttentionDerivationInput {
	/** Repository the reconciled pull request lives on. */
	readonly repoFullName: string;
	/** Null when the pull request answered 404 (deleted or inaccessible). */
	readonly pr: GithubPullRequestSnapshot | null;
	readonly reviews: readonly GithubReviewSnapshot[];
	readonly issueComments: readonly GithubIssueCommentSnapshot[];
	readonly reviewComments: readonly GithubReviewCommentSnapshot[];
	readonly checkRuns: readonly GithubCheckRunSnapshot[];
	readonly combinedStatus: GithubCombinedStatusSnapshot | null;
	/** True when the prior stored policy digest differs from the current one. */
	readonly policyChanged: boolean;
	/** Login of the bot-owned account; its own activity is never attention. */
	readonly botLogin: string;
	/** True when any paginated read hit its page bound (incomplete truth). */
	readonly truncated: boolean;
	/** Injected now (ms) for staleness classification only. */
	readonly nowMs: number;
	/** A requested-changes/comment older than this needs a bot response. */
	readonly staleAfterMs: number;
}

/** An external (non-bot) activity timestamp, for staleness classification. */
interface ExternalActivity {
	readonly key: string;
	readonly atMs: number;
}

function parseMs(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function reviewCandidates(
	prNumber: number,
	botLogin: string,
	reviews: readonly GithubReviewSnapshot[],
	activity: ExternalActivity[],
): AttentionCandidate[] {
	const candidates: AttentionCandidate[] = [];
	for (const review of reviews) {
		if (review.authorLogin === botLogin) continue;
		if (!KNOWN_REVIEW_STATES.has(review.state)) {
			candidates.push({
				reason: "unresolved_ambiguity",
				key: `review-state:${review.nodeId}:${review.state}`,
				detail: {
					prNumber,
					nodeId: review.nodeId,
					reviewState: review.state,
					note: "unknown review state",
				},
			});
			continue;
		}
		const atMs = parseMs(review.submittedAt);
		if (atMs !== null) activity.push({ key: `review:${review.nodeId}`, atMs });
		if (review.state === "CHANGES_REQUESTED") {
			candidates.push({
				reason: "requested_changes",
				key: `review:${review.nodeId}:${review.submittedAt ?? ""}`,
				detail: {
					prNumber,
					nodeId: review.nodeId,
					authorLogin: review.authorLogin,
					authorAssociation: review.authorAssociation,
					submittedAt: review.submittedAt,
					htmlUrl: review.htmlUrl,
				},
			});
		}
	}
	return candidates;
}

function commentCandidates(
	prNumber: number,
	botLogin: string,
	kind: string,
	comments: readonly (GithubIssueCommentSnapshot | GithubReviewCommentSnapshot)[],
	activity: ExternalActivity[],
): AttentionCandidate[] {
	const candidates: AttentionCandidate[] = [];
	for (const comment of comments) {
		if (comment.authorLogin === botLogin) continue;
		// Activity is tracked for every external comment, but only
		// classified-actionable authors open attention (warren-b853).
		const placeholder = PLACEHOLDER_ASSOCIATIONS.has(comment.authorAssociation);
		const atMs = parseMs(comment.updatedAt);
		if (atMs !== null) activity.push({ key: `${kind}:${comment.nodeId}`, atMs });
		if (placeholder) continue;
		// Keyed on the comment's node id only: a durable-comment edit is the
		// same subject as the original and must not open a second item. The
		// detail therefore carries no mutable timestamp either.
		candidates.push({
			reason: "maintainer_comment",
			key: `${kind}:${comment.nodeId}`,
			detail: {
				prNumber,
				kind,
				nodeId: comment.nodeId,
				authorLogin: comment.authorLogin,
				authorAssociation: comment.authorAssociation,
				createdAt: comment.createdAt,
				htmlUrl: comment.htmlUrl,
				note: "comment text is untrusted data; never a controller command",
			},
		});
	}
	return candidates;
}

function checkCandidates(
	prNumber: number,
	checks: readonly GithubCheckRunSnapshot[],
): AttentionCandidate[] {
	const candidates: AttentionCandidate[] = [];
	for (const check of checks) {
		if (!KNOWN_CHECK_STATUSES.has(check.status)) {
			candidates.push({
				reason: "unresolved_ambiguity",
				key: `check-status:${check.nodeId}:${check.status}`,
				detail: {
					prNumber,
					nodeId: check.nodeId,
					checkName: check.name,
					checkStatus: check.status,
					note: "unknown check status",
				},
			});
			continue;
		}
		if (check.status === "completed" && !KNOWN_CONCLUSIONS.has(check.conclusion ?? "")) {
			candidates.push({
				reason: "unresolved_ambiguity",
				key: `check-conclusion:${check.nodeId}:${check.conclusion ?? "null"}`,
				detail: {
					prNumber,
					nodeId: check.nodeId,
					checkName: check.name,
					checkConclusion: check.conclusion,
					note: "completed check without a recognized conclusion",
				},
			});
			continue;
		}
		if (check.conclusion !== null && FAILING_CONCLUSIONS.has(check.conclusion)) {
			candidates.push({
				reason: "failing_checks",
				key: `check:${check.nodeId}:${check.conclusion}`,
				detail: {
					prNumber,
					nodeId: check.nodeId,
					checkName: check.name,
					checkStatus: check.status,
					checkConclusion: check.conclusion,
					htmlUrl: check.htmlUrl,
				},
			});
		}
	}
	return candidates;
}

function combinedStatusCandidate(
	prNumber: number,
	status: GithubCombinedStatusSnapshot | null,
): AttentionCandidate[] {
	if (status === null) return [];
	if (status.state !== "failure" && status.state !== "error") return [];
	return [
		{
			reason: "failing_checks",
			key: `combined-status:${status.sha}:${status.state}`,
			detail: {
				prNumber,
				sha: status.sha,
				state: status.state,
				totalCount: status.totalCount,
			},
		},
	];
}

function staleCandidates(
	prNumber: number,
	activity: readonly ExternalActivity[],
	nowMs: number,
	staleAfterMs: number,
): AttentionCandidate[] {
	if (staleAfterMs <= 0) return [];
	const cutoff = nowMs - staleAfterMs;
	return activity
		.filter((entry) => entry.atMs < cutoff)
		.map((entry) => ({
			reason: "stale_author_action",
			key: `stale:${entry.key}`,
			detail: {
				prNumber,
				subject: entry.key,
				lastExternalActivityMs: entry.atMs,
				staleAfterMs,
				note: "external activity awaits a bot response beyond the stale bound",
			},
		}));
}

/**
 * Check names with a completed passing run in the same observation. A
 * check whose latest run passed on this PR is green: its stale failing
 * run must not open attention (warren-b853).
 */
function passingCheckNames(checks: readonly GithubCheckRunSnapshot[]): Set<string> {
	const passing = new Set<string>();
	for (const check of checks) {
		if (check.status === "completed" && check.conclusion === "success") passing.add(check.name);
	}
	return passing;
}

/**
 * Derive attention candidates. Deterministic in input order, and every
 * candidate's key is stable for the same upstream fact, so storing them
 * through a dedupe-by-detail write yields one row per distinct fact.
 */
export function deriveAttentionCandidates(input: AttentionDerivationInput): AttentionCandidate[] {
	if (input.pr === null) {
		return [
			{
				reason: "unresolved_ambiguity",
				key: "pr-missing",
				detail: { subject: "pull request missing (404 or deleted)" },
			},
		];
	}
	const pr = input.pr;
	const activity: ExternalActivity[] = [];
	const candidates: AttentionCandidate[] = [];
	if (pr.authorLogin !== input.botLogin) {
		candidates.push({
			reason: "human_takeover",
			key: `pr-author:${pr.authorLogin}`,
			detail: {
				prNumber: pr.number,
				authorLogin: pr.authorLogin,
				note: "pull request author is not the bot account",
			},
		});
	}
	candidates.push(...reviewCandidates(pr.number, input.botLogin, input.reviews, activity));
	candidates.push(
		...commentCandidates(pr.number, input.botLogin, "issue_comment", input.issueComments, activity),
	);
	candidates.push(
		...commentCandidates(
			pr.number,
			input.botLogin,
			"review_comment",
			input.reviewComments,
			activity,
		),
	);
	const passingNames = passingCheckNames(input.checkRuns);
	for (const candidate of checkCandidates(pr.number, input.checkRuns)) {
		if (
			candidate.reason === "failing_checks" &&
			typeof candidate.detail.checkName === "string" &&
			passingNames.has(candidate.detail.checkName)
		) {
			continue;
		}
		candidates.push(candidate);
	}
	candidates.push(...combinedStatusCandidate(pr.number, input.combinedStatus));
	if (input.policyChanged) {
		candidates.push({
			reason: "policy_changed",
			key: "policy",
			detail: {
				prNumber: pr.number,
				note: "repository policy content digest changed since last observation",
			},
		});
	}
	if (input.truncated) {
		candidates.push({
			reason: "unresolved_ambiguity",
			key: "pagination-truncated",
			detail: {
				prNumber: pr.number,
				note: "a paginated read hit its page bound; upstream truth is incomplete",
			},
		});
	}
	// Collapse repeated activity for the same subject to its latest timestamp
	// so an edited comment cannot open two stale rows for one subject.
	const latest = new Map<string, ExternalActivity>();
	for (const entry of activity) {
		const prior = latest.get(entry.key);
		if (prior === undefined || entry.atMs > prior.atMs) latest.set(entry.key, entry);
	}
	candidates.push(
		...staleCandidates(pr.number, [...latest.values()], input.nowMs, input.staleAfterMs),
	);
	return candidates;
}
