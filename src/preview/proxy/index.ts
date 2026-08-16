/**
 * Reverse proxy preamble for per-run previews (R-19 / docs/design/preview-environments.md,
 * warren-8a10; path-mode addendum warren-8085 + HTML rewrite warren-ab3a
 * / pl-f4ea; SPA out-of-the-box revision warren-63e1). Split into
 * `proxy/` modules in warren-b902.
 *
 * The proxy is an in-process Bun route, not a separate reverse proxy.
 * There are two routing modes, picked at config time from
 * `WARREN_PREVIEW_MODE`:
 *
 *   - **Subdomain mode** (operator owns a wildcard CNAME + cert): the
 *     handler runs as a preamble *before* the normal auth gate and
 *     route match in `src/server/server.ts` and matches
 *     `Host: run-<runId>.<previewHost>`. URL forwarded upstream keeps
 *     `url.pathname` verbatim.
 *
 *   - **Path mode** (default; reuses warren's own hostname + cert):
 *     match `^/p/<runId>(/<rest>)?$` on the request path. The
 *     `/p/<runId>` prefix is stripped before forwarding so the
 *     upstream sees a request rooted at `<rest>` (or `/` when `rest`
 *     is empty). Since warren-3f8a the handler is mounted on a
 *     DEDICATED listener (`WARREN_PREVIEW_PORT`, default bind port +
 *     1) so previews get their own browser origin — same-origin
 *     preview code must not be able to read the operator token out of
 *     the warren UI's storage. The main listener answers `/p/...` with
 *     a 308 to the preview origin (`createPreviewPathRedirect`). The
 *     unix transport keeps the legacy same-origin mounting (no TCP
 *     port to bind) and warns at boot.
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
 *   1. **Signed-cookie auth** (warren-820e: FIRST, before any run
 *      lookup). The preamble runs below warren's auth gate, so
 *      unauthenticated callers must see one uniform **401** whether
 *      the runId is unknown, previewless, or remote — anything else
 *      is a run-existence / topology oracle. The cookie verifies
 *      against the URL-derived runId alone, so it can be checked
 *      without touching the database.
 *
 *   2. **Resolve the run.** `runs.preview_state` must be `live`;
 *      anything else (`starting`, `failed`, `torn-down`, null) → 503.
 *      Unknown runId → 404. These distinct answers only reach
 *      cookie-verified callers.
 *
 *   3. **Cross-host check.** `runs.worker_id !== LOCAL_WORKER_NAME`
 *      returns **501** with an R-12 deferral message that never
 *      interpolates the worker id.
 *
 *   4. **last_hit_at debounce.** Update `runs.preview_last_hit_at`
 *      **before** forwarding (docs/design/preview-environments.md) — debounced via an in-memory
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

import { LOCAL_WORKER_NAME } from "../../runs/worker-identity.ts";
import type { PreviewMode } from "../../warren-config/index.ts";
import { DEFAULT_DEBOUNCE_MS, forwardToUpstream, maybeFlushLastHit } from "./forward.ts";
import { previewError, previewUnauthorized } from "./responses.ts";
import {
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
export { createPreviewPathRedirect } from "./redirect.ts";
export { LOGIN_PATH_PREFIX } from "./responses.ts";
export {
	HTML_HEAD_LOOKAHEAD_BYTES,
	injectBaseHref,
	isHtmlContentType,
	rewriteLocationHeader,
	rewriteRootRelativeAttrs,
} from "./rewrite.ts";
export {
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
				// Referer-based asset routing (warren-63e1). The path-mode
				// proxy runs on the dedicated preview listener (warren-3f8a),
				// which serves nothing but previews — every unmatched path is
				// a candidate sub-resource, so no API carve-out applies.
				const refererRunId = parseRunIdFromReferer(request.headers.get("referer"));
				if (refererRunId === null) return null;
				runId = refererRunId;
				// Asset request: forward the original pathname verbatim so the
				// upstream sees e.g. `/_next/static/foo.js`, not `/p/<id>/...`.
				upstreamPath = url.pathname;
			}
		}

		// Auth FIRST (warren-820e): closing the run-existence oracle means the
		// uniform 401 must be decided from the URL + cookie alone, before any
		// repo lookup. Signed cookie verifies against this run's id (so a cookie
		// scoped to .<host> can't be used to reach a sibling preview).
		const cookieHeader = request.headers.get("cookie");
		if (!deps.previewAuth.verifyCookie(cookieHeader, runId, now())) {
			return previewUnauthorized(runId, deps.config, url);
		}

		const run = await deps.repos.runs.get(runId);
		if (run === null) {
			return previewError(404, "preview_not_found", `no run with id ${runId}`);
		}

		if (run.workerId !== null && run.workerId !== localWorkerName) {
			// The preamble runs BEFORE the auth gate, so this body reaches
			// anonymous callers — never interpolate `run.workerId` into it.
			// `workerId` is a REDACTED_RUN_FIELDS member (warren-946f): internal
			// worker topology is operator-only shape, and scenario 39 now drives
			// this exact path with a sentinel in the column (warren-b0bd).
			return previewError(
				501,
				"preview_remote_worker",
				"preview proxying is local-worker-only in V1; the run lives on a remote worker (R-12 deferral, see docs/design/preview-environments.md)",
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

		// docs/design/preview-environments.md: update last_hit_at BEFORE forwarding (debounced).
		await maybeFlushLastHit(deps.repos, run, lastFlush, debounceMs, now());

		const pathPrefix = mode === "path" ? `${PREVIEW_PATH_PREFIX}/${runId}` : null;
		return forwardToUpstream(fetchImpl, request, upstreamPath, url.search, port, pathPrefix);
	};
}
