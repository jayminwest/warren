import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { PreviewAuth } from "../cookie.ts";
import { createPreviewProxyHandler } from "./index.ts";
import { fetchStub, setupProxyEnv } from "./test-helpers.ts";

describe("createPreviewProxyHandler (path mode)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;

	beforeEach(async () => {
		// Path mode runs against the warren origin: cookie scopes itself
		// per-runId via Path=/p/<id>/ (warren-edff). The proxy preamble
		// only HMAC-verifies the cookie value against runId — browser-
		// enforced Path scope is what isolates sibling-run sessions.
		({ db, repos, auth, runId } = await setupProxyEnv({ scope: "path", previewPort: 30200 }));
	});

	afterEach(async () => {
		await db.close();
	});

	function buildPathRequest(opts: {
		path: string;
		cookie?: string | null;
		method?: string;
		extraHeaders?: Record<string, string>;
	}): { request: Request; url: URL } {
		const headers: Record<string, string> = {
			host: "warren.example.com",
			...(opts.extraHeaders ?? {}),
		};
		if (opts.cookie !== undefined && opts.cookie !== null) headers.cookie = opts.cookie;
		const request = new Request(`http://warren.example.com${opts.path}`, {
			method: opts.method ?? "GET",
			headers,
		});
		const url = new URL(request.url);
		return { request, url };
	}

	function validCookieFor(thisRunId: string, now: Date): string {
		const c = auth.signCookie(thisRunId, now);
		return `${c.name}=${c.value}`;
	}

	test("returns null for paths that don't start with /p/<id>", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const cases = ["/", "/runs/abc", "/p", "/p/", "/projects/list"];
		for (const path of cases) {
			const { request, url } = buildPathRequest({ path });
			expect(await handler(request, url)).toBeNull();
		}
	});

	test("subdomain-shaped Host on a non-preview path returns null in path mode", async () => {
		// In path mode the Host header is irrelevant — only the path
		// matters. A request to /runs/foo with a run-x.<host> Host
		// must fall through to the normal pipeline.
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const request = new Request(`http://run-${runId}.preview.warren.example.com/runs/x`, {
			headers: { host: `run-${runId}.preview.warren.example.com` },
		});
		const url = new URL(request.url);
		expect(await handler(request, url)).toBeNull();
	});

	test("404 for unknown runId in /p/<unknown>/", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({ path: "/p/run_doesnotexist/" });
		const res = await handler(request, url);
		expect(res?.status).toBe(404);
	});

	test("501 cross-host (worker_id !== local) with R-12 deferral message", async () => {
		await repos.runs.attachBurrow(runId, { workerId: "remote-worker-2" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({ path: `/p/${runId}/` });
		const res = await handler(request, url);
		expect(res?.status).toBe(501);
		const body = (await res?.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("preview_remote_worker");
		expect(body.error.message).toContain("R-12");
	});

	test("503 when preview_state is not live", async () => {
		await repos.runs.attachPreview(runId, { previewState: "starting" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(503);
	});

	test("401 when cookie is missing — never 200, never 502", async () => {
		let upstreamCalled = false;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => {
				upstreamCalled = true;
				return new Response("upstream");
			}),
		});
		const { request, url } = buildPathRequest({ path: `/p/${runId}/` });
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
		expect(upstreamCalled).toBe(false);
		const body = (await res?.json()) as { error: { code: string; hint: string } };
		expect(body.error.code).toBe("preview_unauthorized");
		// Path-mode hint points at the warren origin from the request.
		expect(body.error.hint).toContain(`/runs/${runId}/preview/login`);
		expect(body.error.hint).toContain(`/p/${runId}/`);
	});

	test("401 when cookie is for a different run", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("upstream")),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor("run_other", new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
	});

	test("forwards `/p/<id>/foo?q=1` → upstream `/foo?q=1` (prefix stripped)", async () => {
		const captured: { url: string | undefined; host: string | null } = {
			url: undefined,
			host: null,
		};
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input, init) => {
				captured.url = typeof input === "string" ? input : (input as Request).url;
				captured.host = (init?.headers as Headers).get("host");
				return new Response("ok-from-upstream", { status: 200 });
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/foo?q=1`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("ok-from-upstream");
		expect(captured.url).toBe("http://127.0.0.1:30200/foo?q=1");
		expect(captured.host).toBe("127.0.0.1:30200");
	});

	test("forwards `/p/<id>/` (root) → upstream `/`", async () => {
		let upstreamUrl: string | undefined;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input) => {
				upstreamUrl = typeof input === "string" ? input : (input as Request).url;
				return new Response("ok", { status: 200 });
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
		});
		await handler(request, url);
		expect(upstreamUrl).toBe("http://127.0.0.1:30200/");
	});

	test("forwards `/p/<id>` (no trailing slash) → upstream `/`", async () => {
		let upstreamUrl: string | undefined;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input) => {
				upstreamUrl = typeof input === "string" ? input : (input as Request).url;
				return new Response("ok", { status: 200 });
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}`,
			cookie: validCookieFor(runId, new Date()),
		});
		await handler(request, url);
		expect(upstreamUrl).toBe("http://127.0.0.1:30200/");
	});

	test("strips Authorization + warren_preview cookie before forwarding", async () => {
		let forwardedAuth: string | null = "unset";
		let forwardedCookie: string | null = "unset";
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (_input, init) => {
				const headers = init?.headers as Headers;
				forwardedAuth = headers.get("authorization");
				forwardedCookie = headers.get("cookie");
				return new Response("ok");
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: `${validCookieFor(runId, new Date())}; other=keepme`,
			extraHeaders: { authorization: "Bearer leaky-token" },
		});
		await handler(request, url);
		expect(forwardedAuth).toBeNull();
		expect(forwardedCookie).toBeNull();
	});

	test("updates preview_last_hit_at BEFORE returning, debounced", async () => {
		let now = new Date("2026-01-01T01:00:00Z");
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path", lastHitDebounceMs: 30_000 },
			now: () => now,
			fetch: fetchStub(async () => new Response("ok")),
		});
		await repos.runs.attachPreview(runId, { previewLastHitAt: "2025-12-01T00:00:00Z" });
		const cookie = validCookieFor(runId, now);
		const first = buildPathRequest({ path: `/p/${runId}/`, cookie });
		await handler(first.request, first.url);
		const after1 = await repos.runs.require(runId);
		expect(after1.previewLastHitAt).toBe(now.toISOString());

		// Within debounce: no write.
		const before2 = after1.previewLastHitAt;
		now = new Date(now.getTime() + 5_000);
		const second = buildPathRequest({ path: `/p/${runId}/`, cookie });
		await handler(second.request, second.url);
		const after2 = await repos.runs.require(runId);
		expect(after2.previewLastHitAt).toBe(before2);
	});

	test("WebSocket upgrade returns 426", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
			extraHeaders: { upgrade: "websocket" },
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(426);
	});

	test("502 when upstream fetch throws", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});
		const { request, url } = buildPathRequest({
			path: `/p/${runId}/`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(502);
	});
});
