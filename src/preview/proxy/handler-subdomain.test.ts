import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { COOKIE_NAME, type PreviewAuth } from "../cookie.ts";
import { createPreviewProxyHandler } from "./index.ts";
import { fetchStub, HOST, setupProxyEnv } from "./test-helpers.ts";

describe("createPreviewProxyHandler (subdomain mode)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;

	beforeEach(async () => {
		({ db, repos, auth, runId } = await setupProxyEnv({ scope: "subdomain", previewPort: 30100 }));
	});

	afterEach(async () => {
		await db.close();
	});

	function buildRequest(opts: {
		host: string;
		path?: string;
		cookie?: string | null;
		method?: string;
		extraHeaders?: Record<string, string>;
	}): { request: Request; url: URL } {
		const path = opts.path ?? "/";
		const headers: Record<string, string> = {
			host: opts.host,
			...(opts.extraHeaders ?? {}),
		};
		if (opts.cookie !== undefined && opts.cookie !== null) headers.cookie = opts.cookie;
		const request = new Request(`http://${opts.host}${path}`, {
			method: opts.method ?? "GET",
			headers,
		});
		const url = new URL(request.url);
		return { request, url };
	}

	function validCookieFor(thisRunId: string, now: Date): string {
		const c = auth.signCookie(thisRunId, now);
		return `${COOKIE_NAME}=${c.value}`;
	}

	test("returns null for hosts that don't match the preview suffix", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({ host: "warren.example.com" });
		expect(await handler(request, url)).toBeNull();
	});

	test("404 for unknown runId", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({ host: `run-doesnotexist.${HOST}` });
		const res = await handler(request, url);
		expect(res?.status).toBe(404);
	});

	test("501 cross-host (worker_id !== local) with R-12 deferral message", async () => {
		await repos.runs.attachBurrow(runId, { workerId: "remote-worker-2" });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({ host: `run-${runId}.${HOST}` });
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
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(503);
	});

	test("401 when cookie is missing — never 200, never 502 (SPEC §11.L risk #2)", async () => {
		let upstreamCalled = false;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => {
				upstreamCalled = true;
				return new Response("upstream");
			}),
		});
		const { request, url } = buildRequest({ host: `run-${runId}.${HOST}` });
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
		expect(upstreamCalled).toBe(false);
		const body = (await res?.json()) as { error: { code: string } };
		expect(body.error.code).toBe("preview_unauthorized");
	});

	test("401 when cookie is for a different run", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("upstream")),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor("run_other", new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
	});

	test("forwards a valid request to 127.0.0.1:<port>", async () => {
		const captured: { url: string | undefined; method: string | undefined; host: string | null } = {
			url: undefined,
			method: undefined,
			host: null,
		};
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async (input, init) => {
				captured.url = typeof input === "string" ? input : (input as Request).url;
				captured.method = init?.method;
				captured.host = (init?.headers as Headers).get("host");
				return new Response("ok-from-upstream", { status: 200 });
			}),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			path: "/some/page?q=1",
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("ok-from-upstream");
		expect(captured.url).toBe("http://127.0.0.1:30100/some/page?q=1");
		expect(captured.method).toBe("GET");
		expect(captured.host).toBe("127.0.0.1:30100");
	});

	test("strips Authorization + warren_preview cookie before forwarding", async () => {
		let forwardedAuth: string | null = "unset";
		let forwardedCookie: string | null = "unset";
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async (_input, init) => {
				const headers = init?.headers as Headers;
				forwardedAuth = headers.get("authorization");
				forwardedCookie = headers.get("cookie");
				return new Response("ok");
			}),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
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
			config: { mode: "subdomain", host: HOST, lastHitDebounceMs: 30_000 },
			now: () => now,
			fetch: fetchStub(async () => new Response("ok")),
		});

		// Reset preview_last_hit_at well in the past so the first call writes.
		await repos.runs.attachPreview(runId, { previewLastHitAt: "2025-12-01T00:00:00Z" });

		const cookie = validCookieFor(runId, now);
		const first = buildRequest({ host: `run-${runId}.${HOST}`, cookie });
		const r1 = await handler(first.request, first.url);
		expect(r1?.status).toBe(200);
		const after1 = await repos.runs.require(runId);
		expect(after1.previewLastHitAt).toBe(now.toISOString());

		// Within the debounce window: last_hit_at must NOT be re-written.
		const before2 = after1.previewLastHitAt;
		now = new Date(now.getTime() + 5_000);
		const second = buildRequest({ host: `run-${runId}.${HOST}`, cookie });
		await handler(second.request, second.url);
		const after2 = await repos.runs.require(runId);
		expect(after2.previewLastHitAt).toBe(before2);

		// Past the debounce window: writes again.
		now = new Date(now.getTime() + 30_001);
		const third = buildRequest({ host: `run-${runId}.${HOST}`, cookie });
		await handler(third.request, third.url);
		const after3 = await repos.runs.require(runId);
		expect(after3.previewLastHitAt).toBe(now.toISOString());
	});

	test("WebSocket upgrade returns 426 (HTTP-only V1)", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
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
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});
		const { request, url } = buildRequest({
			host: `run-${runId}.${HOST}`,
			cookie: validCookieFor(runId, new Date()),
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(502);
	});
});

describe("createPreviewProxyHandler (subdomain mode) — leaves HTML untouched", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;

	beforeEach(async () => {
		({ db, repos, auth, runId } = await setupProxyEnv({ scope: "subdomain", previewPort: 30300 }));
	});

	afterEach(async () => {
		await db.close();
	});

	test("subdomain mode passes text/html through byte-for-byte (no <base> injection)", async () => {
		const html = "<html><head><title>x</title></head><body>ok</body></html>";
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(
				async () =>
					new Response(html, {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			),
		});
		const c = auth.signCookie(runId, new Date());
		const request = new Request(`http://run-${runId}.${HOST}/`, {
			headers: {
				host: `run-${runId}.${HOST}`,
				cookie: `${COOKIE_NAME}=${c.value}`,
			},
		});
		const url = new URL(request.url);
		const res = await handler(request, url);
		expect(await res?.text()).toBe(html);
	});

	test("subdomain mode passes Location: through verbatim on 302", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(
				async () => new Response("", { status: 302, headers: { location: "/signin" } }),
			),
		});
		const c = auth.signCookie(runId, new Date());
		const request = new Request(`http://run-${runId}.${HOST}/private`, {
			headers: {
				host: `run-${runId}.${HOST}`,
				cookie: `${COOKIE_NAME}=${c.value}`,
			},
		});
		const url = new URL(request.url);
		const res = await handler(request, url);
		expect(res?.headers.get("location")).toBe("/signin");
	});
});
