/**
 * The postComment mutation executor (warren-09f3; design record §6.3).
 *
 * Some review protocols need a comment, not a body edit: acknowledging
 * findings with what changed, or issuing the re-review command the profile
 * grammar declares. The discipline is absolute:
 *
 * - Comment text is composed EXCLUSIVELY from controller-owned state —
 *   finding titles being addressed (structured classifier fields, never a
 *   raw comment body), run references, and evidence lines — poured into
 *   profile-declared templates with named placeholders. Untrusted upstream
 *   comment content can never reach the wire through this module, because
 *   no input slot accepts it.
 * - One comment per follow-up cycle per work item: the action key is
 *   deterministic over (campaign, work item, cycle), so every re-drive in
 *   the same cycle lands on the same journal row and a second trigger
 *   cannot post twice (no bot chatter).
 * - A re-review command is composed only when the profile declares BOTH a
 *   comment-templates block AND a bot grammar with re-review commands, AND
 *   the caller affirms the preceding body update or push actually landed.
 * - A per-day per-campaign comment cap lives in the policy; exceeding it
 *   raises an attention item and posts nothing.
 * - A profile without the comment-templates block is grammar-less for
 *   comments and posts nothing at all.
 *
 * Execution follows the shared phase-3 journal contract
 * (`journalMutationIntent` → `executeJournaledMutation`), identical to
 * `pr_execute`: `planned` is committed before any I/O, `executing` is
 * stamped immediately before the POST, and an ambiguous response settles
 * `uncertain` and is never re-sent blind (a replayed POST is duplicate
 * upstream noise the maintainers see).
 */

import { canonicalJson } from "../digest.ts";
import type { ReviewBotGrammar } from "../reconcile/bot-grammar.ts";
import { renderPostCommentIntent, type PostCommentIntent } from "../github/pr-mutations.ts";
import type { CommentTemplatesPolicy, RepositoryPolicy } from "../repository-policy.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import {
	executeJournaledMutation,
	type MutationExecuteOutcome,
	mutationRequestDigest,
	POST_COMMENT_ACTION_TYPE,
} from "./mutation-journal.ts";
import type { GithubCommentPosterTransport } from "../github/pr-mutations.ts";

/** Attention reason when the per-day per-campaign comment cap is exceeded. */
export const COMMENT_RATE_CAPPED_REASON = "comment_rate_capped";

/** Hard bounds on composed comment content. */
const MAX_FINDING_TITLES = 20;
const MAX_FINDING_TITLE_LENGTH = 200;
const MAX_EVIDENCE_LINES = 20;
const MAX_EVIDENCE_LINE_LENGTH = 200;

/** One structured classifier field the composer may render. */
export interface CommentFieldValue {
	readonly value: unknown;
	/** `untrusted` fields are upstream-derived and bounded, never echoed raw. */
	readonly provenance: "untrusted" | "profile";
}

/** Controller-owned state one composed comment renders from. */
export interface CommentComposeInput {
	readonly campaignId: string;
	/** The warren run reference the follow-up work belongs to. */
	readonly runId: string;
	readonly prNumber: number;
	/** Finding titles being addressed — structured fields, never raw bodies. */
	readonly findingTitles: readonly CommentFieldValue[];
	/** Evidence lines to cite, one per line in the rendered comment. */
	readonly evidenceLines: readonly string[];
}

/** Compose the finding-response reply, or `null` when nothing may be posted. */
export function composeFindingResponseComment(
	policy: RepositoryPolicy,
	input: CommentComposeInput,
): string | null {
	const templates = policy.commentTemplates;
	if (templates === null) return null;
	return renderTemplate(templates.findingResponseTemplate, templateValues(templates, input, null));
}

/**
 * Compose the profile-declared re-review command comment, or `null` when
 * the profile declares no grammar with re-review commands, declares no
 * comment templates, or the preceding body update / push did not land.
 */
export function composeReReviewComment(
	policy: RepositoryPolicy,
	input: CommentComposeInput,
	options: {
		/** The profile-declared bot grammar, when the profile declares one. */
		readonly botGrammar: ReviewBotGrammar | null;
		/**
		 * Whether the preceding body-update or push actually landed — the
		 * re-review command is only issued after a real controller change.
		 */
		readonly precedingChangeLanded: boolean;
	},
): string | null {
	const templates = policy.commentTemplates;
	if (templates === null) return null;
	if (!options.precedingChangeLanded) return null;
	const grammar = options.botGrammar;
	if (grammar === null || grammar.reReviewCommands.length === 0) return null;
	// The command value is copied from the profile — the comment supplies
	// nothing, and no other grammar surface exists for comments.
	const command = grammar.reReviewCommands[0];
	if (command === undefined) return null;
	return renderTemplate(
		templates.reReviewCommandTemplate,
		templateValues(templates, input, command),
	);
}

/** Bounded, whitespace-collapsed text — structured fields only, never raw. */
function sanitizeLine(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") return null;
	const collapsed = value
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
	if (collapsed.length === 0) return null;
	return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
}

function renderBulletList(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

interface TemplateValueMap {
	readonly [key: string]: string;
}

function templateValues(
	_templates: CommentTemplatesPolicy,
	input: CommentComposeInput,
	reReviewCommand: string | null,
): TemplateValueMap {
	const titles = input.findingTitles
		.slice(0, MAX_FINDING_TITLES)
		.map((field) => sanitizeLine(field.value, MAX_FINDING_TITLE_LENGTH))
		.filter((line): line is string => line !== null);
	const evidence = input.evidenceLines
		.slice(0, MAX_EVIDENCE_LINES)
		.map((line) => sanitizeLine(line, MAX_EVIDENCE_LINE_LENGTH))
		.filter((line): line is string => line !== null);
	return {
		campaignId: input.campaignId,
		runId: input.runId,
		prNumber: String(input.prNumber),
		findingTitles: renderBulletList(titles),
		evidenceLines: renderBulletList(evidence),
		reReviewCommand: reReviewCommand ?? "",
	};
}

/** Fill `{name}` placeholders; every name is validated at policy load. */
function renderTemplate(template: string, values: TemplateValueMap): string {
	return template.replace(/\{([A-Za-z]+)\}/g, (match, name: string) => {
		const value = values[name];
		return value === undefined ? match : value;
	});
}

/** Deterministic action key: one comment intent per campaign/work item/cycle. */
export function commentActionKey(
	campaignId: string,
	workItemId: string,
	cycleId: string,
): string {
	return `pr_comment:${campaignId}:${workItemId}:${cycleId}`;
}

/** One postComment attempt's machine-readable outcome. */
export type PostCommentOutcomeStatus =
	| "posted"
	| MutationExecuteOutcome["status"]
	| "already_commented_this_cycle"
	| "rate_capped"
	| "no_templates";

export interface PostCommentOutcome {
	readonly status: PostCommentOutcomeStatus;
	readonly commentId: number | null;
}

export interface PostCommentDeps {
	readonly store: CampaignStateStore;
	readonly poster: GithubCommentPosterTransport;
}

export interface PostCommentInput {
	readonly campaignId: string;
	readonly workItemId: string;
	/** Durable follow-up cycle id; the one-comment-per-cycle invariant key. */
	readonly cycleId: string;
	/** The validated repository policy whose digest binds the journal row. */
	readonly policy: RepositoryPolicy;
	readonly policyDigest: string;
	readonly compose: CommentComposeInput;
	/** Caller's pinned "now", so the daily cap is deterministic in tests. */
	readonly nowMs: number;
}

/**
 * Journal and post one finding-response comment for this follow-up cycle.
 * Never posts twice in a cycle, never over the daily cap, and never echoes
 * untrusted upstream comment content (the compose input carries structured
 * fields only — see the module header).
 */
export async function postFindingResponseComment(
	deps: PostCommentDeps,
	input: PostCommentInput,
): Promise<PostCommentOutcome> {
	const templates = input.policy.commentTemplates;
	if (templates === null) {
		return { status: "no_templates", commentId: null };
	}
	const actionKey = commentActionKey(input.campaignId, input.workItemId, input.cycleId);
	const existing = deps.store.actions.getActionByKey(actionKey);
	if (existing !== null && existing.state !== "planned") {
		// Terminal or mid-flight row on this cycle: one comment per cycle.
		return { status: "already_commented_this_cycle", commentId: null };
	}
	const capOutcome = enforceDailyCap(deps, input, templates);
	if (capOutcome !== null) return capOutcome;

	const body = composeFindingResponseComment(input.policy, input.compose);
	if (body === null) {
		return { status: "no_templates", commentId: null };
	}
	return await journalAndPost(deps, input, actionKey, body);
}

/**
 * Journal and post the profile-declared re-review command for this cycle.
 * Only after the preceding body update or push actually landed, and only
 * when the profile declares both comment templates and a bot grammar with
 * re-review commands.
 */
export async function postReReviewCommandComment(
	deps: PostCommentDeps,
	input: PostCommentInput,
	options: {
		readonly botGrammar: ReviewBotGrammar | null;
		readonly precedingChangeLanded: boolean;
	},
): Promise<PostCommentOutcome> {
	const templates = input.policy.commentTemplates;
	if (templates === null) {
		return { status: "no_templates", commentId: null };
	}
	const actionKey = commentActionKey(input.campaignId, input.workItemId, input.cycleId);
	const existing = deps.store.actions.getActionByKey(actionKey);
	if (existing !== null && existing.state !== "planned") {
		return { status: "already_commented_this_cycle", commentId: null };
	}
	const capOutcome = enforceDailyCap(deps, input, templates);
	if (capOutcome !== null) return capOutcome;

	const body = composeReReviewComment(input.policy, input.compose, options);
	if (body === null) {
		return { status: "no_templates", commentId: null };
	}
	return await journalAndPost(deps, input, actionKey, body);
}

/**
 * Per-day per-campaign comment cap (warren-09f3). Counts every
 * `pr_comment` intent journaled in the trailing 24h — including planned
 * rows, so a crash cannot spend the cap twice — and raises one attention
 * item per capped day when exceeded.
 */
function enforceDailyCap(
	deps: PostCommentDeps,
	input: PostCommentInput,
	templates: CommentTemplatesPolicy,
): PostCommentOutcome | null {
	const windowStartMs = input.nowMs - 24 * 60 * 60 * 1000;
	const recent = deps.store.actions
		.listActionsForCampaign(input.campaignId)
		.filter(
			(action) =>
				action.actionType === POST_COMMENT_ACTION_TYPE &&
				action.createdAtMs >= windowStartMs &&
				action.state !== "permanent_failure",
		).length;
	if (recent < templates.maxCommentsPerDay) return null;
	deps.store.events.addAttentionOnce({
		campaignId: input.campaignId,
		workItemId: input.workItemId,
		reason: COMMENT_RATE_CAPPED_REASON,
		detailJson: canonicalJson({ dayKey: dayKey(input.nowMs), campaignId: input.campaignId }),
	});
	return { status: "rate_capped", commentId: null };
}

/** UTC `YYYY-MM-DD` of the pinned "now" — a stable attention detail key. */
function dayKey(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 10);
}

/** Journal the intent and drive it through the shared mutation journal. */
async function journalAndPost(
	deps: PostCommentDeps,
	input: PostCommentInput,
	actionKey: string,
	body: string,
): Promise<PostCommentOutcome> {
	const intent: PostCommentIntent = renderPostCommentIntent({
		upstreamOwner: input.policy.upstream.owner,
		upstreamRepo: input.policy.upstream.repo,
		issueNumber: input.compose.prNumber,
		body,
	});
	// beginAction is idempotent on actionKey and fails closed on a digest
	// mismatch: a re-drive with the same composed body replans onto the same
	// row, and a different body for the same cycle can never slip through.
	const action = deps.store.actions.beginAction({
			actionKey,
			campaignId: input.campaignId,
			workItemId: input.workItemId,
			actionType: POST_COMMENT_ACTION_TYPE,
			requestDigest: mutationRequestDigest(intent),
			policyDigest: input.policyDigest,
		});
	let postedCommentId: number | null = null;
	const outcome = await executeJournaledMutation(
		deps.store,
		{
			campaignId: input.campaignId,
			action,
		},
		async () => {
			const posted = await deps.poster.postComment(intent);
			postedCommentId = posted.commentId;
			return {};
		},
	);
	if (outcome.status === "succeeded") {
		return { status: "posted", commentId: postedCommentId };
	}
	return { status: outcome.status, commentId: null };
}
