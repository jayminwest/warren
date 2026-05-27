/**
 * Meta handlers — `/healthz`, `/version`, `/preview/config`.
 *
 * Extracted from `handlers/index.ts` (warren-599c / pl-9088 step 3).
 * These are deliberately the inert non-diagnostic probes; `/readyz`
 * lives in `./diagnostics.ts` because it pulls in the full probe set.
 */

import { VERSION } from "../../index.ts";
import { DEFAULT_PREVIEW_MODE } from "../../warren-config/index.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";

export function healthzHandler(): RouteHandler {
	return () => jsonResponse(200, { ok: true });
}

export function versionHandler(): RouteHandler {
	return () => jsonResponse(200, { version: VERSION });
}

/**
 * `GET /preview/config` (R-19 / SPEC §11.L path addendum, warren-016d).
 *
 * Surfaces the deployment-wide preview routing mode + optional host so the
 * UI's `PreviewCard` can render the canonical preview URL without having
 * to encode mode-specific shapes itself. The login handshake at
 * `/runs/:id/preview/login` does its own server-side redirect resolution,
 * so this endpoint is purely informational — the UI calls it once and
 * caches indefinitely (mode/host change requires a warren restart).
 *
 * `host` is null when path mode is configured without `WARREN_PREVIEW_HOST`;
 * in that case the UI derives the URL from `window.location.origin`. In
 * subdomain mode `host` is always set (boot rejects subdomain-without-host).
 */
export function previewConfigHandler(deps: ServerDeps): RouteHandler {
	return () =>
		jsonResponse(200, {
			mode: deps.previewMode ?? DEFAULT_PREVIEW_MODE,
			host: deps.previewHost ?? null,
		});
}
