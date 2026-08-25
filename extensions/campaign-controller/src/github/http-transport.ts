/**
 * The production GitHub transport: real `fetch`, GET/HEAD only (warren-33aa).
 *
 * The structural no-mutation guarantee lives here and in the fake server:
 * `read()` is the only operation, and it rejects any method other than
 * GET or HEAD with a BoundaryError *before* any network I/O. There is no
 * write-shaped method on this class for anyone to call, and errors carry
 * only redacted request headers, so a thrown credential can never leak.
 */

import { BoundaryError } from "../errors.ts";
import { GithubApiError } from "./errors.ts";
import { AUTHORIZATION_HEADER, redactHeaders } from "./redact.ts";
import type {
	GithubHttpResponse,
	GithubReadMethod,
	GithubReadRequest,
	GithubTransport,
} from "./types.ts";

/** Hard runtime guard: anything but GET/HEAD fails immediately. */
export function assertReadMethod(method: string, path: string): GithubReadMethod {
	if (method !== "GET" && method !== "HEAD") {
		throw new BoundaryError(
			`V0 GitHub transport is read-only: refused ${method} ${path} (only GET/HEAD are allowed)`,
		);
	}
	return method;
}

export type FetchLike = (url: string | URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export interface BunFetchGithubTransportOptions {
	/** API base, default `https://api.github.com`. */
	baseUrl?: string;
	/** Bearer token; sent as `Authorization: Bearer <token>`, never echoed. */
	token?: string;
	/** Injectable fetch for tests. Defaults to the global fetch. */
	fetchImpl?: FetchLike;
	/** User agent; GitHub requires one. */
	userAgent?: string;
}

export class BunFetchGithubTransport implements GithubTransport {
	private readonly baseUrl: string;
	private readonly token: string | undefined;
	private readonly fetchImpl: FetchLike;
	private readonly userAgent: string;

	constructor(options: BunFetchGithubTransportOptions = {}) {
		this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
		this.token = options.token;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.userAgent = options.userAgent ?? "warren-campaign-controller";
	}

	/** The one operation. GET or HEAD only; everything else fails hard. */
	async read(request: GithubReadRequest): Promise<GithubHttpResponse> {
		assertReadMethod(request.method, request.path);
		const headers: Record<string, string> = {
			accept: "application/vnd.github+json",
			"user-agent": this.userAgent,
			...request.headers,
		};
		if (this.token !== undefined && this.token.length > 0) {
			headers[AUTHORIZATION_HEADER] = `Bearer ${this.token}`;
		}
		const url = `${this.baseUrl}${request.path}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: request.method,
				headers,
				redirect: "manual",
			});
		} catch (cause) {
			throw new GithubApiError(`GitHub request failed for ${request.path}`, {
				path: request.path,
				requestHeaders: redactHeaders(headers, this.token),
				cause,
			});
		}
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key.toLowerCase()] = value;
		});
		const body = request.method === "HEAD" ? null : await response.text();
		return { status: response.status, headers: responseHeaders, body };
	}

	/** The credential, if any, for redaction at error boundaries. */
	get redactionSecret(): string | undefined {
		return this.token;
	}
}
