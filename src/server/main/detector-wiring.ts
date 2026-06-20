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
 * - `bootConversationMergePollerFromEnv` (warren-b872): polls GitHub for
 *   sent-off conversations whose plotSync PR has merged and auto-dispatches
 *   the planner run keyed on `plot_id`. On by default (warren-157a) — like
 *   the conversation idle detector it is a lifecycle-reclaim path that must
 *   not depend on an operator remembering a flag. Opt-out via
 *   `WARREN_MERGE_POLLER_DISABLED=1`.
 * - `bootConversationIdleDetectorFromEnv` (warren-005d):
 *   finalizes the anchoring `mode:"conversation"` run after
 *   `conversation.idleTimeoutMs` of inactivity (the conversation row stays
 *   `active`; transcript and Plot persist). On by default — it is the only
 *   thing that reclaims an abandoned conversation's compute, since
 *   warren-c770 exempts conversation runs from the watchdog and crash
 *   recovery. Opt-out via `WARREN_CONVERSATION_IDLE_DISABLED=1`.
 */

import type { BurrowClientPool } from "../../burrow-client/pool.ts";
import type { Repos } from "../../db/repos/index.ts";
import { createPrMergeChecker } from "../../plan-runs/index.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import {
	type AutoOpenPrConfig,
	bootConversationIdleDetector,
	bootConversationMergePoller,
	bootPauseDetector,
	bootWatchdog,
	type ConversationIdleDetectorHandle,
	createMergePollerDispatch,
	createRepoIdleConversationReader,
	defaultPlotEventReader,
	loadWatchdogConfigFromEnv,
	type MergePollerHandle,
	type PauseDetectorHandle,
	type RunEventBroker,
	type WatchdogHandle,
} from "../../runs/index.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
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

export interface MergePollerWiringInput {
	readonly env: EnvLike;
	readonly repos: Repos;
	readonly burrowClientPool: BurrowClientPool;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	readonly seedsCli: SeedsCliDeps;
	readonly autoOpenPr: AutoOpenPrConfig;
	readonly runBranchPrefixDefault?: string;
	readonly logger: Logger;
	readonly now?: () => Date;
}

/**
 * Boot the send-off PR-merge poller (warren-b872). On by default
 * (warren-157a) — mirroring the conversation idle detector, this is the
 * lifecycle path that auto-dispatches the planner run keyed on `plot_id`
 * once a sent-off conversation's plotSync PR merges, so it must not depend
 * on an operator remembering a flag. Opt-out via
 * `WARREN_MERGE_POLLER_DISABLED=1`; polls every
 * `WARREN_MERGE_POLLER_TICK_MS` (default 30s).
 */
export function bootConversationMergePollerFromEnv(
	input: MergePollerWiringInput,
): MergePollerHandle {
	const { env, logger } = input;
	const disabled = parseTrueEnv(env.WARREN_MERGE_POLLER_DISABLED);
	const tickMs = parseIntEnv(env, "WARREN_MERGE_POLLER_TICK_MS", 30_000);
	const dispatch = createMergePollerDispatch({
		repos: input.repos,
		burrowClientPool: input.burrowClientPool,
		bridges: input.bridges,
		warrenConfigs: input.warrenConfigs,
		projectsConfig: input.projectsConfig,
		projectSpawn: input.projectSpawn,
		seedsCli: input.seedsCli,
		...(input.runBranchPrefixDefault !== undefined
			? { runBranchPrefixDefault: input.runBranchPrefixDefault }
			: {}),
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	const handle = bootConversationMergePoller({
		repos: input.repos,
		checkPrMerged: createPrMergeChecker({ token: input.autoOpenPr.token }),
		dispatch,
		tickMs,
		disabled,
		logger: pauseLoggerFromPino(logger),
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	if (disabled) {
		logger.info({}, "merge poller disabled via WARREN_MERGE_POLLER_DISABLED");
	} else {
		logger.info({ tickMs }, "merge poller running");
	}
	return handle;
}

export interface ConversationIdleWiringInput {
	readonly env: EnvLike;
	readonly repos: Repos;
	readonly warrenConfigs: WarrenConfigCache;
	readonly logger: Logger;
	readonly now?: () => Date;
}

/**
 * Boot the conversation idle-timeout coordinator (warren-005d).
 * On by default — unlike the opt-in detectors
 * above, this is the lifecycle reclaim path for conversation compute
 * (mirroring preview eviction / workspace GC), so it must not depend on an
 * operator remembering a flag. Opt-out via
 * `WARREN_CONVERSATION_IDLE_DISABLED=1`; ticks every
 * `WARREN_CONVERSATION_IDLE_TICK_MS` (default 60s). The per-conversation
 * budget comes from each project's `conversation.idleTimeoutMs`
 * (`.warren/config.yaml`), falling back to the 20-minute default.
 */
export function bootConversationIdleDetectorFromEnv(
	input: ConversationIdleWiringInput,
): ConversationIdleDetectorHandle {
	const { env, logger } = input;
	const disabled = parseTrueEnv(env.WARREN_CONVERSATION_IDLE_DISABLED);
	const tickMs = parseIntEnv(env, "WARREN_CONVERSATION_IDLE_TICK_MS", 60_000);
	const handle = bootConversationIdleDetector({
		repos: input.repos,
		reader: createRepoIdleConversationReader(input.repos),
		warrenConfigs: input.warrenConfigs,
		tickMs,
		disabled,
		logger: pauseLoggerFromPino(logger),
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	if (disabled) {
		logger.info({}, "conversation idle detector disabled via WARREN_CONVERSATION_IDLE_DISABLED");
	} else {
		logger.info({ tickMs }, "conversation idle detector running");
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
		logger.info({}, "run watchdog disabled via WARREN_WATCHDOG_DISABLED (or budget pinned to 0)");
	} else {
		logger.info(
			{ tickMs: config.tickMs, heartbeatTimeoutMs: config.heartbeatTimeoutMs },
			"run watchdog running",
		);
	}
	return handle;
}

/**
 * Superset input for `bootBackgroundDetectors` — the pause detector, run
 * heartbeat watchdog, and send-off merge poller share most of their deps, so
 * `bootServer` hands the whole bag once instead of wiring three call sites.
 */
export interface BackgroundDetectorWiringInput {
	readonly env: EnvLike;
	readonly repos: Repos;
	readonly burrowClientPool: BurrowClientPool;
	readonly broker: RunEventBroker;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	readonly seedsCli: SeedsCliDeps;
	readonly autoOpenPr: AutoOpenPrConfig;
	readonly runBranchPrefixDefault?: string;
	readonly logger: Logger;
	readonly now?: () => Date;
}

export interface BackgroundDetectorHandles {
	readonly pauseDetector: PauseDetectorHandle;
	readonly watchdog: WatchdogHandle;
	readonly mergePoller: MergePollerHandle;
	readonly conversationIdleDetector: ConversationIdleDetectorHandle;
}

/**
 * Boot all four background detectors in one call. Each is independently
 * gated by its own env flag inside the per-detector boot (the pause
 * detector is opt-in; the watchdog, conversation idle detector, and
 * send-off merge poller are on-by-default opt-outs); this wrapper just
 * collapses the shared dep-plumbing so `bootServer` stays under the
 * file-size ratchet.
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
		burrowClientPool: input.burrowClientPool,
		broker: input.broker,
		autoOpenPr: input.autoOpenPr,
		logger: input.logger,
		...now,
	});
	const mergePoller = bootConversationMergePollerFromEnv({
		env: input.env,
		repos: input.repos,
		burrowClientPool: input.burrowClientPool,
		bridges: input.bridges,
		warrenConfigs: input.warrenConfigs,
		projectsConfig: input.projectsConfig,
		projectSpawn: input.projectSpawn,
		seedsCli: input.seedsCli,
		autoOpenPr: input.autoOpenPr,
		...(input.runBranchPrefixDefault !== undefined
			? { runBranchPrefixDefault: input.runBranchPrefixDefault }
			: {}),
		logger: input.logger,
		...now,
	});
	const conversationIdleDetector = bootConversationIdleDetectorFromEnv({
		env: input.env,
		repos: input.repos,
		warrenConfigs: input.warrenConfigs,
		logger: input.logger,
		...now,
	});
	return { pauseDetector, watchdog, mergePoller, conversationIdleDetector };
}
