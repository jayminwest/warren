/**
 * GitHub App manifest registration handlers (warren-a647, plan pl-d1c9
 * step 17) — the HTTP surface over `src/forge/github-app/registration.ts`.
 *
 * Two routes, both `anonymous` policy and both deliberate:
 *
 *   - `GET /github-app/register` renders the manifest form. It must be
 *     auth-exempt because the operator reaches it with a plain browser
 *     navigation (no bearer header), and it discloses nothing server-side:
 *     the manifest it renders describes an App the CALLER is about to
 *     create in their own GitHub account. On a `WARREN_AUTH=public`
 *     instance a stranger pressing the button just creates an App for
 *     themselves — no warren data crosses the wire either way.
 *   - `GET /github-app/callback` is where GitHub redirects the browser
 *     after the App is created — again no bearer can ride that redirect.
 *     Its authentication story is the single-use, ten-minute `state` nonce
 *     the register page embedded in the manifest
 *     ({@link RegistrationSessions}): without a live nonce the callback
 *     answers 400 and converts nothing, so a public instance leaks no
 *     credential material here (scenario 39's guarantee).
 *
 * Both pages are HTML with a locked-down CSP (no scripts at all;
 * `form-action` widened to github.com only, since the register form POSTs
 * there). That is deliberately narrower than the SPA's policy in
 * `response.ts`, so these responses build their own header set rather
 * than reuse `SECURITY_HEADERS` — whose `form-action 'self'` would block
 * the manifest hand-off.
 *
 * The pending-nonce store is a module-level singleton by default: the two
 * routes are separate `ROUTE_TABLE` entries (separate `build` calls) but
 * must share one store, and the flow's state is process-local by design
 * (a restart mid-flow means starting over). Tests inject their own
 * `RegistrationSessions` + `fetch` through the options bag.
 */

import {
	buildGitHubAppManifest,
	convertManifestCode,
	GITHUB_APP_MANIFEST_CREATE_URL,
	gitHubOrgManifestCreateUrl,
	RegistrationSessions,
	renderCredentialsPage,
	renderRegistrationErrorPage,
	renderRegistrationPage,
} from "../../forge/github-app/registration.ts";
import type { RouteHandler } from "../types.ts";

/** Homepage the created App points at — the warren repo itself. */
const WARREN_HOMEPAGE_URL = "https://github.com/jayminwest/warren";

/** Injectable seams for the two registration handlers. */
export interface GitHubAppHandlerOptions {
	readonly sessions?: RegistrationSessions;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly random?: () => string;
}

let sharedSessions: RegistrationSessions | null = null;

function resolveSessions(options: GitHubAppHandlerOptions): RegistrationSessions {
	if (options.sessions !== undefined) return options.sessions;
	sharedSessions ??= new RegistrationSessions(options.now ?? Date.now, undefined, options.random);
	return sharedSessions;
}

/**
 * These pages carry no SPA assets and run no JavaScript, so the CSP is
 * `default-src 'none'` plus inline styles; `form-action` names the one
 * off-origin destination (github.com's manifest endpoint).
 */
const REGISTRATION_PAGE_HEADERS: Readonly<Record<string, string>> = {
	"content-type": "text/html; charset=utf-8",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
	"cache-control": "no-store",
};

function htmlResponse(status: number, html: string): Response {
	return new Response(html, { status, headers: REGISTRATION_PAGE_HEADERS });
}

/** GitHub org logins are alphanumerics and single hyphens — nothing else. */
const ORG_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * `GET /github-app/register` — render the manifest form. Query params:
 * `name` (App name; defaults to `warren-forge-<rand6>` since App names
 * are globally unique on GitHub) and `org` (create under an organization
 * instead of the operator's personal account).
 */
export function registerGitHubAppHandler(options: GitHubAppHandlerOptions = {}): RouteHandler {
	return (ctx) => {
		const sessions = resolveSessions(options);
		const org = ctx.url.searchParams.get("org");
		if (org !== null && !ORG_LOGIN_PATTERN.test(org)) {
			return htmlResponse(
				400,
				renderRegistrationErrorPage(
					"Invalid org",
					"The ?org= value is not a plausible GitHub organization login.",
				),
			);
		}
		const state = sessions.begin();
		const suffix = (options.random ?? (() => Math.random().toString(36).slice(2)))()
			.replace(/[^a-z0-9]/gi, "")
			.slice(0, 6)
			.toLowerCase();
		const name = ctx.url.searchParams.get("name") ?? `warren-forge-${suffix || "app"}`;
		const manifest = buildGitHubAppManifest({
			name,
			homepageUrl: WARREN_HOMEPAGE_URL,
			redirectUrl: `${ctx.url.origin}/github-app/callback`,
			state,
		});
		const createUrl =
			org === null ? GITHUB_APP_MANIFEST_CREATE_URL : gitHubOrgManifestCreateUrl(org);
		return htmlResponse(200, renderRegistrationPage({ manifest, createUrl }));
	};
}

/**
 * `GET /github-app/callback?code=…&state=…` — redeem the manifest code.
 * The `state` must be a live nonce from this process's register route
 * (single-use, ten-minute TTL); the `code` is then converted against
 * GitHub with NO authentication (spike Q2) and the resulting credential
 * set is rendered once. 400 for a missing/unknown/expired `state` — never
 * 403, so the policy wire test's "a spectator route never answers 401/403"
 * invariant holds for a bare anonymous hit.
 */
export function gitHubAppCallbackHandler(options: GitHubAppHandlerOptions = {}): RouteHandler {
	return async (ctx) => {
		const sessions = resolveSessions(options);
		const code = ctx.url.searchParams.get("code");
		const state = ctx.url.searchParams.get("state");
		if (code === null || code === "" || state === null || state === "") {
			return htmlResponse(
				400,
				renderRegistrationErrorPage(
					"Missing code or state",
					"This endpoint is GitHub's redirect target after App creation; it needs the ?code= and ?state= query parameters GitHub appends.",
				),
			);
		}
		if (!sessions.consume(state)) {
			return htmlResponse(
				400,
				renderRegistrationErrorPage(
					"Unknown or expired state",
					"The state nonce is not one this process issued (or it expired — nonces live ten minutes). It may also have been spent already; every nonce is single-use.",
				),
			);
		}
		const result = await convertManifestCode(code, {
			...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
		});
		if (!result.ok) {
			return htmlResponse(
				502,
				renderRegistrationErrorPage("Manifest conversion failed", result.detail),
			);
		}
		return htmlResponse(200, renderCredentialsPage(result.registration));
	};
}
