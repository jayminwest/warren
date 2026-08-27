/**
 * Forge credential-heartbeat boot wiring (warren-1295, plan pl-d1c9
 * acceptance criterion 8).
 *
 * Boots the GitHub App credential probe (`src/forge/github-app/heartbeat.ts`)
 * when — and only when — the resolved forge is the App provider
 * (`WARREN_FORGE=app`). The PAT-mode `GitHubForge` holds a static secret
 * with no mint path, so there is nothing to probe; the `fake` forge has
 * no credential at all.
 *
 * Extracted from `bootServer` (which sits at its per-file size budget)
 * and invoked from `./detector-wiring.ts` alongside the other background
 * detectors.
 */

import type { Forge } from "../../forge/contract.ts";
import {
	type ForgeHeartbeatHandle,
	loadForgeHeartbeatConfigFromEnv,
	startGitHubAppHeartbeat,
} from "../../forge/github-app/heartbeat.ts";
import { GitHubAppForge } from "../../forge/github-app/provider.ts";
import { HotForge } from "../../forge/hot-forge.ts";
import { resolveForgeKind } from "../../forge/registry.ts";
import type { MetricsRegistry } from "../../observability/metrics-registry.ts";
import type { EnvLike } from "../config.ts";
import type { Logger } from "../types.ts";

export interface ForgeHeartbeatWiringInput {
	readonly env: EnvLike;
	/** The boot-resolved forge (src/forge/registry.ts). */
	readonly forge: Forge;
	readonly logger: Logger;
	/** Optional counter sink; the probe increments once per tick when present. */
	readonly metricsRegistry: MetricsRegistry | undefined;
}

/**
 * Boot the App-credential heartbeat, or return `undefined` when there is
 * nothing to probe (non-`app` forge) or the operator opted out
 * (`WARREN_FORGE_HEARTBEAT_DISABLED=1`).
 */
export function bootForgeHeartbeatFromEnv(
	input: ForgeHeartbeatWiringInput,
): ForgeHeartbeatHandle | undefined {
	const { env, logger } = input;
	// warren-b504: when the opt-in credential store armed boot, the forge
	// threaded through boot is the `HotForge` wrapper — unwrap to the
	// concrete delegate so the probe targets the real provider.
	const forge = input.forge instanceof HotForge ? input.forge.current : input.forge;
	if (resolveForgeKind(env) !== "app") return undefined;
	if (!(forge instanceof GitHubAppForge)) {
		// Unreachable through resolveForge (the `app` arm only constructs
		// GitHubAppForge); a hand-built deps bag could still land here.
		logger.warn({}, "WARREN_FORGE=app but the resolved forge is not a GitHubAppForge");
		return undefined;
	}
	const config = loadForgeHeartbeatConfigFromEnv(env);
	if (!config.enabled) {
		logger.info({}, "forge heartbeat disabled via WARREN_FORGE_HEARTBEAT_DISABLED");
		return undefined;
	}
	const handle = startGitHubAppHeartbeat({
		probe: () => forge.probeCredential(),
		intervalMs: config.intervalMs,
		logger,
		...(input.metricsRegistry !== undefined ? { metrics: input.metricsRegistry } : {}),
	});
	logger.info({ intervalMs: config.intervalMs }, "forge heartbeat running (WARREN_FORGE=app)");
	return handle;
}
