/**
 * Review-feedback classification over durable upstream source events
 * (plan pl-096b step warren-2ec3).
 *
 * Pure and deterministic: one normalized event plus a profile-declared bot
 * grammar in, zero or more classified feedback rows out. The output is the
 * sole input of the follow-up coordinator, so the untrusted-input
 * discipline here is absolute:
 *
 * - Only structured extracted fields cross this boundary: check names,
 *   conclusions, URLs, file paths, line numbers, finding titles, priorities,
 *   and author logins. Raw comment and review bodies never leave this
 *   module — they are matched against profile-declared markers, line
 *   grammars, and exact command strings, then discarded.
 * - Every extracted field is stamped `provenance: "untrusted"`: it names
 *   something an upstream actor wrote, and downstream consumers must treat
 *   it as inert data, never as an instruction. No comment can name or
 *   trigger a controller action; the only grammar-recognized action surface
 *   is `re_review_available`, whose command value comes from the profile,
 *   not from the comment.
 * - Recognition rules come from the profile (`ReviewBotGrammar`), not from
 *   code or from the events themselves.
 *
 * One event yields at most one feedback row per category; the row id is the
 * source event's durable key, so reclassification is a no-op.
 */

import {
	compileBotGrammar,
	MAX_CLASSIFIED_BODY_LENGTH,
	type ReviewBotGrammar,
} from "./bot-grammar.ts";
import type { GithubEventKind } from "./events.ts";

/** Every actionable category the classifier emits. */
export type FeedbackCategory =
	| "failing_check"
	| "changes_requested"
	| "review_bot_findings"
	| "maintainer_question"
	| "re_review_available"
	| "pr_merged"
	| "pr_closed";

/** Provenance stamps. Every upstream-derived value is untrusted. */
export type FieldProvenance = "untrusted" | "profile";

/** One extracted field value with its provenance stamp. */
export interface ClassifiedField {
	readonly value: unknown;
	readonly provenance: FieldProvenance;
}

/** One classified feedback row, keyed by its source event node id. */
export interface ClassifiedFeedback {
	/** The durable source-event key that produced this row. */
	readonly sourceEventNodeId: string;
	readonly category: FeedbackCategory;
	/** Structured fields only — never a raw comment or review body. */
	readonly fields: Record<string, ClassifiedField>;
}

/** Check-run conclusions that mean the branch is red. */
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/** Review states that mean a human requested changes. */
const CHANGES_REQUESTED_STATE = "CHANGES_REQUESTED";

/** Author associations that mark a maintainer-side account. */
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Mark a value as upstream-written and therefore inert. */
function untrusted(value: unknown): ClassifiedField {
	return { value, provenance: "untrusted" };
}

/**
 * A path-shaped string: no whitespace, control characters, or shell
 * metacharacters. A grammar capture that fails this shape is dropped —
 * a finding's `file` slot carries a file path or nothing, so prose can
 * never masquerade as one.
 */
function looksLikePath(value: string): boolean {
	if (value.length === 0 || value.length > 512) return false;
	for (const ch of value) {
		const code = ch.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return false;
		if (FORBIDDEN_PATH_CHARACTERS.has(ch)) return false;
	}
	return true;
}

/** Mark a value as coming from the profile itself, not from upstream text. */
function profile(value: unknown): ClassifiedField {
	return { value, provenance: "profile" };
}

/** Shrink comment text to a bounded slice before any pattern runs on it. */
function bounded(body: unknown): string | null {
	if (typeof body !== "string") return null;
	return body.length > MAX_CLASSIFIED_BODY_LENGTH
		? body.slice(0, MAX_CLASSIFIED_BODY_LENGTH)
		: body;
}

/**
 * Classify one normalized source event. `payload` is the parsed
 * `payloadJson` of the event. Returns zero or one feedback rows — one
 * event is one upstream fact, so it folds into at most one category.
 */
export function classifyEvent(
	eventKind: GithubEventKind,
	sourceEventNodeId: string,
	payload: unknown,
	grammar: ReviewBotGrammar,
): ClassifiedFeedback | null {
	if (typeof payload !== "object" || payload === null) return null;
	const record = payload as Record<string, unknown>;
	switch (eventKind) {
		case "check_run":
			return classifyCheckRun(sourceEventNodeId, record);
		case "combined_status":
			return classifyCombinedStatus(sourceEventNodeId, record);
		case "review":
			return classifyReview(sourceEventNodeId, record, grammar);
		case "issue_comment":
		case "review_comment":
			return classifyComment(sourceEventNodeId, record, grammar);
		case "pull_request":
			return classifyPullRequestState(sourceEventNodeId, record);
		case "policy_digest":
			return null;
	}
}

function classifyCheckRun(
	nodeId: string,
	payload: Record<string, unknown>,
): ClassifiedFeedback | null {
	const conclusion = payload.conclusion;
	if (typeof conclusion !== "string" || !FAILING_CONCLUSIONS.has(conclusion)) return null;
	return {
		sourceEventNodeId: nodeId,
		category: "failing_check",
		fields: {
			checkName: untrusted(payload.name ?? null),
			conclusion: untrusted(conclusion),
			url: untrusted(payload.htmlUrl ?? payload.detailsUrl ?? null),
		},
	};
}

function classifyCombinedStatus(
	nodeId: string,
	payload: Record<string, unknown>,
): ClassifiedFeedback | null {
	const state = payload.state;
	if (state !== "failure" && state !== "error") return null;
	return {
		sourceEventNodeId: nodeId,
		category: "failing_check",
		fields: {
			checkName: profile("combined_status"),
			conclusion: untrusted(state),
			url: untrusted(null),
		},
	};
}

function classifyReview(
	nodeId: string,
	payload: Record<string, unknown>,
	grammar: ReviewBotGrammar,
): ClassifiedFeedback | null {
	if (payload.state !== CHANGES_REQUESTED_STATE) return null;
	const author = payload.authorLogin;
	if (typeof author !== "string" || grammar.knownBotLogins.includes(author)) return null;
	return {
		sourceEventNodeId: nodeId,
		category: "changes_requested",
		fields: {
			authorLogin: untrusted(author),
			url: untrusted(payload.htmlUrl ?? null),
		},
	};
}

function classifyComment(
	nodeId: string,
	payload: Record<string, unknown>,
	grammar: ReviewBotGrammar,
): ClassifiedFeedback | null {
	const author = payload.authorLogin;
	if (typeof author !== "string") return null;
	const body = bounded(payload.body);
	if (body === null) return null;

	// Bot-authored output: recognize a durable finding list under the
	// profile-declared marker and extract structured findings only.
	if (grammar.knownBotLogins.includes(author)) {
		return classifyBotFindings(nodeId, author, body, grammar);
	}

	// Human comment: an exact, profile-declared command requests re-review.
	// The command value is copied from the grammar — the comment supplies
	// nothing downstream except its author and URL.
	const trimmed = body.trim();
	if (grammar.reReviewCommands.includes(trimmed)) {
		return {
			sourceEventNodeId: nodeId,
			category: "re_review_available",
			fields: {
				command: profile(trimmed),
				authorLogin: untrusted(author),
				url: untrusted(payload.htmlUrl ?? null),
			},
		};
	}

	// A maintainer-side question is attention-worthy; the body is not.
	if (MAINTAINER_ASSOCIATIONS.has(String(payload.authorAssociation ?? "")) && body.includes("?")) {
		return {
			sourceEventNodeId: nodeId,
			category: "maintainer_question",
			fields: {
				authorLogin: untrusted(author),
				url: untrusted(payload.htmlUrl ?? null),
			},
		};
	}
	return null;
}

/** Characters that never appear in a path-shaped extraction. */
const FORBIDDEN_PATH_CHARACTERS = new Set([
	" ",
	"\t",
	"&",
	";",
	"|",
	"`",
	"$",
	"(",
	")",
	"<",
	">",
	'"',
	"'",
	"\\",
]);

function classifyBotFindings(
	nodeId: string,
	author: string,
	body: string,
	grammar: ReviewBotGrammar,
): ClassifiedFeedback | null {
	if (!body.startsWith(grammar.findingMarker)) return null;
	const listText = body.slice(grammar.findingMarker.length);
	const pattern = compileBotGrammar(grammar);
	const findings = listText
		.split("\n")
		.map((line) => extractFinding(pattern, line))
		.filter((finding): finding is Record<string, ClassifiedField> => finding !== null);
	if (findings.length === 0) return null;
	return {
		sourceEventNodeId: nodeId,
		category: "review_bot_findings",
		fields: {
			authorLogin: untrusted(author),
			findings: untrusted(findings),
		},
	};
}

/** Extract one structured finding from a list line, or null. */
function extractFinding(pattern: RegExp, line: string): Record<string, ClassifiedField> | null {
	const match = pattern.exec(line);
	if (match === null || match.groups === undefined) return null;
	const groups = match.groups;
	const title = groups.title;
	if (title === undefined || title.trim().length === 0) return null;
	const finding: Record<string, ClassifiedField> = {
		title: untrusted(title.trim()),
	};
	if (groups.file !== undefined && looksLikePath(groups.file)) {
		finding.file = untrusted(groups.file);
	}
	const lineNo = groups.line === undefined ? Number.NaN : Number.parseInt(groups.line, 10);
	if (Number.isInteger(lineNo)) finding.line = untrusted(lineNo);
	if (groups.priority !== undefined && groups.priority.length > 0) {
		finding.priority = untrusted(groups.priority.trim());
	}
	return finding;
}

function classifyPullRequestState(
	nodeId: string,
	payload: Record<string, unknown>,
): ClassifiedFeedback | null {
	if (typeof payload.mergedAt === "string") {
		return {
			sourceEventNodeId: nodeId,
			category: "pr_merged",
			fields: {
				prNumber: untrusted(payload.number ?? null),
				mergedAt: untrusted(payload.mergedAt),
			},
		};
	}
	if (typeof payload.closedAt === "string" && payload.state === "closed") {
		return {
			sourceEventNodeId: nodeId,
			category: "pr_closed",
			fields: {
				prNumber: untrusted(payload.number ?? null),
				closedAt: untrusted(payload.closedAt),
			},
		};
	}
	return null;
}

/**
 * Classify a batch of stored events. Rows are deduplicated by their
 * classification id (source event node id + category) — identical
 * reclassification is a no-op.
 */
export function classifyEvents(
	events: ReadonlyArray<{ eventKind: GithubEventKind; key: string; payloadJson: string }>,
	grammar: ReviewBotGrammar,
): ClassifiedFeedback[] {
	const rows: ClassifiedFeedback[] = [];
	const seen = new Set<string>();
	for (const event of events) {
		let payload: unknown;
		try {
			payload = JSON.parse(event.payloadJson);
		} catch {
			continue;
		}
		const row = classifyEvent(event.eventKind, event.key, payload, grammar);
		if (row === null) continue;
		const id = feedbackRowId(row);
		if (seen.has(id)) continue;
		seen.add(id);
		rows.push(row);
	}
	return rows;
}

/** Durable dedupe id: source event node id plus category. */
export function feedbackRowId(
	row: Pick<ClassifiedFeedback, "sourceEventNodeId" | "category">,
): string {
	return `${row.sourceEventNodeId}|${row.category}`;
}
