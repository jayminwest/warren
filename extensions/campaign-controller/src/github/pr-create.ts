/**
 * The single GitHub mutation: cross-fork pull-request creation
 * (Phase 2, warren-84da; design record §7.1 / §15 Phase 2).
 *
 * This is deliberately NOT a method on the read-only transport. The
 * creator is a separate class that can only be constructed from a
 * validated repository policy whose `mutations.createPullRequest` flag is
 * true — a dry-run policy makes the mutation structurally absent, exactly
 * as V0 shipped it. The one operation it exposes takes the frozen,
 * journaled `CrossForkPullRequestIntent` verbatim and refuses anything
 * whose URL is not that policy's upstream `/pulls` collection, so even a
 * corrupted journal row cannot aim the credential at another repository.
 *
 * Response-loss discipline mirrors the warren dispatcher: the caller
 * journals `executing` before the POST, and a transport failure after the
 * request may have been sent surfaces as `GithubPrCreateUncertainError` —
 * the caller settles `uncertain` and NEVER re-POSTs (a duplicate create
 * is a duplicate upstream PR, unrecoverable noise for the maintainers).
 */

import { BoundaryError, ValidationError } from "../errors.ts";
import type { RepositoryPolicy } from "../repository-policy.ts";
import { GithubApiError } from "./errors.ts";
import type { FetchLike } from "./http-transport.ts";
import type { CrossForkPullRequestIntent } from "./pr-request.ts";
import { AUTHORIZATION_HEADER, redactHeaders } from "./redact.ts";

/** The transport seam the execute stage consumes; the fake implements it too. */
export interface GithubPrCreateTransport {
	createPullRequest(intent: CrossForkPullRequestIntent): Promise<GithubPrCreateResult>;
}

/** The narrowed facts a successful (or recovered) create returns. */
export interface GithubPrCreateResult {
	prNumber: number;
	prUrl: string;
	/** GitHub's stable node id for dedupe against the event store. */
	nodeId: string | null;
}

/** The POST may or may not have reached GitHub; the caller must not retry. */
export class GithubPrCreateUncertainError extends GithubApiError {
	constructor(
		message: string,
		options: { path: string; requestHeaders?: Record<string, string>; cause?: unknown },
	) {
		super(message, options);
		this.name = "GithubPrCreateUncertainError";
	}
}

/** GitHub answered 422 "already exists" for this head/base pair. */
export class GithubPrAlreadyExistsError extends GithubApiError {
	constructor(message: string, path: string) {
		super(message, { path, status: 422 });
		this.name = "GithubPrAlreadyExistsError";
	}
}

export interface BunFetchGithubPrCreatorOptions {
	/** The validated repository policy; the flag gate reads it, not config. */
	policy: RepositoryPolicy;
	/** API base, default `https://api.github.com`. */
	baseUrl?: string;
	/** Bearer token; required — an anonymous create is never attempted. */
	token: string;
	/** Injectable fetch for tests. Defaults to the global fetch. */
	fetchImpl?: FetchLike;
	/** User agent; GitHub requires one. */
	userAgent?: string;
}

export class BunFetchGithubPrCreator implements GithubPrCreateTransport {
	private readonly policy: RepositoryPolicy;
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly fetchImpl: FetchLike;
	private readonly userAgent: string;

	constructor(options: BunFetchGithubPrCreatorOptions) {
		if (options.policy.mutations.createPullRequest !== true) {
			throw new BoundaryError(
				"refusing to construct the PR creator: the repository policy does not enable mutations.createPullRequest",
			);
		}
		if (typeof options.token !== "string" || options.token.length === 0) {
			throw new BoundaryError(
				"refusing to construct the PR creator: a GitHub credential is required for a live create",
			);
		}
		this.policy = options.policy;
		this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
		this.token = options.token;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.userAgent = options.userAgent ?? "warren-campaign-controller";
	}

	/** POST the journaled intent, verbatim, to the policy-bound upstream. */
	async createPullRequest(intent: CrossForkPullRequestIntent): Promise<GithubPrCreateResult> {
		assertIntentTargetsPolicyUpstream(intent, this.policy);
		const headers: Record<string, string> = {
			accept: "application/vnd.github+json",
			"content-type": "application/json",
			"user-agent": this.userAgent,
			[AUTHORIZATION_HEADER]: `Bearer ${this.token}`,
		};
		const url = `${this.baseUrl}${intent.url}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(intent.body),
				redirect: "manual",
			});
		} catch (cause) {
			// The request may have been sent before the transport failed:
			// the outcome is UNKNOWN and the caller must never re-POST.
			throw new GithubPrCreateUncertainError(
				`PR create outcome unknown for ${intent.url}: transport failed after the request may have been sent`,
				{ path: intent.url, requestHeaders: redactHeaders(headers, this.token), cause },
			);
		}
		const text = await response.text();
		if (response.status === 422 && /already exists/i.test(text)) {
			throw new GithubPrAlreadyExistsError(
				`GitHub reports a pull request already exists for head ${intent.body.head} — recover it through a read, never a second POST`,
				intent.url,
			);
		}
		if (response.status !== 201) {
			throw new GithubApiError(`PR create failed with HTTP ${response.status} for ${intent.url}`, {
				status: response.status,
				path: intent.url,
				requestHeaders: redactHeaders(headers, this.token),
			});
		}
		return parseCreatedPr(text, intent);
	}
}

/** The intent may only aim at the policy upstream's `/pulls` collection. */
export function assertIntentTargetsPolicyUpstream(
	intent: CrossForkPullRequestIntent,
	policy: RepositoryPolicy,
): void {
	const expected = `/repos/${policy.upstream.owner}/${policy.upstream.repo}/pulls`;
	if (intent.method !== "POST" || intent.url !== expected) {
		throw new BoundaryError(
			`refusing PR create: intent targets '${intent.method} ${intent.url}', policy binds '${expected}'`,
		);
	}
}

function parseCreatedPr(text: string, intent: CrossForkPullRequestIntent): GithubPrCreateResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (cause) {
		throw new ValidationError(`PR create returned unparseable JSON for ${intent.url}`, { cause });
	}
	if (typeof raw !== "object" || raw === null) {
		throw new ValidationError(`PR create returned a non-object body for ${intent.url}`);
	}
	const row = raw as Record<string, unknown>;
	if (typeof row.number !== "number" || !Number.isInteger(row.number) || row.number < 1) {
		throw new ValidationError(`PR create response has no integer 'number' for ${intent.url}`);
	}
	const prUrl = typeof row.html_url === "string" && row.html_url.length > 0 ? row.html_url : null;
	if (prUrl === null) {
		throw new ValidationError(`PR create response has no 'html_url' for ${intent.url}`);
	}
	return {
		prNumber: row.number,
		prUrl,
		nodeId: typeof row.node_id === "string" && row.node_id.length > 0 ? row.node_id : null,
	};
}
