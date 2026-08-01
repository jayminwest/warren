/**
 * Meta handlers — `/healthz`, `/version`, `/whoami`, `/preview/config`.
 *
 * Extracted from `handlers/index.ts` (warren-599c / pl-9088 step 3).
 * These are deliberately the inert non-diagnostic probes; `/readyz`
 * lives in `./diagnostics.ts` because it pulls in the full probe set.
 */

import { VERSION } from "../../index.ts";
import { DEFAULT_PREVIEW_MODE } from "../../warren-config/index.ts";
import { grantedCapabilities, OPERATOR_ACTOR } from "../auth.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";

export function healthzHandler(): RouteHandler {
	return () => jsonResponse(200, { ok: true });
}

export function versionHandler(): RouteHandler {
	return () => jsonResponse(200, { version: VERSION });
}

/**
 * `GET /whoami` — the caller's own identity and capability set
 * (warren-e195).
 *
 * The server-side source of truth for the UI capability layer: the SPA
 * calls this once on mount and renders operator-only affordances from the
 * answer instead of inferring permission from "is there a token in
 * localStorage". Everything it reports is derived from the request the
 * caller already made, so it discloses nothing the caller didn't supply.
 *
 * Its policy is `readPublic`, not `anonymous` — deliberately. An
 * `anonymous` route is auth-exempt, so the gate never runs and
 * `RouteContext.actor` is undefined: the route could not name its caller
 * at all. `readPublic` gives the UI what it needs in both modes. Under
 * `WARREN_AUTH=public` a credential-less caller is admitted as
 * `ANONYMOUS_ACTOR` and learns it is anonymous; under the default
 * `WARREN_AUTH=token` it gets the same 401 as every other API route,
 * which the SPA already routes to the login screen.
 *
 * The body varies with the `Authorization` header, so it is per-caller and
 * must not be shared-cached; `Vary` says so to any proxy in front of
 * warren. The UI is expected to hold it in memory for the session.
 */
export function whoamiHandler(): RouteHandler {
	return (ctx) => {
		// An absent actor means the request never passed the gate — only a
		// hand-built test context arrives that way — and is read as the
		// operator, matching `isPublicOnly` in `../projection.ts`.
		const actor = ctx.actor ?? OPERATOR_ACTOR;
		return jsonResponse(
			200,
			{ identity: actor.kind, capabilities: grantedCapabilities(actor) },
			{ headers: { vary: "Authorization" } },
		);
	};
}

/**
 * `GET /preview/config` (R-19 / docs/design/preview-environments.md path addendum, warren-016d).
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
