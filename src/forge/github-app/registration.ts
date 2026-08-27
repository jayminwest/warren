/**
 * GitHub App manifest registration flow (warren-a647, plan pl-d1c9 step 17,
 * forge-contract.md §7 Q1/Q2).
 *
 * How an operator mints the `WARREN_GITHUB_APP_*` credential triple without
 * ever hand-assembling an App in the GitHub UI:
 *
 *   1. `GET /github-app/register` renders a page carrying an App MANIFEST
 *      (name, homepage, loopback `redirect_url`, `setup_url`, and the
 *      permission set the forge needs) as a single form field. The random
 *      `state` nonce rides the form's ACTION URL as a query parameter —
 *      GitHub's manifest schema rejects a `state` key inside the manifest
 *      itself (`"state" is not a permitted key`, hit live 2026-08-13).
 *   2. GitHub creates the App under the operator's own account and redirects
 *      the browser to the manifest's `redirect_url` — warren's
 *      `GET /github-app/callback` — with `?code=…&state=…`. Q1 (spike
 *      warren-bc4c): a loopback `redirect_url` IS accepted and the
 *      query-parameter `state` round-trips intact, so the flow works behind NAT.
 *   3. The callback validates `state` against the single-use, short-TTL
 *      {@link RegistrationSessions} store, then converts the code:
 *      `POST /app-manifests/{code}/conversions`. Q2 (same spike): that call
 *      needs NO authentication, the code is single-use, and the response
 *      carries the App id, slug, PEM private key, and client id/secret — the
 *      whole credential set the `app` forge arm consumes, rendered once for
 *      the operator to copy into their secret store.
 *   4. Installing the App redirects to the manifest's `setup_url` (`/github-app/installed`) with the installation id (warren-54c7).
 *
 * Nothing here persists BY DEFAULT: the converted credentials exist only in
 * the rendered callback page, and the pending `state` nonces live in process
 * memory with a ten-minute TTL — a restart mid-flow just means starting over.
 * The warren-b504 opt-in credential store (WARREN_APP_CRED_STORE=data-dir,
 * ./credential-store.ts) is the one exception: on an armed deployment the
 * callback persists the App half and the install return route completes and
 * activates the forge in-process.
 *
 * This module is the domain half; the HTTP surface lives in
 * `src/server/handlers/github-app.ts` (seam stays forge-inward, warren-89a6).
 */

import { getRandomValues } from "node:crypto";
import { GITHUB_API_BASE } from "../github/headers.ts";
import { renderRegistrationChrome } from "./page-chrome.ts";

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
 *
 * `workflows` write: GitHub rejects ANY App-token push that creates or
 * updates a file under `.github/workflows/` unless the App holds it —
 * the whole push is refused, not just the workflow file. Agents
 * legitimately author workflows (run_qfc0xxgytf1p lost its branch to
 * this on the first dogfood day, 2026-08-13); a classic PAT's `workflow`
 * scope covered it silently in PAT mode. Operators of an App registered
 * before this permission was added must grant it in the App's settings
 * AND approve the permission request on the installation.
 */
export const GITHUB_APP_MANIFEST_PERMISSIONS = {
	contents: "write",
	pull_requests: "write",
	checks: "read",
	metadata: "read",
	workflows: "write",
} as const;

/**
 * The manifest POSTed to GitHub's create page (a subset of its schema).
 * Deliberately NO `state` field: GitHub validates the manifest against a
 * closed schema and refuses unknown keys — the CSRF nonce travels as a
 * `?state=` query parameter on the create URL instead (see
 * {@link renderRegistrationPage}).
 */
export interface GitHubAppManifest {
	readonly name: string;
	readonly url: string;
	readonly redirect_url: string;
	readonly setup_url: string;
	readonly public: boolean;
	readonly default_permissions: typeof GITHUB_APP_MANIFEST_PERMISSIONS;
}

export function buildGitHubAppManifest(input: {
	readonly name: string;
	readonly homepageUrl: string;
	readonly redirectUrl: string;
	readonly setupUrl: string;
}): GitHubAppManifest {
	return {
		name: input.name,
		url: input.homepageUrl,
		redirect_url: input.redirectUrl,
		// warren-54c7: GitHub redirects here after INSTALLATION with
		// ?installation_id=<id>&setup_action=install appended, so the last
		// credential-triple value comes home on its own. Verified against
		// GitHub's manifest schema docs — a documented key, unlike `state`.
		setup_url: input.setupUrl,
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

/**
 * Default cap on live pending nonces (warren-e320). The routes minting
 * them are `anonymous` policy, so without a bound a stranger could grow
 * the process-local store without limit inside the TTL window — and each
 * live nonce enables one outbound `POST /app-manifests/{code}/conversions`
 * from warren's egress. Capping the store transitively bounds outbound
 * conversions to this many per TTL window.
 */
export const REGISTRATION_STATE_MAX_PENDING = 32;

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
		private readonly maxPending: number = REGISTRATION_STATE_MAX_PENDING,
	) {}

	begin(): string {
		this.sweep();
		// warren-e320: bound the store — evict the OLDEST live nonce once the
		// cap is reached (Map iteration is insertion-ordered, so the first key
		// is the oldest). Evict-oldest rather than refuse: a flood then burns
		// the flooder's own earlier nonces, not the operator's in-flight one
		// ... unless the flood IS the only traffic, in which case either
		// policy bounds the store the same.
		while (this.pending.size >= this.maxPending) {
			const oldest = this.pending.keys().next();
			if (oldest.done) break;
			this.pending.delete(oldest.value);
		}
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

/**
 * Shared chrome for every page in this flow (warren-4f1e): the layout,
 * brand header, and design tokens live once in `page-chrome.ts`, mirrored
 * from the SPA's Direction C dark tokens. `body` is trusted, already-escaped
 * markup from the renderers below; `title` is plain text escaped here.
 */
function page(title: string, body: string): string {
	return renderRegistrationChrome(escapeHtml(title), body);
}

/**
 * The register page: the manifest rides a single hidden `manifest` form
 * field; pressing the button POSTs it to GitHub's create page. The CSRF
 * `state` nonce goes on the action URL as a query parameter — GitHub echoes
 * it back on the callback redirect but refuses it inside the manifest. No
 * inline script — the page's CSP forbids it, and a visible button means the
 * operator sees exactly what is about to be created before they commit.
 */
export function renderRegistrationPage(input: {
	readonly manifest: GitHubAppManifest;
	readonly createUrl: string;
	readonly state: string;
	/**
	 * warren-b504: true when the opt-in credential store is armed — the
	 * footer then tells the truth about persistence. Default false keeps
	 * the page byte-identical to the historical no-promise.
	 */
	readonly storesCredential?: boolean;
}): string {
	const manifestJson = escapeHtml(JSON.stringify(input.manifest));
	const actionUrl = `${input.createUrl}?state=${encodeURIComponent(input.state)}`;
	const body = `<h1>Register a GitHub App for warren</h1>
<p>This form creates a private GitHub App under your account with exactly the
permissions warren's App forge needs (contents: write, pull-requests: write,
workflows: write, checks: read). Pressing the button hands this manifest to
GitHub:</p>
<pre>${escapeHtml(JSON.stringify(input.manifest, null, 2))}</pre>
<form method="post" action="${escapeHtml(actionUrl)}">
<input type="hidden" name="manifest" value="${manifestJson}">
<button type="submit">Create the GitHub App on github.com</button>
</form>
<p>The link this form hands to GitHub carries a <strong>single-use nonce
that expires in 10 minutes</strong> — move through the GitHub step promptly.
If it stalls or expires, just reload <code>/github-app/register</code> and
start again.</p>
<p><strong>Manual-form trap:</strong> the button should land on GitHub's
pre-filled confirmation page for this exact manifest. If GitHub instead
shows the full &ldquo;Register new GitHub App&rdquo; form asking you to pick
permissions by hand, <strong>back out and restart here</strong> — filling
that form in manually creates an App that never redirects back to warren.</p>
<p class="note">${
		input.storesCredential === true
			? "GitHub returns you here with a single-use code. warren stores the App credential under its data dir (mode 0600) and activates the App forge once you install the App."
			: "GitHub returns you here with a single-use code; warren converts it into the App credentials and shows them to you once. Nothing is stored."
	}</p>`;
	return page("Register a GitHub App", body);
}

/**
 * The callback page: the converted credential set, rendered once. The PEM
 * is shown verbatim (the operator pastes it into their secret store; the
 * forge unfolds literal `\n` sequences if their store needs the single-line
 * form). The install link lands on GitHub's installation flow; the manifest's
 * `setup_url` then brings the browser back to `/github-app/installed` with
 * the installation id on the query string (warren-54c7). The manual
 * URL-scavenging instructions stay as fallback.
 */
export function renderCredentialsPage(registration: GitHubAppRegistration): string {
	const installUrl = `https://github.com/apps/${registration.slug}/installations/new`;
	const envBlock = [
		"WARREN_FORGE=app",
		`WARREN_GITHUB_APP_ID=${registration.appId}`,
		"WARREN_GITHUB_APP_INSTALLATION_ID=<from the install step below>",
		"WARREN_GITHUB_APP_PRIVATE_KEY=<the PEM below>",
	].join("\n");
	const k8sBlock = [
		"kubectl -n warren patch secret warren-secrets --type merge -p \\",
		'  \'{"stringData":{"warren-forge":"app",',
		`    "github-app-id":"${registration.appId}",`,
		'    "github-app-installation-id":"<from the install step below>",',
		'    "github-app-private-key":"<the PEM below, as ONE line with literal \\n escapes>"}}\'',
	].join("\n");
	const composeBlock = [
		"environment:",
		"  WARREN_FORGE: app",
		`  WARREN_GITHUB_APP_ID: "${registration.appId}"`,
		'  WARREN_GITHUB_APP_INSTALLATION_ID: "<from the install step below>"',
		'  WARREN_GITHUB_APP_PRIVATE_KEY: "<the PEM below>"',
	].join("\n");
	const body = `<h1>App registered: ${escapeHtml(registration.name)}</h1>
<p>Copy these values into your secret store NOW — warren keeps no copy, and
this page is the only place they appear.</p>
<dl>
<dt>App id</dt><dd><pre>${registration.appId}</pre></dd>
<dt>Slug</dt><dd><pre>${escapeHtml(registration.slug)}</pre></dd>
<dt>Client id</dt><dd><pre>${escapeHtml(registration.clientId)}</pre></dd>
<p class="note">warren does NOT use the client id or client secret — only the
App id, installation id, and private key matter. These two are shown only
because GitHub returns them; you do not need to store them.</p>
<dt>Client secret</dt><dd><pre>${escapeHtml(registration.clientSecret)}</pre></dd>
<dt>Private key (PEM)</dt><dd><pre>${escapeHtml(registration.pem)}</pre></dd>
</dl>
<h1>One step left: install the App</h1>
<p>The credential triple needs the installation id, which only exists once the
App is installed. Open
<a href="${escapeHtml(installUrl)}">${escapeHtml(installUrl)}</a>
and pick the account/repos warren may touch. When the install finishes GitHub
returns you to warren (<code>/github-app/installed</code>) with the id on the
query string and the secret-store blocks completed. If that redirect can't
reach this warren, read the id by hand from the URL GitHub lands on
(<code>.../settings/installations/&lt;id&gt;</code>) and use the blocks below.</p>
<h1>Install the secrets</h1>
<p>Pick the block matching your deploy shape and paste it as-is. warren can't
know your deploy shape, so this step stays manual — each variant is one paste.</p>
<h2>Kubernetes (the <code>warren-secrets</code> Secret, see docs/RUNBOOK-K8S.md)</h2>
<pre>${escapeHtml(k8sBlock)}</pre>
<p class="note">The private key goes in as ONE line with literal
<code>\n</code> escapes — warren unfolds them at boot. If you saved the PEM
to a file, join its lines with two-character <code>\n</code> sequences
first.</p>
<h2>docker compose (<code>environment:</code> on the warren service)</h2>
<pre>${escapeHtml(composeBlock)}</pre>
<h2>Plain <code>.env</code></h2>
<pre>${escapeHtml(envBlock)}</pre>
<p class="note">Set these on the warren process and restart. A missing or
unparseable value fails boot loudly.</p>`;
	return page("GitHub App credentials", body);
}

/**
 * The installed page (warren-54c7): the manifest `setup_url` target. GitHub
 * appends `?installation_id=<id>&setup_action=install`, so this page renders
 * the id plus the secret-store blocks with it filled in (App id and PEM stay
 * placeholders — they appeared once on the credentials page). A missing or
 * malformed id renders the fallback manual instructions, not an error: the
 * install already happened on GitHub's side, so a 500 only strands harder.
 */
export function renderInstalledPage(input: { readonly installationId: string | null }): string {
	const id = input.installationId ?? "<from .../settings/installations/<id>>";
	const envBlock = [
		"WARREN_FORGE=app",
		"WARREN_GITHUB_APP_ID=<the App id from the credentials page>",
		`WARREN_GITHUB_APP_INSTALLATION_ID=${id}`,
		"WARREN_GITHUB_APP_PRIVATE_KEY=<the PEM from the credentials page>",
	].join("\n");
	const k8sBlock = [
		"kubectl -n warren patch secret warren-secrets --type merge -p \\",
		'  \'{"stringData":{"warren-forge":"app",',
		'    "github-app-id":"<the App id from the credentials page>",',
		`    "github-app-installation-id":"${id}",`,
		'    "github-app-private-key":"<the PEM, as ONE line with literal \\n escapes>"}}\'',
	].join("\n");
	const composeBlock = [
		"environment:",
		"  WARREN_FORGE: app",
		'  WARREN_GITHUB_APP_ID: "<the App id from the credentials page>"',
		`  WARREN_GITHUB_APP_INSTALLATION_ID: "${id}"`,
		'  WARREN_GITHUB_APP_PRIVATE_KEY: "<the PEM from the credentials page>"',
	].join("\n");
	const idSection =
		input.installationId === null
			? `<h1>Installation id not on this URL</h1>
<p>GitHub normally appends <code>?installation_id=&lt;id&gt;</code> to this
redirect, but this visit has none warren can read. The install still went
through — find the id by hand under your account's <code>Settings &rarr;
Applications &rarr; Configure</code> (the URL reads
<code>.../settings/installations/&lt;id&gt;</code>) and paste it below.</p>`
			: `<h1>App installed — installation id</h1>
<pre>${escapeHtml(input.installationId)}</pre>
<p>This is the last value the credential triple needed. The blocks below
have it filled in; the App id and private key come from the credentials page
warren showed you right after the App was created.</p>`;
	const body = `${idSection}
<h1>Install the secrets</h1>
<p>Pick the block matching your deploy shape and paste it as-is, substituting the
two values from the credentials page.</p>
<h2>Kubernetes (the <code>warren-secrets</code> Secret, see docs/RUNBOOK-K8S.md)</h2>
<pre>${escapeHtml(k8sBlock)}</pre>
<p class="note">The private key goes in as ONE line with literal
<code>\n</code> escapes — warren unfolds them at boot.</p>
<h2>docker compose (<code>environment:</code> on the warren service)</h2>
<pre>${escapeHtml(composeBlock)}</pre>
<h2>Plain <code>.env</code></h2>
<pre>${escapeHtml(envBlock)}</pre>
<p class="note">Set these on the warren process and restart. A missing or
unparseable value fails boot loudly.</p>`;
	return page("GitHub App installed", body);
}

/** A registration-flow failure page (bad state, spent code, upstream error). */
export function renderRegistrationErrorPage(title: string, detail: string): string {
	const body = `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
<p class="note">Start over at <code>/github-app/register</code>.</p>`;
	return page(title, body);
}
