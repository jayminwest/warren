/**
 * warren-b504: opt-in GitHub App credential persistence + hot forge
 * activation — handler-level tests for the armed-store paths. The
 * not-armed paths (byte-identical legacy pages) are covered in
 * `github-app.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import {
	GITHUB_APP_CREDENTIAL_FILE,
	GitHubAppCredentialStore,
} from "../../forge/github-app/credential-store.ts";
import { RegistrationSessions } from "../../forge/github-app/registration.ts";
import { generateTestAppKeyPair } from "../../forge/github-app/test-helpers.ts";
import { type GitHubAppActivation, HotForge } from "../../forge/hot-forge.ts";
import type { RouteContext } from "../types.ts";
import {
	gitHubAppCallbackHandler,
	gitHubAppInstalledHandler,
	registerGitHubAppHandler,
} from "./github-app.ts";

function ctxFor(url: string): RouteContext {
	return {
		request: new Request(url),
		url: new URL(url),
		params: {},
		requestId: "req-test",
		logger: {
			info() {},
			warn() {},
			error() {},
			debug() {},
			child() {
				return this;
			},
		} as unknown as RouteContext["logger"],
	};
}

const BASE = "http://127.0.0.1:8377";

function armedStore(): { activation: GitHubAppActivation; store: GitHubAppCredentialStore } {
	const dir = mkdtempSync(join(tmpdir(), "warren-appcred-handler-"));
	const store = new GitHubAppCredentialStore(join(dir, GITHUB_APP_CREDENTIAL_FILE));
	const hotForge = new HotForge(new FakeForge());
	return { activation: { store, hotForge }, store };
}

const conversionBody = (pem: string) => ({
	id: 4560297,
	slug: "warren-test-app",
	name: "warren-test-app",
	html_url: "https://github.com/apps/warren-test-app",
	client_id: "Iv1.0123456789abcdef",
	client_secret: "client-secret-value",
	pem,
});

function sessionsWith(state: string): RegistrationSessions {
	const sessions = new RegistrationSessions(
		() => 1000,
		60000,
		() => state,
	);
	sessions.begin();
	return sessions;
}

describe("registerGitHubAppHandler (store armed)", () => {
	test("the footer announces persistence instead of promising nothing is stored", async () => {
		const { activation } = armedStore();
		const handler = registerGitHubAppHandler({
			sessions: new RegistrationSessions(
				() => 1000,
				60000,
				() => "nonce-1",
			),
			activation,
		});
		const res = await handler(ctxFor(`${BASE}/github-app/register`));
		const html = await res.text();
		expect(html).toContain("warren stores the App credential");
		expect(html).not.toContain("Nothing is stored");
	});
});

describe("gitHubAppCallbackHandler (store armed)", () => {
	test("persists the App half and renders the stored page, not the env blocks", async () => {
		const { activation, store } = armedStore();
		const handler = gitHubAppCallbackHandler({
			sessions: sessionsWith("nonce-live"),
			activation,
			fetch: (async () =>
				new Response(
					JSON.stringify(
						conversionBody("-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----"),
					),
					{
						status: 201,
					},
				)) as unknown as typeof fetch,
		});
		const res = await handler(ctxFor(`${BASE}/github-app/callback?code=c1&state=nonce-live`));
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("warren stored the App credential");
		expect(html).not.toContain("WARREN_FORGE=app");
		const stored = store.read();
		expect(stored?.appId).toBe("4560297");
		expect(stored?.privateKey).toContain("BEGIN RSA PRIVATE KEY");
		expect(stored?.installationId).toBeUndefined();
	});

	test("re-registration overwrites the stored App half", async () => {
		const { activation, store } = armedStore();
		store.storeApp("1", "-----BEGIN RSA PRIVATE KEY-----\nOLD\n-----END RSA PRIVATE KEY-----");
		const fetchStub: typeof fetch = (async () =>
			new Response(
				JSON.stringify(
					conversionBody("-----BEGIN RSA PRIVATE KEY-----\nNEW\n-----END RSA PRIVATE KEY-----"),
				),
				{
					status: 201,
				},
			)) as unknown as typeof fetch;
		const handler = gitHubAppCallbackHandler({
			sessions: sessionsWith("n2"),
			activation,
			fetch: fetchStub,
		});
		await handler(ctxFor(`${BASE}/github-app/callback?code=c2&state=n2`));
		expect(store.read()).toEqual({
			appId: "4560297",
			privateKey: "-----BEGIN RSA PRIVATE KEY-----\nNEW\n-----END RSA PRIVATE KEY-----",
		});
	});
});

describe("gitHubAppInstalledHandler (store armed)", () => {
	test("completes the triple, activates the forge in-process, and renders connected", async () => {
		const { activation, store, ...rest } = armedStore();
		expect(rest).toEqual({});
		const keyPair = generateTestAppKeyPair();
		store.storeApp("4560297", keyPair.privateKeyPem);
		const handler = gitHubAppInstalledHandler({ activation });
		const res = await handler(
			ctxFor(`${BASE}/github-app/installed?installation_id=99123&setup_action=install`),
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Connected");
		expect(html).toContain("99123");
		expect(html).not.toContain("WARREN_GITHUB_APP_INSTALLATION_ID");
		expect(store.read()?.installationId).toBe("99123");
		expect(activation.hotForge.activated).toBe(true);
		expect(activation.hotForge.capabilities.credentialLifetime).toBe("short-lived");
	});

	test("an App stored but no readable id renders the store-aware manual fallback", async () => {
		const { activation, store } = armedStore();
		store.storeApp(
			"4560297",
			"-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----",
		);
		const handler = gitHubAppInstalledHandler({ activation });
		const res = await handler(ctxFor(`${BASE}/github-app/installed`));
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Installation id not on this URL");
		expect(html).toContain("installation_id=");
		// The forge is NOT activated from a partial triple.
		expect(activation.hotForge.activated).toBe(false);
	});

	test("no stored App renders the legacy manual page byte-identically", async () => {
		const { activation } = armedStore();
		const armed = await gitHubAppInstalledHandler({ activation })(
			ctxFor(`${BASE}/github-app/installed?installation_id=12345678`),
		);
		const bare = await gitHubAppInstalledHandler()(
			ctxFor(`${BASE}/github-app/installed?installation_id=12345678`),
		);
		expect(await armed.text()).toBe(await bare.text());
	});

	test("a corrupt stored key fails loud with a 500 page and no activation", async () => {
		const { activation, store } = armedStore();
		store.storeApp("4560297", "not a pem");
		const handler = gitHubAppInstalledHandler({ activation });
		const res = await handler(ctxFor(`${BASE}/github-app/installed?installation_id=99123`));
		expect(res.status).toBe(500);
		const html = await res.text();
		expect(html).toContain("App activation failed");
		expect(html).not.toContain("not a pem");
		expect(activation.hotForge.activated).toBe(false);
	});
});
