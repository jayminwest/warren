import { describe, expect, test } from "bun:test";
import { RegistrationSessions } from "../../forge/github-app/registration.ts";
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

describe("registerGitHubAppHandler", () => {
	test("renders the manifest form aimed at the callback on the same origin", async () => {
		const handler = registerGitHubAppHandler({
			sessions: new RegistrationSessions(
				() => 1000,
				60000,
				() => "nonce-1",
			),
			random: () => "abc123",
		});
		const res = await handler(ctxFor(`${BASE}/github-app/register`));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(res.headers.get("content-security-policy")).toContain("form-action https://github.com");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const html = await res.text();
		expect(html).toContain(`${BASE}/github-app/callback`);
		expect(html).toContain("nonce-1");
		expect(html).toContain("warren-forge-abc123");
		expect(html).toContain('action="https://github.com/settings/apps/new?state=nonce-1"');
	});

	test("?name= overrides the generated App name", async () => {
		const handler = registerGitHubAppHandler({
			sessions: new RegistrationSessions(
				() => 1000,
				60000,
				() => "nonce-1",
			),
		});
		const res = await handler(ctxFor(`${BASE}/github-app/register?name=my-forge`));
		const html = await res.text();
		expect(html).toContain("my-forge");
	});

	test("?org= retargets the form at the organization's create endpoint", async () => {
		const handler = registerGitHubAppHandler({
			sessions: new RegistrationSessions(
				() => 1000,
				60000,
				() => "nonce-1",
			),
		});
		const res = await handler(ctxFor(`${BASE}/github-app/register?org=os-eco`));
		const html = await res.text();
		expect(html).toContain(
			'action="https://github.com/organizations/os-eco/settings/apps/new?state=nonce-1"',
		);
	});

	test("an implausible ?org= is refused with 400", async () => {
		const handler = registerGitHubAppHandler({
			sessions: new RegistrationSessions(
				() => 1000,
				60000,
				() => "nonce-1",
			),
		});
		const res = await handler(ctxFor(`${BASE}/github-app/register?org=evil.com/x`));
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain("Invalid org");
	});
});

describe("gitHubAppCallbackHandler", () => {
	const conversionBody = {
		id: 4560297,
		slug: "warren-test-app",
		name: "warren-test-app",
		html_url: "https://github.com/apps/warren-test-app",
		client_id: "Iv1.0123456789abcdef",
		client_secret: "client-secret-value",
		pem: "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----\n",
	};

	function sessionsWith(state: string): RegistrationSessions {
		const sessions = new RegistrationSessions(
			() => 1000,
			60000,
			() => state,
		);
		sessions.begin();
		return sessions;
	}

	test("missing code or state is a 400, never a 401/403", async () => {
		const handler = gitHubAppCallbackHandler({ sessions: new RegistrationSessions() });
		const res = await handler(ctxFor(`${BASE}/github-app/callback`));
		expect(res.status).toBe(400);
		expect(res.status).not.toBe(403);
		expect(res.status).not.toBe(401);
	});

	test("an unknown or spent state is a 400 and converts nothing", async () => {
		let fetchCalls = 0;
		const fetchStub: typeof fetch = (async () => {
			fetchCalls += 1;
			return new Response("{}", { status: 201 });
		}) as unknown as typeof fetch;
		const handler = gitHubAppCallbackHandler({
			sessions: new RegistrationSessions(),
			fetch: fetchStub,
		});
		const res = await handler(ctxFor(`${BASE}/github-app/callback?code=c1&state=never-issued`));
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Unknown or expired state");
		expect(fetchCalls).toBe(0);
	});

	test("a live state converts the code and renders the credentials once", async () => {
		const sessions = sessionsWith("nonce-live");
		const fetchStub: typeof fetch = (async () =>
			new Response(JSON.stringify(conversionBody), { status: 201 })) as unknown as typeof fetch;
		const handler = gitHubAppCallbackHandler({ sessions, fetch: fetchStub });
		const res = await handler(ctxFor(`${BASE}/github-app/callback?code=c1&state=nonce-live`));
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("WARREN_GITHUB_APP_ID=4560297");
		expect(html).toContain("client-secret-value");
		expect(html).toContain("BEGIN RSA PRIVATE KEY");
		// Single-use: the replay is refused without another conversion call.
		const replay = await handler(ctxFor(`${BASE}/github-app/callback?code=c1&state=nonce-live`));
		expect(replay.status).toBe(400);
	});

	test("a conversion failure renders the upstream detail as 502", async () => {
		const sessions = sessionsWith("nonce-live");
		const fetchStub: typeof fetch = (async () =>
			new Response("gone", { status: 404 })) as unknown as typeof fetch;
		const handler = gitHubAppCallbackHandler({ sessions, fetch: fetchStub });
		const res = await handler(ctxFor(`${BASE}/github-app/callback?code=spent&state=nonce-live`));
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("single-use");
	});
});

describe("gitHubAppInstalledHandler", () => {
	test("renders the installation id from the query string", async () => {
		const handler = gitHubAppInstalledHandler();
		const res = await handler(
			ctxFor(`${BASE}/github-app/installed?installation_id=12345678&setup_action=install`),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
		const html = await res.text();
		expect(html).toContain("WARREN_GITHUB_APP_INSTALLATION_ID=12345678");
	});

	test("missing params render the fallback page, never a 500 or 401/403", async () => {
		const handler = gitHubAppInstalledHandler();
		const res = await handler(ctxFor(`${BASE}/github-app/installed`));
		expect(res.status).toBe(200);
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(403);
		const html = await res.text();
		expect(html).toContain("Installation id not on this URL");
	});

	test("a malformed installation_id falls back instead of rendering junk", async () => {
		const handler = gitHubAppInstalledHandler();
		const res = await handler(ctxFor(`${BASE}/github-app/installed?installation_id=abc';drop`));
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Installation id not on this URL");
		expect(html).not.toContain("abc';drop");
	});
});
