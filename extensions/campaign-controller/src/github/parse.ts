/**
 * Narrowing parsers: raw GitHub JSON in, controller snapshots out
 * (warren-33aa, plan pl-91b6 risk 5).
 *
 * Every parser copies exactly the declared fields. Unknown upstream fields
 * are dropped, missing required fields fail as ValidationError, and no
 * parser ever returns the raw object — so an untrusted payload cannot
 * smuggle extra shape into controller state.
 */

import { ValidationError } from "../errors.ts";
import type {
	GithubCheckRunSnapshot,
	GithubCombinedStatusSnapshot,
	GithubContentSnapshot,
	GithubIssueCommentSnapshot,
	GithubIssueSnapshot,
	GithubNotificationSnapshot,
	GithubPullRequestSnapshot,
	GithubRepoSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
} from "./types.ts";

type Raw = Record<string, unknown>;

function requiredString(obj: Raw, key: string): string {
	const value = obj[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new ValidationError(`GitHub payload field "${key}" is missing or not a string`);
	}
	return value;
}

function optionalString(obj: Raw, key: string): string | null {
	const value = obj[key];
	return typeof value === "string" ? value : null;
}

function requiredNumber(obj: Raw, key: string): number {
	const value = obj[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ValidationError(`GitHub payload field "${key}" is missing or not a number`);
	}
	return value;
}

function requiredBoolean(obj: Raw, key: string): boolean {
	const value = obj[key];
	if (typeof value !== "boolean") {
		throw new ValidationError(`GitHub payload field "${key}" is missing or not a boolean`);
	}
	return value;
}

function requiredObject(obj: Raw, key: string): Raw {
	const value = obj[key];
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`GitHub payload field "${key}" is missing or not an object`);
	}
	return value as Raw;
}

function requiredArray(obj: Raw, key: string): unknown[] {
	const value = obj[key];
	if (!Array.isArray(value)) {
		throw new ValidationError(`GitHub payload field "${key}" is missing or not an array`);
	}
	return value;
}

function loginOf(obj: Raw, key = "user"): string {
	return requiredString(requiredObject(obj, key), "login");
}

/** Parse raw JSON text into an unknown object; fails as ValidationError. */
export function parseJsonObject(body: string, what: string): Raw {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (cause) {
		throw new ValidationError(`GitHub ${what} response is not valid JSON`, { cause });
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError(`GitHub ${what} response is not a JSON object`);
	}
	return parsed as Raw;
}

function parseJsonObjectOrEmpty(body: string, what: string): Raw {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return {};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError(`GitHub ${what} response is not a JSON object`);
	}
	return parsed as Raw;
}

/** Parse a JSON array body; empty object (GitHub 403/404 shapes) yields []. */
function parseItems(body: string): Raw[] {
	const parsed: unknown = JSON.parse(body);
	if (Array.isArray(parsed)) {
		return parsed as Raw[];
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new ValidationError("GitHub collection response is not a JSON array");
	}
	return [];
}

export function parseRepo(raw: Raw): GithubRepoSnapshot {
	return {
		nodeId: requiredString(raw, "node_id"),
		name: requiredString(raw, "name"),
		fullName: requiredString(raw, "full_name"),
		ownerLogin: requiredString(requiredObject(raw, "owner"), "login"),
		defaultBranch: requiredString(raw, "default_branch"),
		isFork: requiredBoolean(raw, "fork"),
		isArchived: requiredBoolean(raw, "archived"),
		pushedAt: optionalString(raw, "pushed_at"),
		htmlUrl: requiredString(raw, "html_url"),
	};
}

export function parseContent(raw: Raw): GithubContentSnapshot {
	const encoding = requiredString(raw, "encoding");
	const encoded = optionalString(raw, "content");
	let text = "";
	if (encoded !== null) {
		text = encoding === "base64" ? decodeBase64Utf8(encoded) : encoded;
	}
	return {
		path: requiredString(raw, "path"),
		encoding,
		text,
	};
}

function decodeBase64Utf8(encoded: string): string {
	const cleaned = encoded.replace(/\s/g, "");
	const bytes = Uint8Array.from(atob(cleaned), (ch) => ch.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

function parseIssue(raw: Raw): GithubIssueSnapshot {
	return {
		nodeId: requiredString(raw, "node_id"),
		number: requiredNumber(raw, "number"),
		state: requiredString(raw, "state"),
		title: requiredString(raw, "title"),
		authorLogin: loginOf(raw),
		labels: requiredArray(raw, "labels")
			.map((label) =>
				typeof label === "object" && label !== null ? optionalString(label as Raw, "name") : null,
			)
			.filter((name): name is string => name !== null),
		createdAt: requiredString(raw, "created_at"),
		updatedAt: requiredString(raw, "updated_at"),
		closedAt: optionalString(raw, "closed_at"),
		htmlUrl: requiredString(raw, "html_url"),
	};
}

function parsePullRequest(raw: Raw): GithubPullRequestSnapshot {
	const head = requiredObject(raw, "head");
	const base = requiredObject(raw, "base");
	return {
		nodeId: requiredString(raw, "node_id"),
		number: requiredNumber(raw, "number"),
		state: requiredString(raw, "state"),
		draft: requiredBoolean(raw, "draft"),
		title: requiredString(raw, "title"),
		body: optionalString(raw, "body"),
		authorLogin: loginOf(raw),
		headRef: requiredString(head, "ref"),
		headSha: requiredString(head, "sha"),
		headRepoFullName: requiredString(requiredObject(head, "repo"), "full_name"),
		baseRef: requiredString(base, "ref"),
		baseSha: requiredString(base, "sha"),
		baseRepoFullName: requiredString(requiredObject(base, "repo"), "full_name"),
		mergedAt: optionalString(raw, "merged_at"),
		closedAt: optionalString(raw, "closed_at"),
		createdAt: requiredString(raw, "created_at"),
		updatedAt: requiredString(raw, "updated_at"),
		htmlUrl: requiredString(raw, "html_url"),
		mergeableState: optionalString(raw, "mergeable_state"),
	};
}

function parseNotification(raw: Raw): GithubNotificationSnapshot {
	const subject = requiredObject(raw, "subject");
	const repository = requiredObject(raw, "repository");
	return {
		nodeId: requiredString(raw, "id"),
		reason: requiredString(raw, "reason"),
		updatedAt: requiredString(raw, "updated_at"),
		subjectType: requiredString(subject, "type"),
		subjectTitle: requiredString(subject, "title"),
		subjectUrl: requiredString(subject, "url"),
		repositoryFullName: requiredString(repository, "full_name"),
	};
}

function parseIssueComment(raw: Raw): GithubIssueCommentSnapshot {
	return {
		nodeId: requiredString(raw, "node_id"),
		id: requiredNumber(raw, "id"),
		authorLogin: loginOf(raw),
		authorAssociation: optionalString(raw, "author_association") ?? "NONE",
		body: requiredString(raw, "body"),
		createdAt: requiredString(raw, "created_at"),
		updatedAt: requiredString(raw, "updated_at"),
		htmlUrl: requiredString(raw, "html_url"),
	};
}

function parseReview(raw: Raw): GithubReviewSnapshot {
	return {
		nodeId: requiredString(raw, "node_id"),
		id: requiredNumber(raw, "id"),
		authorLogin: loginOf(raw),
		authorAssociation: optionalString(raw, "author_association") ?? "NONE",
		state: requiredString(raw, "state"),
		body: optionalString(raw, "body") ?? "",
		submittedAt: optionalString(raw, "submitted_at"),
		commitId: optionalString(raw, "commit_id"),
		htmlUrl: requiredString(raw, "html_url"),
	};
}

function parseReviewComment(raw: Raw): GithubReviewCommentSnapshot {
	return {
		nodeId: requiredString(raw, "node_id"),
		id: requiredNumber(raw, "id"),
		authorLogin: loginOf(raw),
		authorAssociation: optionalString(raw, "author_association") ?? "NONE",
		body: requiredString(raw, "body"),
		createdAt: requiredString(raw, "created_at"),
		updatedAt: requiredString(raw, "updated_at"),
		htmlUrl: requiredString(raw, "html_url"),
	};
}

function parseCheckRun(raw: Raw): GithubCheckRunSnapshot {
	return {
		nodeId: requiredString(raw, "node_id"),
		id: requiredNumber(raw, "id"),
		name: requiredString(raw, "name"),
		status: requiredString(raw, "status"),
		conclusion: optionalString(raw, "conclusion"),
		startedAt: optionalString(raw, "started_at"),
		completedAt: optionalString(raw, "completed_at"),
		detailsUrl: optionalString(raw, "details_url"),
		htmlUrl: requiredString(raw, "html_url"),
	};
}

function parseCombinedStatus(raw: Raw): GithubCombinedStatusSnapshot {
	return {
		state: requiredString(raw, "state"),
		totalCount: requiredNumber(raw, "total_count"),
		sha: requiredString(raw, "sha"),
		contexts: requiredArray(raw, "statuses").map((status) => {
			const entry = status as Record<string, unknown>;
			return {
				context: requiredString(entry, "context"),
				state: requiredString(entry, "state"),
				description: optionalString(entry, "description"),
			};
		}),
	};
}

/** Parse the check-runs envelope (`{ total_count, check_runs: [...] }`). */
export function parseCheckRunCollection(raw: Record<string, unknown>): GithubCheckRunSnapshot[] {
	return requiredArray(raw, "check_runs").map((entry) =>
		parseCheckRun(entry as Record<string, unknown>),
	);
}

/** Exported parse surface used by the client's generic readers. */
export const parsers = {
	repo: parseRepo,
	content: parseContent,
	issue: parseIssue,
	pullRequest: parsePullRequest,
	notification: parseNotification,
	issueComment: parseIssueComment,
	review: parseReview,
	reviewComment: parseReviewComment,
	checkRun: parseCheckRun,
	combinedStatus: parseCombinedStatus,
};

/** Parse a collection body into narrowed items via a per-item parser. */
export function parseCollection<T>(body: string, parseItem: (raw: Raw) => T): T[] {
	return parseItems(body).map(parseItem);
}

/** Best-effort message extraction from an error body (never throws). */
export function errorMessage(body: string | null): string | null {
	if (body === null) {
		return null;
	}
	try {
		return optionalString(parseJsonObjectOrEmpty(body, "error"), "message");
	} catch {
		return null;
	}
}
