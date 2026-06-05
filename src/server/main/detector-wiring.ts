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
 *   go silent-but-busy past `WARREN_RUN_HEARTBEAT_TIMEOUT_MS`, routing the
 *   timeout through reap so the burrow workspace + bwrap process tree is
 *   torn down. Opt-in: arms only on a positive timeout. See
 *   `src/runs/watchdog.ts`.
 */

import type { BurrowClientPool } from "../../burrow-client/pool.ts";
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
} from "../../runs/index.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { EnvLike } from "../config.ts";
import type { Logger } from "../types.ts";
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
	readonly burrowClientPool: BurrowClientPool;
	readonly broker: RunEventBroker;
	readonly autoOpenPr: AutoOpenPrConfig;
	readonly logger: Logger;
	readonly now?: () => Date;
}

export function bootWatchdogFromEnv(input: WatchdogWiringInput): WatchdogHandle {
	const { env, logger } = input;
	const config = loadWatchdogConfigFromEnv(env);
	const handle = bootWatchdog({
		repos: input.repos,
		burrowClientPool: input.burrowClientPool,
		broker: input.broker,
		autoOpenPr: input.autoOpenPr,
		heartbeatTimeoutMs: config.heartbeatTimeoutMs,
		tickMs: config.tickMs,
		disabled: !config.enabled,
		logger: bridgeLoggerFromPino(logger),
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	if (!config.enabled) {
		logger.info({}, "run watchdog disabled (set WARREN_RUN_HEARTBEAT_TIMEOUT_MS to arm)");
	} else {
		logger.info(
			{ tickMs: config.tickMs, heartbeatTimeoutMs: config.heartbeatTimeoutMs },
			"run watchdog running",
		);
	}
	return handle;
}
