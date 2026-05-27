import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { createPreviewAuth, type PreviewAuth } from "../cookie.ts";
import { createPreviewProxyHandler } from "./index.ts";
import { fetchStub, HOST, setupProxyEnv, TOKEN } from "./test-helpers.ts";

describe("createPreviewProxyHandler (path mode) — referer routing (warren-63e1)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;

	beforeEach(async () => {
		({ db, repos, auth, runId } = await setupProxyEnv({ scope: "path", previewPort: 30400 }));
	});

	afterEach(async () => {
		await db.close();
	});

	function buildAssetRequest(opts: { path: string; referer?: string; cookieRunId?: string }): {
		request: Request;
		url: URL;
	} {
		const headers: Record<string, string> = { host: "warren.example.com" };
		if (opts.referer !== undefined) headers.referer = opts.referer;
		if (opts.cookieRunId !== undefined) {
			const c = auth.signCookie(opts.cookieRunId, new Date());
			headers.cookie = `${c.name}=${c.value}`;
		}
		const request = new Request(`http://warren.example.com${opts.path}`, { headers });
		return { request, url: new URL(request.url) };
	}

	test("routes a `/_next/static/...` asset to the preview when Referer names /p/<id>/", async () => {
		let upstreamUrl: string | undefined;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async (input) => {
				upstreamUrl = typeof input === "string" ? input : (input as Request).url;
				return new Response("upstream-bundle", {
					status: 200,
					headers: { "content-type": "application/javascript" },
				});
			}),
		});
		const { request, url } = buildAssetRequest({
			path: "/_next/static/chunks/main.js",
			referer: `http://warren.example.com/p/${runId}/`,
			cookieRunId: runId,
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("upstream-bundle");
		// The path is forwarded verbatim — upstream sees /_next/..., not /p/<id>/_next/...
		expect(upstreamUrl).toBe("http://127.0.0.1:30400/_next/static/chunks/main.js");
	});

	test("401 when the per-run cookie is missing on a referer-routed asset", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildAssetRequest({
			path: "/_next/static/foo.js",
			referer: `http://warren.example.com/p/${runId}/`,
		});
		const res = await handler(request, url);
		expect(res?.status).toBe(401);
	});

	test("falls through (null) when no Referer header is present", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildAssetRequest({ path: "/_next/static/foo.js" });
		// No /p/<id>/ in path AND no referer → fall through to warren's normal pipeline.
		expect(await handler(request, url)).toBeNull();
	});

	test("falls through when Referer points at a non-preview page", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		const { request, url } = buildAssetRequest({
			path: "/_next/static/foo.js",
			referer: "http://warren.example.com/runs",
		});
		expect(await handler(request, url)).toBeNull();
	});

	test("warren API paths still win on path match (no referer hijack)", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(async () => new Response("nope")),
		});
		// User on a preview clicks a link into warren's /runs/<id>/cancel
		// route. Referer points at /p/<id>/ but isWarrenApiPath says /runs/...
		// is real warren — the proxy preamble must return null so the real
		// handler runs.
		const { request, url } = buildAssetRequest({
			path: "/runs/run_unrelated/cancel",
			referer: `http://warren.example.com/p/${runId}/`,
		});
		expect(await handler(request, url)).toBeNull();
	});

	test("subdomain mode does not consult Referer (path-mode-only feature)", async () => {
		const subAuth = createPreviewAuth(TOKEN, { secure: false });
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: subAuth,
			config: { mode: "subdomain", host: HOST },
			fetch: fetchStub(async () => new Response("upstream")),
		});
		const request = new Request("http://warren.example.com/_next/static/foo.js", {
			headers: {
				host: "warren.example.com",
				referer: `http://run-${runId}.${HOST}/`,
			},
		});
		const url = new URL(request.url);
		// Subdomain mode keys off Host, which doesn't match the preview suffix
		// here; referer routing is path-mode-only by design (SPEC §11.L
		// addendum: subdomain mode owns its own DNS and emits absolute URLs
		// from the upstream's own origin).
		expect(await handler(request, url)).toBeNull();
	});
});
