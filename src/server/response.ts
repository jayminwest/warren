/**
 * Shared response constructors.
 *
 * Centralising Content-Type and encoding here keeps every handler on
 * the same wire shape — and gives tests one seam to assert on. The
 * NDJSON helper preserves backpressure: the source generator is only
 * consumed when the wire pulls more bytes, so a slow client doesn't
 * make warren buffer the whole event log in memory.
 */

const JSON_CT = "application/json; charset=utf-8";
const NDJSON_CT = "application/x-ndjson";

/**
 * Baseline security headers every warren response carries (warren-e2a4).
 * The operator bearer token lives in browser storage on this origin, so
 * the missing-CSP / missing-frame-ancestors posture was never cosmetic.
 * HSTS is a no-op over plain HTTP (browsers ignore it), so it is safe to
 * emit unconditionally for the TLS-terminated deployments that need it.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"content-security-policy":
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
	"strict-transport-security": "max-age=31536000; includeSubDomains",
};

/**
 * Every API body varies by `Authorization`: under `WARREN_AUTH=public`
 * (warren-851b) an operator sees more fields than a spectator at the same
 * URL. Without `Vary` a shared cache in front (a CDN toggle away) could
 * serve the operator body to anonymous visitors. Emitting it on responses
 * that do not vary is harmless — it only narrows cacheability.
 */
const VARY_AUTH = { vary: "Authorization" } as const;

export function jsonResponse(status: number, body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		...init,
		headers: mergeHeaders(init?.headers, {
			"content-type": JSON_CT,
			...VARY_AUTH,
			...SECURITY_HEADERS,
		}),
	});
}

export function textResponse(status: number, body: string, contentType: string): Response {
	return new Response(body, {
		status,
		headers: { "content-type": contentType, ...SECURITY_HEADERS },
	});
}

export function ndjsonResponse(stream: ReadableStream<Uint8Array>, init?: ResponseInit): Response {
	return new Response(stream, {
		status: 200,
		...init,
		headers: mergeHeaders(init?.headers, {
			"content-type": NDJSON_CT,
			"cache-control": "no-store",
			...VARY_AUTH,
			...SECURITY_HEADERS,
		}),
	});
}

/**
 * Stamp {@link SECURITY_HEADERS} onto a Response built outside the shared
 * constructors — the preview-proxy preamble (`src/server/server.ts`) builds
 * its own envelopes below the normal pipeline, and warren-e2a4's "every
 * response" baseline has to reach those too. Existing headers win, so an
 * upstream's own `content-type` / `cache-control` is never clobbered.
 */
export function withSecurityHeaders(res: Response): Response {
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: mergeHeaders(res.headers, SECURITY_HEADERS),
	});
}

function mergeHeaders(
	provided: HeadersInit | undefined,
	defaults: Record<string, string>,
): Headers {
	const headers = new Headers(provided);
	for (const [key, value] of Object.entries(defaults)) {
		if (!headers.has(key)) headers.set(key, value);
	}
	return headers;
}
