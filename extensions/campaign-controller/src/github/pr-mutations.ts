/**
 * Phase-3 GitHub mutation transports (warren-094b; design record §7.1).
 *
 * Like `pr-create.ts`, these are deliberately NOT methods on the read-only
 * transport. Each mutation is its own class that can only be constructed
 * from a validated repository policy whose individual flag is `true` — a
 * policy that disables a mutation leaves *no object with that method to
 * call*, so the enforced-by-absence property holds per mutation, not per
 * posture.
 *
 * Journal contract (identical to `pr_execute`): the caller journals the
 * intent `planned` with the canonical request digest before any I/O, marks
 * `executing` immediately before the request, and settles through the
 * shared mutation journal in `src/pr-execute/mutation-journal.ts`. A
 * transport failure after the request may have been sent surfaces as
 * `GithubMutationUncertainError` — the caller settles `uncertain` and never
 * re-sends blind, because a replayed PATCH/POST/PUT/push is duplicate
 * upstream noise the maintainers see.
 *
 * Every intent is verified against the policy's upstream coordinates before
 * the credential is used, so even a corrupted journal row cannot aim a
 * mutation at another repository. `followUpPush` is fork-side (a git push
 * to an existing PR head branch), but it is policy-gated the same way and
 * verified against the policy's repo coordinates.
 */

import { BoundaryError, ValidationError } from "../errors.ts";
import type { RepositoryPolicy } from "../repository-policy.ts";
import { GithubApiError } from "./errors.ts";
import type { FetchLike } from "./http-transport.ts";
import { AUTHORIZATION_HEADER, redactHeaders } from "./redact.ts";

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/** PATCH an existing upstream pull request's title and/or body. */
export interface UpdatePullRequestIntent {
	method: "PATCH";
	/** `/repos/{owner}/{repo}/pulls/{number}`, policy upstream only. */
	url: string;
	body: Readonly<{ title?: string; body?: string }>;
}

/** POST a comment on an upstream issue or pull request. */
export interface PostCommentIntent {
	method: "POST";
	/** `/repos/{owner}/{repo}/issues/{number}/comments`, policy upstream only. */
	url: string;
	body: Readonly<{ body: string }>;
}

/** Ask GitHub to merge the base branch into an existing PR's head. */
export interface UpdateBranchIntent {
	method: "PUT";
	/** `/repos/{owner}/{repo}/pulls/{number}/update-branch`, policy upstream only. */
	url: string;
	body: Readonly<{ update_method: "merge" }>;
}

/**
 * Push follow-up commits to an existing PR's head branch on the bot-owned
 * fork. Not a GitHub REST call — `url` is the fork's push URL, verified
 * against the policy's upstream coordinates (a fork of the same repo).
 */
export interface FollowUpPushIntent {
	method: "GIT_PUSH";
	/** `https://github.com/{forkOwner}/{forkRepo}.git` for the policy's repo. */
	url: string;
	body: Readonly<{ forkOwner: string; forkRepo: string; headBranch: string; refspec: string }>;
}

/** Any journaled phase-3 mutation intent. */
export type MutationIntent =
	| UpdatePullRequestIntent
	| PostCommentIntent
	| UpdateBranchIntent
	| FollowUpPushIntent;

interface RenderInput {
	upstreamOwner: string;
	upstreamRepo: string;
}

/** PATCH intent for one policy-upstream pull request. At least one field. */
export function renderUpdatePullRequestIntent(
	input: RenderInput & { prNumber: number; title?: string; body?: string },
): UpdatePullRequestIntent {
	requirePositiveInt(input.prNumber, "prNumber");
	const body: { title?: string; body?: string } = {};
	if (input.title !== undefined) {
		requireNonEmpty(input.title, "title");
		body.title = input.title;
	}
	if (input.body !== undefined) {
		requireNonEmpty(input.body, "body");
		body.body = input.body;
	}
	if (body.title === undefined && body.body === undefined) {
		throw new ValidationError("updatePullRequest intent needs a title or a body to change");
	}
	return deepFreeze({
		method: "PATCH" as const,
		url: `/repos/${input.upstreamOwner}/${input.upstreamRepo}/pulls/${input.prNumber}`,
		body: deepFreeze(body),
	});
}

/** POST-comment intent for one policy-upstream issue or pull request. */
export function renderPostCommentIntent(
	input: RenderInput & { issueNumber: number; body: string },
): PostCommentIntent {
	requirePositiveInt(input.issueNumber, "issueNumber");
	requireNonEmpty(input.body, "body");
	return deepFreeze({
		method: "POST" as const,
		url: `/repos/${input.upstreamOwner}/${input.upstreamRepo}/issues/${input.issueNumber}/comments`,
		body: deepFreeze({ body: input.body }),
	});
}

/** Update-branch intent for one policy-upstream pull request. */
export function renderUpdateBranchIntent(
	input: RenderInput & { prNumber: number },
): UpdateBranchIntent {
	requirePositiveInt(input.prNumber, "prNumber");
	return deepFreeze({
		method: "PUT" as const,
		url: `/repos/${input.upstreamOwner}/${input.upstreamRepo}/pulls/${input.prNumber}/update-branch`,
		body: deepFreeze({ update_method: "merge" as const }),
	});
}

/** Follow-up-push intent onto the PR head branch of the policy repo's fork. */
export function renderFollowUpPushIntent(input: {
	forkOwner: string;
	forkRepo: string;
	headBranch: string;
	/** Full refspec, e.g. `HEAD:refs/heads/warren/issue-42`. */
	refspec: string;
}): FollowUpPushIntent {
	for (const [name, value] of [
		["forkOwner", input.forkOwner],
		["forkRepo", input.forkRepo],
		["headBranch", input.headBranch],
		["refspec", input.refspec],
	] as const) {
		requireNonEmpty(value, name);
	}
	return deepFreeze({
		method: "GIT_PUSH" as const,
		url: `https://github.com/${input.forkOwner}/${input.forkRepo}.git`,
		body: deepFreeze({
			forkOwner: input.forkOwner,
			forkRepo: input.forkRepo,
			headBranch: input.headBranch,
			refspec: input.refspec,
		}),
	});
}

function requirePositiveInt(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new ValidationError(`${name} must be a positive integer, got ${String(value)}`);
	}
}

function requireNonEmpty(value: string, name: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ValidationError(`mutation intent field '${name}' must be a non-empty string`);
	}
}

function deepFreeze<T>(value: T): T {
	Object.freeze(value);
	for (const inner of Object.values(value as Record<string, unknown>)) {
		if (typeof inner === "object" && inner !== null && !Object.isFrozen(inner)) {
			deepFreeze(inner);
		}
	}
	return value;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The request may or may not have reached GitHub; the caller must settle
 * `uncertain` and never re-send blind.
 */
export class GithubMutationUncertainError extends GithubApiError {
	constructor(
		message: string,
		options: { path: string; requestHeaders?: Record<string, string>; cause?: unknown },
	) {
		super(message, options);
		this.name = "GithubMutationUncertainError";
	}
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

export interface MutationTransportOptions {
	/** The validated repository policy; the flag gate reads it, not config. */
	policy: RepositoryPolicy;
	/** API base, default `https://api.github.com`. */
	baseUrl?: string;
	/** Bearer token; required — an anonymous mutation is never attempted. */
	token: string;
	/** Injectable fetch for tests. Defaults to the global fetch. */
	fetchImpl?: FetchLike;
	/** User agent; GitHub requires one. */
	userAgent?: string;
}

type SendFn = (
	what: string,
	method: "PATCH" | "POST" | "PUT",
	url: string,
	body: unknown,
) => Promise<Response>;

function requireToken(token: string, what: string): void {
	if (typeof token !== "string" || token.length === 0) {
		throw new BoundaryError(`refusing to construct the ${what}: a GitHub credential is required`);
	}
}

function makeSend(options: MutationTransportOptions): SendFn {
	const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
	return async (what, method, url, body) => {
		const headers: Record<string, string> = {
			accept: "application/vnd.github+json",
			"content-type": "application/json",
			"user-agent": options.userAgent ?? "warren-campaign-controller",
			[AUTHORIZATION_HEADER]: `Bearer ${options.token}`,
		};
		let response: Response;
		try {
			response = await (options.fetchImpl ?? fetch)(`${baseUrl}${url}`, {
				method,
				headers,
				body: JSON.stringify(body),
				redirect: "manual",
			});
		} catch (cause) {
			throw new GithubMutationUncertainError(
				`${what} outcome unknown for ${url}: transport failed after the request may have been sent`,
				{ path: url, requestHeaders: redactHeaders(headers, options.token), cause },
			);
		}
		if (response.status < 200 || response.status >= 300) {
			const text = await response.text();
			throw new GithubApiError(`${what} failed with HTTP ${response.status} for ${url}`, {
				status: response.status,
				path: url,
				requestHeaders: redactHeaders(headers, options.token),
				cause: text.length > 0 ? text : undefined,
			});
		}
		return response;
	};
}

/** The intent may only aim at the policy's own upstream coordinates. */
function assertUpstreamUrl(
	intentUrl: string,
	expected: string,
	what: string,
	policy: RepositoryPolicy,
): void {
	if (intentUrl !== expected) {
		throw new BoundaryError(
			`refusing ${what}: intent targets '${intentUrl}', policy binds ${expected} (${policy.upstream.owner}/${policy.upstream.repo})`,
		);
	}
}

/** The intent's fork coordinates must be a fork of the policy's repo. */
function assertForkMatchesUpstream(
	forkOwner: string,
	forkRepo: string,
	policy: RepositoryPolicy,
): void {
	if (forkRepo !== policy.upstream.repo || forkOwner === policy.upstream.owner) {
		throw new BoundaryError(
			`refusing followUpPush: intent targets ${forkOwner}/${forkRepo}, not a fork of ${policy.upstream.owner}/${policy.upstream.repo}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Transports — one class per flag
// ---------------------------------------------------------------------------

/** The seam the updatePullRequest executor consumes. */
export interface GithubPrUpdateTransport {
	updatePullRequest(intent: UpdatePullRequestIntent): Promise<{ updatedAt: string | null }>;
}

export class BunFetchGithubPrUpdater implements GithubPrUpdateTransport {
	readonly #policy: RepositoryPolicy;
	readonly #send: SendFn;

	constructor(options: MutationTransportOptions) {
		if (options.policy.mutations.updatePullRequest !== true) {
			throw new BoundaryError(
				"refusing to construct the PR updater: the repository policy does not enable mutations.updatePullRequest",
			);
		}
		requireToken(options.token, "PR updater");
		this.#policy = options.policy;
		this.#send = makeSend(options);
	}

	/** PATCH the journaled intent, verbatim, to the policy-bound upstream. */
	async updatePullRequest(intent: UpdatePullRequestIntent): Promise<{ updatedAt: string | null }> {
		requirePrUrl(intent.url, this.#policy);
		const response = await this.#send("updatePullRequest", intent.method, intent.url, intent.body);
		return { updatedAt: jsonFieldOrNull(await readJson(response), "updated_at", "string") };
	}
}

/** The seam the postComment executor consumes. */
export interface GithubCommentPosterTransport {
	postComment(intent: PostCommentIntent): Promise<{ commentId: number | null }>;
}

export class BunFetchGithubCommentPoster implements GithubCommentPosterTransport {
	readonly #policy: RepositoryPolicy;
	readonly #send: SendFn;

	constructor(options: MutationTransportOptions) {
		if (options.policy.mutations.postComment !== true) {
			throw new BoundaryError(
				"refusing to construct the comment poster: the repository policy does not enable mutations.postComment",
			);
		}
		requireToken(options.token, "comment poster");
		this.#policy = options.policy;
		this.#send = makeSend(options);
	}

	/** POST the journaled intent, verbatim, to the policy-bound upstream. */
	async postComment(intent: PostCommentIntent): Promise<{ commentId: number | null }> {
		requireCommentsUrl(intent.url, this.#policy);
		const response = await this.#send("postComment", intent.method, intent.url, intent.body);
		return { commentId: jsonFieldOrNull(await readJson(response), "id", "number") };
	}
}

/** The seam the updateBranch executor consumes. */
export interface GithubBranchUpdaterTransport {
	updateBranch(intent: UpdateBranchIntent): Promise<{ message: string | null }>;
}

export class BunFetchGithubBranchUpdater implements GithubBranchUpdaterTransport {
	readonly #policy: RepositoryPolicy;
	readonly #send: SendFn;

	constructor(options: MutationTransportOptions) {
		if (options.policy.mutations.updateBranch !== true) {
			throw new BoundaryError(
				"refusing to construct the branch updater: the repository policy does not enable mutations.updateBranch",
			);
		}
		requireToken(options.token, "branch updater");
		this.#policy = options.policy;
		this.#send = makeSend(options);
	}

	/** PUT the journaled intent, verbatim, to the policy-bound upstream. */
	async updateBranch(intent: UpdateBranchIntent): Promise<{ message: string | null }> {
		requireUpdateBranchUrl(intent.url, this.#policy);
		const response = await this.#send("updateBranch", intent.method, intent.url, intent.body);
		return { message: jsonFieldOrNull(await readJson(response), "message", "string") };
	}
}

/** The injected push primitive; the follow-up coordinator supplies the real git mechanics. */
export type GitPushFn = (intent: FollowUpPushIntent) => Promise<void>;

/** The seam the followUpPush executor consumes. */
export interface GithubFollowUpPushTransport {
	pushFollowUpCommits(intent: FollowUpPushIntent): Promise<{ pushedTo: string }>;
}

export class GitPushFollowUpPusher implements GithubFollowUpPushTransport {
	readonly #policy: RepositoryPolicy;
	readonly #push: GitPushFn;

	constructor(options: { policy: RepositoryPolicy; push: GitPushFn }) {
		if (options.policy.mutations.followUpPush !== true) {
			throw new BoundaryError(
				"refusing to construct the follow-up pusher: the repository policy does not enable mutations.followUpPush",
			);
		}
		this.#policy = options.policy;
		this.#push = options.push;
	}

	/** Push the journaled intent, verbatim, to the policy repo's fork. */
	async pushFollowUpCommits(intent: FollowUpPushIntent): Promise<{ pushedTo: string }> {
		assertForkMatchesUpstream(intent.body.forkOwner, intent.body.forkRepo, this.#policy);
		const expected = `https://github.com/${intent.body.forkOwner}/${intent.body.forkRepo}.git`;
		assertUpstreamUrl(intent.url, expected, "followUpPush", this.#policy);
		try {
			await this.#push(intent);
		} catch (cause) {
			// A push may or may not have landed on the remote before the
			// failure surfaced: uncertain, never a blind re-push.
			throw new GithubMutationUncertainError(
				`followUpPush outcome unknown for ${intent.url}: the push failed after it may have reached the remote`,
				{ path: intent.url, cause },
			);
		}
		return { pushedTo: intent.body.headBranch };
	}
}

// ---------------------------------------------------------------------------
// URL verification
// ---------------------------------------------------------------------------

function urlMismatch(url: string, policy: RepositoryPolicy): BoundaryError {
	return new BoundaryError(
		`refusing mutation: intent targets '${url}', policy binds the ${policy.upstream.owner}/${policy.upstream.repo} upstream`,
	);
}

/** `/repos/{owner}/{repo}/pulls/{n}` for the policy upstream; else throws. */
function requirePrUrl(url: string, policy: RepositoryPolicy): number {
	const prefix = `/repos/${policy.upstream.owner}/${policy.upstream.repo}/pulls/`;
	if (!url.startsWith(prefix)) {
		throw urlMismatch(url, policy);
	}
	const tail = url.slice(prefix.length);
	if (!/^\d+$/.test(tail)) {
		throw urlMismatch(url, policy);
	}
	return Number.parseInt(tail, 10);
}

/** `/repos/{owner}/{repo}/issues/{n}/comments` for the policy upstream; else throws. */
function requireCommentsUrl(url: string, policy: RepositoryPolicy): number {
	const prefix = `/repos/${policy.upstream.owner}/${policy.upstream.repo}/issues/`;
	const suffix = "/comments";
	if (!url.startsWith(prefix) || !url.endsWith(suffix)) {
		throw urlMismatch(url, policy);
	}
	const tail = url.slice(prefix.length, url.length - suffix.length);
	if (!/^\d+$/.test(tail)) {
		throw urlMismatch(url, policy);
	}
	return Number.parseInt(tail, 10);
}

/** `/repos/{owner}/{repo}/pulls/{n}/update-branch` for the policy upstream; else throws. */
function requireUpdateBranchUrl(url: string, policy: RepositoryPolicy): number {
	const prefix = `/repos/${policy.upstream.owner}/${policy.upstream.repo}/pulls/`;
	const suffix = "/update-branch";
	if (!url.startsWith(prefix) || !url.endsWith(suffix)) {
		throw urlMismatch(url, policy);
	}
	const tail = url.slice(prefix.length, url.length - suffix.length);
	if (!/^\d+$/.test(tail)) {
		throw urlMismatch(url, policy);
	}
	return Number.parseInt(tail, 10);
}

// ---------------------------------------------------------------------------
// Response narrowing
// ---------------------------------------------------------------------------

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const raw: unknown = await response.json();
		if (typeof raw === "object" && raw !== null) {
			return raw as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function jsonFieldOrNull<T extends "string" | "number">(
	row: Record<string, unknown> | null,
	key: string,
	kind: T,
): T extends "string" ? string | null : number | null {
	const value = row?.[key];
	if (kind === "string") {
		return (typeof value === "string" ? value : null) as T extends "string"
			? string | null
			: number | null;
	}
	return (typeof value === "number" ? value : null) as T extends "string"
		? string | null
		: number | null;
}
