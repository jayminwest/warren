/**
 * Preview-proxy + signed-cookie auth wiring (warren-8d3d / pl-9088 step
 * 10). Extracted from `bootServer` so the orchestrator in `index.ts`
 * stays under the per-file budget.
 *
 * R-19 / docs/design/preview-environments.md (warren-8a10; path-mode scope warren-edff). Both
 * surfaces (login handshake + proxy preamble) need the same secret;
 * derive from `WARREN_API_TOKEN` so a fresh-install operator doesn't
 * have a second token to manage (warren-ef6e: under the first-boot
 * token bootstrap, `serverConfig.token` carries the mint-or-reused
 * persisted token, so the preview signer follows it automatically).
 *
 * Subdomain mode requires `WARREN_PREVIEW_HOST` (the cookie's Domain
 * scope and the proxy's Host match both anchor to it). Path mode
 * (default) doesn't — the only disabler is `--no-auth` (no token to
 * sign with).
 *
 * Mode discriminator from `WARREN_PREVIEW_MODE` (warren-fcb7) picks the
 * routing branch. Since warren-3f8a, path mode serves previews from a
 * DEDICATED listener (`WARREN_PREVIEW_PORT`, default bind port + 1) so
 * previews get their own browser origin and cannot read the operator
 * token out of the warren UI's localStorage. `bootPreviewSurface` is
 * the topology decision point:
 *
 *   - subdomain mode → proxy mounts as the MAIN listener's preamble
 *     (origin isolation comes from the per-run host).
 *   - path mode, TCP  → proxy mounts on the dedicated listener; the
 *     main listener gets a 308 redirect preamble for `/p/...`.
 *   - path mode, unix → no TCP port to bind; legacy same-origin
 *     mounting with a boot warning naming the risk.
 */

import type { Repos } from "../../db/repos/index.ts";
import { createPreviewAuth, type PreviewAuth } from "../../preview/cookie.ts";
import type { loadPreviewLaunchConfigFromEnv } from "../../preview/launch/index.ts";
import {
	createPreviewPathRedirect,
	createPreviewProxyHandler,
	type PreviewProxyConfig,
	type PreviewProxyHandler,
} from "../../preview/proxy/index.ts";
import { startPreviewServer } from "../preview-server.ts";
import type { Logger, ServeHandle, Transport } from "../types.ts";

type PreviewLaunchConfig = ReturnType<typeof loadPreviewLaunchConfigFromEnv>;

export interface PreviewWiringInput {
	readonly token: string | null;
	readonly previewLaunchConfig: PreviewLaunchConfig;
	readonly repos: Repos;
	readonly logger: Logger;
	/**
	 * `RuntimeProvider.capabilities.previewPorts` from the boot-resolved
	 * provider (warren-820e). A provider that can never allocate preview
	 * ports must not install the pre-auth preview preamble at all —
	 * capabilities-not-conditionals applied to a boot-time wiring
	 * decision, and it removes the pre-auth `/p/<runId>` surface on
	 * deployments (K8s today) where it is dead code.
	 */
	readonly previewPorts: boolean;
	/**
	 * The warren API listener's TCP port (warren-3f8a), threaded into the
	 * path-mode proxy config so 401 hints can name the login origin.
	 * Omit on the unix transport or when the bind port is ephemeral.
	 */
	readonly apiPort?: number;
	readonly now?: () => Date;
}

export interface PreviewWiring {
	readonly previewAuth: PreviewAuth | undefined;
	readonly previewProxy: PreviewProxyHandler | undefined;
}

function proxyConfigFor(
	previewLaunchConfig: PreviewLaunchConfig,
	apiPort: number | undefined,
): PreviewProxyConfig {
	if (previewLaunchConfig.mode === "path") {
		return {
			mode: "path",
			host: previewLaunchConfig.host,
			...(apiPort !== undefined ? { apiPort } : {}),
		};
	}
	return { mode: "subdomain", host: previewLaunchConfig.host as string };
}

export function createPreviewAuthAndProxy(input: PreviewWiringInput): PreviewWiring {
	const { token, previewLaunchConfig, repos, logger, apiPort, now } = input;
	if (!input.previewPorts) {
		logger.info(
			{},
			"runtime provider lacks the previewPorts capability; preview surface disabled (warren-820e)",
		);
		return { previewAuth: undefined, previewProxy: undefined };
	}
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
					config: proxyConfigFor(previewLaunchConfig, apiPort),
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

export interface PreviewSurfaceInput extends PreviewWiringInput {
	readonly transport: Transport;
}

export interface PreviewSurface {
	readonly previewAuth: PreviewAuth | undefined;
	/**
	 * Preamble for the MAIN listener: the subdomain proxy, the path-mode
	 * 308 redirect, or the legacy unix-transport path proxy. Undefined
	 * when the preview surface is disabled.
	 */
	readonly mainPreamble: PreviewProxyHandler | undefined;
	/** The dedicated path-mode preview listener (TCP transport only). */
	readonly previewListener: ServeHandle | undefined;
	/**
	 * Launch config with `port` resolved to the preview listener's actual
	 * public port (null when no dedicated listener runs) — the shape URL
	 * builders (PR annotation, `/preview/config`) should consume.
	 */
	readonly launchConfig: PreviewLaunchConfig;
}

/**
 * Decide the preview topology and boot the dedicated listener when path
 * mode runs on TCP (warren-3f8a). See the module header for the matrix.
 */
export function bootPreviewSurface(input: PreviewSurfaceInput): PreviewSurface {
	const { transport, previewLaunchConfig, logger } = input;
	const apiPort = transport.kind === "tcp" && transport.port > 0 ? { apiPort: transport.port } : {};
	const { previewAuth, previewProxy } = createPreviewAuthAndProxy({ ...input, ...apiPort });

	const disabledOrSubdomain =
		previewProxy === undefined || previewLaunchConfig.mode === "subdomain";
	if (disabledOrSubdomain) {
		return {
			previewAuth,
			mainPreamble: previewProxy,
			previewListener: undefined,
			launchConfig: { ...previewLaunchConfig, port: null },
		};
	}

	if (transport.kind !== "tcp") {
		logger.warn(
			{},
			"path-mode previews share the warren origin on the unix transport (warren-3f8a): agent-authored preview code runs same-origin with the operator UI; prefer WARREN_PREVIEW_MODE=subdomain or a TCP bind",
		);
		return {
			previewAuth,
			mainPreamble: previewProxy,
			previewListener: undefined,
			launchConfig: { ...previewLaunchConfig, port: null },
		};
	}

	const bindPort = previewLaunchConfig.port ?? (transport.port > 0 ? transport.port + 1 : 0);
	const previewListener = startPreviewServer({
		hostname: transport.hostname,
		port: bindPort,
		proxy: previewProxy,
		logger,
	});
	const resolvedPort =
		previewListener.transport.kind === "tcp" ? previewListener.transport.port : null;
	logger.info(
		{ url: previewListener.url },
		"preview listener running on its own origin (warren-3f8a)",
	);
	return {
		previewAuth,
		mainPreamble: resolvedPort !== null ? createPreviewPathRedirect(resolvedPort) : undefined,
		previewListener,
		launchConfig: { ...previewLaunchConfig, port: resolvedPort },
	};
}
