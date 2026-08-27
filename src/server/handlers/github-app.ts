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
 * warren-e320: every route under the `/github-app` prefix rides the
 * boot-resolved existence gate (`resolveGitHubAppRegistrationGate` in
 * `src/server/github-app-gate.ts`, applied in `buildApiRoutes`) — OFF by
 * default on a public instance or once `WARREN_FORGE=app` is configured,
 * overridable with `WARREN_GITHUB_APP_REGISTRATION=on|off`, 404 when off.
 * The gate matches the PREFIX on purpose: the `/github-app/installed`
 * return route (warren-54c7) inherits it with no route-table special-casing.
 *
 * The pending-nonce store is a module-level singleton by default: the two
 * routes are separate `ROUTE_TABLE` entries (separate `build` calls) but
 * must share one store, and the flow's state is process-local by design
 * (a restart mid-flow means starting over). Tests inject their own
 * `RegistrationSessions` + `fetch` through the options bag.
 */

import {
	renderActivatedPage,
	renderInstalledMissingIdPage,
	renderStoredCredentialsPage,
} from "../../forge/github-app/activation-pages.ts";
import {
	buildGitHubAppManifest,
	convertManifestCode,
	GITHUB_APP_MANIFEST_CREATE_URL,
	gitHubOrgManifestCreateUrl,
	RegistrationSessions,
	renderCredentialsPage,
	renderInstalledPage,
	renderRegistrationErrorPage,
	renderRegistrationPage,
} from "../../forge/github-app/registration.ts";
import type { GitHubAppActivation } from "../../forge/hot-forge.ts";
import { notFound } from "../errors.ts";
import { jsonResponse } from "../response.ts";
import type { RouteContext, RouteHandler, ServerDeps } from "../types.ts";

/** Homepage the created App points at — the warren repo itself. */
const WARREN_HOMEPAGE_URL = "https://github.com/jayminwest/warren";

/**
 * warren-b504: route-table helper threading the boot-resolved activation
 * seam onto the callback/installed handler options. Empty options when
 * the opt-in store is not armed, so the legacy pages render byte-identically.
 */
export function gitHubAppRouteOptions(
	deps: Pick<ServerDeps, "gitHubAppActivation">,
): GitHubAppHandlerOptions {
	return deps.gitHubAppActivation === undefined ? {} : { activation: deps.gitHubAppActivation };
}

/**
 * Injectable seams for the registration handlers. `activation` is the
 * warren-b504 opt-in credential store: PRESENT only when
 * `WARREN_APP_CRED_STORE=data-dir` armed the deployment. When absent
 * (the default), every page renders byte-identical to the historical
 * render-once behavior.
 */
export interface GitHubAppHandlerOptions {
	readonly sessions?: RegistrationSessions;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly random?: () => string;
	readonly activation?: GitHubAppActivation;
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
			setupUrl: `${ctx.url.origin}/github-app/installed`,
		});
		const createUrl =
			org === null ? GITHUB_APP_MANIFEST_CREATE_URL : gitHubOrgManifestCreateUrl(org);
		return htmlResponse(
			200,
			renderRegistrationPage({
				manifest,
				createUrl,
				state,
				...(options.activation !== undefined ? { storesCredential: true } : {}),
			}),
		);
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
		// warren-b504: with the opt-in store armed, persist the App half of
		// the triple (re-registration overwrites, dropping a stale
		// installation id) and render the stored-credential page instead of
		// the copy-these-env-vars page. Never log the PEM.
		if (options.activation !== undefined) {
			options.activation.store.storeApp(String(result.registration.appId), result.registration.pem);
			ctx.logger.info(
				{ appId: result.registration.appId, path: options.activation.store.path },
				"github app credential stored (opt-in WARREN_APP_CRED_STORE)",
			);
			return htmlResponse(
				200,
				renderStoredCredentialsPage(result.registration, options.activation.store.path),
			);
		}
		return htmlResponse(200, renderCredentialsPage(result.registration));
	};
}

/**
 * GitHub installation ids are numeric. Anything else — a stray string, a
 * negative, an empty value — is treated as absent so the page falls back
 * to the manual instructions instead of rendering junk into a shell block.
 */
const INSTALLATION_ID_PATTERN = /^[0-9]+$/;

/**
 * `GET /github-app/installed?installation_id=<id>&setup_action=install` —
 * the manifest `setup_url` target (warren-54c7). GitHub redirects the
 * browser here after the operator installs the App, carrying the
 * installation id the credential triple still needs. Anonymous policy like
 * its siblings (no bearer rides a GitHub redirect); it renders nothing
 * server-side — the id arrives on the query string from GitHub itself.
 * Always 200 with page content: a missing/malformed `installation_id`
 * means the fallback manual instructions render, not an error page.
 *
 * warren-b504: with the opt-in store armed and the App half stored, a
 * valid installation id completes the triple on disk and ACTIVATES the
 * GitHubApp forge in-process (no restart). Partial state — App stored,
 * no readable id — renders the store-aware manual fallback, not the
 * generic env-block page. Without the store armed the page is
 * byte-identical to the historical one.
 */
export function gitHubAppInstalledHandler(options: GitHubAppHandlerOptions = {}): RouteHandler {
	return (ctx) => {
		const raw = ctx.url.searchParams.get("installation_id");
		const installationId = raw !== null && INSTALLATION_ID_PATTERN.test(raw) ? raw : null;
		const activation = options.activation;
		if (activation !== undefined) {
			const armed = renderArmedInstalledPage({
				activation,
				installationId,
				origin: ctx.url.origin,
				logger: ctx.logger,
			});
			if (armed !== null) return armed;
		}
		return htmlResponse(200, renderInstalledPage({ installationId }));
	};
}

/**
 * The armed-store arm of the installed route (warren-b504): complete the
 * stored triple, activate the App forge in-process, render the connected
 * page. Returns null when this visit should fall back to the legacy
 * manual page (no stored App) or already handled a partial/failed state
 * via the returned Response.
 */
function renderArmedInstalledPage(input: {
	readonly activation: GitHubAppActivation;
	readonly installationId: string | null;
	readonly origin: string;
	readonly logger: RouteContext["logger"];
}): Response | null {
	const { activation, installationId, logger } = input;
	const stored = activation.store.read();
	if (stored === null) {
		// App never stored (e.g. a bare visit before any registration):
		// fall through to today's manual page, byte-identical.
		return null;
	}
	if (installationId === null) {
		return htmlResponse(200, renderInstalledMissingIdPage(activation.store.path));
	}
	const completed = activation.store.completeInstallation(installationId);
	if (completed === null) {
		return null;
	}
	try {
		activation.hotForge.activateApp({
			appId: completed.appId,
			installationId: completed.installationId ?? installationId,
			privateKey: completed.privateKey,
		});
	} catch (cause) {
		// ForgeConfigError (unparseable stored key) — fail loud on the
		// page, keep the process up. Never include the key material.
		return htmlResponse(
			500,
			renderRegistrationErrorPage(
				"App activation failed",
				`The stored credential could not activate the App forge: ${
					cause instanceof Error ? cause.message : String(cause)
				}. Delete ${activation.store.path} and re-register.`,
			),
		);
	}
	logger.info(
		{ appId: completed.appId, installationId },
		"github app forge activated in-process (opt-in credential store)",
	);
	return htmlResponse(
		200,
		renderActivatedPage({
			appId: completed.appId,
			installationId,
			credentialPath: activation.store.path,
			uiUrl: `${input.origin}/`,
		}),
	);
}

/**
 * warren-e320: every route under the `/github-app` prefix rides the
 * boot-resolved registration gate (`resolveGitHubAppRegistrationGate`).
 * Prefix matching is deliberate: the `/github-app/installed` return route
 * (warren-54c7) inherits the gate with nobody having to remember to wire it.
 * A gated-off route answers 404 — never 401/403 — so the public-mode
 * invariant scenario 39 guards holds.
 */
export const GITHUB_APP_ROUTE_PREFIX = "/github-app";

export function gitHubAppRegistrationGatedHandler(pathname: string): Response {
	const rendered = notFound(pathname);
	return jsonResponse(rendered.status, rendered.envelope);
}
