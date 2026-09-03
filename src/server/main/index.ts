/**
 * Boot entry for `warren serve` (docs/design/runtime-and-supervisor.md).
 *
 * Wires together every layer the server depends on (env config, db,
 * BurrowClient + RunEventBroker, BridgeRegistry, projects, auth) and calls
 * `startServer`. Returns a `WarrenServerHandle` whose `stop()` tears
 * everything down in reverse order; the supervisor owns SIGTERM/SIGINT
 * plumbing. `bootServer` is async.
 *
 * Split into a `main/` subdirectory (warren-8d3d / pl-9088 step 10) — one
 * `*-wiring.ts` module per boot concern; this file is the composition root.
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
import {
	loadAutoOpenPrConfigFromEnv,
	loadRunBranchPrefixFromEnv,
	RunEventBroker,
} from "../../runs/index.ts";
import { loadWorkspaceGcConfigFromEnv } from "../../runs/reap/gc.ts";
import { resolveLocalBootBackend } from "../../runtime/local/boot-backend.ts";
import { resolveRuntimeKind } from "../../runtime/registry.ts";
import { loadWarrenServerConfigFromFile } from "../../server-config/index.ts";
import { SeedsTracker } from "../../tracker/seeds-tracker.ts";
import { loadTriggerSchedulerConfigFromEnv } from "../../triggers/index.ts";
import { createWarrenConfigCache } from "../../warren-config/index.ts";
import { NO_AUTH, resolveAuth, resolveAuthKind } from "../auth.ts";
import { type EnvLike, loadServerConfigFromEnv } from "../config.ts";
import { bootGitHubAppRegistrationGate } from "../github-app-gate.ts";
import { bootScheduler } from "../scheduler.ts";
import { startServer } from "../server.ts";
import { armSetupHandoffFromBoot, setupRedemptionUrl } from "../setup-handoff.ts";
import { loadEventStreamLimitsFromEnv } from "../stream-limits.ts";
import type { AuthProvider, RunActivityCheck, ServeHandle } from "../types.ts";
import { seedAgentsAtBoot } from "./agent-seeding.ts";
import { bindReapWithBootDeps, bootBridgesAndProviderRetry } from "./bridges-wiring.ts";
import { buildServerDeps } from "./deps.ts";
import { bootBackgroundDetectors } from "./detector-wiring.ts";
import { bootGitHubAppActivation } from "./github-app-activation-wiring.ts";
import { makePodWarningRunEventSink } from "./k8s-pod-warning-sink.ts";
import { bootLifecycleBus } from "./lifecycle-bus-wiring.ts";
import {
	bridgeLoggerFromPino,
	previewEvictionLoggerFromPino,
	schedulerLoggerFromPino,
} from "./logging.ts";
import { bootObservability, captureBootFailure } from "./observability-wiring.ts";
import { bootPlanRunCoordinatorWiring } from "./plan-run-wiring.ts";
import { bootPreviewSurface } from "./preview-wiring.ts";
import { wireInfraLostRetry } from "./retry-wiring.ts";
import { bootK8sRuntime, resolveBootRuntimeProvider } from "./runtime-wiring.ts";
import { bootstrapOperatorToken } from "./token-bootstrap.ts";
import { bootToolCallsBackfill } from "./tool-calls-backfill-wiring.ts";
import { closeDatabase, defaultSpawn, redactDbUrl, resolvePgPoolMax } from "./utils.ts";
import { bootWorkspaceGc } from "./workspace-gc-wiring.ts";

// Re-exported so `main.test.ts` keeps its strict round-trip check.
export { resolvePgPoolMax } from "./utils.ts";

export interface BootServerOptions {
	readonly env?: EnvLike;
	readonly noAuth?: boolean;
	/** Override the UI dist directory default (`<cwd>/src/ui/dist`). */
	readonly defaultUiDistDir?: string;
	/** Override `Date.now()` for deterministic tests. */
	readonly now?: () => Date;
	readonly setupHandoff?: boolean; // warren-48f8: arm the one-time setup handoff (warren up only).
	/** warren-53ea: boot-wired IssueTracker override; pass it ALREADY-CONNECTED. */
	readonly issueTracker?: import("../../tracker/contract.ts").IssueTracker;
}

export interface WarrenServerHandle extends ServeHandle {
	stop(): Promise<void>;
	/** Token from the mint-or-persist path (not env); `warren up` writes the client config. */
	readonly operatorToken?: string;
	readonly setupUrl?: string; // warren-48f8: one-time /setup URL, only when the handoff armed.
}

export async function bootServer(opts: BootServerOptions = {}): Promise<WarrenServerHandle> {
	const env = opts.env ?? process.env;
	const { logger, metricsRegistry } = await bootObservability(env);

	// warren-ef6e fresh-install token bootstrap (see ./token-bootstrap.ts).
	const { tokenBoot, bootEnv } = bootstrapOperatorToken({
		env,
		logger,
		...(opts.noAuth !== undefined ? { noAuth: opts.noAuth } : {}),
	});

	const serverConfig = loadServerConfigFromEnv({
		env: bootEnv,
		...(opts.noAuth !== undefined ? { noAuth: opts.noAuth } : {}),
		...(opts.defaultUiDistDir !== undefined ? { defaultUiDistDir: opts.defaultUiDistDir } : {}),
	});
	const projectsConfig = loadProjectsConfigFromEnv(env);

	// Resolve the auth backend's IDENTITY here (warren-851b), before the db
	// opens: an unrecognized `WARREN_AUTH` throws rather than degrading to a
	// provider nobody asked for. warren-ce9b: `public` also demands a non-empty
	// org allowlist; `undefined` in every other mode ⇒ no org restriction.
	const authKind = resolveAuthKind(env);
	const publicAllowlist = resolvePublicAllowlist(authKind === "public", env);

	// warren-48f8: one-time setup handoff (warren up only; never public/no-auth).
	const setupHandoffBoot = armSetupHandoffFromBoot(opts, tokenBoot, env, authKind, logger);

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

	// warren-ce9b: registered projects must satisfy the allowlist or boot refuses.
	assertRegisteredProjectsAllowlisted(publicAllowlist, await listProjects(repos.projects));
	// Load the operator-facing TOML config (pl-9ba1 step 7 / warren-3909).
	const fileConfig = await loadWarrenServerConfigFromFile({ env });
	// warren-f796: the LocalBootBackend owns the local-topology seams; warren-9a26
	// dropped the burrow client from it (the daemon is gone).
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

	// Boot-time agent seeding (warren-c4be): idempotent; a refused definition warns.
	await seedAgentsAtBoot({
		repo: repos.agents,
		env,
		logger,
		...(opts.now ? { now: opts.now } : {}),
	});

	const autoOpenPr = loadAutoOpenPrConfigFromEnv(env);
	// warren-6c4c: resolve the forge ONCE; warren-b504: opt-in store wraps it in a HotForge.
	const appCredBoot = { env, dataDir: serverConfig.dataDir, logger };
	const { forge, activation: gitHubAppActivation } = bootGitHubAppActivation(appCredBoot);
	const gitHubAppRegistration = bootGitHubAppRegistrationGate(env, logger);
	const warrenConfigs = createWarrenConfigCache();
	const runBranchPrefixDefault = loadRunBranchPrefixFromEnv(env);
	const previewPortRange = loadPreviewPortRangeFromEnv(env);
	// Dialect-polymorphic allocator (warren-adfb): sqlite uses BEGIN/COMMIT
	// + mutex; postgres adds `pg_advisory_xact_lock` for cross-process
	// serialization. Constructed unconditionally for both dialects.
	const adapter = DrizzleAdapter.for(db);
	const portAllocator = new PreviewPortAllocator(adapter, previewPortRange);
	const previewLaunchConfig = loadPreviewLaunchConfigFromEnv(env);
	const previewEvictionConfig = loadPreviewEvictionConfigFromEnv(env);
	const workspaceGcConfig = loadWorkspaceGcConfigFromEnv(env);

	// Seeds-CLI seam shared by the bridge reap path (warren-41d5) and the plan-run coordinator.
	const schedulerConfig = loadTriggerSchedulerConfigFromEnv(env);
	const seedsCli = { sdBinary: schedulerConfig.sdBinary, spawn: defaultSpawn };
	// warren-5819 (pl-a37b Track B step 7): ONE SeedsTracker threaded through
	// every seedsCli fan-out site below and onto ServerDeps. Contract port:
	// warren-2d98/47b0/6234; override seam: warren-53ea (BootServerOptions).
	const issueTracker = opts.issueTracker ?? new SeedsTracker(seedsCli);

	// Tier-1 observation bus (warren-bb60) + first-party consumers (warren-4e74 healer,
	// warren-df3e seed-close). Installed BEFORE bridges resume in-flight runs so no emit
	// is dropped (see lifecycle-bus-wiring.ts). warren-3bc6: `forge` is the boot-resolved instance.
	const lifecycleBusHandle = bootLifecycleBus({ logger, repos, issueTracker, broker, forge });

	// K8s runtime background loops (pl-829f step 25 / warren-7c30); undefined under the
	// default `local` backend; booted HERE (before `bootBridges`, warren-c531).
	// warren-32f8: onPodWarning surfaces pod-level stalls onto the run's event stream.
	const onPodWarning = makePodWarningRunEventSink({ repos, broker, logger });
	// warren-7116: runtime → domain edge for the workspace_ready_at stamp.
	const onWorkspaceReady = (runId: string, at: Date): void => {
		void repos.runs.markWorkspaceReady(runId, at).catch(() => {});
	};
	const k8sRuntime = bootK8sRuntime({
		env,
		metrics: metricsRegistry,
		logger,
		onPodWarning,
		onWorkspaceReady,
	});
	if (k8sRuntime !== undefined) logger.info({}, "k8s runtime: pod-watcher + pod-GC started");

	// Resolve the runtime provider ONCE (warren-c531) — the SAME instance flows into the
	// bridge registry, poller, watchdog, and `ServerDeps` (warren-f796: local vs k8s seams).
	const localBackend =
		resolveRuntimeKind(env) === "local"
			? resolveLocalBootBackend(env, { onWorkspaceReady })
			: undefined;
	const runtimeProvider =
		localBackend?.runtimeProvider ??
		resolveBootRuntimeProvider({
			env,
			runInbox: () => repos.runInbox,
			logger,
			...(metricsRegistry !== undefined ? { admissionMetrics: metricsRegistry } : {}),
			...(k8sRuntime !== undefined ? { k8sRuntime } : {}),
			forge,
			onWorkspaceReady,
		});
	// warren-3f8a/820e: path mode boots a dedicated preview listener; previewPorts gates it.
	const previewSurface = bootPreviewSurface({
		token: serverConfig.token,
		previewLaunchConfig,
		repos,
		logger,
		transport: serverConfig.transport,
		previewPorts: runtimeProvider.capabilities.previewPorts,
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});
	const previewSidecars = localBackend?.previewSidecars;
	const workspaceDestroyer = localBackend?.workspaceDestroyer;
	// warren-cd3b: the salvage bundle capture lands beside the salvage intake dir.
	// warren-45e6: the boot-resolved forge drives reap's PR sub-steps.
	const salvageDir = join(serverConfig.dataDir, "salvage");
	// warren-4af7: infra-lost auto-retry — see retry-wiring.ts.
	const { onInfraLostRun, onRegistryCreated } = wireInfraLostRetry({
		repos,
		runtimeProvider,
		broker,
		projectsConfig,
		warrenConfigs,
		seedsCli,
		issueTracker,
		forge,
		env,
		logger,
		projectSpawn: defaultSpawn,
		...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});
	const bindReap = bindReapWithBootDeps({ forge, previewSidecars, salvageDir, onInfraLostRun });

	// warren-339d: bridge boot + provider-retry registration (see bridges-wiring.ts).
	const { bridgesBoot, providerRetryRegistration } = await bootBridgesAndProviderRetry({
		bridges: {
			repos,
			broker,
			runtimeProvider,
			// warren-e24d: reap seam pre-bound with the provider-derived preview seam.
			reap: bindReap,
			logger: bridgeLoggerFromPino(logger),
			autoOpenPr,
			warrenConfigs,
			portAllocator,
			previewLaunchConfig: previewSurface.launchConfig,
			seedsCli,
			issueTracker,
			// warren-4af7: infra-lost ghost-reconcile + registry late-binding.
			onInfraLostRun,
			onRegistryCreated,
		},
		logger,
		bus: lifecycleBusHandle.bus,
		repos,
		runtimeProvider,
		projectsConfig,
		projectSpawn: defaultSpawn,
		forge,
		warrenConfigs,
		seedsCli,
		issueTracker,
		broker,
		...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});

	const scheduler = bootScheduler({
		repos,
		runtimeProvider,
		bridges: bridgesBoot.registry,
		warrenConfigs,
		projectsConfig,
		projectSpawn: defaultSpawn,
		config: schedulerConfig,
		issueTracker,
		logger: schedulerLoggerFromPino(logger),
		// warren-0b49: the boot-resolved forge drives the CI-fixer poller and
		// the per-spawn credential mints (§4) — no captured githubToken.
		forge,
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
		forge,
		bridges: bridgesBoot.registry,
		warrenConfigs,
		projectsConfig,
		autoOpenPr,
		seedsCli,
		issueTracker,
		projectSpawn: defaultSpawn,
		logger,
		...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});

	// Background detectors: run heartbeat watchdog (warren-285d), periodic
	// ops-stats worker, forge credential heartbeat (warren-1295). See detector-wiring.ts.
	const { watchdog, opsStatsWorker, forgeHeartbeat, finalizeRecovery } = bootBackgroundDetectors({
		env,
		adapter,
		repos,
		reap: bindReap,
		broker,
		bridges: bridgesBoot.registry,
		warrenConfigs,
		autoOpenPr,
		runtimeProvider,
		forge,
		metricsRegistry,
		logger,
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});

	// Preview TTL + LRU eviction worker (R-19 / docs/design/preview-environments.md, warren-ea6b).
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

	// Fallback GC for stranded workspaces (warren-0a9a). See workspace-gc-wiring.ts.
	const workspaceGcWorker = bootWorkspaceGc({
		repos,
		workspaceDestroyer,
		config: workspaceGcConfig,
		logger,
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});

	// Tool-calls rollup backfill (warren-7746). Fire-and-forget; see the wiring module.
	bootToolCallsBackfill({ repos, logger });

	const deps = buildServerDeps({
		repos,
		db,
		// warren-c531 / warren-6c4c: provider + forge resolved once above; deps re-uses them.
		runtimeProvider,
		forge,
		gitHubAppRegistration,
		...(setupHandoffBoot !== undefined ? { setupHandoff: setupHandoffBoot.store } : {}),
		...(gitHubAppActivation !== undefined ? { gitHubAppActivation } : {}),
		broker,
		// warren-f566: the global lifecycle stream broker the bus wiring owns.
		lifecycleStream: lifecycleBusHandle.lifecycleStream,
		bridges: bridgesBoot.registry,
		projectsConfig,
		logger,
		uiDistDir: serverConfig.uiDistDir,
		autoOpenPr,
		warrenConfigs,
		runBranchPrefixDefault,
		previewPortRange,
		previewLaunchConfig: previewSurface.launchConfig,
		previewEvictionConfig,
		workspaceGcTtlMs: workspaceGcConfig.ttlMs,
		// Event-stream concurrency caps (warren-25f6); a bad knob refuses the boot.
		eventStreamLimits: loadEventStreamLimitsFromEnv(),
		// warren-ce9b: only set under `WARREN_AUTH=public`; gates POST /projects.
		publicAllowlist,
		previewAuth: previewSurface.previewAuth,
		...(previewSidecars !== undefined ? { previewSidecars } : {}),
		sdBinary: schedulerConfig.sdBinary,
		issueTracker,
		metricsRegistry,
		// warren-cd3b: durable salvage-bundle intake dir (the persistent volume).
		salvageDir,
		// `/metrics` pod-phase gauges read from the pod-watcher at scrape (warren-7c30).
		...(k8sRuntime !== undefined ? { k8sPodWatcher: k8sRuntime.podWatcher } : {}),
		...(finalizeRecovery !== undefined ? { finalizeRecovery } : {}),
		...(opts.now !== undefined ? { now: opts.now } : {}),
	});

	// Build the provider from the backend resolved at the top of the boot
	// (warren-851b). `--no-auth` (token null) wins: the loopback dev hatch.
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

	// warren-57fd: this probe makes a run-scoped callback token invalid once terminal.
	const runActivityCheck: RunActivityCheck = async (runId) => {
		const row = await deps.repos.runs.get(runId);
		return row !== null && !isTerminalRunState(row.state);
	};

	const mainPreamble = previewSurface.mainPreamble;
	const handle = startServer(deps, {
		transport: serverConfig.transport,
		auth,
		logger,
		runActivityCheck,
		...(mainPreamble !== undefined ? { previewProxy: mainPreamble } : {}),
	});

	logger.info({ url: handle.url }, "warren server listening");

	return {
		transport: handle.transport,
		url: handle.url,
		...(tokenBoot !== null && tokenBoot.source !== "env" ? { operatorToken: tokenBoot.token } : {}),
		...(setupHandoffBoot !== undefined
			? { setupUrl: setupRedemptionUrl(handle.url, setupHandoffBoot.code) }
			: {}),
		stop: async () => {
			logger.info({}, "warren server stopping");
			// Stop the HTTP listener first, then drain the scheduler so any in-flight
			// tick finishes calling spawnRun before bridges/burrow/db disappear.
			await handle.stop();
			await previewSurface.previewListener?.stop();
			await planRunCoordinator.stop();
			await watchdog.stop();
			await scheduler.stop();
			await previewEvictionWorker.stop();
			await workspaceGcWorker.stop();
			await opsStatsWorker.stop();
			forgeHeartbeat?.stop();
			await k8sRuntime?.stop();
			await bridgesBoot.registry.stopAll();
			// Detach the lifecycle-bus consumers + uninstall the singleton so a
			// teardown leaves no global emit target behind (warren-4e74).
			providerRetryRegistration.unregister();
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
