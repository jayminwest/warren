/**
 * Reverse proxy preamble for per-run previews (R-19 / SPEC §11.L,
 * warren-8a10; path-mode addendum warren-8085 + HTML rewrite warren-ab3a
 * / pl-f4ea; SPA out-of-the-box revision warren-63e1).
 *
 * The proxy is an in-process Bun route, not a separate reverse proxy.
 * `tryHandlePreviewProxy` runs *before* the normal auth gate and route
 * match in `src/server/server.ts`. There are two routing modes, picked
 * at config time from `WARREN_PREVIEW_MODE`:
 *
 *   - **Subdomain mode** (operator owns a wildcard CNAME + cert):
 *     match `Host: run-<runId>.<previewHost>`. URL forwarded upstream
 *     keeps `url.pathname` verbatim.
 *
 *   - **Path mode** (default; reuses warren's own host + cert): match
 *     `^/p/<runId>(/<rest>)?$` on the request path. The `/p/<runId>`
 *     prefix is stripped before forwarding so the upstream sees a
 *     request rooted at `<rest>` (or `/` when `rest` is empty).
 *
 *     **Referer-based asset routing (warren-63e1):** when the request
 *     path does NOT match `/p/<runId>/...` but the `Referer` header's
 *     pathname does, the proxy treats the request as a sub-resource of
 *     that preview (e.g. `GET /_next/static/foo.js` referred from
 *     `https://warren.example.com/p/<id>/`) and forwards `url.pathname`
 *     to the preview's upstream port. Modern SPA bundlers (Next.js,
 *     Vite, SvelteKit, Astro) emit root-relative asset URLs that the
 *     HTML `<base>` rewrite can't redirect; without referer routing
 *     those assets fall through to warren's SPA shell and the browser
 *     parses warren's `index.html` as JS / CSS / woff2. Referer is the
 *     reliable browser-default signal (same-origin sub-resources
 *     always send it); requests for well-known warren API paths
 *     (`/runs`, `/projects`, …) skip referer routing so a stray click
 *     from a preview into warren's own API still hits the real handler.
 *
 * In either mode the rest of the seam is identical:
 *
 *   1. **Resolve the run.** `runs.preview_state` must be `live`;
 *      anything else (`starting`, `failed`, `torn-down`, null) → 503
 *      with the state in the body so a reviewer can tell `still
 *      booting` apart from `evicted`. Unknown runId → 404.
 *
 *   2. **Cross-host check.** `runs.worker_id !== LOCAL_WORKER_NAME`
 *      returns **501** with an explicit R-12 deferral message. Silent
 *      fall-through to a closed loopback port would manifest as
 *      "preview works for some runs, not others"; the SPEC's
 *      acceptance scenario asserts this path explicitly.
 *
 *   3. **Signed-cookie auth.** Verify the `warren_preview` cookie
 *      against the runId via `PreviewAuth.verifyCookie`. Missing /
 *      invalid / expired cookie → **401** with a body pointing the
 *      browser at the `/runs/:id/preview/login` handshake. Bearer-
 *      in-header is impossible for a browser hitting the preview
 *      origin directly, so cookie is the only auth surface.
 *
 *   4. **last_hit_at debounce.** Update `runs.preview_last_hit_at`
 *      **before** forwarding (SPEC §11.L: a slow upstream response
 *      must not make the preview look idle to the eviction worker).
 *      Debounced via an in-memory `Map<runId, lastFlushAtMs>` to
 *      ~once per `DEFAULT_DEBOUNCE_MS` (default 30s) per run — keeps
 *      the hot path cheap. The map is a single-process singleton; a
 *      warren restart forgets it, but the persisted
 *      `preview_last_hit_at` is the source of truth so eviction
 *      doesn't false-trigger.
 *
 *   5. **Forward.** Rewrite the URL to
 *      `http://127.0.0.1:<preview_port>` preserving the (mode-specific)
 *      upstream path + query string, strip the inbound `Host` /
 *      `Cookie` / `Authorization` headers (preview app should not see
 *      warren's auth state), and stream the body through.
 *
 *   6. **Path-mode response rewrites (best-effort).** SPEC §11.L
 *      addendum: root-relative URLs from the upstream would escape the
 *      `/p/<runId>/` prefix. Two transforms apply only when mode=path:
 *
 *      a. `<base href="/p/<runId>/">` is injected immediately after the
 *         opening `<head>` tag when `Content-Type` is `text/html`
 *         (parameters tolerated). Idempotent: skipped when the lookahead
 *         window already contains a `<base>` element so re-proxying
 *         warren-served HTML is a no-op. The lookahead is bounded to
 *         `HTML_HEAD_LOOKAHEAD_BYTES` (64 KiB); larger documents without
 *         a parseable `<head>` in the first chunk pass through untouched.
 *         The byte after the lookahead streams unchanged.
 *
 *      b. `Location:` headers on 3xx responses are prefixed with
 *         `/p/<runId>` when they parse as same-origin absolute paths
 *         (`/signin` → `/p/<runId>/signin`). Absolute URLs, scheme-
 *         relative URLs (`//host/foo`), and values already under
 *         `/p/<runId>/` pass through untouched.
 *
 *      c. Root-relative `href`, `src`, and `srcset` attribute values
 *         inside the same `HTML_HEAD_LOOKAHEAD_BYTES` window are
 *         prefixed with `/p/<runId>` (warren-63e1) — defense in depth
 *         for referer-based asset routing, and the path that catches
 *         server-rendered HTML with absolute URLs computed before the
 *         `<base>` rewrite saw them. Protocol-relative (`//host/...`),
 *         absolute (`http://...`), data, and already-prefixed values
 *         pass through.
 *
 *      Other content types (JSON, JS, CSS, fonts, images) and subdomain
 *      mode skip every transform entirely.
 *
 * WebSocket upgrades are not yet supported: Bun.serve's WS surface is
 * accept-then-handle, not transparent-proxy, so a true `Upgrade: websocket`
 * relay needs `server.upgrade()` plus a paired raw socket to the upstream.
 * V1 ships HTTP-only; a 426 is returned for upgrade requests so the
 * client can fall back. A follow-up seed under `pl-2c59` will add WS
 * support once an operator demands it.
 *
 * Every observable side effect (clock, runs repo, fetch) is injectable
 * so unit tests don't touch real sockets or wait on real timers.
 */

import { LOCAL_WORKER_NAME } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import type { PreviewProxyHandler } from "../server/types.ts";
import type { PreviewMode } from "../warren-config/index.ts";
import type { PreviewAuth } from "./cookie.ts";

export type { PreviewProxyHandler };

/** SPEC §11.L: debounce `preview_last_hit_at` writes to ~once per 30s. */
export const DEFAULT_DEBOUNCE_MS = 30_000;

/** Cookie header name written into the redirect body so a browser falls
 *  back gracefully when it didn't get redirected through the login route. */
export const LOGIN_PATH_PREFIX = "/runs/";

/** URL path prefix the path-mode matcher anchors to (`/p/<runId>/...`). */
export const PREVIEW_PATH_PREFIX = "/p";

/** SPEC §11.L addendum (warren-ab3a): cap the lookahead for `<head>` /
 *  `<base>` detection to the first 64 KiB of body. Documents without a
 *  parseable `<head>` in that window pass through untouched. The same
 *  cap bounds the root-relative URL attribute rewrite (warren-63e1)
 *  so neither transform pays for a hostile multi-megabyte upstream. */
export const HTML_HEAD_LOOKAHEAD_BYTES = 64 * 1024;

/**
 * Warren API path prefixes (warren-63e1). Mirrors
 * `src/server/handlers.ts::API_PREFIXES` — duplicated here so referer-
 * based asset routing can skip "looks like a warren API call" without
 * pulling the whole handlers module into the preview/ tree. The
 * `warren-api-prefixes-stay-in-sync` test in `proxy.test.ts` asserts
 * parity so a future API surface addition surfaces here too.
 */
const WARREN_API_PATH_PREFIXES: readonly string[] = [
	"/analytics",
	"/brainstorm",
	"/runs",
	"/projects",
	"/agents",
	"/burrows",
	"/workers",
	"/healthz",
	"/readyz",
	"/version",
	"/preview",
	"/plan-runs",
	"/plot-plan-runs",
	"/plots",
];

/**
 * True iff `pathname` matches a warren API prefix. The referer-based
 * routing path consults this so a click from inside a preview into
 * (e.g.) `/runs/<id>/cancel` reaches the real handler rather than the
 * preview's upstream port. The `/p/...` prefix is left out — the
 * direct path-mode match upstream of this check already routes those.
 */
export function isWarrenApiPath(pathname: string): boolean {
	for (const prefix of WARREN_API_PATH_PREFIXES) {
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

interface PreviewProxyConfigBase {
	/** Local-worker name. Defaults to the pool's `LOCAL_WORKER_NAME`
	 *  constant; only tests should override. */
	readonly localWorkerName?: string;
	/** Override the debounce window (tests). */
	readonly lastHitDebounceMs?: number;
}

export interface PreviewProxyConfigSubdomain extends PreviewProxyConfigBase {
	readonly mode: "subdomain";
	/** Operator-facing host suffix the proxy matches against `Host:`
	 *  headers (`run-<runId>.<host>`). Resolved at boot from
	 *  `WARREN_PREVIEW_HOST`. */
	readonly host: string;
}

export interface PreviewProxyConfigPath extends PreviewProxyConfigBase {
	readonly mode: "path";
	/** Operator's warren host (informational — used only in the 401
	 *  hint URL). Path mode derives the preview origin from the
	 *  request's own `Host` header, so this is allowed to be null. */
	readonly host?: string | null;
}

export type PreviewProxyConfig = PreviewProxyConfigSubdomain | PreviewProxyConfigPath;

export interface PreviewProxyDeps {
	readonly repos: Repos;
	readonly previewAuth: PreviewAuth;
	readonly config: PreviewProxyConfig;
	/** Override `fetch` for the upstream forward (tests). */
	readonly fetch?: typeof fetch;
	/** Override `Date.now()` so debounce + cookie expiry can be pinned. */
	readonly now?: () => Date;
}

/**
 * Match `run-<runId>.<host>` against `Host:`. Returns the runId on a
 * match, `null` otherwise. Tolerates an optional `:port` suffix because
 * Caddy / Fly edges sometimes preserve the upstream port in the Host
 * header (especially on `http://` dev deploys).
 */
export function parseRunIdFromHost(hostHeader: string | null, suffix: string): string | null {
	if (hostHeader === null || hostHeader.length === 0) return null;
	// Strip optional `:port`.
	const colon = hostHeader.lastIndexOf(":");
	const host =
		colon !== -1 && /^\d+$/.test(hostHeader.slice(colon + 1))
			? hostHeader.slice(0, colon)
			: hostHeader;
	if (host === suffix) return null;
	const suffixDot = `.${suffix}`;
	if (!host.endsWith(suffixDot)) return null;
	const prefix = host.slice(0, host.length - suffixDot.length);
	if (!prefix.startsWith("run-")) return null;
	const runId = prefix.slice("run-".length);
	if (runId.length === 0) return null;
	// runIds are generated as `run_<base32>` (see `generateId`). The dot is
	// disallowed in run subdomains; reject anything else so a multi-label
	// `Host: deeper.run-X.<host>` doesn't accidentally route here.
	if (runId.includes(".")) return null;
	return runId;
}

/**
 * Match `/p/<runId>` (with optional `/<rest>`) on a URL pathname.
 * Returns `{runId, rest}` where `rest` is the remainder of the path
 * (always starts with `/`; defaults to `/` when the request was for
 * `/p/<runId>` with no trailing slash). Returns null when the path
 * doesn't match the preview prefix — the caller falls through to the
 * regular pipeline.
 *
 * The runId charset is intentionally permissive (`[A-Za-z0-9_-]+`) so
 * any future change to `generateId`'s alphabet keeps matching; the
 * DB lookup (`repos.runs.get`) is the actual source of truth and
 * issues a 404 for unknown IDs. The single-segment shape (no `/`,
 * no `.`) is what protects against path-traversal escapes from the
 * prefix.
 */
export function parsePreviewPathPrefix(pathname: string): { runId: string; rest: string } | null {
	const match = /^\/p\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
	if (match === null) return null;
	const runId = match[1];
	if (runId === undefined || runId.length === 0) return null;
	const rest = match[2] ?? "/";
	return { runId, rest };
}

/**
 * Extract a runId from a `Referer:` header (warren-63e1). Parses the
 * header value as a URL and matches `parsePreviewPathPrefix` on the
 * pathname. Returns null when the header is missing, malformed, or
 * does not point at a `/p/<runId>/...` page — the proxy preamble
 * falls through to the regular pipeline in those cases.
 *
 * Origin is not constrained: a same-host referer is the common path
 * (browser default policy), but a cross-origin referer that still
 * names `/p/<runId>/...` is acceptable because the cookie check
 * downstream still anchors on the runId-bound signature.
 */
export function parseRunIdFromReferer(refererHeader: string | null): string | null {
	if (refererHeader === null || refererHeader.length === 0) return null;
	let url: URL;
	try {
		url = new URL(refererHeader);
	} catch {
		return null;
	}
	const parsed = parsePreviewPathPrefix(url.pathname);
	return parsed === null ? null : parsed.runId;
}

/**
 * Build the proxy handler. The returned function is wired into the
 * server preamble; it returns a `Response` to short-circuit the
 * request, or `null` to fall through to the regular auth + route
 * pipeline.
 */
export function createPreviewProxyHandler(deps: PreviewProxyDeps): PreviewProxyHandler {
	const fetchImpl = deps.fetch ?? globalThis.fetch;
	const now = deps.now ?? (() => new Date());
	const localWorkerName = deps.config.localWorkerName ?? LOCAL_WORKER_NAME;
	const debounceMs = deps.config.lastHitDebounceMs ?? DEFAULT_DEBOUNCE_MS;
	const lastFlush = new Map<string, number>();
	const mode = deps.config.mode;

	return async (request: Request, url: URL): Promise<Response | null> => {
		let runId: string;
		let upstreamPath: string;

		if (mode === "subdomain") {
			const hostHeader = request.headers.get("host");
			const parsed = parseRunIdFromHost(hostHeader, deps.config.host);
			if (parsed === null) return null;
			runId = parsed;
			upstreamPath = url.pathname;
		} else {
			const parsed = parsePreviewPathPrefix(url.pathname);
			if (parsed !== null) {
				runId = parsed.runId;
				upstreamPath = parsed.rest;
			} else {
				// Referer-based asset routing (warren-63e1). Skip when the
				// path looks like a warren API call so a click from inside a
				// preview into `/runs/<id>/cancel` (etc.) still reaches the
				// real handler.
				if (isWarrenApiPath(url.pathname)) return null;
				const refererRunId = parseRunIdFromReferer(request.headers.get("referer"));
				if (refererRunId === null) return null;
				runId = refererRunId;
				// Asset request: forward the original pathname verbatim so the
				// upstream sees e.g. `/_next/static/foo.js`, not `/p/<id>/...`.
				upstreamPath = url.pathname;
			}
		}

		const run = await deps.repos.runs.get(runId);
		if (run === null) {
			return previewError(404, "preview_not_found", `no run with id ${runId}`);
		}

		if (run.workerId !== null && run.workerId !== localWorkerName) {
			return previewError(
				501,
				"preview_remote_worker",
				`preview proxying is local-worker-only in V1; run.worker_id=${run.workerId} (R-12 deferral, see SPEC §11.L)`,
			);
		}

		if (run.previewState !== "live") {
			const stateLabel = run.previewState ?? "unset";
			return previewError(
				503,
				"preview_not_live",
				`preview is not live (preview_state=${stateLabel})`,
			);
		}

		const port = run.previewPort;
		if (port === null) {
			return previewError(
				503,
				"preview_port_missing",
				"preview is marked live but has no port allocated",
			);
		}

		// WebSocket upgrades: punt explicitly rather than silently dropping
		// the Upgrade header on the forward. A future seed wires `server.upgrade()`
		// + paired upstream socket.
		const upgrade = request.headers.get("upgrade");
		if (upgrade !== null && upgrade.toLowerCase() === "websocket") {
			return previewError(
				426,
				"preview_ws_not_implemented",
				"WebSocket proxying is not yet implemented for preview environments",
			);
		}

		// Auth: signed cookie verifies against this run's id (so a cookie
		// scoped to .<host> can't be used to reach a sibling preview).
		const cookieHeader = request.headers.get("cookie");
		if (!deps.previewAuth.verifyCookie(cookieHeader, runId, now())) {
			return previewUnauthorized(runId, deps.config, url);
		}

		// SPEC §11.L: update last_hit_at BEFORE forwarding (debounced).
		await maybeFlushLastHit(deps.repos, run, lastFlush, debounceMs, now());

		const pathPrefix = mode === "path" ? `${PREVIEW_PATH_PREFIX}/${runId}` : null;
		return forwardToUpstream(fetchImpl, request, upstreamPath, url.search, port, pathPrefix);
	};
}

async function maybeFlushLastHit(
	repos: Repos,
	run: RunRow,
	lastFlush: Map<string, number>,
	debounceMs: number,
	now: Date,
): Promise<void> {
	const last = lastFlush.get(run.id) ?? 0;
	const nowMs = now.getTime();
	if (nowMs - last < debounceMs) return;
	lastFlush.set(run.id, nowMs);
	try {
		await repos.runs.attachPreview(run.id, { previewLastHitAt: now.toISOString() });
	} catch {
		// Best-effort: a transient db error here shouldn't 502 the proxy.
		// The next debounced flush retries; the eviction worker reads the
		// last persisted value as the source of truth.
		lastFlush.delete(run.id);
	}
}

async function forwardToUpstream(
	fetchImpl: typeof fetch,
	request: Request,
	upstreamPath: string,
	search: string,
	port: number,
	pathPrefix: string | null,
): Promise<Response> {
	const upstreamUrl = `http://127.0.0.1:${port}${upstreamPath}${search}`;
	const headers = new Headers(request.headers);
	// Strip warren-internal auth state. The preview app must never see
	// the operator's bearer token or signed-cookie — even though `fetch`
	// would forward them verbatim if we left them in.
	headers.delete("host");
	headers.delete("authorization");
	headers.delete("cookie");
	// Rewrite Host to the upstream loopback so apps that rely on Host for
	// routing or URL composition don't see `run-<id>.<host>`.
	headers.set("host", `127.0.0.1:${port}`);

	const method = request.method.toUpperCase();
	const init: RequestInit = {
		method,
		headers,
		redirect: "manual",
	};
	if (method !== "GET" && method !== "HEAD") {
		init.body = request.body;
		// Streaming bodies require duplex: 'half'; node/Bun both accept it.
		(init as RequestInit & { duplex?: string }).duplex = "half";
	}

	let upstream: Response;
	try {
		upstream = await fetchImpl(upstreamUrl, init);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return previewError(
			502,
			"preview_upstream_unreachable",
			`could not reach preview upstream at ${upstreamUrl}: ${message}`,
		);
	}

	// Bun's fetch auto-decompresses gzip/br/deflate transparently, but it
	// does NOT strip the `Content-Encoding` header from `upstream.headers`
	// (oven-sh/bun#4528). If we forward those headers verbatim the browser
	// receives plaintext labeled as gzip → `ERR_CONTENT_DECODING_FAILED`
	// (diagnosed against run_7jjpt2jn9ej5's blank preview page). The
	// announced `Content-Length` is also for the *encoded* body, so it
	// disagrees with the decompressed length we'd be streaming. Strip both
	// once at the boundary so every downstream branch (subdomain mode,
	// path-mode HTML rewrite, path-mode passthrough) sees clean headers.
	const passHeaders = new Headers(upstream.headers);
	passHeaders.delete("content-encoding");
	passHeaders.delete("content-length");

	if (pathPrefix === null) {
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: passHeaders,
		});
	}
	return applyPathModeRewrites(upstream, passHeaders, pathPrefix);
}

/**
 * Path-mode response transforms (SPEC §11.L addendum, warren-ab3a).
 * Rewrites a same-origin `Location:` on 3xx responses, and best-effort
 * injects `<base href="<pathPrefix>/">` after the opening `<head>` tag
 * on `text/html` bodies. All other content types and statuses stream
 * through unchanged.
 */
async function applyPathModeRewrites(
	upstream: Response,
	headers: Headers,
	pathPrefix: string,
): Promise<Response> {
	if (upstream.status >= 300 && upstream.status < 400) {
		const loc = headers.get("location");
		if (loc !== null) {
			const rewritten = rewriteLocationHeader(loc, pathPrefix);
			if (rewritten !== loc) headers.set("location", rewritten);
		}
	}

	if (!isHtmlContentType(headers.get("content-type")) || upstream.body === null) {
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}

	// `headers` was already stripped of content-encoding and content-length
	// by the caller (forwardToUpstream) so the browser doesn't try to
	// gunzip plaintext or trust a length from the encoded upstream body.

	const reader = upstream.body.getReader();
	const chunks: Uint8Array[] = [];
	let collected = 0;
	let exhausted = false;
	while (collected < HTML_HEAD_LOOKAHEAD_BYTES) {
		const { value, done } = await reader.read();
		if (done) {
			exhausted = true;
			break;
		}
		chunks.push(value);
		collected += value.byteLength;
	}
	const head = concatChunks(chunks, collected);
	const baseInjected = injectBaseHref(head, pathPrefix);
	const afterBase = baseInjected ?? head;
	const attrsRewritten = rewriteRootRelativeAttrs(afterBase, pathPrefix);
	const startBytes = attrsRewritten ?? afterBase;

	if (exhausted) {
		// Cast: TS's BodyInit shape excludes the parameterized
		// Uint8Array<ArrayBufferLike> Bun's lib emits, but the runtime
		// accepts Uint8Array everywhere a BufferSource is allowed.
		return new Response(startBytes as unknown as BodyInit, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(startBytes);
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value !== undefined) controller.enqueue(value);
				}
				controller.close();
			} catch (err) {
				controller.error(err);
			}
		},
	});
	return new Response(stream, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
	if (chunks.length === 1) {
		const single = chunks[0];
		if (single !== undefined) return single;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/**
 * Match `Content-Type: text/html` (parameters tolerated, e.g.
 * `text/html; charset=utf-8`). Other media types pass through the
 * rewriter untouched.
 */
export function isHtmlContentType(value: string | null): boolean {
	if (value === null) return false;
	const semi = value.indexOf(";");
	const media = (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
	return media === "text/html";
}

/**
 * Inject `<base href="<pathPrefix>/">` immediately after the opening
 * `<head>` tag. Idempotent: returns `null` (no rewrite) when an existing
 * `<base>` element is already present anywhere in the lookahead window,
 * or when no `<head>` tag is found in the first
 * `HTML_HEAD_LOOKAHEAD_BYTES` bytes. Operates on bytes so the head
 * portion of arbitrary UTF-8 documents round-trips losslessly — we only
 * splice ASCII bytes in at an ASCII-tag boundary.
 */
export function injectBaseHref(body: Uint8Array, pathPrefix: string): Uint8Array | null {
	const window = body.subarray(0, Math.min(body.length, HTML_HEAD_LOOKAHEAD_BYTES));
	const headStart = indexOfAsciiCaseInsensitive(window, HEAD_OPEN_BYTES);
	if (headStart === -1) return null;
	// Find the next `>` that closes the opening tag. The tag may have
	// attributes (`<head lang="en">`); attributes are bounded by the same
	// `>` rule HTML uses, so we just scan for it.
	let cursor = headStart + HEAD_OPEN_BYTES.length;
	while (cursor < window.length && window[cursor] !== 0x3e /* > */) cursor++;
	if (cursor >= window.length) return null;
	const insertAt = cursor + 1;
	if (hasBaseElement(window, insertAt)) return null;
	const inject = TEXT_ENCODER.encode(`<base href="${pathPrefix}/">`);
	const out = new Uint8Array(body.length + inject.length);
	out.set(body.subarray(0, insertAt), 0);
	out.set(inject, insertAt);
	out.set(body.subarray(insertAt), insertAt + inject.length);
	return out;
}

/**
 * Rewrite root-relative `href`, `src`, and `srcset` attribute values
 * (warren-63e1) so root-relative URLs emitted by Next.js / Vite /
 * SvelteKit / Astro asset pipelines land back under the preview's
 * `/p/<runId>/...` prefix. Operates byte-wise over the same
 * `HTML_HEAD_LOOKAHEAD_BYTES` window the `<base>` injection uses so
 * the post-window stream still passes through unchanged.
 *
 * Returns the modified buffer, or `null` when nothing in the window
 * needed rewriting (caller falls back to the original bytes). The
 * scanner is conservative: it only fires on a `<attr>=<quote>/<value><quote>`
 * pattern where the attribute name is preceded by an HTML attribute
 * boundary (whitespace, `<`, or `/`), the value begins with a single
 * `/` (protocol-relative `//host` and absolute URLs are left alone),
 * and the value is not already prefixed with `<pathPrefix>/`. `srcset`
 * is split on commas and each entry's leading URL is rewritten in
 * place.
 */
export function rewriteRootRelativeAttrs(body: Uint8Array, pathPrefix: string): Uint8Array | null {
	const limit = Math.min(body.length, HTML_HEAD_LOOKAHEAD_BYTES);
	const prefixBytes = TEXT_ENCODER.encode(pathPrefix);
	const parts: Uint8Array[] = [];
	let segmentStart = 0;
	let cursor = 0;
	let mutated = false;

	while (cursor < limit) {
		const m = matchAttributeAt(body, cursor, limit);
		if (m === null) {
			cursor++;
			continue;
		}
		const value = body.subarray(m.valueStart, m.valueEnd);
		const rewritten = m.isSrcset
			? rewriteSrcsetValue(value, prefixBytes)
			: rewriteUrlValue(value, prefixBytes);
		if (rewritten !== null) {
			parts.push(body.subarray(segmentStart, m.valueStart));
			parts.push(rewritten);
			segmentStart = m.valueEnd;
			mutated = true;
		}
		cursor = m.valueEnd;
	}

	if (!mutated) return null;
	parts.push(body.subarray(segmentStart));
	let total = 0;
	for (const p of parts) total += p.byteLength;
	return concatChunks(parts, total);
}

interface AttributeMatch {
	readonly valueStart: number;
	readonly valueEnd: number;
	readonly isSrcset: boolean;
}

/**
 * Find a `<attr>=<quote>...<quote>` pattern at exactly `i`, where attr is
 * one of `href`, `src`, `srcset`. Returns the inclusive byte range of the
 * attribute value (without the surrounding quotes) on a hit, null otherwise.
 *
 * The preceding byte must be a known HTML attribute boundary so we don't
 * match `xhref=` inside another word or a string literal — the realistic
 * non-match risk is matching attribute names that are substrings of other
 * tokens inside an inline `<script>`/`<style>` block. We accept that risk
 * inside the 64 KiB head window because (a) inline scripts in the head are
 * rare on production bundlers, (b) substring matches inside JS string
 * literals would have to be quoted with `"`/`'` to trigger, and (c) the
 * rewrite only fires on values starting with `/`.
 */
function matchAttributeAt(body: Uint8Array, i: number, limit: number): AttributeMatch | null {
	for (const attr of ATTR_PATTERNS) {
		if (i + attr.name.length + 2 > body.length) continue;
		if (!matchesAsciiCi(body, i, attr.name)) continue;
		// Boundary check: previous byte must be whitespace, `<`, or `/`.
		if (i > 0) {
			const prev = body[i - 1];
			if (
				prev !== 0x20 /* space */ &&
				prev !== 0x09 /* tab */ &&
				prev !== 0x0a /* LF */ &&
				prev !== 0x0d /* CR */ &&
				prev !== 0x3c /* < */ &&
				prev !== 0x2f /* / */
			) {
				continue;
			}
		}
		const eqPos = i + attr.name.length;
		if (body[eqPos] !== 0x3d /* = */) continue;
		const quotePos = eqPos + 1;
		const quote = body[quotePos];
		if (quote !== 0x22 /* " */ && quote !== 0x27 /* ' */) continue;
		const valueStart = quotePos + 1;
		let valueEnd = valueStart;
		while (valueEnd < body.length && body[valueEnd] !== quote) valueEnd++;
		// Unterminated quoted value → bail. valueEnd at limit/end is OK only when
		// the closing quote exists; otherwise the rewrite is unsafe.
		if (valueEnd >= body.length) continue;
		if (valueStart > limit) continue;
		return { valueStart, valueEnd, isSrcset: attr.isSrcset };
	}
	return null;
}

const ATTR_PATTERNS: ReadonlyArray<{ name: Uint8Array; isSrcset: boolean }> = [
	{ name: new TextEncoder().encode("srcset"), isSrcset: true },
	{ name: new TextEncoder().encode("href"), isSrcset: false },
	{ name: new TextEncoder().encode("src"), isSrcset: false },
];

function matchesAsciiCi(haystack: Uint8Array, at: number, needle: Uint8Array): boolean {
	if (at + needle.length > haystack.length) return false;
	for (let j = 0; j < needle.length; j++) {
		const h = haystack[at + j];
		const n = needle[j];
		if (h === undefined || n === undefined) return false;
		const hLower = h >= 0x41 && h <= 0x5a ? h + 0x20 : h;
		const nLower = n >= 0x41 && n <= 0x5a ? n + 0x20 : n;
		if (hLower !== nLower) return false;
	}
	return true;
}

/**
 * Rewrite a single root-relative URL value. Returns null when the value
 * doesn't qualify (empty, doesn't start with `/`, starts with `//`,
 * already prefixed). On a hit returns a new buffer with `prefix`
 * prepended.
 */
function rewriteUrlValue(value: Uint8Array, prefix: Uint8Array): Uint8Array | null {
	if (value.length === 0) return null;
	if (value[0] !== 0x2f /* / */) return null;
	// Protocol-relative `//host/...` — out of scope.
	if (value.length >= 2 && value[1] === 0x2f) return null;
	if (startsWithPrefix(value, prefix)) {
		// Already at the prefix root or under the prefix. `/p/<id>` exactly
		// and `/p/<id>/...` both pass through.
		if (value.length === prefix.length) return null;
		if (value[prefix.length] === 0x2f) return null;
	}
	const out = new Uint8Array(prefix.length + value.length);
	out.set(prefix, 0);
	out.set(value, prefix.length);
	return out;
}

/**
 * Rewrite a `srcset` attribute value. Splits on commas at the top level
 * (commas inside data: URLs are not handled — those skip the rewrite
 * anyway because they don't start with `/`). For each entry, the URL is
 * the leading whitespace-trimmed run up to the next whitespace; only
 * that URL portion is rewritten via `rewriteUrlValue`.
 */
function rewriteSrcsetValue(value: Uint8Array, prefix: Uint8Array): Uint8Array | null {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(value);
	const entries = text.split(",");
	let changed = false;
	const rewrittenEntries = entries.map((entry) => {
		const leading = entry.match(/^\s*/)?.[0] ?? "";
		const rest = entry.slice(leading.length);
		const urlEnd = rest.search(/\s/);
		const url = urlEnd === -1 ? rest : rest.slice(0, urlEnd);
		const tail = urlEnd === -1 ? "" : rest.slice(urlEnd);
		if (url.length === 0) return entry;
		const urlBytes = new TextEncoder().encode(url);
		const rewritten = rewriteUrlValue(urlBytes, prefix);
		if (rewritten === null) return entry;
		changed = true;
		return `${leading}${new TextDecoder().decode(rewritten)}${tail}`;
	});
	if (!changed) return null;
	return new TextEncoder().encode(rewrittenEntries.join(","));
}

function startsWithPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
	if (value.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (value[i] !== prefix[i]) return false;
	}
	return true;
}

/**
 * Rewrite a `Location:` header value into the path-mode prefix when it
 * names a same-origin absolute path. Returns the input unchanged when:
 *   - the value is empty;
 *   - the value is an absolute URL (`http://...`, `https://...`);
 *   - the value is a scheme-relative URL (`//host/path`);
 *   - the value already lives under `<pathPrefix>/`.
 *
 * Only path-mode callers invoke this; subdomain mode preserves URL
 * semantics already.
 */
export function rewriteLocationHeader(value: string, pathPrefix: string): string {
	if (value.length === 0) return value;
	// Same-origin absolute paths start with a single `/`; protocol-relative
	// `//host/path` and absolute URLs (`http(s)://...`) are out of scope.
	if (!value.startsWith("/") || value.startsWith("//")) return value;
	if (value === pathPrefix) return value;
	if (value.startsWith(`${pathPrefix}/`)) return value;
	return `${pathPrefix}${value}`;
}

const TEXT_ENCODER = new TextEncoder();
const HEAD_OPEN_BYTES = TEXT_ENCODER.encode("<head");
const BASE_OPEN_BYTES = TEXT_ENCODER.encode("<base");

function indexOfAsciiCaseInsensitive(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
	if (needle.length === 0) return start;
	const end = haystack.length - needle.length;
	outer: for (let i = start; i <= end; i++) {
		for (let j = 0; j < needle.length; j++) {
			const h = haystack[i + j];
			const n = needle[j];
			if (h === undefined || n === undefined) continue outer;
			const hLower = h >= 0x41 && h <= 0x5a ? h + 0x20 : h;
			const nLower = n >= 0x41 && n <= 0x5a ? n + 0x20 : n;
			if (hLower !== nLower) continue outer;
		}
		return i;
	}
	return -1;
}

/**
 * Return true iff the buffer contains a `<base>` element (i.e. `<base`
 * followed by whitespace, `/`, or `>`) — `<basefont>` is the only other
 * element starting with `<base` and is deprecated enough we ignore it.
 */
function hasBaseElement(buf: Uint8Array, from: number): boolean {
	let cursor = from;
	while (cursor < buf.length) {
		const idx = indexOfAsciiCaseInsensitive(buf, BASE_OPEN_BYTES, cursor);
		if (idx === -1) return false;
		const next = buf[idx + BASE_OPEN_BYTES.length];
		if (
			next === 0x20 || // space
			next === 0x09 || // tab
			next === 0x0a || // LF
			next === 0x0d || // CR
			next === 0x2f || // /
			next === 0x3e // >
		) {
			return true;
		}
		cursor = idx + BASE_OPEN_BYTES.length;
	}
	return false;
}

function previewError(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code, message } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * 401 envelope with a mode-aware hint pointing at the login handshake.
 * Subdomain mode emits an absolute URL keyed off the configured host;
 * path mode keeps the hint relative (the warren origin matches the
 * inbound request, but the proxy preamble is below the auth layer that
 * would otherwise validate that origin).
 */
function previewUnauthorized(runId: string, config: PreviewProxyConfig, url: URL): Response {
	const loginPath = `${LOGIN_PATH_PREFIX}${runId}/preview/login`;
	const hint =
		config.mode === "subdomain"
			? `GET https://${config.host}${loginPath}?token=<WARREN_API_TOKEN>&redirect=https://run-${runId}.${config.host}/`
			: `GET ${url.origin}${loginPath}?token=<WARREN_API_TOKEN>&redirect=${url.origin}/p/${runId}/`;
	const body = {
		error: {
			code: "preview_unauthorized",
			message: "preview requires a signed-cookie session",
			hint,
		},
	};
	return new Response(JSON.stringify(body), {
		status: 401,
		headers: {
			"content-type": "application/json",
			// Browsers don't honor WWW-Authenticate for cookie schemes, but
			// the header is informative for CLI consumers.
			"www-authenticate": 'Cookie realm="warren-preview"',
		},
	});
}

// Re-export PreviewMode so call sites that wire the proxy don't have
// to dual-import from warren-config.
export type { PreviewMode };
