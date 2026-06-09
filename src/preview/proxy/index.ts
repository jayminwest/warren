/**
 * Reverse proxy preamble for per-run previews (R-19 / SPEC §11.L,
 * warren-8a10; path-mode addendum warren-8085 + HTML rewrite warren-ab3a
 * / pl-f4ea; SPA out-of-the-box revision warren-63e1). Split into
 * `proxy/` modules in warren-b902.
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
 *     that preview and forwards `url.pathname` to the preview's
 *     upstream port. Modern SPA bundlers emit root-relative asset URLs
 *     that the HTML `<base>` rewrite can't redirect; without referer
 *     routing those assets fall through to warren's SPA shell.
 *
 * In either mode the rest of the seam is identical:
 *
 *   1. **Resolve the run.** `runs.preview_state` must be `live`;
 *      anything else (`starting`, `failed`, `torn-down`, null) → 503.
 *      Unknown runId → 404.
 *
 *   2. **Cross-host check.** `runs.worker_id !== LOCAL_WORKER_NAME`
 *      returns **501** with an R-12 deferral message.
 *
 *   3. **Signed-cookie auth.** Missing / invalid / expired cookie →
 *      **401** pointing the browser at `/runs/:id/preview/login`.
 *
 *   4. **last_hit_at debounce.** Update `runs.preview_last_hit_at`
 *      **before** forwarding (SPEC §11.L) — debounced via an in-memory
 *      `Map<runId, lastFlushAtMs>` to ~once per `DEFAULT_DEBOUNCE_MS`.
 *
 *   5. **Forward.** Rewrite the URL to `http://127.0.0.1:<preview_port>`,
 *      strip warren-internal headers (`Host` / `Cookie` / `Authorization`),
 *      and stream the body through (`forward.ts`).
 *
 *   6. **Path-mode response rewrites (best-effort).** `<base href>`
 *      injection, root-relative `href`/`src`/`srcset` rewriting, and
 *      same-origin `Location:` rewriting all live in `rewrite.ts`.
 *      Other content types and subdomain mode skip every transform.
 *
 * WebSocket upgrades are not yet supported (HTTP-only V1; 426 returned).
 *
 * Every observable side effect (clock, runs repo, fetch) is injectable
 * so unit tests don't touch real sockets or wait on real timers.
 */

import { LOCAL_WORKER_NAME } from "../../burrow-client/pool.ts";
import type { PreviewMode } from "../../warren-config/index.ts";
import { DEFAULT_DEBOUNCE_MS, forwardToUpstream, maybeFlushLastHit } from "./forward.ts";
import { previewError, previewUnauthorized } from "./responses.ts";
import {
	isWarrenApiPath,
	PREVIEW_PATH_PREFIX,
	parsePreviewPathPrefix,
	parseRunIdFromHost,
	parseRunIdFromReferer,
} from "./route-match.ts";
import type { PreviewProxyDeps, PreviewProxyHandler } from "./types.ts";

// Public surface — types, helper functions, and constants the rest of
// the codebase and tests pull from `./index.ts`. Re-exported here so
// `import ... from "../preview/proxy/index.ts"` (or just
// `"../preview/proxy"`) keeps working after the split.
export { DEFAULT_DEBOUNCE_MS } from "./forward.ts";
export { LOGIN_PATH_PREFIX } from "./responses.ts";
export {
	HTML_HEAD_LOOKAHEAD_BYTES,
	injectBaseHref,
	isHtmlContentType,
	rewriteLocationHeader,
	rewriteRootRelativeAttrs,
} from "./rewrite.ts";
export {
	isWarrenApiPath,
	PREVIEW_PATH_PREFIX,
	parsePreviewPathPrefix,
	parseRunIdFromHost,
	parseRunIdFromReferer,
} from "./route-match.ts";
export type {
	PreviewProxyConfig,
	PreviewProxyConfigPath,
	PreviewProxyConfigSubdomain,
	PreviewProxyDeps,
	PreviewProxyHandler,
} from "./types.ts";
// Re-export PreviewMode so call sites that wire the proxy don't have
// to dual-import from warren-config.
export type { PreviewMode };

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
