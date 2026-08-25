/**
 * Deterministic in-process fake GitHub server (warren-33aa).
 *
 * Implements the same `GithubTransport` contract as the production
 * transport, so client tests run without sockets, wall time, or entropy.
 * It records every request (method, path, query, redacted headers), can
 * paginate collections, emit duplicate node ids (caller data), reorder
 * events (caller data), serve conditional 304s from versioned ETags,
 * and simulate primary and secondary rate limits. Like the production
 * transport it fails hard on any non-GET/HEAD method.
 */

import type { Clock, IdGenerator } from "../clock.ts";
import { SequentialIdGenerator, SystemClock } from "../clock.ts";
import { assertReadMethod } from "./http-transport.ts";
import { redactHeaders } from "./redact.ts";
import type { GithubHttpResponse, GithubReadRequest, GithubTransport } from "./types.ts";

/** One recorded request, as exposed to tests — headers already redacted. */
export interface RecordedGithubRequest {
	method: string;
	/** Path without the query string. */
	path: string;
	query: Record<string, string>;
	/** Request headers with the credential redacted. */
	headers: Record<string, string>;
}

/** Primary rate-limit simulation knobs. */
export interface FakeRateLimitState {
	limit: number;
	remaining: number;
	resetEpochSeconds: number;
}

/** Secondary (abuse detection) rate-limit simulation knobs. */
export interface FakeAbuseState {
	retryAfterSeconds: number;
}

interface FakeResource {
	/** Raw JSON-able body. Arrays on paginated routes are the full collection. */
	body: unknown;
	version: number;
	paginated: boolean;
	/** Pinned modification time (ms) — bumps with the version. */
	lastModifiedMs: number;
}

export interface FakeGithubServerOptions {
	clock?: Clock;
	idGenerator?: IdGenerator;
	/** Secret used to redact recorded headers (usually the token under test). */
	redactionSecret?: string;
	/** Default per-page size when the request omits `per_page`. */
	defaultPerPage?: number;
}

interface RecordedInternal {
	method: string;
	path: string;
	query: Record<string, string>;
	rawHeaders: Record<string, string>;
}

export class FakeGithubServer implements GithubTransport {
	private readonly resources = new Map<string, FakeResource>();
	private readonly recorded: RecordedInternal[] = [];
	private readonly clock: Clock;
	/** Deterministic id source for tests building stable node ids. */
	readonly ids: IdGenerator;
	private readonly secret: string | undefined;
	private readonly defaultPerPage: number;
	private rateLimit: FakeRateLimitState | null = null;
	private abuse: FakeAbuseState | null = null;

	constructor(options: FakeGithubServerOptions = {}) {
		this.clock = options.clock ?? new SystemClock();
		this.ids = options.idGenerator ?? new SequentialIdGenerator();
		this.secret = options.redactionSecret;
		this.defaultPerPage = options.defaultPerPage ?? 30;
	}

	/** Register (or replace) a single resource at an exact path. */
	setResource(path: string, body: unknown): this {
		this.resources.set(normalize(path), {
			body,
			version: 1,
			paginated: false,
			lastModifiedMs: this.clock.nowMs(),
		});
		return this;
	}

	/**
	 * Register a paginated collection. The stored array is the full
	 * collection; `read` slices it by `page`/`per_page` and emits a
	 * `Link: rel="next"` header while more pages remain. Items may contain
	 * duplicate node ids — that is the caller simulating GitHub's
	 * at-least-once delivery.
	 */
	setPaginatedCollection(path: string, items: unknown[]): this {
		this.resources.set(normalize(path), {
			body: items,
			version: 1,
			paginated: true,
			lastModifiedMs: this.clock.nowMs(),
		});
		return this;
	}

	/** Change a resource's body, bumping its ETag/Last-Modified version. */
	mutateResource(path: string, body: unknown): this {
		const key = normalize(path);
		const prior = this.resources.get(key);
		this.resources.set(key, {
			body,
			version: (prior?.version ?? 0) + 1,
			paginated: prior?.paginated ?? false,
			lastModifiedMs: this.clock.nowMs(),
		});
		return this;
	}

	/** Remove a registered resource so subsequent reads answer 404. */
	deleteResource(path: string): this {
		this.resources.delete(normalize(path));
		return this;
	}

	/** Bump a resource's version without changing its body. */
	bumpResource(path: string): this {
		const prior = this.resources.get(normalize(path));
		if (prior) {
			prior.version += 1;
			prior.lastModifiedMs = this.clock.nowMs();
		}
		return this;
	}

	/** Simulate an exhausted primary rate limit on every response. */
	setRateLimit(state: FakeRateLimitState): this {
		this.rateLimit = state;
		return this;
	}

	/** Simulate an abuse-detection (secondary) rate limit. */
	setAbuseDetection(state: FakeAbuseState): this {
		this.abuse = state;
		return this;
	}

	/** Clear both rate-limit simulations. */
	clearRateLimits(): this {
		this.rateLimit = null;
		this.abuse = null;
		return this;
	}

	/** All recorded requests, newest last, with headers redacted. */
	recordedRequests(): RecordedGithubRequest[] {
		return this.recorded.map((entry) => ({
			method: entry.method,
			path: entry.path,
			query: entry.query,
			headers: redactHeaders(entry.rawHeaders, this.secret),
		}));
	}

	/** Total requests served (attempts that passed the method guard). */
	get requestCount(): number {
		return this.recorded.length;
	}

	/** Serve one request. Non-GET/HEAD fails hard and is never recorded. */
	async read(request: GithubReadRequest): Promise<GithubHttpResponse> {
		assertReadMethod(request.method, request.path);
		const [rawPath, queryString = ""] = request.path.split("?");
		const query = Object.fromEntries(new URLSearchParams(queryString));
		const headers = lowercaseHeaders(request.headers ?? {});
		this.recorded.push({
			method: request.method,
			path: normalize(rawPath ?? "/"),
			query,
			rawHeaders: headers,
		});
		const baseHeaders = this.baseHeaders();
		if (this.abuse) {
			return jsonError(403, "You have triggered an abuse detection mechanism and must wait", {
				...baseHeaders,
				"retry-after": String(this.abuse.retryAfterSeconds),
			});
		}
		if (this.rateLimit && this.rateLimit.remaining <= 0) {
			return jsonError(403, "API rate limit exceeded for this installation", baseHeaders);
		}
		const resource = this.resources.get(normalize(rawPath ?? "/"));
		if (!resource) {
			return jsonError(404, "Not Found", baseHeaders);
		}
		const etag = `W/"fake-v${resource.version}"`;
		const lastModified = new Date(resource.lastModifiedMs).toISOString();
		const validators = { etag, "last-modified": lastModified, ...baseHeaders };
		if (isNotModified(headers, etag, resource.lastModifiedMs)) {
			return { status: 304, headers: validators, body: null };
		}
		if (request.method === "HEAD") {
			return { status: 200, headers: validators, body: null };
		}
		if (resource.paginated) {
			return paginateResource(resource, query, rawPath ?? "/", this.defaultPerPage, validators);
		}
		return { status: 200, headers: validators, body: JSON.stringify(resource.body) };
	}
	/** Common headers, including the simulated rate-limit snapshot. */
	private baseHeaders(): Record<string, string> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.rateLimit) {
			headers["x-ratelimit-limit"] = String(this.rateLimit.limit);
			headers["x-ratelimit-remaining"] = String(this.rateLimit.remaining);
			headers["x-ratelimit-reset"] = String(this.rateLimit.resetEpochSeconds);
		}
		return headers;
	}
}

function normalize(path: string): string {
	const trimmed = path.startsWith("/") ? path : `/${path}`;
	return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key.toLowerCase()] = value;
	}
	return out;
}

function jsonError(
	status: number,
	message: string,
	headers: Record<string, string>,
): GithubHttpResponse {
	return { status, headers, body: JSON.stringify({ message }) };
}

function isNotModified(
	requestHeaders: Record<string, string>,
	currentEtag: string,
	lastModifiedMs: number,
): boolean {
	const ifNoneMatch = requestHeaders["if-none-match"];
	if (ifNoneMatch !== undefined) {
		return ifNoneMatch
			.split(",")
			.some((candidate) => candidate.trim() === currentEtag || candidate.trim() === "*");
	}
	const ifModifiedSince = requestHeaders["if-modified-since"];
	if (ifModifiedSince !== undefined) {
		const since = Date.parse(ifModifiedSince);
		return Number.isFinite(since) && lastModifiedMs <= since;
	}
	return false;
}

function paginateResource(
	resource: FakeResource,
	query: Record<string, string>,
	rawPath: string,
	defaultPerPage: number,
	headers: Record<string, string>,
): GithubHttpResponse {
	const items = Array.isArray(resource.body) ? resource.body : [];
	const perPage = clampInt(query.per_page, defaultPerPage, 1, 100);
	const page = clampInt(query.page, 1, 1, Number.MAX_SAFE_INTEGER);
	const start = (page - 1) * perPage;
	const slice = items.slice(start, start + perPage);
	const nextExists = start + perPage < items.length;
	const link = nextExists
		? `<${rawPath}?page=${page + 1}&per_page=${perPage}>; rel="next"`
		: undefined;
	const responseHeaders = link === undefined ? headers : { ...headers, link };
	return { status: 200, headers: responseHeaders, body: JSON.stringify(slice) };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (raw === undefined) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(Math.max(parsed, min), max);
}
