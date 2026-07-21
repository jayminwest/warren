/**
 * Background-detector boot wiring (pause detector + run heartbeat
 * watchdog). Extracted from `bootServer` so the orchestrator in
 * `index.ts` stays under the per-file size budget.
 *
 * - `bootPauseDetectorFromEnv` (pl-0344 step 5 / warren-2976): polls Plot
 *   event logs of in-flight batch runs for unanswered `question_posed`
 *   and resumes paused runs on `question_answered` or `pauseTimeoutMs`.
 *   Opt-in via `WARREN_PAUSE_DETECTOR_ENABLED=1`. The respawn seam is a
 *   logging no-op until the interactive primitive consumes it.
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
import {
	type AutoOpenPrConfig,
	bootPauseDetector,
	bootWatchdog,
	defaultPlotEventReader,
	loadWatchdogConfigFromEnv,
	type PauseDetectorHandle,
	type RunEventBroker,
	type WatchdogHandle,
	type WatchdogReap,
} from "../../runs/index.ts";
import { bootOpsStatsWorker, type OpsStatsWorkerHandle } from "../../runs/ops-stats.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { EnvLike } from "../config.ts";
import type { BridgeRegistry, Logger } from "../types.ts";
import { bridgeLoggerFromPino, pauseLoggerFromPino } from "./logging.ts";
import { parseIntEnv, parseTrueEnv } from "./utils.ts";

export interface PauseDetectorWiringInput {
	readonly env: EnvLike;
	readonly repos: Repos;
	readonly warrenConfigs: WarrenConfigCache;
	readonly logger: Logger;
	readonly now?: () => Date;
}

export function bootPauseDetectorFromEnv(input: PauseDetectorWiringInput): PauseDetectorHandle {
	const { env, logger } = input;
	const enabled = parseTrueEnv(env.WARREN_PAUSE_DETECTOR_ENABLED);
	const tickMs = parseIntEnv(env, "WARREN_PAUSE_DETECTOR_TICK_MS", 15_000);
	const handle = bootPauseDetector({
		repos: input.repos,
		plotReader: defaultPlotEventReader,
		respawn: async (respawnInput) => {
			logger.info(
				{ runId: respawnInput.run.id, reason: respawnInput.reason.kind },
				"pause.respawn_seam_unconfigured",
			);
		},
		warrenConfigs: input.warrenConfigs,
		tickMs,
		disabled: !enabled,
		logger: pauseLoggerFromPino(logger),
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	if (!enabled) {
		logger.info({}, "pause detector disabled (set WARREN_PAUSE_DETECTOR_ENABLED=1 to enable)");
	} else {
		logger.info({ tickMs }, "pause detector running");
	}
	return handle;
}

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
			},
			"run watchdog running",
		);
	}
	return handle;
}

/**
 * Superset input for `bootBackgroundDetectors` — the pause detector and run
 * heartbeat watchdog share most of their deps, so `bootServer` hands the
 * whole bag once instead of wiring two call sites.
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
	readonly logger: Logger;
	readonly now?: () => Date;
}

export interface BackgroundDetectorHandles {
	readonly pauseDetector: PauseDetectorHandle;
	readonly watchdog: WatchdogHandle;
	/** Periodic operational-stats log line (warren-b2dd / pl-f700 step 6). */
	readonly opsStatsWorker: OpsStatsWorkerHandle;
}

/**
 * Boot all background detectors in one call. Each is independently
 * gated by its own env flag inside the per-detector boot (the pause
 * detector is opt-in; the watchdog is an on-by-default opt-out); this
 * wrapper just collapses the shared dep-plumbing so `bootServer` stays
 * under the file-size ratchet.
 */
export function bootBackgroundDetectors(
	input: BackgroundDetectorWiringInput,
): BackgroundDetectorHandles {
	const now = input.now !== undefined ? { now: input.now } : {};
	const pauseDetector = bootPauseDetectorFromEnv({
		env: input.env,
		repos: input.repos,
		warrenConfigs: input.warrenConfigs,
		logger: input.logger,
		...now,
	});
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
	return { pauseDetector, watchdog, opsStatsWorker };
}
