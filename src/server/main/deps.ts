/**
 * `ServerDeps` literal construction (warren-8d3d / pl-9088 step 10).
 * Extracted from `bootServer` so the orchestrator in `index.ts` stays
 * under the per-file budget. Pure assembly: every field comes from
 * inputs the orchestrator has already wired.
 */

import type { AnyWarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { MetricsRegistry } from "../../observability/metrics-registry.ts";
import type { PreviewAuth } from "../../preview/cookie.ts";
import type { loadPreviewEvictionConfigFromEnv } from "../../preview/eviction/index.ts";
import type { loadPreviewLaunchConfigFromEnv } from "../../preview/launch/index.ts";
import type { loadPreviewPortRangeFromEnv } from "../../preview/port-allocator.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { loadCanopyRegistryConfigFromEnv } from "../../registry/config.ts";
import type { loadAutoOpenPrConfigFromEnv, RunEventBroker } from "../../runs/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { PodAdmissionSource } from "../../runtime/k8s/admission.ts";
import type { PodMetricsSource } from "../../runtime/k8s/pod-metrics.ts";
import type { PodCacheReader } from "../../runtime/k8s/pod-watcher.ts";
import type { createWarrenConfigCache } from "../../warren-config/index.ts";
import { IdempotencyStore } from "../idempotency.ts";
import type { BridgeRegistry, Logger, ServerDeps } from "../types.ts";
import { defaultSpawn } from "./utils.ts";

type CanopyConfig = ReturnType<typeof loadCanopyRegistryConfigFromEnv>;
type AutoOpenPrConfig = ReturnType<typeof loadAutoOpenPrConfigFromEnv>;
type WarrenConfigs = ReturnType<typeof createWarrenConfigCache>;
type PreviewLaunchConfig = ReturnType<typeof loadPreviewLaunchConfigFromEnv>;
type PreviewEvictionConfig = ReturnType<typeof loadPreviewEvictionConfigFromEnv>;
type PreviewPortRange = ReturnType<typeof loadPreviewPortRangeFromEnv>;

export interface BuildServerDepsInput {
	readonly repos: Repos;
	readonly db: AnyWarrenDb;
	/**
	 * The runtime provider resolved ONCE at boot (`resolveRuntimeProvider`,
	 * warren-c531) — the sole composition point. `bootServer` resolves it before
	 * `bootBridges` (so the bridge registry, run-state poller, and watchdog all
	 * share the same instance) and hands it here rather than deps re-resolving a
	 * second instance. Under `local` it is the burrow-backed `LocalProvider`.
	 */
	readonly runtimeProvider: RuntimeProvider;
	/**
	 * Provider-neutral preview sidecar resolver (warren-e24d), gated on the
	 * runtime's preview-port capability at boot. Threaded onto `ServerDeps` for
	 * the preview-teardown handler's best-effort sidecar stop. Absent under a
	 * backend without preview ports.
	 */
	readonly previewSidecars?: import("../../runtime/local/preview/sidecars.ts").LocalSidecarsResolver;
	/**
	 * Local-topology `/readyz` burrow probe (warren-f796). Present only under
	 * `WARREN_RUNTIME=local` (from the `LocalBootBackend`); absent under k8s.
	 */
	readonly burrowProbe?: () => Promise<import("../../diagnostics/checks.ts").DiagnosticCheck>;
	readonly broker: RunEventBroker;
	readonly bridges: BridgeRegistry;
	readonly canopyConfig: CanopyConfig;
	readonly projectsConfig: ProjectsConfig;
	readonly logger: Logger;
	readonly uiDistDir: string | null;
	readonly autoOpenPr: AutoOpenPrConfig;
	readonly warrenConfigs: WarrenConfigs;
	readonly runBranchPrefixDefault: string | undefined;
	readonly previewPortRange: PreviewPortRange;
	readonly previewLaunchConfig: PreviewLaunchConfig;
	readonly previewEvictionConfig: PreviewEvictionConfig;
	readonly workspaceGcTtlMs: number;
	readonly previewAuth: PreviewAuth | undefined;
	readonly sdBinary: string;
	readonly metricsRegistry?: MetricsRegistry;
	/**
	 * The started K8s pod-watcher (src/server/main/runtime-wiring.ts), present
	 * only under `WARREN_RUNTIME=k8s`. One instance satisfies three seams: the
	 * `K8sProvider`'s status cache + admission source (threaded onto the provider
	 * below) and the `/metrics` pod-gauge source (`ServerDeps.podMetrics`).
	 * Absent under `local` — no pod plumbing is wired.
	 */
	readonly k8sPodWatcher?: PodCacheReader & PodAdmissionSource & PodMetricsSource;
	readonly now?: () => Date;
}

export function buildServerDeps(input: BuildServerDepsInput): ServerDeps {
	const {
		repos,
		db,
		runtimeProvider,
		burrowProbe,
		broker,
		bridges,
		canopyConfig,
		projectsConfig,
		logger,
		uiDistDir,
		autoOpenPr,
		warrenConfigs,
		runBranchPrefixDefault,
		previewPortRange,
		previewLaunchConfig,
		previewEvictionConfig,
		workspaceGcTtlMs,
		previewAuth,
		previewSidecars,
		sdBinary,
		metricsRegistry,
		k8sPodWatcher,
		now,
	} = input;

	const previewHostForDeps =
		previewLaunchConfig.host !== null ? previewLaunchConfig.host : undefined;

	// Runtime-provider seam (warren-c531): the provider is resolved ONCE at boot
	// (before `bootBridges`, so the bridge registry + poller + watchdog share it)
	// and threaded in here, rather than deps re-resolving a second instance.

	return {
		repos,
		db,
		runtimeProvider,
		...(burrowProbe !== undefined ? { burrowProbe } : {}),
		broker,
		bridges,
		...(canopyConfig !== null ? { canopyConfig } : {}),
		projectsConfig,
		logger,
		uiDistDir,
		spawn: defaultSpawn,
		seedsCli: { sdBinary, spawn: defaultSpawn },
		autoOpenPr,
		warrenConfigs,
		...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
		previewPortRange,
		previewMaxLive: previewEvictionConfig.maxLive,
		workspaceGcTtlMs,
		previewMode: previewLaunchConfig.mode,
		...(previewHostForDeps !== undefined ? { previewHost: previewHostForDeps } : {}),
		...(previewAuth !== undefined ? { previewAuth } : {}),
		...(previewSidecars !== undefined ? { previewSidecars } : {}),
		idempotencyStore: new IdempotencyStore(now !== undefined ? { now: () => now().getTime() } : {}),
		...(metricsRegistry !== undefined ? { metricsRegistry } : {}),
		// `/metrics` pod-phase gauges read live from the same pod-watcher at scrape
		// (pl-829f step 25 / warren-7c30); absent under LocalProvider.
		...(k8sPodWatcher !== undefined ? { podMetrics: k8sPodWatcher } : {}),
		...(now !== undefined ? { now } : {}),
	};
}
