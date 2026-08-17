import { describe, expect, test } from "bun:test";
import {
	buildGitHubAppManifest,
	convertManifestCode,
	escapeHtml,
	GITHUB_APP_MANIFEST_CREATE_URL,
	GITHUB_APP_MANIFEST_PERMISSIONS,
	gitHubOrgManifestCreateUrl,
	REGISTRATION_STATE_MAX_PENDING,
	REGISTRATION_STATE_TTL_MS,
	RegistrationSessions,
	renderCredentialsPage,
	renderInstalledPage,
	renderRegistrationErrorPage,
	renderRegistrationPage,
} from "./registration.ts";

describe("buildGitHubAppManifest", () => {
	test("packs the redirect and the forge's permission set, with NO state key", () => {
		const manifest = buildGitHubAppManifest({
			name: "warren-test",
			homepageUrl: "https://example.test/",
			redirectUrl: "http://127.0.0.1:8377/github-app/callback",
			setupUrl: "http://127.0.0.1:8377/github-app/installed",
		});
		expect(manifest).toEqual({
			name: "warren-test",
			url: "https://example.test/",
			redirect_url: "http://127.0.0.1:8377/github-app/callback",
			setup_url: "http://127.0.0.1:8377/github-app/installed",
			public: false,
			default_permissions: GITHUB_APP_MANIFEST_PERMISSIONS,
		});
	});

	test("the permission set is contents+pull-requests+workflows write, checks read", () => {
		expect(GITHUB_APP_MANIFEST_PERMISSIONS).toEqual({
			contents: "write",
			pull_requests: "write",
			checks: "read",
			metadata: "read",
			workflows: "write",
		});
	});
});

describe("manifest create URLs", () => {
	test("the personal-account endpoint is the default", () => {
		expect(GITHUB_APP_MANIFEST_CREATE_URL).toBe("https://github.com/settings/apps/new");
	});

	test("the org variant names the organization", () => {
		expect(gitHubOrgManifestCreateUrl("os-eco")).toBe(
			"https://github.com/organizations/os-eco/settings/apps/new",
		);
	});
});

describe("convertManifestCode", () => {
	const conversionBody = {
		id: 4560297,
		slug: "warren-test-app",
		name: "warren-test-app",
		html_url: "https://github.com/apps/warren-test-app",
		client_id: "Iv1.0123456789abcdef",
		client_secret: "client-secret-value",
		pem: "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----\n",
	};

	test("POSTs the conversion with NO Authorization header (spike Q2)", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetchStub: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return new Response(JSON.stringify(conversionBody), { status: 201 });
		}) as unknown as typeof fetch;
		const result = await convertManifestCode("code-123", { fetch: fetchStub });
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.url).toBe("https://api.github.com/app-manifests/code-123/conversions");
		expect(call?.init?.method).toBe("POST");
		const headers = new Headers(call?.init?.headers);
		expect(headers.has("authorization")).toBe(false);
	});

	test("parses the credential set out of the conversion body", async () => {
		const fetchStub: typeof fetch = (async () =>
			new Response(JSON.stringify(conversionBody), { status: 201 })) as unknown as typeof fetch;
		const result = await convertManifestCode("code-123", { fetch: fetchStub });
		if (!result.ok) throw new Error("expected ok");
		expect(result.registration).toEqual({
			appId: 4560297,
			slug: "warren-test-app",
			name: "warren-test-app",
			htmlUrl: "https://github.com/apps/warren-test-app",
			clientId: "Iv1.0123456789abcdef",
			clientSecret: "client-secret-value",
			pem: "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----\n",
		});
	});

	test("a 404 (spent or unknown code) fails with a start-over hint", async () => {
		const fetchStub: typeof fetch = (async () =>
			new Response("not found", { status: 404 })) as unknown as typeof fetch;
		const result = await convertManifestCode("spent-code", { fetch: fetchStub });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.status).toBe(404);
		expect(result.detail).toContain("single-use");
	});

	test("a non-404 upstream failure reports the status", async () => {
		const fetchStub: typeof fetch = (async () =>
			new Response("boom", { status: 500 })) as unknown as typeof fetch;
		const result = await convertManifestCode("code-123", { fetch: fetchStub });
		expect(result).toMatchObject({ ok: false, status: 500 });
	});

	test("a network error fails closed rather than throwing", async () => {
		const fetchStub: typeof fetch = (async () => {
			throw new Error("socket hangup");
		}) as unknown as typeof fetch;
		const result = await convertManifestCode("code-123", { fetch: fetchStub });
		expect(result).toMatchObject({ ok: false, status: 0 });
	});

	test("a response missing a credential field is a failure, not a partial", async () => {
		const { pem: _pem, ...missingPem } = conversionBody;
		const fetchStub: typeof fetch = (async () =>
			new Response(JSON.stringify(missingPem), { status: 201 })) as unknown as typeof fetch;
		const result = await convertManifestCode("code-123", { fetch: fetchStub });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.detail).toContain("pem");
	});
});

describe("RegistrationSessions", () => {
	test("a nonce redeems exactly once", () => {
		const sessions = new RegistrationSessions(
			() => 1000,
			60000,
			() => "nonce-a",
		);
		const state = sessions.begin();
		expect(state).toBe("nonce-a");
		expect(sessions.consume(state)).toBe(true);
		expect(sessions.consume(state)).toBe(false);
	});

	test("an unknown nonce never redeems", () => {
		const sessions = new RegistrationSessions();
		expect(sessions.consume("never-issued")).toBe(false);
	});

	test("an expired nonce refuses and is swept", () => {
		let clock = 1000;
		const sessions = new RegistrationSessions(
			() => clock,
			60000,
			() => "nonce-b",
		);
		const state = sessions.begin();
		clock += 60001;
		expect(sessions.consume(state)).toBe(false);
		expect(sessions.size).toBe(0);
	});

	test("the default TTL is ten minutes", () => {
		expect(REGISTRATION_STATE_TTL_MS).toBe(600_000);
	});

	test("the store is capped — begin() evicts the oldest live nonce past the cap (warren-e320)", () => {
		let n = 0;
		const sessions = new RegistrationSessions(
			() => 1000,
			60000,
			() => `nonce-${n++}`,
			3,
		);
		const first = sessions.begin();
		sessions.begin();
		sessions.begin();
		expect(sessions.size).toBe(3);
		// The fourth begin() evicts the oldest (first) nonce.
		const fourth = sessions.begin();
		expect(sessions.size).toBe(3);
		expect(sessions.consume(first)).toBe(false);
		expect(sessions.consume(fourth)).toBe(true);
	});

	test("the default cap is 32 (warren-e320)", () => {
		expect(REGISTRATION_STATE_MAX_PENDING).toBe(32);
		let n = 0;
		const sessions = new RegistrationSessions(Date.now, 60000, () => `nonce-${n++}`);
		for (let i = 0; i < REGISTRATION_STATE_MAX_PENDING + 10; i++) {
			sessions.begin();
		}
		expect(sessions.size).toBe(REGISTRATION_STATE_MAX_PENDING);
	});
});

describe("escapeHtml", () => {
	test("escapes the five HTML-significant characters", () => {
		expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
	});
});

describe("renderRegistrationPage", () => {
	test("carries the manifest as the form's hidden field and the state on the action URL", () => {
		const manifest = buildGitHubAppManifest({
			name: "warren-test",
			homepageUrl: "https://example.test/",
			redirectUrl: "http://127.0.0.1:8377/github-app/callback",
			setupUrl: "http://127.0.0.1:8377/github-app/installed",
		});
		const html = renderRegistrationPage({
			manifest,
			createUrl: GITHUB_APP_MANIFEST_CREATE_URL,
			state: "nonce-1",
		});
		expect(html).toContain('action="https://github.com/settings/apps/new?state=nonce-1"');
		expect(html).toContain('name="manifest"');
		// GitHub's manifest schema refuses a state key — it must never appear
		// inside the manifest JSON (hit live 2026-08-13).
		expect(html).not.toContain("&quot;state&quot;");
		expect(html).toContain("http://127.0.0.1:8377/github-app/callback");
	});

	test("states the single-use, 10-minute nonce TTL and the manual-form trap", () => {
		const manifest = buildGitHubAppManifest({
			name: "warren-test",
			homepageUrl: "https://example.test/",
			redirectUrl: "http://127.0.0.1:8377/github-app/callback",
			setupUrl: "http://127.0.0.1:8377/github-app/installed",
		});
		const html = renderRegistrationPage({
			manifest,
			createUrl: GITHUB_APP_MANIFEST_CREATE_URL,
			state: "nonce-1",
		});
		expect(html).toContain("single-use");
		expect(html).toContain("10 minutes");
		expect(html).toContain("/github-app/register");
		expect(html).toContain("back out and restart");
	});

	test("escapes a hostile manifest name in both renderings", () => {
		const manifest = buildGitHubAppManifest({
			name: '"><script>alert(1)</script>',
			homepageUrl: "https://example.test/",
			redirectUrl: "http://127.0.0.1:8377/github-app/callback",
			setupUrl: "http://127.0.0.1:8377/github-app/installed",
		});
		const html = renderRegistrationPage({
			manifest,
			createUrl: GITHUB_APP_MANIFEST_CREATE_URL,
			state: "nonce-1",
		});
		expect(html).not.toContain("<script>alert(1)</script>");
	});
});

describe("renderCredentialsPage", () => {
	const registration = {
		appId: 4560297,
		slug: "warren-test-app",
		name: "warren-test-app",
		htmlUrl: "https://github.com/apps/warren-test-app",
		clientId: "Iv1.0123456789abcdef",
		clientSecret: "client-secret-value",
		pem: "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----\n",
	};

	test("renders the whole credential set plus the env block and install link", () => {
		const html = renderCredentialsPage(registration);
		expect(html).toContain("4560297");
		expect(html).toContain("warren-test-app");
		expect(html).toContain("client-secret-value");
		expect(html).toContain("BEGIN RSA PRIVATE KEY");
		expect(html).toContain("WARREN_FORGE=app");
		expect(html).toContain("WARREN_GITHUB_APP_ID=4560297");
		expect(html).toContain("WARREN_GITHUB_APP_INSTALLATION_ID");
		expect(html).toContain("WARREN_GITHUB_APP_PRIVATE_KEY");
		expect(html).toContain("https://github.com/apps/warren-test-app/installations/new");
	});

	test("renders copy-paste secret blocks per deploy shape, with the App id pre-filled", () => {
		const html = renderCredentialsPage(registration);
		// K8s: kubectl patch against the RUNBOOK secret and key names.
		expect(html).toContain("kubectl -n warren patch secret warren-secrets");
		expect(html).toContain(
			"&#39;{&quot;stringData&quot;:{&quot;warren-forge&quot;:&quot;app&quot;,",
		);
		expect(html).toContain("&quot;github-app-id&quot;:&quot;4560297&quot;");
		expect(html).toContain("&quot;github-app-installation-id&quot;");
		expect(html).toContain("&quot;github-app-private-key&quot;");
		// docker compose environment: block.
		expect(html).toContain("environment:");
		expect(html).toContain("WARREN_FORGE: app");
		expect(html).toContain("WARREN_GITHUB_APP_ID: &quot;4560297&quot;");
		// .env block already covered by the test above.
	});

	test("notes that client id/secret are unused by warren", () => {
		const html = renderCredentialsPage(registration);
		expect(html).toContain("does NOT use the client id or client secret");
	});

	test("escapes HTML metacharacters in App fields", () => {
		const html = renderCredentialsPage({ ...registration, name: "<b>x</b>" });
		expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
	});
});

describe("renderRegistrationErrorPage", () => {
	test("escapes the title and detail and points back at /register", () => {
		const html = renderRegistrationErrorPage("<bad>", "detail <here>");
		expect(html).toContain("&lt;bad&gt;");
		expect(html).toContain("detail &lt;here&gt;");
		expect(html).toContain("/github-app/register");
	});
});

describe("shared page chrome (warren-4f1e)", () => {
	const manifest = buildGitHubAppManifest({
		name: "warren-test",
		homepageUrl: "https://example.test/",
		redirectUrl: "http://127.0.0.1:8377/github-app/callback",
		setupUrl: "http://127.0.0.1:8377/github-app/installed",
	});
	const pages: Array<[string, string]> = [
		[
			"register",
			renderRegistrationPage({
				manifest,
				createUrl: GITHUB_APP_MANIFEST_CREATE_URL,
				state: "nonce-1",
			}),
		],
		[
			"credentials",
			renderCredentialsPage({
				appId: 4560297,
				slug: "warren-test-app",
				name: "warren-test-app",
				htmlUrl: "https://github.com/apps/warren-test-app",
				clientId: "Iv1.0123456789abcdef",
				clientSecret: "client-secret-value",
				pem: "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----\n",
			}),
		],
		["installed", renderInstalledPage({ installationId: "87654321" })],
		["installed-fallback", renderInstalledPage({ installationId: null })],
		["error", renderRegistrationErrorPage("boom", "detail")],
	];

	test("every page renders through the shared chrome (brand header, inline style, main)", () => {
		for (const [name, html] of pages) {
			expect(html, name).toStartWith("<!doctype html>");
			expect(html, name).toContain('<html lang="en" data-theme="dark">');
			expect(html, name).toContain('<header><div class="brand">warren');
			expect(html, name).toContain("<main>");
			// The inline stylesheet carries the SPA dark tokens (oklch
			// neutrals and the brand green at 152 hue).
			expect(html, name).toContain("<style>");
			expect(html, name).toContain("oklch(72% 0.11 152)");
		}
	});

	test("no page carries a <script> tag — CSP default-src 'none' forbids it", () => {
		for (const [name, html] of pages) {
			expect(html.toLowerCase(), name).not.toContain("<script");
		}
	});

	test("no page fetches external assets (link/img/font-face/import)", () => {
		for (const [name, html] of pages) {
			expect(html.toLowerCase(), name).not.toContain("<link");
			expect(html.toLowerCase(), name).not.toContain("<img");
			expect(html, name).not.toContain("@font-face");
			expect(html, name).not.toContain("@import");
		}
	});
});

describe("renderInstalledPage", () => {
	test("renders the installation id into every secret-store block (warren-54c7)", () => {
		const html = renderInstalledPage({ installationId: "87654321" });
		expect(html).toContain("WARREN_GITHUB_APP_INSTALLATION_ID=87654321");
		expect(html).toContain("&quot;github-app-installation-id&quot;:&quot;87654321&quot;");
		expect(html).toContain("WARREN_GITHUB_APP_INSTALLATION_ID: &quot;87654321&quot;");
		// The App id and PEM were shown once on the credentials page; this
		// route never sees them, so they stay placeholders.
		expect(html).toContain("&lt;the App id from the credentials page&gt;");
		expect(html).toContain("&lt;the PEM");
	});

	test("a null installation id renders the manual fallback, not an error", () => {
		const html = renderInstalledPage({ installationId: null });
		expect(html).toContain("Installation id not on this URL");
		expect(html).toContain("settings/installations/");
		expect(html).toContain("WARREN_GITHUB_APP_INSTALLATION_ID=&lt;from");
	});
});
