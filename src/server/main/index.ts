/**
 * Boot entry for `warren serve` (SPEC §8.2 / §10.3).
 *
 * Wires together every layer the server depends on:
 *   - load env-driven config (server bind, data dir, UI dist),
 *   - open the SQLite db (creates + migrates if missing),
 *   - construct the BurrowClient + RunEventBroker,
 *   - boot the BridgeRegistry (resumes any in-flight runs from the
 *     events-table cursor — SPEC §9 restart-recovery contract),
 *   - load the canopy + projects sub-configs,
 *   - resolve the AuthProvider,
 *   - call `startServer`.
 *
 * Returns a `WarrenServerHandle` whose `stop()` tears everything down
 * in the reverse order: aborts the wire, drains the bridges, closes
 * the db, closes the burrow client. The supervisor (Phase 12) will
 * own the SIGTERM/SIGINT plumbing — this entry just exposes the stop
 * function so an integration test or the CLI can call it directly.
 *
 * `bootServer` is async because the startup burrow probe is async.
 *
 * Split into a `main/` subdirectory (warren-8d3d / pl-9088 step 10):
 * - `./utils.ts`         — env/process/db helpers (incl. `defaultSpawn`,
 *                          `resolvePgPoolMax`)
 * - `./logging.ts`       — pino → narrow logger adapters
 * - `./preview-wiring.ts` — preview signed-cookie + proxy assembly
 */

import { join } from "node:path";
import { BurrowClient, probeBurrowClient } from "../../burrow-client/index.ts";
import { openDatabase } from "../../db/client.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { createRepos } from "../../db/repos/index.ts";
import {
	autoTransitionPlotToDone,
	bootPlanRunCoordinator,
	createPlanRunSpawn,
	createPrMergeChecker,
	createResolveExecution,
	defaultPlotStatusSetter,
	loadPlanRunCoordinatorConfigFromEnv,
} from "../../plan-runs/index.ts";
import {
	loadPreviewEvictionConfigFromEnv,
	startPreviewEvictionWorker,
} from "../../preview/eviction/index.ts";
import { loadPreviewLaunchConfigFromEnv } from "../../preview/launch/index.ts";
import { loadPreviewPortRangeFromEnv, PreviewPortAllocator } from "../../preview/port-allocator.ts";
import { loadProjectsConfigFromEnv } from "../../projects/config.ts";
import { parseGitHubUrl } from "../../projects/index.ts";
import { seedBuiltinAgents } from "../../registry/builtins/index.ts";
import { loadCanopyRegistryConfigFromEnv } from "../../registry/config.ts";
import {
	composeRunBranch,
	loadAutoOpenPrConfigFromEnv,
	loadRunBranchPrefixFromEnv,
	RunEventBroker,
	reapRun,
	resolveDispatcherHandle,
	resolveRunBranchPrefix,
} from "../../runs/index.ts";
import { buildPrContent, openPullRequest } from "../../runs/pr.ts";
import { loadWorkspaceGcConfigFromEnv, startWorkspaceGcWorker } from "../../runs/reap/gc.ts";
import { resolveRuntimeKind } from "../../runtime/registry.ts";
import { showSeed } from "../../seeds-cli/index.ts";
import { loadWarrenServerConfigFromFile } from "../../server-config/index.ts";
import { loadTriggerSchedulerConfigFromEnv } from "../../triggers/index.ts";
import { createWarrenConfigCache } from "../../warren-config/index.ts";
import { NO_AUTH, resolveAuth } from "../auth.ts";
import { bootBridges } from "../bridges.ts";
import { type EnvLike, loadServerConfigFromEnv } from "../config.ts";
import { bootScheduler } from "../scheduler.ts";
import { startServer } from "../server.ts";
import type { AuthProvider, ServeHandle } from "../types.ts";
import { buildServerDeps } from "./deps.ts";
import { bootBackgroundDetectors } from "./detector-wiring.ts";
import {
	bridgeLoggerFromPino,
	planRunLoggerFromPino,
	previewEvictionLoggerFromPino,
	schedulerLoggerFromPino,
	workspaceGcLoggerFromPino,
} from "./logging.ts";
import { bootObservability, captureBootFailure } from "./observability-wiring.ts";
import { resolveLocalPreviewGcSeams } from "./preview-gc-wiring.ts";
import { createPreviewAuthAndProxy } from "./preview-wiring.ts";
import { bootK8sRuntime, resolveBootRuntimeProvider } from "./runtime-wiring.ts";
import { closeDatabase, defaultSpawn, redactDbUrl, resolvePgPoolMax } from "./utils.ts";

// Re-export `resolvePgPoolMax` so the strict round-trip check stays
// accessible from `main.test.ts` (and any other importer that grew
// before the split).
export { resolvePgPoolMax } from "./utils.ts";

export interface BootServerOptions {
	readonly env?: EnvLike;
	readonly noAuth?: boolean;
	/** Override the UI dist directory default (`<cwd>/src/ui/dist`). */
	readonly defaultUiDistDir?: string;
	/** Override `Date.now()` for deterministic tests. */
	readonly now?: () => Date;
}

export interface WarrenServerHandle extends ServeHandle {
	stop(): Promise<void>;
}

export async function bootServer(opts: BootServerOptions = {}): Promise<WarrenServerHandle> {
	const env = opts.env ?? process.env;
	const { logger, metricsRegistry } = await bootObservability(env);

	const serverConfig = loadServerConfigFromEnv({
		env,
		...(opts.noAuth !== undefined ? { noAuth: opts.noAuth } : {}),
		...(opts.defaultUiDistDir !== undefined ? { defaultUiDistDir: opts.defaultUiDistDir } : {}),
	});
	const canopyConfig = loadCanopyRegistryConfigFromEnv(env);
	const projectsConfig = loadProjectsConfigFromEnv(env);

	if (serverConfig.dbUrlConflict !== null) {
		logger.warn(
			{ url: serverConfig.dbUrl, path: serverConfig.dbUrlConflict },
			"WARREN_DB_URL and WARREN_DB_PATH are both set and disagree; WARREN_DB_URL wins",
		);
	}
	const pgPoolMax = resolvePgPoolMax(env);
	const db = await openDatabase({
		url: serverConfig.dbUrl,
		...(pgPoolMax !== undefined ? { pgPoolMax } : {}),
	});
	const repos = createRepos(db);

	// Load the operator-facing TOML config (pl-9ba1 step 7 / warren-3909).
	const fileConfig = await loadWarrenServerConfigFromFile({ env });
	// warren-288f: multi-worker pooling is retired with the K8s migration — the
	// self-host backend is a single local burrow built from WARREN_BURROW_* env
	// vars. The `[workers]` TOML block, the /workers + /burrows surfaces, and the
	// worker-probe loop are all gone; the workers table itself is dropped in
	// step 24 (warren-3743).
	const burrowClient = BurrowClient.fromEnv(env);
	const broker = new RunEventBroker();

	logger.info(
		{
			dbUrl: redactDbUrl(serverConfig.dbUrl),
			dialect: db.dialect,
			transport: serverConfig.transport,
		},
		"warren server starting",
	);
	if (fileConfig.path !== null) {
		logger.info({ path: fileConfig.path }, "loaded warren.toml");
	}

	// Seed built-in agents (warren-d3e9). Idempotent: existing rows
	// (whether seeded by an earlier boot or upserted by a refresh of a
	// same-named library agent) are preserved.
	const seedResult = await seedBuiltinAgents(repos.agents, undefined, opts.now);
	if (seedResult.seeded.length > 0) {
		logger.info({ agents: seedResult.seeded }, "seeded built-in agents");
	}

	const autoOpenPr = loadAutoOpenPrConfigFromEnv(env);
	if (autoOpenPr.enabled && autoOpenPr.token === "") {
		logger.warn(
			{},
			"WARREN_AUTO_OPEN_PR is enabled but GITHUB_TOKEN is unset; reap pr_open will skip with reap_failed events",
		);
	}

	const warrenConfigs = createWarrenConfigCache();
	const runBranchPrefixDefault = loadRunBranchPrefixFromEnv(env);
	const previewPortRange = loadPreviewPortRangeFromEnv(env);
	// Dialect-polymorphic allocator (warren-adfb): sqlite uses BEGIN/COMMIT
	// + per-instance mutex; postgres adds `pg_advisory_xact_lock` for cross-
	// process serialization. Constructed unconditionally for both dialects.
	const adapter = DrizzleAdapter.for(db);
	const portAllocator = new PreviewPortAllocator(adapter, previewPortRange);
	const previewLaunchConfig = loadPreviewLaunchConfigFromEnv(env);
	const previewEvictionConfig = loadPreviewEvictionConfigFromEnv(env);
	const workspaceGcConfig = loadWorkspaceGcConfigFromEnv(env);

	// Seeds-CLI seam shared by the bridge reap path (warren-41d5 auto_plan_run
	// child-seed validation) and the plan-run coordinator below.
	const schedulerConfig = loadTriggerSchedulerConfigFromEnv(env);
	const seedsCli = { sdBinary: schedulerConfig.sdBinary, spawn: defaultSpawn };

	// K8s runtime background loops (pl-829f step 25 / warren-7c30). Under
	// `WARREN_RUNTIME=k8s` this constructs + starts the pod-watcher informer and
	// the pod-GC loop, feeding both the shared `metricsRegistry` as their counter
	// sink. Returns `undefined` for the default `local` backend, so the self-host
	// boot path constructs nothing new. The started watcher is the provider's
	// status cache + admission source and the `/metrics` gauge source; the shared
	// core-API factory keeps the provider on one client.
	//
	// warren-c531: booted HERE (before `bootBridges`) so the runtime provider can
	// be resolved once and threaded into the bridge registry, the run-state
	// poller, and the watchdog — all of which run before `buildServerDeps`. Until
	// this move, the provider was resolved late (in `buildServerDeps`) and those
	// background paths defaulted to the burrow-backed `LocalProvider`, so under
	// `WARREN_RUNTIME=k8s` the bridge/poller spoke burrow directly and never
	// streamed pod-log events / reconciled terminal pod status.
	const k8sRuntime = bootK8sRuntime({ env, metrics: metricsRegistry, logger });
	if (k8sRuntime !== undefined) {
		logger.info({}, "k8s runtime: pod-watcher + pod-GC started");
	}

	// Resolve the runtime provider ONCE — the sole composition point (warren-c531,
	// formerly in `buildServerDeps`). The SAME instance flows into the bridge
	// registry, run-state poller, watchdog, and `ServerDeps`. See
	// `resolveBootRuntimeProvider` for the `WARREN_RUNTIME` selection semantics.
	const runtimeProvider = resolveBootRuntimeProvider({
		env,
		burrowClient,
		runInbox: () => repos.runInbox,
		logger,
		...(metricsRegistry !== undefined ? { admissionMetrics: metricsRegistry } : {}),
		...(k8sRuntime !== undefined ? { k8sRuntime } : {}),
	});

	// Preview + workspace-GC seams (warren-e24d), gated on provider capabilities
	// (dark under K8s). See `resolveLocalPreviewGcSeams`.
	const { previewSidecars, workspaceDestroyer } = resolveLocalPreviewGcSeams(
		runtimeProvider,
		burrowClient,
	);
	const bindReap = (i: Parameters<typeof reapRun>[0]) =>
		reapRun({ ...i, ...(previewSidecars !== undefined ? { previewSidecars } : {}) });

	const bridgesBoot = await bootBridges({
		repos,
		broker,
		runtimeProvider,
		// warren-e24d: reap seam pre-bound with the provider-derived preview seam.
		reap: bindReap,
		logger: bridgeLoggerFromPino(logger),
		autoOpenPr,
		warrenConfigs,
		portAllocator,
		previewLaunchConfig,
		seedsCli,
	});
	if (bridgesBoot.resumed.length > 0) {
		logger.info(
			{ count: bridgesBoot.resumed.length },
			"resumed run-stream bridges from active runs",
		);
	}
	if (bridgesBoot.skipped.length > 0) {
		logger.warn(
			{ count: bridgesBoot.skipped.length, runs: bridgesBoot.skipped },
			"skipped runs without burrow_run_id",
		);
	}

	// Startup burrow probe — local backend only; k8s has no socket (warren-c128).
	if (resolveRuntimeKind(env) === "local") {
		probeBurrowClient(burrowClient).then((result) => {
			if (!result.ok) {
				logger.warn(
					{ worker: result.workerName, err: result.error?.message ?? "unknown" },
					"burrow probe failed at boot — /readyz will reflect this",
				);
			}
		});
	}

	const scheduler = bootScheduler({
		repos,
		runtimeProvider,
		bridges: bridgesBoot.registry,
		warrenConfigs,
		projectsConfig,
		projectSpawn: defaultSpawn,
		config: schedulerConfig,
		logger: schedulerLoggerFromPino(logger),
		// warren-0b75: CI-fixer poller reuses the reap pr-open GITHUB_TOKEN.
		githubToken: autoOpenPr.token,
		...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});
	if (schedulerConfig.disabled) {
		logger.info({}, "scheduler disabled via WARREN_SCHEDULER_DISABLED");
	} else {
		logger.info(
			{ tickMs: schedulerConfig.tickMs, sdBinary: schedulerConfig.sdBinary },
			"scheduler running",
		);
	}

	// Plan-run coordinator (pl-a258 / warren-2623). Polls active plan_runs
	// rows on a 10s tick by default; same single-flight + disabled-via-env
	// shape as bootScheduler so operators reading logs see identical
	// lifecycle semantics.
	const planRunCoordinatorConfig = loadPlanRunCoordinatorConfigFromEnv(env);
	const planRunCoordinator = bootPlanRunCoordinator({
		repos,
		showSeed: async (projectId, seedId) => {
			const project = await repos.projects.require(projectId);
			return showSeed(seedsCli, project.localPath, seedId);
		},
		checkPrMerged: createPrMergeChecker({ token: autoOpenPr.token }),
		resolveExecution: createResolveExecution(repos), // pl-fb43 step 5: per-child execution repo
		reopenPr:
			autoOpenPr.enabled && autoOpenPr.token !== ""
				? async (runId: string): Promise<string | null> => {
						try {
							const run = await repos.runs.get(runId);
							if (run === null || run.projectId === null) return null;
							const project = await repos.projects.get(run.projectId);
							if (project === null) return null;
							const warrenConfig = await warrenConfigs.get(run.projectId, project.localPath);
							const prefix = resolveRunBranchPrefix({
								projectDefault: warrenConfig.defaults?.runBranchPrefix,
								envDefault: runBranchPrefixDefault,
							});
							const branch = composeRunBranch(prefix, runId);
							const parsed = parseGitHubUrl(project.gitUrl);
							const content = buildPrContent({
								prompt: run.prompt,
								runId: run.id,
								agentName: run.agentName,
								...(run.startedAt !== null ? { startedAt: run.startedAt } : {}),
								...(run.endedAt !== null ? { endedAt: run.endedAt } : {}),
								...(run.costUsd !== null ? { costUsd: run.costUsd } : {}),
								...(run.tokensInput !== null ? { tokensInput: run.tokensInput } : {}),
								...(run.tokensOutput !== null ? { tokensOutput: run.tokensOutput } : {}),
								...(run.tokensCacheRead !== null ? { tokensCacheRead: run.tokensCacheRead } : {}),
								...(autoOpenPr.warrenBaseUrl !== null
									? { warrenBaseUrl: autoOpenPr.warrenBaseUrl }
									: {}),
							});
							const result = await openPullRequest({
								owner: parsed.owner,
								repo: parsed.name,
								head: branch,
								base: project.defaultBranch,
								title: content.title,
								body: content.body,
								token: autoOpenPr.token,
							});
							if (result.ok) return result.url;
							logger.warn(
								{ runId, reason: result.reason, message: result.message },
								"plan_run.reopen_pr_failed",
							);
							return null;
						} catch (err) {
							logger.warn(
								{ runId, reason: err instanceof Error ? err.message : String(err) },
								"plan_run.reopen_pr_error",
							);
							return null;
						}
					}
				: undefined,
		spawn: createPlanRunSpawn({
			repos,
			runtimeProvider,
			bridges: bridgesBoot.registry,
			warrenConfigs,
			projectsConfig,
			projectSpawn: defaultSpawn,
			seedsCli,
			...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
			...(opts.now !== undefined ? { now: opts.now } : {}),
		}),
		// warren-b290 / pl-7937 step 5: auto-transition the bound Plot from
		// `active` → `done` when every child of a Plot-bound PlanRun reaches a
		// terminal state. Best-effort — see autoTransitionPlotToDone.
		transitionPlot: async (planRun) => {
			if (planRun.plotId === null) {
				// Coordinator already guards on plotId, but narrow defensively
				// so an unexpected null still produces a benign skip.
				return { kind: "skipped", currentStatus: "unknown" };
			}
			const project = await repos.projects.require(planRun.projectId);
			return autoTransitionPlotToDone({
				setter: defaultPlotStatusSetter,
				logger,
				plotDir: join(project.localPath, ".plot"),
				plotId: planRun.plotId,
				handle: resolveDispatcherHandle(planRun.dispatcherHandle),
				planRunId: planRun.id,
			});
		},
		tickMs: planRunCoordinatorConfig.tickMs,
		disabled: planRunCoordinatorConfig.disabled,
		mergeTimeoutMs: planRunCoordinatorConfig.mergeTimeoutMs,
		logger: planRunLoggerFromPino(logger),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});
	if (planRunCoordinatorConfig.disabled) {
		logger.info({}, "plan-run coordinator disabled via WARREN_PLAN_RUN_DISABLED");
	} else {
		logger.info({ tickMs: planRunCoordinatorConfig.tickMs }, "plan-run coordinator running");
	}

	// Background detectors (each gated by its own env flag): the pause
	// detector (warren-2976), run heartbeat watchdog (warren-285d), send-off
	// PR-merge poller (warren-b872, auto-dispatches the planner once a sent-off
	// conversation's plotSync PR merges), and the on-by-default conversation
	// idle-timeout coordinator (warren-005d, finalizes an idle conversation's
	// anchoring run; the conversation itself stays active). See
	// detector-wiring.ts.
	const { pauseDetector, watchdog, mergePoller, conversationIdleDetector, opsStatsWorker } =
		bootBackgroundDetectors({
			env,
			adapter,
			repos,
			reap: bindReap,
			broker,
			bridges: bridgesBoot.registry,
			warrenConfigs,
			projectsConfig,
			projectSpawn: defaultSpawn,
			seedsCli,
			autoOpenPr,
			runtimeProvider,
			...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
			logger,
			...(opts.now !== undefined ? { now: opts.now } : {}),
		});

	// Preview TTL + LRU eviction worker (R-19 / SPEC §11.L, warren-ea6b).
	const previewEvictionWorker = startPreviewEvictionWorker({
		db,
		repos,
		warrenConfigs,
		config: previewEvictionConfig,
		logger: previewEvictionLoggerFromPino(logger),
		...(previewSidecars !== undefined ? { resolveSidecar: previewSidecars } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});
	if (previewEvictionConfig.disabled) {
		logger.info({}, "preview eviction disabled via WARREN_PREVIEW_EVICTION_DISABLED");
	} else {
		logger.info({ ...previewEvictionConfig }, "preview eviction worker running");
	}

	// Fallback GC for stranded workspaces (warren-0a9a): reclaims workspaces
	// stranded by a mid-reap crash / out-of-band force-kill. warren-e24d: runs
	// only when the runtime advertises `workspaceGc` (dark under K8s).
	const resolvedWorkspaceGcConfig =
		workspaceDestroyer !== undefined ? workspaceGcConfig : { ...workspaceGcConfig, disabled: true };
	const workspaceGcWorker = startWorkspaceGcWorker({
		repos,
		destroyWorkspace: workspaceDestroyer ?? (async () => ({ status: "already-gone" as const })),
		config: resolvedWorkspaceGcConfig,
		logger: workspaceGcLoggerFromPino(logger),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});
	logger.info(
		{ ...resolvedWorkspaceGcConfig },
		resolvedWorkspaceGcConfig.disabled
			? "workspace GC disabled (WARREN_WORKSPACE_GC_DISABLED or runtime lacks workspaceGc capability)"
			: "workspace GC worker running",
	);

	const { previewAuth, previewProxy } = createPreviewAuthAndProxy({
		token: serverConfig.token,
		previewLaunchConfig,
		repos,
		logger,
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});
	const deps = buildServerDeps({
		repos,
		db,
		burrowClient,
		// warren-c531: the provider resolved once above; deps re-uses it.
		runtimeProvider,
		broker,
		bridges: bridgesBoot.registry,
		canopyConfig,
		projectsConfig,
		logger,
		uiDistDir: serverConfig.uiDistDir,
		autoOpenPr,
		warrenConfigs,
		runBranchPrefixDefault,
		previewPortRange,
		previewLaunchConfig,
		previewEvictionConfig,
		workspaceGcTtlMs: workspaceGcConfig.ttlMs,
		previewAuth,
		...(previewSidecars !== undefined ? { previewSidecars } : {}),
		sdBinary: schedulerConfig.sdBinary,
		metricsRegistry,
		// `/metrics` pod-phase gauges read live from the same pod-watcher at scrape
		// (warren-7c30); absent under LocalProvider.
		...(k8sRuntime !== undefined ? { k8sPodWatcher: k8sRuntime.podWatcher } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});

	const auth: AuthProvider =
		serverConfig.token !== null ? resolveAuth({ token: serverConfig.token }) : NO_AUTH;

	const handle = startServer(deps, {
		transport: serverConfig.transport,
		auth,
		logger,
		...(previewProxy !== undefined ? { previewProxy } : {}),
	});

	logger.info({ url: handle.url }, "warren server listening");

	return {
		transport: handle.transport,
		url: handle.url,
		stop: async () => {
			logger.info({}, "warren server stopping");
			// Stop the HTTP listener first so no new POSTs land mid-teardown,
			// then drain the scheduler so any in-flight tick finishes calling
			// spawnRun before bridges/burrow/db disappear under it.
			await handle.stop();
			await planRunCoordinator.stop();
			await pauseDetector.stop();
			await watchdog.stop();
			await mergePoller.stop();
			await conversationIdleDetector.stop();
			await scheduler.stop();
			await previewEvictionWorker.stop();
			await workspaceGcWorker.stop();
			await opsStatsWorker.stop();
			// K8s runtime loops (no-op / undefined under the local backend).
			await k8sRuntime?.stop();
			await bridgesBoot.registry.stopAll();
			await burrowClient.close();
			await closeDatabase(db);
		},
	};
}

/**
 * CLI entry. Allows `bun run src/server/main/index.ts` to act as the
 * warren serve binary the supervisor (Phase 12) execs. Catches startup
 * errors, formats them, and exits non-zero so docker/fly's restart
 * policy kicks in.
 */
if (import.meta.main) {
	bootServer().catch(async (err) => {
		const message = err instanceof Error ? err.message : String(err);
		await captureBootFailure(err);
		console.error(`warren: ${message}`);
		process.exit(1);
	});
}
