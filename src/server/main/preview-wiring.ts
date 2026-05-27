/**
 * Preview-proxy + signed-cookie auth wiring (warren-8d3d / pl-9088 step
 * 10). Extracted from `bootServer` so the orchestrator in `index.ts`
 * stays under the per-file budget.
 *
 * R-19 / SPEC §11.L (warren-8a10; path-mode scope warren-edff). Both
 * surfaces (login handshake + proxy preamble) need the same secret;
 * derive from `WARREN_API_TOKEN` so a fresh-install operator doesn't
 * have a second token to manage.
 *
 * Subdomain mode requires `WARREN_PREVIEW_HOST` (the cookie's Domain
 * scope and the proxy's Host match both anchor to it). Path mode
 * (default) doesn't — previews ride on the warren host itself, so the
 * only disabler is `--no-auth` (no token to sign with).
 *
 * Mode discriminator from `WARREN_PREVIEW_MODE` (warren-fcb7) picks the
 * routing branch: subdomain mode keys off `Host: run-<id>.<host>` and
 * requires `WARREN_PREVIEW_HOST`. Path mode (warren-edff) keys off the
 * request pathname and works without a host — the proxy derives the
 * preview origin from the inbound request, the cookie scopes itself
 * per-runId via `Path=/p/<id>/`.
 */

import type { Repos } from "../../db/repos/index.ts";
import { createPreviewAuth, type PreviewAuth } from "../../preview/cookie.ts";
import type { loadPreviewLaunchConfigFromEnv } from "../../preview/launch/index.ts";
import { createPreviewProxyHandler, type PreviewProxyHandler } from "../../preview/proxy/index.ts";
import type { Logger } from "../types.ts";

type PreviewLaunchConfig = ReturnType<typeof loadPreviewLaunchConfigFromEnv>;

export interface PreviewWiringInput {
	readonly token: string | null;
	readonly previewLaunchConfig: PreviewLaunchConfig;
	readonly repos: Repos;
	readonly logger: Logger;
	readonly now?: () => Date;
}

export interface PreviewWiring {
	readonly previewAuth: PreviewAuth | undefined;
	readonly previewProxy: PreviewProxyHandler | undefined;
}

export function createPreviewAuthAndProxy(input: PreviewWiringInput): PreviewWiring {
	const { token, previewLaunchConfig, repos, logger, now } = input;
	const previewAuth: PreviewAuth | undefined =
		token !== null && (previewLaunchConfig.mode === "path" || previewLaunchConfig.host !== null)
			? createPreviewAuth(token, {
					scope:
						previewLaunchConfig.mode === "path"
							? { mode: "path" }
							: { mode: "subdomain", cookieDomain: `.${previewLaunchConfig.host}` },
				})
			: undefined;

	const previewProxy: PreviewProxyHandler | undefined =
		previewAuth !== undefined &&
		(previewLaunchConfig.mode === "path" || previewLaunchConfig.host !== null)
			? createPreviewProxyHandler({
					repos,
					previewAuth,
					config:
						previewLaunchConfig.mode === "path"
							? { mode: "path", host: previewLaunchConfig.host }
							: { mode: "subdomain", host: previewLaunchConfig.host as string },
					...(now !== undefined ? { now } : {}),
				})
			: undefined;

	if (previewLaunchConfig.host !== null && previewAuth === undefined) {
		logger.warn(
			{ host: previewLaunchConfig.host },
			"WARREN_PREVIEW_HOST is set but --no-auth disables the signed-cookie surface; preview proxy off",
		);
	}

	return { previewAuth, previewProxy };
}
