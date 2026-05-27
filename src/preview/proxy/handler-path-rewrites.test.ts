import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { PreviewAuth } from "../cookie.ts";
import { createPreviewProxyHandler } from "./index.ts";
import { fetchStub, setupProxyEnv } from "./test-helpers.ts";

describe("createPreviewProxyHandler (path mode) — HTML rewrites (warren-ab3a)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;

	beforeEach(async () => {
		({ db, repos, auth, runId } = await setupProxyEnv({ scope: "path", previewPort: 30200 }));
	});

	afterEach(async () => {
		await db.close();
	});

	function pathHandler(upstreamFetch: typeof fetch) {
		return createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: upstreamFetch,
		});
	}

	function buildPathRequest(path: string): { request: Request; url: URL } {
		const c = auth.signCookie(runId, new Date());
		const request = new Request(`http://warren.example.com${path}`, {
			headers: {
				host: "warren.example.com",
				cookie: `${c.name}=${c.value}`,
			},
		});
		return { request, url: new URL(request.url) };
	}

	test("injects <base href> into a text/html response", async () => {
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response("<html><head><title>x</title></head><body>ok</body></html>", {
						status: 200,
						headers: { "content-type": "text/html; charset=utf-8" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		expect(res?.status).toBe(200);
		const body = await res?.text();
		expect(body).toBe(
			`<html><head><base href="/p/${runId}/"><title>x</title></head><body>ok</body></html>`,
		);
		// content-length is stripped so the consumer doesn't honor a stale value.
		expect(res?.headers.get("content-length")).toBeNull();
	});

	test("leaves a non-HTML response (JSON) byte-for-byte", async () => {
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response('{"hello":"/world"}', {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/api/x`);
		const res = await handler(request, url);
		expect(await res?.text()).toBe('{"hello":"/world"}');
	});

	test("leaves CSS / JS / images alone", async () => {
		const cases = ["text/css", "application/javascript", "image/png"];
		for (const ct of cases) {
			const handler = pathHandler(
				fetchStub(
					async () =>
						new Response("/* :root { } */ /not/rewritten", {
							status: 200,
							headers: { "content-type": ct },
						}),
				),
			);
			const { request, url } = buildPathRequest(`/p/${runId}/asset`);
			const res = await handler(request, url);
			expect(await res?.text()).toBe("/* :root { } */ /not/rewritten");
		}
	});

	test("does not re-inject <base> when upstream HTML already declares one", async () => {
		// The path-mode <base> injector (warren-ab3a) is idempotent — it must
		// NOT add a second <base> element when upstream emits its own. The
		// abs-path attribute rewriter (warren-63e1) still runs over the
		// existing `<base href="/...">` because that's a root-relative URL
		// that would otherwise escape the preview prefix.
		const upstreamHtml = '<html><head><base href="/elsewhere/"></head><body>ok</body></html>';
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response(upstreamHtml, {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		const out = (await res?.text()) ?? "";
		// Single <base>, not two.
		const baseMatches = out.match(/<base /g);
		expect(baseMatches !== null && baseMatches.length === 1).toBe(true);
		// Existing href got prefixed with the run prefix.
		expect(out).toContain(`<base href="/p/${runId}/elsewhere/">`);
		expect(out).toContain("<body>ok</body>");
	});

	test("strips Content-Encoding at the boundary and still rewrites", async () => {
		// Bun's fetch auto-decompresses transparently, so by the time the
		// proxy sees `upstream.body` it is already plaintext. The upstream
		// `Content-Encoding` header survives the decompression (Bun bug
		// oven-sh/bun#4528), so the proxy must strip it — otherwise the
		// browser tries to gunzip plaintext and fails with
		// `ERR_CONTENT_DECODING_FAILED` (diagnosed against run_7jjpt2jn9ej5).
		// Once the header is stripped, the path-mode rewrite proceeds
		// normally; the `Content-Length` strip is the same safety belt.
		const html = "<html><head></head><body>raw</body></html>";
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response(html, {
						status: 200,
						headers: {
							"content-type": "text/html",
							"content-encoding": "gzip",
							"content-length": String(html.length),
						},
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		expect(res?.headers.get("content-encoding")).toBeNull();
		expect(res?.headers.get("content-length")).toBeNull();
		const body = await res?.text();
		expect(body).toContain(`<base href="/p/${runId}/">`);
		expect(body).toContain("<body>raw</body>");
	});

	test("rewrites a same-origin Location: header on 302", async () => {
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response("", {
						status: 302,
						headers: { location: "/signin" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/private`);
		const res = await handler(request, url);
		expect(res?.status).toBe(302);
		expect(res?.headers.get("location")).toBe(`/p/${runId}/signin`);
	});

	test("leaves an absolute Location: untouched", async () => {
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response("", {
						status: 301,
						headers: { location: "https://example.com/elsewhere" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		expect(res?.headers.get("location")).toBe("https://example.com/elsewhere");
	});

	test("leaves a Location: already prefixed with /p/<id>/ untouched", async () => {
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response("", {
						status: 302,
						headers: { location: `/p/${runId}/already-there` },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		expect(res?.headers.get("location")).toBe(`/p/${runId}/already-there`);
	});

	test("does not rewrite Location: on a non-3xx status", async () => {
		// Location may legally appear on 201 Created — leave it alone.
		const handler = pathHandler(
			fetchStub(
				async () =>
					new Response("{}", {
						status: 201,
						headers: { location: "/things/42", "content-type": "application/json" },
					}),
			),
		);
		const { request, url } = buildPathRequest(`/p/${runId}/things`);
		const res = await handler(request, url);
		expect(res?.headers.get("location")).toBe("/things/42");
	});
});

describe("createPreviewProxyHandler (path mode) — abs-path HTML rewrite (warren-63e1)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let auth: PreviewAuth;
	let runId: string;

	beforeEach(async () => {
		({ db, repos, auth, runId } = await setupProxyEnv({ scope: "path", previewPort: 30500 }));
	});

	afterEach(async () => {
		await db.close();
	});

	function buildAuthedPathRequest(path: string): { request: Request; url: URL } {
		const c = auth.signCookie(runId, new Date());
		const request = new Request(`http://warren.example.com${path}`, {
			headers: {
				host: "warren.example.com",
				cookie: `${c.name}=${c.value}`,
			},
		});
		return { request, url: new URL(request.url) };
	}

	test("rewrites <script src> and <link href> inside the head on text/html", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(
				async () =>
					new Response(
						'<!doctype html><html><head><link rel="stylesheet" href="/_next/static/css/x.css"><script src="/_next/static/chunks/main.js"></script></head><body>ok</body></html>',
						{ status: 200, headers: { "content-type": "text/html" } },
					),
			),
		});
		const { request, url } = buildAuthedPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		const body = (await res?.text()) ?? "";
		expect(body).toContain(`<link rel="stylesheet" href="/p/${runId}/_next/static/css/x.css">`);
		expect(body).toContain(`<script src="/p/${runId}/_next/static/chunks/main.js">`);
	});

	test("idempotent — re-proxying already-prefixed HTML is a no-op", async () => {
		const html = `<html><head><script src="/p/${runId}/foo.js"></script></head><body>ok</body></html>`;
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(
				async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
			),
		});
		const { request, url } = buildAuthedPathRequest(`/p/${runId}/`);
		const res = await handler(request, url);
		const body = (await res?.text()) ?? "";
		// `<base>` is still injected (separate idempotency check covers
		// that), but the existing /p/<id>/foo.js is not double-prefixed.
		expect(body).not.toContain(`/p/${runId}/p/${runId}/`);
		expect(body).toContain(`<script src="/p/${runId}/foo.js">`);
	});

	test("leaves non-HTML content types alone (JSON, JS)", async () => {
		const handler = createPreviewProxyHandler({
			repos,
			previewAuth: auth,
			config: { mode: "path" },
			fetch: fetchStub(
				async () =>
					new Response('{"href":"/foo"}', {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		});
		const { request, url } = buildAuthedPathRequest(`/p/${runId}/api/x`);
		const res = await handler(request, url);
		expect(await res?.text()).toBe('{"href":"/foo"}');
	});
});
