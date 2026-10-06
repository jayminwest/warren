/**
 * GitLab REST transport (API v4) — request execution.
 *
 * The single `fetch` boundary for a GitLab instance. Mirrors the Azure
 * DevOps transport (`../ado/http.ts`) and shares the GitHub arm's
 * fail-soft readers, retry policy and status classifier, which carry no
 * GitHub knowledge: GitLab answers 401, 403, 404, 409, 422 and 429 with the
 * same meanings, and sends `Retry-After` on a rate limit.
 *
 * Authentication is the `PRIVATE-TOKEN` header, which takes a personal,
 * project or group access token alike.
 *
 * Every call carries a deadline (`../fetch-deadline.ts`): a self-hosted
 * instance often sits behind a proxy, and a stalled connection would
 * otherwise hold a reap or a poller tick open indefinitely.
 */

import type { ForgeError, ForgeResult } from "../contract.ts";
import { fetchWithDeadline } from "../fetch-deadline.ts";
import {
	classifyGitHubHttpError,
	networkError,
	type GitHubHttpError as TransportError,
} from "../github/errors.ts";
import { readText, truncate } from "../github/readers.ts";
import { type GitHubRetryOptions as RetryOptions, withGitHubRetry } from "../github/retry.ts";

/** Result helpers shared by the arm's modules. */
export function ok<T>(value: T): ForgeResult<T> {
	return { ok: true, value };
}

export function err<T>(error: ForgeError): ForgeResult<T> {
	return { ok: false, error };
}

/** Transport-kind vocabulary aligns with the seam kinds — the map is a rename. */
export function toForgeError(error: TransportError): ForgeError {
	const forgeError: ForgeError = { kind: error.kind, status: error.status, detail: error.message };
	if (error.kind === "rate_limited" && error.retryAfterMs !== null) {
		return { ...forgeError, retryAfterMs: error.retryAfterMs };
	}
	return forgeError;
}

/** Default per-request deadline. */
export const DEFAULT_GITLAB_TIMEOUT_MS = 30_000;

const USER_AGENT = "warren-forge-gitlab";

/** Cap on response-body text folded into an error message. */
const ERROR_BODY_MAX_CHARS = 500;

export type GitLabTransportResult =
	| { readonly ok: true; readonly response: Response }
	| { readonly ok: false; readonly error: TransportError };

export interface GitLabRequestInput {
	/** Absolute URL under the instance's `/api/v4`. */
	readonly url: string;
	readonly method?: "GET" | "POST" | "PUT" | "DELETE";
	readonly token: string;
	/** JSON-serializable request body; omitted when undefined. */
	readonly body?: unknown;
	/** `Accept` override for non-JSON endpoints such as job traces. */
	readonly accept?: string;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Short call-site label folded into error messages, e.g. `GET /merge_requests/7`. */
	readonly context: string;
	/** Retry tuning; transient failures retry by default. Pass `maxRetries: 0` to disable. */
	readonly retry?: RetryOptions;
	readonly timeoutMs?: number;
}

/** Build the header set for one GitLab request. */
export function buildGitLabHeaders(
	token: string,
	accept = "application/json",
): Record<string, string> {
	return {
		accept,
		"content-type": "application/json",
		"private-token": token,
		"user-agent": USER_AGENT,
	};
}

/**
 * Execute one GitLab REST request. Never throws — a thrown fetch
 * (including the deadline firing) surfaces as a `network` error.
 */
export async function requestGitLab(input: GitLabRequestInput): Promise<GitLabTransportResult> {
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const init: RequestInit = {
		method: input.method ?? "GET",
		headers: buildGitLabHeaders(input.token, input.accept),
		...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
	};
	const timeoutMs = input.timeoutMs ?? DEFAULT_GITLAB_TIMEOUT_MS;

	const retried = await withGitHubRetry(async () => {
		let res: Response;
		try {
			res = await fetchWithDeadline(fetchImpl, input.url, init, timeoutMs);
		} catch (err) {
			return { ok: false, error: networkError(err, input.context) };
		}
		if (!res.ok) {
			const text = truncate(await readText(res), ERROR_BODY_MAX_CHARS);
			return {
				ok: false,
				error: classifyGitHubHttpError(res.status, res.headers, text, input.context),
			};
		}
		// Every endpoint this transport serves answers JSON or plain text.
		// A 2xx HTML page means WARREN_GITLAB_URL names something other
		// than a GitLab API root (a landing page, a proxy's login wall).
		if ((res.headers.get("content-type") ?? "").includes("text/html")) {
			return {
				ok: false,
				error: {
					kind: "http_error" as const,
					status: res.status,
					retryAfterMs: null,
					message: `${input.context} answered ${res.status} with an HTML page, not the GitLab API: check WARREN_GITLAB_URL`,
				},
			};
		}
		return { ok: true, value: res };
	}, input.retry ?? {});
	if (!retried.ok) return retried;
	return { ok: true, response: retried.value };
}
