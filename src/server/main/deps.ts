/**
 * `ServerDeps` literal construction (warren-8d3d / pl-9088 step 10).
 * Extracted from `bootServer` so the orchestrator in `index.ts` stays
 * under the per-file budget. Pure assembly: every field comes from
 * inputs the orchestrator has already wired.
 */

import type { AnyWarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { Forge } from "../../forge/contract.ts";
import type { MetricsRegistry } from "../../observability/metrics-registry.ts";
import type { PreviewAuth } from "../../preview/cookie.ts";
import type { loadPreviewEvictionConfigFromEnv } from "../../preview/eviction/index.ts";
import type { loadPreviewLaunchConfigFromEnv } from "../../preview/launch/index.ts";
import type { loadPreviewPortRangeFromEnv } from "../../preview/port-allocator.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { PublicAllowlist } from "../../projects/public-allowlist.ts";
import type { loadAutoOpenPrConfigFromEnv, RunEventBroker } from "../../runs/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { PodAdmissionSource } from "../../runtime/k8s/admission.ts";
import type { PodMetricsSource } from "../../runtime/k8s/pod-metrics.ts";
import type { PodCacheReader, PodSyncSource } from "../../runtime/k8s/pod-watcher.ts";
import { SeedsTracker } from "../../tracker/seeds-tracker.ts";
import type { createWarrenConfigCache } from "../../warren-config/index.ts";
import { createDbSeams } from "../db-seams.ts";
import { IdempotencyStore } from "../idempotency.ts";
import { EventStreamLimiter, type EventStreamLimits } from "../stream-limits.ts";
import type { BridgeRegistry, Logger, ServerDeps } from "../types.ts";
import { defaultSpawn } from "./utils.ts";

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
	 * The forge resolved ONCE at boot (`resolveForge`, warren-6c4c) — the same
	 * composition-point posture as `runtimeProvider` above. Handlers mint
	 * per-spawn git credentials through this single instance.
	 */
	readonly forge: Forge;
	/**
	 * The `/github-app/*` registration gate resolved ONCE at boot
	 * (warren-e320, `resolveGitHubAppRegistrationGate`) — the same
	 * composition-point posture as `forge` above.
	 */
	readonly gitHubAppRegistration: import("../github-app-gate.ts").GitHubAppRegistrationGate;
	/** warren-48f8: the armed setup-handoff store, when the boot opted in. */
	readonly setupHandoff?: import("../setup-handoff.ts").SetupHandoffStore;
	/** warren-b504: opt-in App credential store + hot forge seam; absent when not armed. */
	readonly gitHubAppActivation?: import("../../forge/hot-forge.ts").GitHubAppActivation;
	/**
	 * Provider-neutral preview sidecar resolver (warren-e24d), gated on the
	 * runtime's preview-port capability at boot. Threaded onto `ServerDeps` for
	 * the preview-teardown handler's best-effort sidecar stop. Absent under a
	 * backend without preview ports.
	 */
	readonly previewSidecars?: import("../../runtime/local/preview/sidecars.ts").LocalSidecarsResolver;
	readonly broker: RunEventBroker;
	/**
	 * Global lifecycle notification broker (warren-f566), built and fed by
	 * the lifecycle-bus wiring (`LifecycleBusHandle.lifecycleStream`).
	 * Serves `GET /events/stream`.
	 */
	readonly lifecycleStream: import("../../runs/lifecycle-stream.ts").LifecycleStreamBroker;
	readonly bridges: BridgeRegistry;
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
	/**
	 * Event-stream concurrency caps (warren-25f6), resolved from env by the
	 * orchestrator so a malformed knob fails at boot rather than at the first
	 * stream. One `EventStreamLimiter` is built from them here and shared by
	 * both NDJSON routes plus the `/metrics` saturation gauge.
	 */
	readonly eventStreamLimits: EventStreamLimits;
	/**
	 * Orgs `POST /projects` may register (warren-ce9b). Resolved by the
	 * orchestrator, which passes `undefined` unless `WARREN_AUTH=public`.
	 */
	readonly publicAllowlist: PublicAllowlist | undefined;
	readonly previewAuth: PreviewAuth | undefined;
	readonly sdBinary: string;
	/**
	 * Boot-resolved IssueTracker (warren-5819). Optional so tests can omit;
	 * when absent, `buildServerDeps` constructs a `SeedsTracker` from
	 * `sdBinary` + `defaultSpawn`.
	 */
	readonly issueTracker?: import("../../tracker/contract.ts").IssueTracker;
	readonly metricsRegistry?: MetricsRegistry;
	/**
	 * The started K8s pod-watcher (src/server/main/runtime-wiring.ts), present
	 * only under `WARREN_RUNTIME=k8s`. One instance satisfies three seams: the
	 * `K8sProvider`'s status cache + admission source (threaded onto the provider
	 * below) and the `/metrics` pod-gauge source (`ServerDeps.podMetrics`).
	 * Absent under `local` — no pod plumbing is wired.
	 */
	readonly k8sPodWatcher?: PodCacheReader & PodAdmissionSource & PodMetricsSource & PodSyncSource;
	/**
	 * Durable salvage-bundle directory (warren-cd3b), resolved by the
	 * orchestrator to `<dataDir>/salvage`. Threaded onto `ServerDeps` for the
	 * `POST /runs/:id/salvage` intake.
	 */
	readonly salvageDir: string;
	/**
	 * K8s finalize-intent recovery hook (warren-5202), built by the
	 * orchestrator only under `WARREN_RUNTIME=k8s`. Threaded onto `ServerDeps`
	 * for the `GET /runs/:id/finalize-intent` intent-miss signal.
	 */
	readonly finalizeRecovery?: import("../../runs/finalize-recovery.ts").FinalizeRecoveryHook;
	readonly now?: () => Date;
}

export function buildServerDeps(input: BuildServerDepsInput): ServerDeps {
	const {
		repos,
		db,
		runtimeProvider,
		forge,
		gitHubAppRegistration,
		setupHandoff,
		gitHubAppActivation,
		broker,
		lifecycleStream,
		bridges,
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
		eventStreamLimits,
		publicAllowlist,
		previewAuth,
		previewSidecars,
		sdBinary,
		metricsRegistry,
		/**
		 * Boot-resolved IssueTracker (warren-5819). The orchestrator threads
		 * the same instance into the fan-out sites (bridges, retries,
		 * scheduler, plan-runs); when a test omits it, `buildServerDeps`
		 * builds one from `sdBinary` so `deps.issueTracker` always tracks
		 * `deps.seedsCli`'s configured-ness.
		 */
		issueTracker,
		k8sPodWatcher,
		salvageDir,
		finalizeRecovery,
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
		// Persistence seams derived from `db` ONCE here (warren-89a6). The HTTP
		// handlers are a thin surface: `check:layers` forbids them building a
		// drizzle adapter or a repo out of `deps.db` per request.
		...createDbSeams(db),
		runtimeProvider,
		forge,
		gitHubAppRegistration,
		gitHubAppActivation,
		setupHandoff,
		salvageDir,
		broker,
		lifecycleStream,
		bridges,
		projectsConfig,
		logger,
		uiDistDir,
		spawn: defaultSpawn,
		seedsCli: { sdBinary, spawn: defaultSpawn },
		issueTracker: issueTracker ?? new SeedsTracker({ sdBinary, spawn: defaultSpawn }),
		autoOpenPr,
		warrenConfigs,
		...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
		previewPortRange,
		previewMaxLive: previewEvictionConfig.maxLive,
		workspaceGcTtlMs,
		streamLimiter: new EventStreamLimiter(eventStreamLimits),
		...(publicAllowlist !== undefined ? { publicAllowlist } : {}),
		previewMode: previewLaunchConfig.mode,
		// warren-3f8a: the dedicated preview listener's resolved public port
		// (path mode on TCP); the orchestrator resolved it into launchConfig.
		...(previewLaunchConfig.mode === "path" && previewLaunchConfig.port !== null
			? { previewPort: previewLaunchConfig.port }
			: {}),
		...(previewHostForDeps !== undefined ? { previewHost: previewHostForDeps } : {}),
		...(previewAuth !== undefined ? { previewAuth } : {}),
		...(previewSidecars !== undefined ? { previewSidecars } : {}),
		idempotencyStore: new IdempotencyStore(now !== undefined ? { now: () => now().getTime() } : {}),
		...(metricsRegistry !== undefined ? { metricsRegistry } : {}),
		// `/metrics` pod-phase gauges read live from the same pod-watcher at scrape
		// (pl-829f step 25 / warren-7c30); absent under LocalProvider.
		...(k8sPodWatcher !== undefined ? { podMetrics: k8sPodWatcher } : {}),
		// `/readyz` `k8s_api_reachable` check reads the same watcher's informer
		// sync state (warren-39e1); absent under LocalProvider.
		...(k8sPodWatcher !== undefined ? { k8sPodSync: k8sPodWatcher } : {}),
		...(finalizeRecovery !== undefined ? { finalizeRecovery } : {}),
		...(now !== undefined ? { now } : {}),
	};
}
