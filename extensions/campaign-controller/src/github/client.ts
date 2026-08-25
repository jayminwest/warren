/**
 * The structurally read-only GitHub client (warren-33aa).
 *
 * Every public method is a GET or HEAD read. The class has no method that
 * can create, update, or delete anything on GitHub — dry-run is a
 * structural capability limit (plan pl-91b6 §4.5), not a flag. Reads use
 * conditional validators (ETag / If-Modified-Since) so a poll loop costs
 * nothing when upstream state is unchanged, and paginated reads are
 * bounded so one hostile collection cannot loop forever.
 *
 * Responses are narrowed through `parse.ts`; the raw payload never
 * escapes. Non-2xx failures raise `GithubApiError` (redacted) and
 * rate-limit refusals raise `GithubRateLimitError` with the wait facts.
 */

import { GithubApiError, GithubRateLimitError } from "./errors.ts";
import {
	errorMessage,
	parseCheckRunCollection,
	parseCollection,
	parseJsonObject,
	parsers,
} from "./parse.ts";
import type {
	GithubCheckRunSnapshot,
	GithubCombinedStatusSnapshot,
	GithubConditionalHeaders,
	GithubContentSnapshot,
	GithubIssueCommentSnapshot,
	GithubIssueSnapshot,
	GithubNotificationSnapshot,
	GithubPageResult,
	GithubPullRequestSnapshot,
	GithubRateSnapshot,
	GithubReadResult,
	GithubRepoSnapshot,
	GithubReviewCommentSnapshot,
	GithubReviewSnapshot,
	GithubTransport,
} from "./types.ts";

export interface ReadOnlyGithubClientOptions {
	/** Maximum pages fetched per paginated read (default 10). */
	maxPages?: number;
	/** Page size requested per paginated read, 1..100 (default 100). */
	perPage?: number;
}

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_PER_PAGE = 100;

export class ReadOnlyGithubClient {
	private readonly transport: GithubTransport;
	private readonly maxPages: number;
	private readonly perPage: number;

	constructor(transport: GithubTransport, options: ReadOnlyGithubClientOptions = {}) {
		this.transport = transport;
		this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
		this.perPage = Math.min(Math.max(options.perPage ?? DEFAULT_PER_PAGE, 1), 100);
	}

	/** Repository metadata for the upstream or fork repository. */
	async getRepository(
		owner: string,
		repo: string,
		conditional?: GithubConditionalHeaders,
	): Promise<GithubReadResult<GithubRepoSnapshot>> {
		return this.readOne(`/repos/${owner}/${repo}`, conditional, parsers.repo);
	}

	/** Repository file content (CONTRIBUTING and friends), base64-decoded. */
	async getContent(
		owner: string,
		repo: string,
		path: string,
		conditional?: GithubConditionalHeaders,
	): Promise<GithubReadResult<GithubContentSnapshot>> {
		return this.readOne(`/repos/${owner}/${repo}/contents/${path}`, conditional, parsers.content);
	}

	/** One issue. */
	async getIssue(
		owner: string,
		repo: string,
		issueNumber: number,
		conditional?: GithubConditionalHeaders,
	): Promise<GithubReadResult<GithubIssueSnapshot>> {
		return this.readOne(
			`/repos/${owner}/${repo}/issues/${issueNumber}`,
			conditional,
			parsers.issue,
		);
	}

	/** All issues (optionally filtered by state), bounded pagination. */
	async listIssues(
		owner: string,
		repo: string,
		options: { state?: "open" | "closed" | "all" } & GithubConditionalHeaders = {},
	): Promise<GithubPageResult<GithubIssueSnapshot>> {
		const params: Record<string, string> = {};
		if (options.state !== undefined) {
			params.state = options.state;
		}
		return this.readMany(`/repos/${owner}/${repo}/issues`, params, options, parsers.issue);
	}

	/** One pull request (upstream or fork). */
	async getPullRequest(
		owner: string,
		repo: string,
		pullNumber: number,
		conditional?: GithubConditionalHeaders,
	): Promise<GithubReadResult<GithubPullRequestSnapshot>> {
		return this.readOne(
			`/repos/${owner}/${repo}/pulls/${pullNumber}`,
			conditional,
			parsers.pullRequest,
		);
	}

	/** Open pull requests, bounded pagination. */
	async listPullRequests(
		owner: string,
		repo: string,
		conditional?: GithubConditionalHeaders,
	): Promise<GithubPageResult<GithubPullRequestSnapshot>> {
		return this.readMany(`/repos/${owner}/${repo}/pulls`, {}, conditional, parsers.pullRequest);
	}

	/**
	 * Participating notifications — wake-ups only, never commands
	 * (plan risk 3). Each must lead to an authoritative re-read.
	 */
	async listNotifications(
		options: { participating?: boolean; since?: string } & GithubConditionalHeaders = {},
	): Promise<GithubPageResult<GithubNotificationSnapshot>> {
		const params: Record<string, string> = {};
		if (options.participating === true) {
			params.participating = "true";
		}
		if (options.since !== undefined) {
			params.since = options.since;
		}
		return this.readMany("/notifications", params, options, parsers.notification);
	}

	/** Issue comments on one issue or pull request. */
	async listIssueComments(
		owner: string,
		repo: string,
		issueNumber: number,
		conditional?: GithubConditionalHeaders,
	): Promise<GithubPageResult<GithubIssueCommentSnapshot>> {
		return this.readMany(
			`/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
			{},
			conditional,
			parsers.issueComment,
		);
	}

	/** Submitted reviews on one pull request. */
	async listReviews(
		owner: string,
		repo: string,
		pullNumber: number,
		conditional?: GithubConditionalHeaders,
	): Promise<GithubPageResult<GithubReviewSnapshot>> {
		return this.readMany(
			`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
			{},
			conditional,
			parsers.review,
		);
	}

	/** Review (code) comments on one pull request. */
	async listReviewComments(
		owner: string,
		repo: string,
		pullNumber: number,
		conditional?: GithubConditionalHeaders,
	): Promise<GithubPageResult<GithubReviewCommentSnapshot>> {
		return this.readMany(
			`/repos/${owner}/${repo}/pulls/${pullNumber}/comments`,
			{},
			conditional,
			parsers.reviewComment,
		);
	}

	/** Check runs for one ref (commit sha or branch). */
	async listCheckRunsForRef(
		owner: string,
		repo: string,
		ref: string,
		conditional?: GithubConditionalHeaders,
	): Promise<GithubReadResult<GithubCheckRunSnapshot[]>> {
		return this.readOne(
			`/repos/${owner}/${repo}/commits/${ref}/check-runs`,
			conditional,
			parseCheckRunCollection,
		);
	}

	/** Combined commit status for one ref. */
	async getCombinedStatus(
		owner: string,
		repo: string,
		ref: string,
		conditional?: GithubConditionalHeaders,
	): Promise<GithubReadResult<GithubCombinedStatusSnapshot>> {
		return this.readOne(
			`/repos/${owner}/${repo}/commits/${ref}/status`,
			conditional,
			parsers.combinedStatus,
		);
	}

	/**
	 * A read-only HEAD probe: existence plus validators, no body. Lets the
	 * poll loop check a resource's version before paying for a GET.
	 */
	async probeHead(
		path: string,
		conditional?: GithubConditionalHeaders,
	): Promise<{
		status: number;
		etag: string | null;
		lastModified: string | null;
		rate: GithubRateSnapshot;
	}> {
		const response = await this.transport.read({
			method: "HEAD",
			path,
			headers: conditionalHeaders(conditional),
		});
		if (response.status === 304) {
			return {
				status: 304,
				etag: header(response, "etag"),
				lastModified: header(response, "last-modified"),
				rate: rateSnapshot(response.headers),
			};
		}
		if (response.status < 200 || response.status >= 300) {
			throw toGithubError(response, path);
		}
		return {
			status: response.status,
			etag: header(response, "etag"),
			lastModified: header(response, "last-modified"),
			rate: rateSnapshot(response.headers),
		};
	}

	/** One conditional GET, parsed and narrowed. */
	private async readOne<T>(
		path: string,
		conditional: GithubConditionalHeaders | undefined,
		parse: (raw: Record<string, unknown>) => T,
	): Promise<GithubReadResult<T>> {
		const response = await this.transport.read({
			method: "GET",
			path,
			headers: conditionalHeaders(conditional),
		});
		const etag = header(response, "etag");
		const lastModified = header(response, "last-modified");
		const rate = rateSnapshot(response.headers);
		if (response.status === 304) {
			return { notModified: true, etag, lastModified, rate };
		}
		if (response.status < 200 || response.status >= 300) {
			throw toGithubError(response, path);
		}
		return {
			notModified: false,
			etag,
			lastModified,
			rate,
			data: parse(parseJsonObject(response.body ?? "{}", "resource")),
		};
	}

	/** One bounded conditional paginated read. */
	private async readMany<T>(
		path: string,
		params: Record<string, string>,
		conditional: GithubConditionalHeaders | undefined,
		parseItem: (raw: Record<string, unknown>) => T,
	): Promise<GithubPageResult<T>> {
		const items: T[] = [];
		let etag: string | null = null;
		let lastModified: string | null = null;
		let rate: GithubRateSnapshot = { limit: null, remaining: null, resetEpochSeconds: null };
		for (let page = 1; page <= this.maxPages; page += 1) {
			const query = new URLSearchParams({
				...params,
				page: String(page),
				per_page: String(this.perPage),
			});
			const response = await this.transport.read({
				method: "GET",
				path: `${path}?${query.toString()}`,
				headers: conditionalHeaders(page === 1 ? conditional : undefined),
			});
			etag = header(response, "etag");
			lastModified = header(response, "last-modified");
			rate = rateSnapshot(response.headers);
			if (response.status === 304) {
				return { items, truncated: false, notModified: true, etag, lastModified, rate };
			}
			if (response.status < 200 || response.status >= 300) {
				throw toGithubError(response, path);
			}
			const pageItems = parseCollection(response.body ?? "[]", parseItem);
			items.push(...pageItems);
			if (pageItems.length < this.perPage) {
				return { items, truncated: false, notModified: false, etag, lastModified, rate };
			}
		}
		return { items, truncated: true, notModified: false, etag, lastModified, rate };
	}
}

function conditionalHeaders(
	conditional: GithubConditionalHeaders | undefined,
): Record<string, string> | undefined {
	if (conditional === undefined) {
		return undefined;
	}
	const headers: Record<string, string> = {};
	if (conditional.etag !== undefined) {
		headers["if-none-match"] = conditional.etag;
	}
	if (conditional.lastModified !== undefined) {
		headers["if-modified-since"] = conditional.lastModified;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function header(response: { headers: Record<string, string> }, name: string): string | null {
	return response.headers[name] ?? null;
}

function rateSnapshot(headers: Record<string, string>): GithubRateSnapshot {
	return {
		limit: intOrNull(headers["x-ratelimit-limit"]),
		remaining: intOrNull(headers["x-ratelimit-remaining"]),
		resetEpochSeconds: intOrNull(headers["x-ratelimit-reset"]),
	};
}

function intOrNull(raw: string | undefined): number | null {
	if (raw === undefined) {
		return null;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Map a non-2xx response onto the typed error hierarchy. */
function toGithubError(
	response: { status: number; headers: Record<string, string>; body: string | null },
	path: string,
): GithubApiError | GithubRateLimitError {
	const remaining = intOrNull(response.headers["x-ratelimit-remaining"]);
	const retryAfter = intOrNull(response.headers["retry-after"]);
	const message = errorMessage(response.body) ?? `GitHub responded ${response.status} for ${path}`;
	if (response.status === 403 || response.status === 429) {
		const bodyText = response.body ?? "";
		if (remaining === 0) {
			return new GithubRateLimitError(message, {
				kind: "primary",
				path,
				limit: intOrNull(response.headers["x-ratelimit-limit"]),
				remaining,
				resetEpochSeconds: intOrNull(response.headers["x-ratelimit-reset"]),
			});
		}
		if (retryAfter !== null || bodyText.includes("abuse detection")) {
			return new GithubRateLimitError(message, {
				kind: "secondary",
				path,
				retryAfterSeconds: retryAfter,
			});
		}
	}
	return new GithubApiError(message, { status: response.status, path });
}
