/**
 * Azure DevOps REST transport — request execution.
 *
 * The single `fetch` boundary for `dev.azure.com`. Mirrors the shape of
 * the GitHub transport (`../github/http.ts`) and shares its fail-soft
 * readers and retry policy, which carry no GitHub knowledge; only the
 * headers and the status classification are Azure DevOps facts.
 *
 * Authentication is a personal access token over HTTP basic auth. Azure
 * DevOps ignores the username, so it is left empty. A rejected or missing
 * credential does not come back as a 401 but as a 203 carrying the
 * sign-in page, which the classifier reads as `unauthorized`.
 *
 * Every call carries a deadline: a stalled connection or body read would
 * otherwise hold a reap or a poller tick open indefinitely.
 */

import type { ForgeError, ForgeResult } from "../contract.ts";
import {
	networkError,
	parseRetryAfterMs,
	type GitHubHttpError as TransportError,
} from "../github/errors.ts";
import { readText, truncate } from "../github/readers.ts";
import { type GitHubRetryOptions as RetryOptions, withGitHubRetry } from "../github/retry.ts";

export type { TransportError };

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

/** The REST API version every request pins. */
export const ADO_API_VERSION = "7.1";

/** Default per-request deadline. */
export const DEFAULT_ADO_TIMEOUT_MS = 30_000;

const USER_AGENT = "warren-forge-ado";

/** Cap on response-body text folded into an error message. */
const ERROR_BODY_MAX_CHARS = 500;

export type AdoTransportResult =
	| { readonly ok: true; readonly response: Response }
	| { readonly ok: false; readonly error: TransportError };

export interface AdoRequestInput {
	/** Absolute URL, already carrying `api-version`. */
	readonly url: string;
	readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	readonly token: string;
	/** JSON-serializable request body; omitted when undefined. */
	readonly body?: unknown;
	/** `Accept` override for non-JSON endpoints such as build logs. */
	readonly accept?: string;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Short call-site label folded into error messages, e.g. `GET /pullrequests/7`. */
	readonly context: string;
	/** Retry tuning; transient failures retry by default. Pass `maxRetries: 0` to disable. */
	readonly retry?: RetryOptions;
	readonly timeoutMs?: number;
}

/** Build the header set for one Azure DevOps request. */
export function buildAdoHeaders(
	token: string,
	accept = "application/json",
): Record<string, string> {
	return {
		accept,
		authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
		"content-type": "application/json",
		"user-agent": USER_AGENT,
	};
}

/** Classify a non-2xx (or a 203) Azure DevOps response. */
export function classifyAdoHttpError(
	status: number,
	headers: Headers,
	bodyText: string,
	context: string,
): TransportError {
	const message = `${context} returned ${status}: ${bodyText}`;
	const base = { status, retryAfterMs: null, message };
	if (status === 429) {
		return {
			...base,
			kind: "rate_limited",
			retryAfterMs: parseRetryAfterMs(headers.get("retry-after")),
		};
	}
	if (status === 401 || status === 203) {
		return {
			...base,
			kind: "unauthorized",
			message:
				status === 203
					? `${context} returned 203 (sign-in page): the personal access token was rejected`
					: message,
		};
	}
	if (status === 403) return { ...base, kind: "forbidden" };
	if (status === 404) return { ...base, kind: "not_found" };
	if (status === 409) return { ...base, kind: "conflict" };
	return { ...base, kind: "http_error" };
}

/** Statuses whose `Response` must carry no body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Drain `res` and hand back an equivalent response whose body is already
 * in memory, so no later read can block.
 */
async function bufferResponse(res: Response): Promise<Response> {
	const text = await res.text();
	return new Response(NULL_BODY_STATUSES.has(res.status) ? null : text, {
		status: res.status,
		statusText: res.statusText,
		headers: res.headers,
	});
}

/**
 * Execute one Azure DevOps REST request. Never throws — a thrown fetch
 * (including the deadline firing) surfaces as a `network` error.
 */
export async function requestAdo(input: AdoRequestInput): Promise<AdoTransportResult> {
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const init: RequestInit = {
		method: input.method ?? "GET",
		headers: buildAdoHeaders(input.token, input.accept),
		...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
	};
	const timeoutMs = input.timeoutMs ?? DEFAULT_ADO_TIMEOUT_MS;

	const retried = await withGitHubRetry(async () => {
		// An explicit timer rather than `AbortSignal.timeout`: that signal
		// does not retain the event loop on every platform, so a pending
		// fetch could outlive the deadline it was supposed to cut.
		const controller = new AbortController();
		const deadline = setTimeout(
			() => controller.abort(new DOMException("request timed out at the deadline", "TimeoutError")),
			timeoutMs,
		);
		// The body is consumed inside the same window: a proxy that sends
		// the headers and then stalls the body would otherwise hang a
		// caller's read after the timer was already cleared.
		let res: Response;
		try {
			const fetched = await fetchImpl(input.url, { ...init, signal: controller.signal });
			res = await bufferResponse(fetched);
		} catch (err) {
			return { ok: false, error: networkError(err, input.context) };
		} finally {
			clearTimeout(deadline);
		}
		if (!res.ok || res.status === 203) {
			const text = truncate(await readText(res), ERROR_BODY_MAX_CHARS);
			return {
				ok: false,
				error: classifyAdoHttpError(res.status, res.headers, text, input.context),
			};
		}
		// A rejected credential can also come back as a 200 HTML sign-in
		// page. Every endpoint this transport serves answers JSON (or plain
		// text for logs), so 2xx HTML is an auth failure, not a payload.
		if ((res.headers.get("content-type") ?? "").includes("text/html")) {
			return {
				ok: false,
				error: {
					kind: "unauthorized" as const,
					status: res.status,
					retryAfterMs: null,
					message: `${input.context} answered ${res.status} with a sign-in page — credential rejected`,
				},
			};
		}
		return { ok: true, value: res };
	}, input.retry ?? {});
	if (!retried.ok) return retried;
	return { ok: true, response: retried.value };
}
