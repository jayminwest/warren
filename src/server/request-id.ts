/**
 * X-Request-ID middleware (warren-30af / pl-7b06 step 19).
 *
 * Every HTTP request gets a stable correlation id that is:
 *   - honoured from the inbound `X-Request-ID` header when present and
 *     well-formed (1–128 chars of `[A-Za-z0-9_.-]`), so upstream
 *     proxies / clients can supply their own trace id;
 *   - otherwise minted via `crypto.randomUUID()`;
 *   - threaded through every handler via the per-request child logger
 *     (`RouteContext.logger`) and the `RouteContext.requestId` field;
 *   - stamped onto every outgoing response (success, error, auth deny,
 *     preview proxy, UI fallback) by the dispatch layer in
 *     `server.ts`, so operators can pivot from a UI error toast to the
 *     matching log line.
 *
 * The validation regex is intentionally narrow — accepting arbitrary
 * header bytes would let an attacker smuggle CRLF / log-spoof
 * characters back into our structured logs. Anything outside the
 * whitelist is treated as missing and replaced with a fresh UUID.
 */

import type { Logger } from "./types.ts";

export const REQUEST_ID_HEADER = "X-Request-ID";

const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Pull a usable request id off the inbound request, or mint one. The
 * input is sanitised so that a hostile header value can never end up
 * in our logs or get echoed back verbatim.
 */
export function extractOrGenerateRequestId(request: Request): string {
	const inbound = request.headers.get(REQUEST_ID_HEADER);
	if (inbound !== null && isValidRequestId(inbound)) return inbound;
	return crypto.randomUUID();
}

export function isValidRequestId(value: string): boolean {
	if (value.length === 0 || value.length > MAX_REQUEST_ID_LENGTH) return false;
	return REQUEST_ID_RE.test(value);
}

/**
 * Wrap a logger so every record carries `request_id`. Falls back to a
 * manual shim when the underlying logger has no `child` method (the
 * console-shaped stubs tests use).
 */
export function bindRequestIdLogger(base: Logger, requestId: string): Logger {
	const maybeChild = (base as { child?: (bindings: object) => Logger }).child;
	if (typeof maybeChild === "function") {
		return maybeChild.call(base, { request_id: requestId });
	}
	return {
		info(obj, msg) {
			base.info({ ...obj, request_id: requestId }, msg);
		},
		warn(obj, msg) {
			base.warn({ ...obj, request_id: requestId }, msg);
		},
		error(obj, msg) {
			base.error({ ...obj, request_id: requestId }, msg);
		},
		debug(obj, msg) {
			base.debug?.({ ...obj, request_id: requestId }, msg);
		},
	};
}

/**
 * Stamp `X-Request-ID` onto an outgoing response. Mutates the existing
 * Headers in place — Bun's Response headers are writable, and this
 * preserves any streaming body without re-piping it through a fresh
 * Response. Idempotent: if the header is already set to the same
 * value we leave it; if a handler set its own, we overwrite to keep
 * the wire id authoritative.
 */
export function stampRequestId(response: Response, requestId: string): Response {
	try {
		response.headers.set(REQUEST_ID_HEADER, requestId);
		return response;
	} catch {
		// Defensive: if a future runtime returns an immutable headers
		// object, rebuild the response. Streaming bodies survive — the
		// body is the same ReadableStream reference.
		const headers = new Headers(response.headers);
		headers.set(REQUEST_ID_HEADER, requestId);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
}
