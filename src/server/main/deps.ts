/**
 * `ServerDeps` literal construction (warren-8d3d / pl-9088 step 10).
 * Extracted from `bootServer` so the orchestrator in `index.ts` stays
 * under the per-file budget. Pure assembly: every field comes from
 * inputs the orchestrator has already wired.
 */

import type { BurrowClient } from "../../burrow-client/index.ts";
import type { AnyWarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { MetricsRegistry } from "../../observability/metrics-registry.ts";
import { createDefaultPlanSynthesizer } from "../../plot-plan-runs/index.ts";
import {
	createPlotAggregator,
	createPlotResolver,
	defaultPlanChildAdopter,
	defaultPlotAttacher,
	defaultPlotCreator,
	defaultPlotIntentEditor,
	defaultPlotPrMerger,
	defaultPlotQuestionAnswerer,
	defaultPlotReader,
	defaultPlotRenamer,
	defaultPlotStatusChanger,
} from "../../plots/index.ts";
import type { PreviewAuth } from "../../preview/cookie.ts";
import type { loadPreviewEvictionConfigFromEnv } from "../../preview/eviction/index.ts";
import type { loadPreviewLaunchConfigFromEnv } from "../../preview/launch/index.ts";
import type { loadPreviewPortRangeFromEnv } from "../../preview/port-allocator.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { loadCanopyRegistryConfigFromEnv } from "../../registry/config.ts";
import type { loadAutoOpenPrConfigFromEnv, RunEventBroker } from "../../runs/index.ts";
import { resolveRuntimeProvider } from "../../runtime/registry.ts";
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
	readonly burrowClient: BurrowClient;
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
	readonly now?: () => Date;
}

export function buildServerDeps(input: BuildServerDepsInput): ServerDeps {
	const {
		repos,
		db,
		burrowClient,
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
		sdBinary,
		metricsRegistry,
		now,
	} = input;

	// Plot aggregator (warren-c167 / pl-9d6a step 2). 5s in-memory cache,
	// fan-out across every `hasPlot=true` project, byte-identical empty
	// contract for deployments where no project ships `.plot/`. Threaded
	// through ServerDeps so `GET /plots` (and later mutating handlers in
	// pl-9d6a) read the same cache. `paused_run` needs-attention signal
	// source (warren-d693 / pl-0344 step 9): `repos.runs` already
	// satisfies `AggregatorRunsRepo`'s narrow surface.
	const plotAggregator = createPlotAggregator({
		projectsRepo: repos.projects,
		logger,
		runsRepo: repos.runs,
		...(now !== undefined ? { now: () => now().getTime() } : {}),
	});

	const previewHostForDeps =
		previewLaunchConfig.host !== null ? previewLaunchConfig.host : undefined;

	// Runtime-provider seam (K8s migration pl-829f step 13 / warren-1f56).
	// Resolved once here — the sole composition point — on `WARREN_RUNTIME`
	// (default `local` → the burrow-backed `LocalProvider` over this same pool,
	// passed as a factory so it resolves its container worker lazily).
	const runtimeProvider = resolveRuntimeProvider({
		burrowClient: () => burrowClient,
		// run_inbox steering store for the K8s backend (pl-829f step 18 /
		// warren-3d0b); ignored by LocalProvider.
		k8sRunInbox: () => repos.runInbox,
		// admission-rejection metric sink for the K8s backend (pl-829f step 21 /
		// warren-b6f2); ignored by LocalProvider. Absent registry ⇒ uncounted.
		...(metricsRegistry !== undefined ? { k8sAdmissionMetrics: metricsRegistry } : {}),
	});

	return {
		repos,
		db,
		burrowClient,
		runtimeProvider,
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
		plotAggregator,
		plotCreator: defaultPlotCreator,
		plotAttacher: defaultPlotAttacher,
		plotPrMerger: defaultPlotPrMerger,
		plotIntentEditor: defaultPlotIntentEditor,
		plotRenamer: defaultPlotRenamer,
		plotReader: defaultPlotReader,
		planChildAdopter: defaultPlanChildAdopter,
		plotStatusChanger: defaultPlotStatusChanger,
		plotQuestionAnswerer: defaultPlotQuestionAnswerer,
		plotResolver: createPlotResolver({
			projectsRepo: repos.projects,
			aggregator: plotAggregator,
		}),
		planSynthesizer: createDefaultPlanSynthesizer({
			seedsCli: { sdBinary, spawn: defaultSpawn },
		}),
		idempotencyStore: new IdempotencyStore(now !== undefined ? { now: () => now().getTime() } : {}),
		...(metricsRegistry !== undefined ? { metricsRegistry } : {}),
		...(now !== undefined ? { now } : {}),
	};
}
