/**
 * `GET /setup?code=...` — the one-time browser auth handoff redemption
 * route (warren-48f8, pl-26f3 step 3). See `src/server/setup-handoff.ts`
 * for the mint/arm side.
 *
 * Anonymous policy, by necessity: the browser lands here by navigation
 * (no bearer header can ride it), exactly like the GitHub App manifest
 * callback. The single-use code IS the authentication — a live, unspent
 * code from this process's boot is the only thing that yields a token,
 * and redeeming it consumes it atomically. On a `WARREN_AUTH=public`
 * instance the handoff never arms (`armSetupHandoff` refuses), so the
 * route 404s there and scenario 39's leak guarantee holds.
 *
 * A successful redemption serves a tiny HTML page whose only script
 * stores the operator token in the localStorage key the SPA login page
 * already writes (`warren.apiToken`, `src/ui/src/api/client.ts`) and then
 * redirects to `/` — the handoff gives the UI its credential the way the
 * UI already expects, no parallel auth scheme. The script carries a
 * per-response CSP nonce; the token is embedded JSON-escaped and `<`-
 * escaped so it cannot break out of the script or the document.
 */

import { randomBytes } from "node:crypto";
import { notFound } from "../errors.ts";
import { jsonResponse } from "../response.ts";
import type { SetupHandoffStore } from "../setup-handoff.ts";
import type { RouteHandler } from "../types.ts";

/** The localStorage key the SPA's api client reads (`src/ui/src/api/client.ts`). */
const UI_TOKEN_KEY = "warren.apiToken";

function htmlResponse(
	status: number,
	html: string,
	extraHeaders?: Record<string, string>,
): Response {
	return new Response(html, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			"x-frame-options": "DENY",
			...extraHeaders,
		},
	});
}

/** Embed a string as a JSON literal inside a <script> without breaking out. */
function jsonLiteral(value: string): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderRedemptionPage(token: string, nonce: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>warren setup</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem}code{background:#eee;padding:.1em .3em;border-radius:3px}</style>
</head>
<body>
<h1>Signing you in to warren&hellip;</h1>
<p>This one-time setup code was redeemed; your browser now holds the warren operator session.</p>
<noscript><p>JavaScript is disabled, so the token cannot be stored. Re-enable it and reload, or paste your operator token into the warren login page.</p></noscript>
<script nonce="${nonce}">
(function () {
	try {
		window.localStorage.setItem(${jsonLiteral(UI_TOKEN_KEY)}, ${jsonLiteral(token)});
	} catch (err) {
		document.body.appendChild(document.createTextNode("Could not store the token (localStorage unavailable): " + err));
		return;
	}
	window.location.replace("/");
})();
</script>
</body>
</html>
`;
}

function renderErrorPage(title: string, detail: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>warren setup</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem}</style>
</head>
<body>
<h1>${title}</h1>
<p>${detail}</p>
<p>Open the warren UI and sign in from its login page instead.</p>
</body>
</html>
`;
}

/**
 * The `/setup` route handler. `store` is present only on a setup-handoff
 * boot; absent (ordinary `warren serve`, `WARREN_AUTH=public`, ...) the
 * route answers 404 — never 401/403 — mirroring the GitHub App gate's
 * off-arm posture so the public-mode wire invariant stays intact.
 */
export function setupHandoffHandler(store: SetupHandoffStore | undefined): RouteHandler {
	return (ctx) => {
		if (store === undefined) {
			const rendered = notFound(ctx.url.pathname);
			// no-store on the 404 too: scenario 39's flow-page header sweep treats
			// this route as a flow page on public instances (where it always 404s).
			return jsonResponse(rendered.status, rendered.envelope, {
				headers: { "cache-control": "no-store" },
			});
		}
		const code = ctx.url.searchParams.get("code");
		if (code === null || code === "") {
			return htmlResponse(
				400,
				renderErrorPage(
					"Missing setup code",
					"This page redeems a one-time setup code; the ?code= query parameter is required.",
				),
			);
		}
		const token = store.redeem(code);
		if (token === null) {
			return htmlResponse(
				400,
				renderErrorPage(
					"Unknown, expired, or spent setup code",
					"Setup codes live ten minutes and redeem exactly once. A second visit to the same URL cannot work by design — the operator token is never re-served through a spent code.",
				),
			);
		}
		ctx.logger.info({}, "setup handoff code redeemed (single-use); browser session armed");
		const nonce = randomBytes(16).toString("base64url");
		return htmlResponse(200, renderRedemptionPage(token, nonce), {
			"content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
		});
	};
}
