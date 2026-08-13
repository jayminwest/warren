/**
 * GitHub App manifest registration flow (warren-a647, plan pl-d1c9 step 17,
 * forge-contract.md §7 Q1/Q2).
 *
 * How an operator mints the `WARREN_GITHUB_APP_*` credential triple without
 * ever hand-assembling an App in the GitHub UI:
 *
 *   1. `GET /github-app/register` renders a page carrying an App MANIFEST
 *      (name, homepage, loopback `redirect_url`, a random `state`, and the
 *      permission set the forge needs) as a single form field. Pressing the
 *      button POSTs the manifest to GitHub's "Create GitHub App" endpoint.
 *   2. GitHub creates the App under the operator's own account and redirects
 *      the browser to the manifest's `redirect_url` — warren's
 *      `GET /github-app/callback` — with `?code=…&state=…`. Q1 (spike
 *      warren-bc4c): a loopback `redirect_url` IS accepted and `state`
 *      round-trips intact, so the local-operator flow works behind NAT.
 *   3. The callback validates `state` against the single-use,
 *      short-TTL {@link RegistrationSessions} store, then converts the code:
 *      `POST /app-manifests/{code}/conversions`. Q2 (same spike): that call
 *      needs NO authentication, the code is single-use, and the response
 *      carries the App id, slug, PEM private key, and client id/secret — the
 *      whole credential set the `app` forge arm consumes. The callback
 *      renders them once, for the operator to copy into their secret store.
 *
 * Nothing here persists: the converted credentials exist only in the
 * rendered callback page, and the pending `state` nonces live in process
 * memory with a ten-minute TTL. A warren restart mid-flow just means the
 * operator starts over — GitHub lets them delete the half-created App.
 *
 * This module is the domain half; the HTTP surface lives in
 * `src/server/handlers/github-app.ts`. It imports nothing server-side so
 * the seam direction stays forge-inward (warren-89a6).
 */

import { getRandomValues } from "node:crypto";
import { GITHUB_API_BASE } from "../github/headers.ts";

/** GitHub's manifest-flow endpoint for a personal-account App. */
export const GITHUB_APP_MANIFEST_CREATE_URL = "https://github.com/settings/apps/new";

/** Org-account variant (`?org=<login>` on the register route). */
export function gitHubOrgManifestCreateUrl(orgLogin: string): string {
	return `https://github.com/organizations/${orgLogin}/settings/apps/new`;
}

/**
 * The permission set the `app` forge arm needs (forge-contract.md §5/§6):
 * push branches and open/edit PRs (`contents` + `pull_requests` write) and
 * read the Checks API (`checks` read — the asymmetry a fine-grained PAT
 * can't cross). `metadata` read is implicit on every App.
 */
export const GITHUB_APP_MANIFEST_PERMISSIONS = {
	contents: "write",
	pull_requests: "write",
	checks: "read",
	metadata: "read",
} as const;

/** The manifest POSTed to GitHub's create page (a subset of its schema). */
export interface GitHubAppManifest {
	readonly name: string;
	readonly url: string;
	readonly redirect_url: string;
	readonly state: string;
	readonly public: boolean;
	readonly default_permissions: typeof GITHUB_APP_MANIFEST_PERMISSIONS;
}

export function buildGitHubAppManifest(input: {
	readonly name: string;
	readonly homepageUrl: string;
	readonly redirectUrl: string;
	readonly state: string;
}): GitHubAppManifest {
	return {
		name: input.name,
		url: input.homepageUrl,
		redirect_url: input.redirectUrl,
		state: input.state,
		// Private by default: the App exists to serve this one warren
		// deployment, and a public App is installable by anyone.
		public: false,
		default_permissions: GITHUB_APP_MANIFEST_PERMISSIONS,
	};
}

/**
 * The credential set `POST /app-manifests/{code}/conversions` returns.
 * `pem` and `clientSecret` are live secrets: never log this object whole —
 * the field names ride the pino redact list (src/observability/log-redact.ts)
 * as a backstop, but call sites don't log it at all.
 */
export interface GitHubAppRegistration {
	readonly appId: number;
	readonly slug: string;
	readonly name: string;
	readonly htmlUrl: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly pem: string;
}

export type ConvertManifestCodeResult =
	| { readonly ok: true; readonly registration: GitHubAppRegistration }
	| { readonly ok: false; readonly status: number; readonly detail: string };

/**
 * Convert a manifest `code` into the App's credential set (Q2). NO
 * Authorization header — the code itself is the bearer, and it is
 * single-use: a replay answers 404, which surfaces here as a plain
 * `ok: false` with the upstream status.
 */
export async function convertManifestCode(
	code: string,
	options: { readonly fetch?: typeof fetch } = {},
): Promise<ConvertManifestCodeResult> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	let response: Response;
	try {
		response = await fetchImpl(
			`${GITHUB_API_BASE}/app-manifests/${encodeURIComponent(code)}/conversions`,
			{
				method: "POST",
				headers: {
					accept: "application/vnd.github+json",
					"user-agent": "warren-forge-github-app-registration",
				},
			},
		);
	} catch (cause) {
		return {
			ok: false,
			status: 0,
			detail: `conversion request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		};
	}
	if (!response.ok) {
		await response.body?.cancel();
		return {
			ok: false,
			status: response.status,
			detail:
				response.status === 404
					? "GitHub answered 404 — the code is unknown or already spent (codes are single-use). Start the registration over."
					: `GitHub answered ${response.status} for the manifest conversion.`,
		};
	}
	const body = (await response.json()) as Record<string, unknown> | null;
	const registration = parseConversionBody(body);
	if (registration === null) {
		return {
			ok: false,
			status: response.status,
			detail:
				"GitHub's conversion response was missing one of id, slug, name, html_url, client_id, client_secret, or pem.",
		};
	}
	return { ok: true, registration };
}

function parseConversionBody(body: Record<string, unknown> | null): GitHubAppRegistration | null {
	if (body === null || typeof body.id !== "number") return null;
	const strings = {
		slug: body.slug,
		name: body.name,
		htmlUrl: body.html_url,
		clientId: body.client_id,
		clientSecret: body.client_secret,
		pem: body.pem,
	};
	for (const value of Object.values(strings)) {
		if (typeof value !== "string" || value === "") return null;
	}
	return {
		appId: body.id,
		slug: strings.slug as string,
		name: strings.name as string,
		htmlUrl: strings.htmlUrl as string,
		clientId: strings.clientId as string,
		clientSecret: strings.clientSecret as string,
		pem: strings.pem as string,
	};
}

/** Default TTL for a pending registration `state` nonce. */
export const REGISTRATION_STATE_TTL_MS = 10 * 60 * 1000;

function defaultStateToken(): string {
	const bytes = new Uint8Array(24);
	getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

/**
 * Process-local store of pending registration `state` nonces. `begin()`
 * mints and records one; `consume()` redeems it exactly once (single-use,
 * matching the code it will guard) and refuses unknown or expired nonces.
 * This is the callback's whole authentication story: the browser redirect
 * from GitHub carries no warren credential, so the unguessable nonce the
 * register page embedded in the manifest is what proves the callback
 * belongs to a flow this process started.
 */
export class RegistrationSessions {
	private readonly pending = new Map<string, number>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs: number = REGISTRATION_STATE_TTL_MS,
		private readonly random: () => string = defaultStateToken,
	) {}

	begin(): string {
		this.sweep();
		const state = this.random();
		this.pending.set(state, this.now() + this.ttlMs);
		return state;
	}

	/** Redeem `state` exactly once; false for an unknown or expired nonce. */
	consume(state: string): boolean {
		this.sweep();
		if (!this.pending.has(state)) return false;
		this.pending.delete(state);
		return true;
	}

	/** Pending count — exposed for tests and diagnostics. */
	get size(): number {
		this.sweep();
		return this.pending.size;
	}

	private sweep(): void {
		const cutoff = this.now();
		for (const [state, expiresAt] of this.pending) {
			if (expiresAt <= cutoff) this.pending.delete(state);
		}
	}
}

/** Escape the five HTML-significant characters for text/attribute slots. */
export function escapeHtml(value: string): string {
	return value
		.split("&")
		.join("&amp;")
		.split("<")
		.join("&lt;")
		.split(">")
		.join("&gt;")
		.split('"')
		.join("&quot;")
		.split("'")
		.join("&#39;");
}

const PAGE_STYLE = `
	body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; background: #0d1117; color: #e6edf3; }
	h1 { font-size: 1.3rem; }
	pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 0.75rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
	button { font: inherit; padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid #30363d; background: #238636; color: #fff; cursor: pointer; }
	dt { font-weight: bold; margin-top: 0.5rem; }
	dd { margin-left: 0; }
	.note { color: #9da7b3; }
`;

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>warren — ${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * The register page: the manifest rides a single hidden `manifest` form
 * field; pressing the button POSTs it to GitHub's create page. No inline
 * script — the page's CSP forbids it, and a visible button means the
 * operator sees exactly what is about to be created before they commit.
 */
export function renderRegistrationPage(input: {
	readonly manifest: GitHubAppManifest;
	readonly createUrl: string;
}): string {
	const manifestJson = escapeHtml(JSON.stringify(input.manifest));
	const body = `<h1>Register a GitHub App for warren</h1>
<p>This form creates a private GitHub App under your account with exactly the
permissions warren's App forge needs (contents: write, pull-requests: write,
checks: read). Pressing the button hands this manifest to GitHub:</p>
<pre>${escapeHtml(JSON.stringify(input.manifest, null, 2))}</pre>
<form method="post" action="${escapeHtml(input.createUrl)}">
<input type="hidden" name="manifest" value="${manifestJson}">
<button type="submit">Create the GitHub App on github.com</button>
</form>
<p class="note">GitHub returns you here with a single-use code; warren converts
it into the App credentials and shows them to you once. Nothing is stored.</p>`;
	return page("Register a GitHub App", body);
}

/**
 * The callback page: the converted credential set, rendered once. The PEM
 * is shown verbatim (the operator pastes it into their secret store; the
 * forge unfolds literal `\n` sequences if their store needs the single-line
 * form). The install link lands on GitHub's installation flow, which yields
 * the installation id the env triple needs.
 */
export function renderCredentialsPage(registration: GitHubAppRegistration): string {
	const installUrl = `https://github.com/apps/${registration.slug}/installations/new`;
	const envBlock = [
		"WARREN_FORGE=app",
		`WARREN_GITHUB_APP_ID=${registration.appId}`,
		"WARREN_GITHUB_APP_INSTALLATION_ID=<from the install step below>",
		"WARREN_GITHUB_APP_PRIVATE_KEY=<the PEM below>",
	].join("\n");
	const body = `<h1>App registered: ${escapeHtml(registration.name)}</h1>
<p>Copy these values into your secret store NOW — warren keeps no copy, and
this page is the only place they appear.</p>
<dl>
<dt>App id</dt><dd><pre>${registration.appId}</pre></dd>
<dt>Slug</dt><dd><pre>${escapeHtml(registration.slug)}</pre></dd>
<dt>Client id</dt><dd><pre>${escapeHtml(registration.clientId)}</pre></dd>
<dt>Client secret</dt><dd><pre>${escapeHtml(registration.clientSecret)}</pre></dd>
<dt>Private key (PEM)</dt><dd><pre>${escapeHtml(registration.pem)}</pre></dd>
</dl>
<h1>One step left: install the App</h1>
<p>The credential triple needs the installation id, which only exists once the
App is installed on an account or repository. Open
<a href="${escapeHtml(installUrl)}">${escapeHtml(installUrl)}</a>,
pick the account/repos warren may touch, and read the installation id from the
URL GitHub lands on (<code>.../settings/installations/&lt;id&gt;</code>).</p>
<h1>Environment</h1>
<pre>${escapeHtml(envBlock)}</pre>
<p class="note">Set these on the warren process (K8s: the <code>warren-secrets</code>
Secret, see docs/RUNBOOK-K8S.md) and restart. A missing or unparseable value
fails boot loudly.</p>`;
	return page("GitHub App credentials", body);
}

/** A registration-flow failure page (bad state, spent code, upstream error). */
export function renderRegistrationErrorPage(title: string, detail: string): string {
	const body = `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
<p class="note">Start over at <code>/github-app/register</code>.</p>`;
	return page(title, body);
}
