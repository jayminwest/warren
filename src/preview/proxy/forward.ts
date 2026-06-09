/**
 * Upstream-forwarding core for the preview proxy (warren-b902 split of
 * src/preview/proxy/index.ts). Owns the actual `fetch` to `127.0.0.1:<port>`,
 * inbound auth-header stripping, content-encoding normalization, and
 * the debounced `preview_last_hit_at` write that drives the eviction
 * worker's idle clock.
 *
 * Path-mode response transforms (HTML `<base>` injection, root-relative
 * URL rewrites, `Location:` rewriting) live in `rewrite.ts` and run
 * here only when the caller supplies a non-null `pathPrefix`.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { RunRow } from "../../db/schema.ts";
import { previewError } from "./responses.ts";
import { applyPathModeRewrites } from "./rewrite.ts";

/** SPEC §11.L: debounce `preview_last_hit_at` writes to ~once per 30s. */
export const DEFAULT_DEBOUNCE_MS = 30_000;

export async function maybeFlushLastHit(
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

export async function forwardToUpstream(
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
