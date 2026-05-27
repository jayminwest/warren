/**
 * 4xx/5xx envelope builders for the preview proxy preamble
 * (warren-b902 split of src/preview/proxy.ts). The proxy preamble runs
 * *below* warren's normal error mapper, so these helpers shape their
 * own JSON envelopes directly.
 */

import type { PreviewProxyConfig } from "./types.ts";

/** Cookie redirect hint path written into 401 bodies so a browser falls
 *  back gracefully when it didn't get redirected through the login route. */
export const LOGIN_PATH_PREFIX = "/runs/";

export function previewError(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code, message } }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

/**
 * 401 envelope with a mode-aware hint pointing at the login handshake.
 * Subdomain mode emits an absolute URL keyed off the configured host;
 * path mode keeps the hint relative (the warren origin matches the
 * inbound request, but the proxy preamble is below the auth layer that
 * would otherwise validate that origin).
 */
export function previewUnauthorized(runId: string, config: PreviewProxyConfig, url: URL): Response {
	const loginPath = `${LOGIN_PATH_PREFIX}${runId}/preview/login`;
	const hint =
		config.mode === "subdomain"
			? `GET https://${config.host}${loginPath}?token=<WARREN_API_TOKEN>&redirect=https://run-${runId}.${config.host}/`
			: `GET ${url.origin}${loginPath}?token=<WARREN_API_TOKEN>&redirect=${url.origin}/p/${runId}/`;
	const body = {
		error: {
			code: "preview_unauthorized",
			message: "preview requires a signed-cookie session",
			hint,
		},
	};
	return new Response(JSON.stringify(body), {
		status: 401,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// Browsers don't honor WWW-Authenticate for cookie schemes, but
			// the header is informative for CLI consumers.
			"www-authenticate": 'Cookie realm="warren-preview"',
		},
	});
}
