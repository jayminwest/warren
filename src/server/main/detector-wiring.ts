/**
 * Background-detector boot wiring (run heartbeat watchdog + ops-stats
 * worker). Extracted from `bootServer` so the orchestrator in `index.ts`
 * stays under the per-file size budget.
 *
 * - `bootWatchdogFromEnv` (warren-285d): force-fails `running` runs that
 *   go silent-but-busy past the heartbeat budget, routing the timeout
 *   through reap so the burrow workspace + bwrap process tree is torn
 *   down. On by default (warren-b2dc) with a generous built-in budget
 *   (`DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS`, 45 min) so a fresh deploy is
 *   protected without an explicit env var; tune via
 *   `WARREN_RUN_HEARTBEAT_TIMEOUT_MS`, opt out via
 *   `WARREN_WATCHDOG_DISABLED=1`. See `src/runs/watchdog.ts`.
 */

import type { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { Forge } from "../../forge/contract.ts";
import type { ForgeHeartbeatHandle } from "../../forge/github-app/heartbeat.ts";
import type { MetricsRegistry } from "../../observability/metrics-registry.ts";
import { createFinalizeRecovery, type FinalizeRecoveryHook } from "../../runs/finalize-recovery.ts";
import {
	type AutoOpenPrConfig,
	bootWatchdog,
	loadWatchdogConfigFromEnv,
	type RunEventBroker,
	type WatchdogHandle,
	type WatchdogReap,
} from "../../runs/index.ts";
import { bootOpsStatsWorker, type OpsStatsWorkerHandle } from "../../runs/ops-stats.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import { resolveRuntimeKind } from "../../runtime/registry.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { EnvLike } from "../config.ts";
import type { BridgeRegistry, Logger } from "../types.ts";
import { bootForgeHeartbeatFromEnv } from "./forge-heartbeat-wiring.ts";
import { bridgeLoggerFromPino } from "./logging.ts";

export interface WatchdogWiringInput {
	readonly env: EnvLike;
	readonly repos: Repos;
	/**
	 * The reap seam the watchdog force-fails a hung run through (warren-1fce /
	 * warren-5a3f). Pre-bound by the boot composition root (`src/server/main/index.ts`)
	 * to `reapRun` with the local burrow client applied, so this wiring module holds
	 * no burrow client of its own. Collapses to plain `reapRun` once reap sheds the
	 * client (warren-fbbf).
	 */
	readonly reap: WatchdogReap;
	readonly broker: RunEventBroker;
	readonly autoOpenPr: AutoOpenPrConfig;
	/**
	 * Runtime-provider seam (warren-c531 / warren-1fce). Threaded into the watchdog
	 * tick so its graceful cancel of a hung run and the force-fail reap's
	 * finalize + terminate route through `provider.*` on the ACTIVE backend.
	 * Required — the tick no longer constructs its own burrow-backed provider.
	 */
	readonly runtimeProvider: RuntimeProvider;
	readonly logger: Logger;
	readonly now?: () => Date;
}

export function bootWatchdogFromEnv(input: WatchdogWiringInput): WatchdogHandle {
	const { env, logger } = input;
	const config = loadWatchdogConfigFromEnv(env);
	const handle = bootWatchdog({
		repos: input.repos,
		broker: input.broker,
		autoOpenPr: input.autoOpenPr,
		runtimeProvider: input.runtimeProvider,
		// Reap seam pre-bound by the boot composition root with the burrow client reap
		// still needs for its workspace reads, so this wiring stays burrow-free
		// (warren-1fce / warren-5a3f).
		reap: input.reap,
		heartbeatTimeoutMs: config.heartbeatTimeoutMs,
		terminalReconcileGraceMs: config.terminalReconcileGraceMs,
		cancelReconcileGraceMs: config.cancelReconcileGraceMs,
		tickMs: config.tickMs,
		disabled: !config.enabled,
		logger: bridgeLoggerFromPino(logger),
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	if (!config.enabled) {
		logger.info({}, "run watchdog disabled via WARREN_WATCHDOG_DISABLED (or budget pinned to 0)");
	} else {
		logger.info(
			{
				tickMs: config.tickMs,
				heartbeatTimeoutMs: config.heartbeatTimeoutMs,
				terminalReconcileGraceMs: config.terminalReconcileGraceMs,
				cancelReconcileGraceMs: config.cancelReconcileGraceMs,
			},
			"run watchdog running",
		);
	}
	return handle;
}

/**
 * Superset input for `bootBackgroundDetectors` — the watchdog and ops-stats
 * worker share most of their deps, so `bootServer` hands the whole bag
 * once instead of wiring two call sites.
 */
export interface BackgroundDetectorWiringInput {
	readonly env: EnvLike;
	readonly adapter: DrizzleAdapter;
	readonly repos: Repos;
	/**
	 * The reap seam the watchdog force-fails through (warren-5a3f). Pre-bound by
	 * the boot composition root with the local burrow client applied, so this
	 * wiring module never imports the burrow client.
	 */
	readonly reap: WatchdogReap;
	readonly broker: RunEventBroker;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly autoOpenPr: AutoOpenPrConfig;
	/**
	 * Runtime-provider seam — forwarded to the watchdog tick.
	 */
	readonly runtimeProvider: RuntimeProvider;
	/**
	 * The boot-resolved forge (warren-1295) — the GitHub App credential
	 * heartbeat boots only when this is the `app` provider.
	 */
	readonly forge: Forge;
	/** Counter sink for the forge-heartbeat probe ticks (warren-1295). */
	readonly metricsRegistry: MetricsRegistry | undefined;
	readonly logger: Logger;
	readonly now?: () => Date;
}

export interface BackgroundDetectorHandles {
	readonly watchdog: WatchdogHandle;
	/** Periodic operational-stats log line (warren-b2dd / pl-f700 step 6). */
	readonly opsStatsWorker: OpsStatsWorkerHandle;
	/**
	 * GitHub App credential heartbeat (warren-1295) — `undefined` unless the
	 * resolved forge is the App provider and the probe is not opted out.
	 */
	readonly forgeHeartbeat: ForgeHeartbeatHandle | undefined;
	/**
	 * K8s finalize-intent recovery hook (warren-5202) — turns a run pod's
	 * post-restart `GET /runs/:id/finalize-intent` misses into a recovery reap
	 * so the finalize handshake completes instead of deadlocking. `undefined`
	 * under `local` (no pod ever polls the route there).
	 */
	readonly finalizeRecovery: FinalizeRecoveryHook | undefined;
}

/**
 * Boot all background detectors in one call. The watchdog is an
 * on-by-default opt-out; this wrapper collapses the shared dep-plumbing
 * so `bootServer` stays under the file-size ratchet.
 */
export function bootBackgroundDetectors(
	input: BackgroundDetectorWiringInput,
): BackgroundDetectorHandles {
	const now = input.now !== undefined ? { now: input.now } : {};
	const watchdog = bootWatchdogFromEnv({
		env: input.env,
		repos: input.repos,
		reap: input.reap,
		broker: input.broker,
		autoOpenPr: input.autoOpenPr,
		runtimeProvider: input.runtimeProvider,
		logger: input.logger,
		...now,
	});
	// Read-only observability: one `ops.stats` line per tick with runs-by-
	// state, active bridge count, and cost aggregates — all from data
	// already in SQLite plus the in-process bridge registry size.
	const opsStatsWorker = bootOpsStatsWorker({
		adapter: input.adapter,
		bridges: input.bridges,
		logger: input.logger,
		env: input.env,
	});
	const forgeHeartbeat = bootForgeHeartbeatFromEnv({
		env: input.env,
		forge: input.forge,
		logger: input.logger,
		metricsRegistry: input.metricsRegistry,
	});
	// warren-5202: a control-plane replacement mid-run wipes the in-memory
	// finalize coordinator; the surviving pod keeps polling for an intent no
	// lost reap will ever park. The hook turns that poll into the recovery
	// signal — a miss that outlives its grace drives a fresh reap, re-parking
	// the intent so the normal finalize handshake completes. K8s topology only.
	const finalizeRecovery =
		resolveRuntimeKind(input.env) === "k8s"
			? createFinalizeRecovery({
					repos: input.repos,
					runtimeProvider: input.runtimeProvider,
					reap: input.reap,
					broker: input.broker,
					autoOpenPr: input.autoOpenPr,
					logger: bridgeLoggerFromPino(input.logger),
					...now,
				})
			: undefined;
	return { watchdog, opsStatsWorker, forgeHeartbeat, finalizeRecovery };
}
