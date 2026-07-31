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
import { isTerminalRunState } from "../../core/wire.ts";
import { openDatabase } from "../../db/client.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { createRepos } from "../../db/repos/index.ts";
import {
	loadPreviewEvictionConfigFromEnv,
	startPreviewEvictionWorker,
} from "../../preview/eviction/index.ts";
import { loadPreviewLaunchConfigFromEnv } from "../../preview/launch/index.ts";
import { loadPreviewPortRangeFromEnv, PreviewPortAllocator } from "../../preview/port-allocator.ts";
import { loadProjectsConfigFromEnv } from "../../projects/config.ts";
import { listProjects } from "../../projects/index.ts";
import {
	assertRegisteredProjectsAllowlisted,
	resolvePublicAllowlist,
} from "../../projects/public-allowlist.ts";
import { seedBuiltinAgents } from "../../registry/builtins/index.ts";
import { seedAgentsFromEnvFile } from "../../registry/builtins/seed-file.ts";
import {
	loadAutoOpenPrConfigFromEnv,
	loadRunBranchPrefixFromEnv,
	RunEventBroker,
	reapRun,
} from "../../runs/index.ts";
import { loadWorkspaceGcConfigFromEnv, startWorkspaceGcWorker } from "../../runs/reap/gc.ts";
import { resolveLocalBootBackend } from "../../runtime/local/boot-backend.ts";
import { resolveRuntimeKind } from "../../runtime/registry.ts";
import { loadWarrenServerConfigFromFile } from "../../server-config/index.ts";
import { loadTriggerSchedulerConfigFromEnv } from "../../triggers/index.ts";
import { createWarrenConfigCache } from "../../warren-config/index.ts";
import { NO_AUTH, resolveAuth, resolveAuthKind } from "../auth.ts";
import { bootBridges } from "../bridges.ts";
import { type EnvLike, loadServerConfigFromEnv } from "../config.ts";
import { bootScheduler } from "../scheduler.ts";
import { startServer } from "../server.ts";
import { loadEventStreamLimitsFromEnv } from "../stream-limits.ts";
import type { AuthProvider, RunActivityCheck, ServeHandle } from "../types.ts";
import { buildServerDeps } from "./deps.ts";
import { bootBackgroundDetectors } from "./detector-wiring.ts";
import { bootLifecycleBus } from "./lifecycle-bus-wiring.ts";
import {
	bridgeLoggerFromPino,
	previewEvictionLoggerFromPino,
	schedulerLoggerFromPino,
	workspaceGcLoggerFromPino,
} from "./logging.ts";
import { bootObservability, captureBootFailure } from "./observability-wiring.ts";
import { bootPlanRunCoordinatorWiring } from "./plan-run-wiring.ts";
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
	const projectsConfig = loadProjectsConfigFromEnv(env);

	// Resolve the auth backend's IDENTITY here (warren-851b), before the db
	// opens: an unrecognized `WARREN_AUTH` throws out of `bootServer` rather
	// than degrading to a provider nobody asked for. The provider itself is
	// built further down, once `serverConfig.token` has been consulted.
	//
	// warren-ce9b: `public` also demands a non-empty org allowlist, parsed
	// here so a public instance with no allowlist refuses the boot before it
	// touches anything. `undefined` in every other mode ⇒ no org restriction.
	const authKind = resolveAuthKind(env);
	const publicAllowlist = resolvePublicAllowlist(authKind === "public", env);

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

	// warren-ce9b: hold every ALREADY-registered project to the allowlist too.
	// A public instance serving one private repo is the worst outcome this
	// posture can produce, so a violation refuses the boot (naming every
	// offender) instead of being served anonymously until someone notices.
	assertRegisteredProjectsAllowlisted(publicAllowlist, await listProjects(repos.projects));

	// Load the operator-facing TOML config (pl-9ba1 step 7 / warren-3909).
	const fileConfig = await loadWarrenServerConfigFromFile({ env });
	// warren-288f: multi-worker pooling is retired with the K8s migration — the
	// self-host backend is a single local burrow built from WARREN_BURROW_* env
	// vars. The `[workers]` TOML block, the /workers + /burrows surfaces, and the
	// worker-probe loop are all gone; the workers table itself is dropped in
	// step 24 (warren-3743). warren-f796: the burrow client no longer lives here —
	// the `LocalBootBackend` builds + owns it under `local` (none under `k8s`).
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

	// Seed built-in agents (warren-d3e9); idempotent — existing rows are preserved.
	const seedResult = await seedBuiltinAgents(repos.agents, undefined, opts.now);
	if (seedResult.seeded.length > 0) {
		logger.info({ agents: seedResult.seeded }, "seeded built-in agents");
	}

	const extra = await seedAgentsFromEnvFile(repos.agents, env, opts.now);
	if (extra !== null && extra.seeded.length > 0)
		logger.info({ agents: extra.seeded, path: extra.path }, "seeded seed-file agents");

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

	// Tier-1 observation event bus (warren-bb60) + its first-party consumers
	// (warren-4e74 healer, warren-df3e seed-close). Installed as the process
	// singleton BEFORE the bridges resume in-flight runs (which may reap and emit
	// `post_reap`), so no lifecycle emit is dropped on the floor at boot. Wired
	// here (after `repos`/`broker`/`seedsCli`) so the seed-close subscriber can
	// resolve run/project rows + drive `sd close`. See lifecycle-bus-wiring.ts.
	const lifecycleBusHandle = bootLifecycleBus({ logger, repos, seedsCli, broker });

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

	// Resolve the runtime provider ONCE (warren-c531) — the SAME instance flows
	// into the bridge registry, poller, watchdog, and `ServerDeps`. warren-f796:
	// under `local` the `LocalBootBackend` owns the burrow client + the
	// capability-gated preview/GC seams + burrow probe; under `k8s` there is no
	// burrow, so we resolve the `K8sProvider` directly and those seams stay dark.
	const localBackend =
		resolveRuntimeKind(env) === "local" ? resolveLocalBootBackend(env) : undefined;
	const runtimeProvider =
		localBackend?.runtimeProvider ??
		resolveBootRuntimeProvider({
			env,
			runInbox: () => repos.runInbox,
			logger,
			...(metricsRegistry !== undefined ? { admissionMetrics: metricsRegistry } : {}),
			...(k8sRuntime !== undefined ? { k8sRuntime } : {}),
		});
	const previewSidecars = localBackend?.previewSidecars;
	const workspaceDestroyer = localBackend?.workspaceDestroyer;
	// warren-cd3b: the local salvage step writes its bundle capture to the same
	// durable dir the salvage intake handler serves.
	const salvageDir = join(serverConfig.dataDir, "salvage");
	const bindReap = (i: Parameters<typeof reapRun>[0]) =>
		reapRun({
			...i,
			...(previewSidecars !== undefined ? { previewSidecars } : {}),
			salvageDir,
		});

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
	if (localBackend !== undefined) {
		localBackend.probeBurrow().then((result) => {
			if (!result.ok) {
				logger.warn(
					{ err: result.message ?? "unknown" },
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

	// Plan-run coordinator (pl-a258 / warren-2623). See plan-run-wiring.ts.
	const planRunCoordinator = bootPlanRunCoordinatorWiring({
		env,
		repos,
		runtimeProvider,
		bridges: bridgesBoot.registry,
		warrenConfigs,
		projectsConfig,
		autoOpenPr,
		seedsCli,
		projectSpawn: defaultSpawn,
		logger,
		...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});

	// Background detectors: run heartbeat watchdog (warren-285d) plus the
	// periodic ops-stats worker. See detector-wiring.ts.
	const { watchdog, opsStatsWorker } = bootBackgroundDetectors({
		env,
		adapter,
		repos,
		reap: bindReap,
		broker,
		bridges: bridgesBoot.registry,
		warrenConfigs,
		autoOpenPr,
		runtimeProvider,
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
		// warren-c531: the provider resolved once above; deps re-uses it.
		runtimeProvider,
		// warren-f796: local-topology `/readyz` burrow probe (absent under k8s).
		...(localBackend !== undefined ? { burrowProbe: localBackend.probeBurrow } : {}),
		broker,
		bridges: bridgesBoot.registry,
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
		// Event-stream concurrency caps (warren-25f6). Parsed here so a bad
		// knob refuses the boot instead of surfacing on someone's first stream.
		eventStreamLimits: loadEventStreamLimitsFromEnv(),
		// warren-ce9b: only set under `WARREN_AUTH=public`; gates POST /projects.
		publicAllowlist,
		previewAuth,
		...(previewSidecars !== undefined ? { previewSidecars } : {}),
		sdBinary: schedulerConfig.sdBinary,
		metricsRegistry,
		// warren-cd3b: durable salvage-bundle intake dir (pod-posted git bundles
		// land here; the data dir is the persistent volume in both runtimes).
		salvageDir,
		// `/metrics` pod-phase gauges read live from the same pod-watcher at scrape
		// (warren-7c30); absent under LocalProvider.
		...(k8sRuntime !== undefined ? { k8sPodWatcher: k8sRuntime.podWatcher } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});

	// Build the provider from the backend resolved at the top of the boot
	// (warren-851b), before the listener exists. `--no-auth` (token null)
	// still wins — it is the loopback dev hatch and predates the selector.
	const auth: AuthProvider =
		serverConfig.token !== null
			? resolveAuth({ token: serverConfig.token, kind: authKind })
			: NO_AUTH;
	if (authKind === "public" && serverConfig.token !== null) {
		logger.warn(
			{},
			"WARREN_AUTH=public — unauthenticated callers may read this instance's public projections",
		);
	}

	// warren-57fd: bound each run-scoped callback token's lifetime to its run.
	// The auth layer verifies the token's signature and run binding; this probe
	// is what makes the token invalid once the run reaches a terminal state.
	const runActivityCheck: RunActivityCheck = async (runId) => {
		const row = await deps.repos.runs.get(runId);
		return row !== null && !isTerminalRunState(row.state);
	};

	const handle = startServer(deps, {
		transport: serverConfig.transport,
		auth,
		logger,
		runActivityCheck,
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
			await watchdog.stop();
			await scheduler.stop();
			await previewEvictionWorker.stop();
			await workspaceGcWorker.stop();
			await opsStatsWorker.stop();
			// K8s runtime loops (no-op / undefined under the local backend).
			await k8sRuntime?.stop();
			await bridgesBoot.registry.stopAll();
			// Detach the lifecycle-bus consumers + uninstall the singleton so a
			// teardown leaves no global emit target behind (warren-4e74).
			lifecycleBusHandle.stop();
			// warren-f796: close the local backend's burrow client (undefined under k8s).
			await localBackend?.close();
			await closeDatabase(db);
		},
	};
}

/**
 * CLI entry. Allows `bun run src/server/main/index.ts` to act as the
 * warren serve binary the supervisor (Phase 12) execs. Catches startup
 * errors, formats them, and exits non-zero so the orchestrator's restart
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
