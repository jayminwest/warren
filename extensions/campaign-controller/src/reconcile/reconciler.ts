/**
 * Read-only upstream PR reconciliation (plan pl-91b6 step 9, warren-323d).
 *
 * One `reconcile()` call covers one already-known upstream PR identity:
 * participating notifications are polled as *wake-ups only* (their content
 * never becomes state), then the authoritative pull request, reviews, issue
 * comments, review comments, check runs, combined status, and (optionally)
 * the repository policy file are re-read through GET/HEAD. Observations are
 * normalized into durable events keyed by repository + kind + node id +
 * content digest, so reordered pages, replayed wake-ups, edits, and
 * controller restarts all land exactly once. Attention items are derived
 * deterministically and stored through a deduplicating write.
 *
 * This module performs NO mutation of GitHub, dispatches nothing, replies to
 * nothing, and interprets no comment text. It is read-only by construction:
 * the only I/O seam is the structurally GET/HEAD `ReadOnlyGithubClient`.
 */

import type { Clock } from "../clock.ts";
import { canonicalJson, sha256Hex } from "../digest.ts";
import { StateError } from "../errors.ts";
import type { ReadOnlyGithubClient } from "../github/client.ts";
import { GithubApiError } from "../github/errors.ts";
import type {
	GithubCheckRunSnapshot,
	GithubCombinedStatusSnapshot,
	GithubIssueCommentSnapshot,
	GithubPullRequestSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
} from "../github/types.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import { deriveAttentionCandidates } from "./attention.ts";
import { type ReviewBotGrammar, validateBotGrammar } from "./bot-grammar.ts";
import { classifyEvents, feedbackRowId } from "./classifier.ts";
import {
	dedupeEvents,
	type NormalizedGithubEvent,
	normalizeCheckRun,
	normalizeCombinedStatus,
	normalizeIssueComment,
	normalizePolicyDigest,
	normalizePullRequest,
	normalizeReview,
	normalizeReviewComment,
} from "./events.ts";

/** The upstream PR identity one reconciliation targets. */
export interface UpstreamPrTarget {
	readonly campaignId: string;
	readonly workItemId?: string | null;
	readonly upstreamOwner: string;
	readonly upstreamRepo: string;
	readonly prNumber: number;
	/** Bot-owned account login; its own upstream activity is not attention. */
	readonly botLogin: string;
	/** Optional policy file path whose content digest is watched. */
	readonly policyPath?: string;
	/**
	 * Profile-declared review-bot grammar (plan pl-096b, warren-2ec3).
	 * When set, newly stored events are classified into durable review
	 * feedback; comment text is matched as data and never carried onward.
	 */
	readonly botGrammar?: ReviewBotGrammar | unknown;
	/** Default 0 (staleness classification off). */
	readonly staleAfterMs?: number;
}

/** What one reconciliation pass observed and durably changed. */
export interface ReconcileResult {
	/** Participating notifications seen — wake-ups only, never stored. */
	readonly notificationsSeen: number;
	readonly prMissing: boolean;
	readonly newEvents: number;
	readonly duplicateEvents: number;
	readonly attentionCreated: number;
	readonly attentionAlreadyOpen: number;
	/** Feedback rows newly classified and stored (warren-2ec3). */
	readonly feedbackCreated: number;
	readonly truncated: boolean;
}

export interface UpstreamPrReconcilerDeps {
	readonly client: ReadOnlyGithubClient;
	readonly store: CampaignStateStore;
	/** Injectable clock: staleness classification is deterministic in tests. */
	readonly clock: Clock;
}

/** Everything one pass read about the pull request. */
interface PrObservation {
	pr: GithubPullRequestSnapshot | null;
	reviews: GithubReviewSnapshot[];
	issueComments: GithubIssueCommentSnapshot[];
	reviewComments: GithubReviewCommentSnapshot[];
	checkRuns: GithubCheckRunSnapshot[];
	combinedStatus: GithubCombinedStatusSnapshot | null;
	truncated: boolean;
	notificationsSeen: number;
}

const POLICY_EVENT_KIND = "policy_digest";

export class UpstreamPrReconciler {
	readonly #client: ReadOnlyGithubClient;
	readonly #store: CampaignStateStore;
	readonly #clock: Clock;

	constructor(deps: UpstreamPrReconcilerDeps) {
		this.#client = deps.client;
		this.#store = deps.store;
		this.#clock = deps.clock;
	}

	/**
	 * Reconcile one upstream PR identity. Every GitHub request this issues
	 * is a GET (the client exposes reads plus HEAD probes only).
	 */
	async reconcile(target: UpstreamPrTarget): Promise<ReconcileResult> {
		const repoFullName = `${target.upstreamOwner}/${target.upstreamRepo}`;
		const observation = await this.#observe(target);
		const { policyChanged, policyEvent } = await this.#readPolicy(target, repoFullName);

		const normalized = this.#normalize(repoFullName, observation);
		if (policyEvent !== null) normalized.push(policyEvent);
		const { items, duplicateCount } = dedupeEvents(normalized);
		const { newEvents, durableDuplicates, newlyStored } = this.#storeEvents(target, items);
		const feedbackCreated = this.#classify(target, newlyStored);

		const candidates = deriveAttentionCandidates({
			repoFullName,
			pr: observation.pr,
			reviews: observation.reviews,
			issueComments: observation.issueComments,
			reviewComments: observation.reviewComments,
			checkRuns: observation.checkRuns,
			combinedStatus: observation.combinedStatus,
			policyChanged,
			botLogin: target.botLogin,
			truncated: observation.truncated,
			nowMs: this.#clock.nowMs(),
			staleAfterMs: target.staleAfterMs ?? 0,
		});
		const { attentionCreated, attentionAlreadyOpen } = this.#storeAttention(target, candidates);

		return {
			notificationsSeen: observation.notificationsSeen,
			prMissing: observation.pr === null,
			newEvents,
			duplicateEvents: duplicateCount + durableDuplicates,
			attentionCreated,
			attentionAlreadyOpen,
			feedbackCreated,
			truncated: observation.truncated,
		};
	}

	/** Read the authoritative upstream world for one target. */
	async #observe(target: UpstreamPrTarget): Promise<PrObservation> {
		const notifications = await this.#client.listNotifications({ participating: true });
		let truncated = notifications.truncated;
		const pr = await this.#readPullRequest(target);
		if (pr === null) {
			return {
				pr: null,
				reviews: [],
				issueComments: [],
				reviewComments: [],
				checkRuns: [],
				combinedStatus: null,
				truncated,
				notificationsSeen: notifications.items.length,
			};
		}
		const [reviews, issueComments, reviewComments] = await Promise.all([
			this.#client.listReviews(target.upstreamOwner, target.upstreamRepo, pr.number),
			this.#client.listIssueComments(target.upstreamOwner, target.upstreamRepo, pr.number),
			this.#client.listReviewComments(target.upstreamOwner, target.upstreamRepo, pr.number),
		]);
		truncated ||= reviews.truncated || issueComments.truncated || reviewComments.truncated;
		const checkRead = await this.#client.listCheckRunsForRef(
			target.upstreamOwner,
			target.upstreamRepo,
			pr.headSha,
		);
		const statusRead = await this.#client.getCombinedStatus(
			target.upstreamOwner,
			target.upstreamRepo,
			pr.headSha,
		);
		return {
			pr,
			reviews: reviews.items,
			issueComments: issueComments.items,
			reviewComments: reviewComments.items,
			checkRuns: checkRead.notModified ? [] : (checkRead.data ?? []),
			combinedStatus: statusRead.notModified ? null : (statusRead.data ?? null),
			truncated,
			notificationsSeen: notifications.items.length,
		};
	}

	/** One pull-request read; a 404 (deleted or inaccessible) maps to null. */
	async #readPullRequest(target: UpstreamPrTarget): Promise<GithubPullRequestSnapshot | null> {
		try {
			const read = await this.#client.getPullRequest(
				target.upstreamOwner,
				target.upstreamRepo,
				target.prNumber,
			);
			if (read.notModified) {
				throw new StateError(
					"pull-request read answered 304 without replayed validators; refusing to guess",
				);
			}
			return read.data ?? null;
		} catch (error) {
			if (error instanceof GithubApiError && error.status === 404) {
				return null;
			}
			throw error;
		}
	}

	/** Normalize one observation into durable events. */
	#normalize(repoFullName: string, observation: PrObservation): NormalizedGithubEvent[] {
		const { pr } = observation;
		if (pr === null) return [];
		const normalized: NormalizedGithubEvent[] = [normalizePullRequest(repoFullName, pr)];
		for (const review of observation.reviews) {
			normalized.push(normalizeReview(repoFullName, review));
		}
		for (const comment of observation.issueComments) {
			normalized.push(normalizeIssueComment(repoFullName, comment));
		}
		for (const comment of observation.reviewComments) {
			normalized.push(normalizeReviewComment(repoFullName, comment));
		}
		for (const check of observation.checkRuns) {
			normalized.push(normalizeCheckRun(repoFullName, pr.headSha, check));
		}
		if (observation.combinedStatus !== null) {
			normalized.push(normalizeCombinedStatus(repoFullName, observation.combinedStatus));
		}
		return normalized;
	}

	/** Persist events; returns new vs already-durable counts plus the new rows. */
	#storeEvents(
		target: UpstreamPrTarget,
		items: readonly NormalizedGithubEvent[],
	): {
		newEvents: number;
		durableDuplicates: number;
		newlyStored: NormalizedGithubEvent[];
	} {
		let newEvents = 0;
		let durableDuplicates = 0;
		const newlyStored: NormalizedGithubEvent[] = [];
		for (const entry of items) {
			const stored = this.#store.events.recordGithubEvent({
				nodeId: entry.key,
				campaignId: target.campaignId,
				eventKind: entry.eventKind,
				payloadJson: entry.payloadJson,
			});
			if (stored) {
				newEvents += 1;
				newlyStored.push(entry);
			} else {
				durableDuplicates += 1;
			}
		}
		return { newEvents, durableDuplicates, newlyStored };
	}

	/**
	 * Classify newly stored events through the profile-declared bot grammar
	 * and persist the feedback rows. Classification is pure: untrusted
	 * comment text is matched as data and never enters the stored fields.
	 */
	#classify(target: UpstreamPrTarget, newlyStored: readonly NormalizedGithubEvent[]): number {
		if (target.botGrammar === undefined || newlyStored.length === 0) return 0;
		const grammar = validateBotGrammar(target.botGrammar);
		let created = 0;
		for (const row of classifyEvents(
			newlyStored.map((entry) => ({
				eventKind: entry.eventKind,
				key: entry.key,
				payloadJson: entry.payloadJson,
			})),
			grammar,
		)) {
			const outcome = this.#store.events.addFeedbackOnce({
				id: feedbackRowId(row),
				campaignId: target.campaignId,
				workItemId: target.workItemId ?? null,
				category: row.category,
				sourceEventNodeId: row.sourceEventNodeId,
				fieldsJson: canonicalJson(row.fields),
			});
			if (outcome.created) created += 1;
		}
		return created;
	}

	/** Persist attention candidates through the deduplicating write. */
	#storeAttention(
		target: UpstreamPrTarget,
		candidates: ReadonlyArray<{
			reason: string;
			key: string;
			detail: Record<string, unknown>;
		}>,
	): { attentionCreated: number; attentionAlreadyOpen: number } {
		let attentionCreated = 0;
		let attentionAlreadyOpen = 0;
		for (const candidate of candidates) {
			const outcome = this.#store.events.addAttentionOnce({
				campaignId: target.campaignId,
				workItemId: target.workItemId ?? null,
				reason: candidate.reason,
				detailJson: canonicalJson({ key: candidate.key, ...candidate.detail }),
			});
			if (outcome.created) {
				attentionCreated += 1;
			} else {
				attentionAlreadyOpen += 1;
			}
		}
		return { attentionCreated, attentionAlreadyOpen };
	}

	/**
	 * Read the watched policy file (when configured) and decide whether its
	 * content digest changed relative to the durable event history. Returns
	 * the normalized policy-digest event, or null when the path is unset or
	 * currently unreadable (404 leaves the prior digest authoritative).
	 */
	async #readPolicy(
		target: UpstreamPrTarget,
		repoFullName: string,
	): Promise<{ policyChanged: boolean; policyEvent: NormalizedGithubEvent | null }> {
		if (target.policyPath === undefined) {
			return { policyChanged: false, policyEvent: null };
		}
		let text: string;
		try {
			const read = await this.#client.getContent(
				target.upstreamOwner,
				target.upstreamRepo,
				target.policyPath,
			);
			if (read.notModified || read.data === undefined) {
				return { policyChanged: false, policyEvent: null };
			}
			text = read.data.text;
		} catch (error) {
			if (error instanceof GithubApiError && error.status === 404) {
				return { policyChanged: false, policyEvent: null };
			}
			throw error;
		}
		const policyEvent = normalizePolicyDigest(repoFullName, target.policyPath, sha256Hex(text));
		if (this.#store.events.getGithubEvent(policyEvent.key) !== null) {
			return { policyChanged: false, policyEvent };
		}
		const priorDigests = this.#listPolicyDigests(target.campaignId, repoFullName);
		return { policyChanged: priorDigests.length > 0, policyEvent };
	}

	#listPolicyDigests(campaignId: string, repoFullName: string): string[] {
		const digests: string[] = [];
		for (const row of this.#store.events.listGithubEvents(campaignId)) {
			if (row.eventKind !== POLICY_EVENT_KIND) continue;
			try {
				const payload = JSON.parse(row.payloadJson) as { repo?: unknown };
				if (payload.repo === repoFullName) digests.push(row.nodeId);
			} catch {
				// Unparseable legacy payloads cannot prove a prior policy digest.
			}
		}
		return digests;
	}
}
