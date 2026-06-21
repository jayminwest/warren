/**
 * Scheduler boot — wires the R-06 tick loop into `bootServer`'s lifecycle.
 *
 * One in-process tick fires every `tickMs` (default 60s), walks every
 * project, dispatches cron entries + scheduled-for seeds via `spawnRun`,
 * and persists fire state in the `triggers` table. The tick is
 * single-flight (mx-eb4a3a): a tick already in flight when the next
 * interval fires is skipped, so a slow tick degrades effective cadence
 * but never duplicates fires.
 *
 * Shape mirrors `bootBridges` in ./bridges.ts: a builder that takes the
 * bag of server deps and returns a `SchedulerHandle`. `bootServer`
 * invokes the returned `stop()` BEFORE bridges/burrow/db go away so an
 * in-flight tick (which may be calling `spawnRun` against burrow) drains
 * before its deps disappear.
 *
 * The scheduler's per-fire dispatch wraps `spawnRun` exactly like
 * `POST /runs` does: same agent lookup, same burrow provisioning, same
 * workspace seed, same bridge hand-off so the scheduled run's events
 * flow into warren.events without the operator manually attaching a
 * bridge.
 */

import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { spawnRun } from "../runs/index.ts";
import { listScheduledSeeds, updateExtensions } from "../seeds-cli/index.ts";
import {
	type DispatchSpawnFn,
	type DispatchSpawnInput,
	type DispatchSpawnResult,
	type SchedulerHandle,
	type SchedulerTimerHandle,
	startScheduler,
	type TickCiFixerSpawnFn,
	type TickCiFixerSpawnInput,
	type TickLogger,
	type TriggerSchedulerConfig,
} from "../triggers/index.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { BridgeRegistry } from "./types.ts";

export interface BootSchedulerInput {
	readonly repos: Repos;
	readonly burrowClientPool: BurrowClientPool;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	readonly config: TriggerSchedulerConfig;
	readonly logger?: TickLogger;
	readonly now?: () => Date;
	/**
	 * Deployment-wide run-branch prefix fallback (warren-9993). Forwarded
	 * onto every scheduled `spawnRun` so cron/scheduled-for dispatches honor
	 * the same `WARREN_RUN_BRANCH_PREFIX` the HTTP `POST /runs` path uses.
	 */
	readonly runBranchPrefixDefault?: string;
	/**
	 * `GITHUB_TOKEN` for the CI-fixer poller's check-runs fetch (warren-0b75).
	 * Resolved from the same env the reap pr-open path reads. Defaults to the
	 * empty string; the poller surfaces per-PR `error` results when unset.
	 */
	readonly githubToken?: string;
	/** Override the spawnRun seam (tests). Defaults to the live `spawnRun`. */
	readonly spawnRunFn?: typeof spawnRun;
	/** Test override for setInterval (forwarded to `startScheduler`). */
	readonly setInterval?: (cb: () => void, ms: number) => SchedulerTimerHandle;
	readonly clearInterval?: (handle: SchedulerTimerHandle) => void;
}

/**
 * Construct the live scheduler with full production deps. The returned
 * handle goes on `WarrenServerHandle.stop`'s teardown chain.
 */
export function bootScheduler(input: BootSchedulerInput): SchedulerHandle {
	const spawnRunFn = input.spawnRunFn ?? spawnRun;

	const seedsDeps = { sdBinary: input.config.sdBinary, spawn: input.projectSpawn };

	const spawnDispatch: DispatchSpawnFn = async (
		args: DispatchSpawnInput,
	): Promise<DispatchSpawnResult> => {
		const result = await spawnRunFn({
			repos: input.repos,
			burrowClientPool: input.burrowClientPool,
			agentName: args.agentName,
			projectId: args.projectId,
			prompt: args.prompt,
			trigger: args.trigger,
			...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
			...(args.maxCostUsd !== undefined ? { maxCostUsdOverride: args.maxCostUsd } : {}),
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			warrenConfigs: input.warrenConfigs,
			seedsCli: seedsDeps,
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			...(input.now !== undefined ? { now: input.now } : {}),
		});
		// Same hand-off as POST /runs — bridge the dispatched run so its
		// events flow into warren.events. Without this the scheduled run
		// would emit events into burrow that the warren wire never sees.
		input.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);
		return { runId: result.run.id };
	};

	// warren-0b75: CI-fixer dispatch wraps `spawnRun` like the cron path,
	// pinning trigger="ci-fixer" (the discriminator fixAttemptHistoryByPrUrl
	// counts) and back-linking the fixer to the PR's opener via parentRunId so
	// the fixer's workspace forks from the opener's pushed branch. warren-a993:
	// `targetBranch` pins the burrow branch to the PR head ref so the fixer's
	// commits push back onto the open PR (re-running its CI) instead of opening
	// a fresh `${prefix}/run_xxx` branch; reap honors the same branch on push.
	const ciFixerSpawn: TickCiFixerSpawnFn = async (
		args: TickCiFixerSpawnInput,
	): Promise<{ runId: string }> => {
		const result = await spawnRunFn({
			repos: input.repos,
			burrowClientPool: input.burrowClientPool,
			agentName: args.agentName,
			projectId: args.projectId,
			prompt: args.prompt,
			trigger: "ci-fixer",
			parentRunId: args.parentRunId,
			targetBranch: args.targetBranch,
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			warrenConfigs: input.warrenConfigs,
			seedsCli: seedsDeps,
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			...(input.now !== undefined ? { now: input.now } : {}),
		});
		input.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);
		return { runId: result.run.id };
	};

	return startScheduler({
		tickMs: input.config.tickMs,
		disabled: input.config.disabled,
		repos: input.repos,
		loadWarrenConfig: (projectId, projectPath) => input.warrenConfigs.get(projectId, projectPath),
		listScheduledSeeds: (projectPath) => listScheduledSeeds(seedsDeps, projectPath),
		updateExtensions: (projectPath, seedId, extensions) =>
			updateExtensions(seedsDeps, projectPath, seedId, extensions),
		spawn: spawnDispatch,
		ciFixer: {
			githubToken: input.githubToken ?? "",
			spawn: ciFixerSpawn,
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
		},
		...(input.logger !== undefined ? { logger: input.logger } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
		...(input.setInterval !== undefined ? { setInterval: input.setInterval } : {}),
		...(input.clearInterval !== undefined ? { clearInterval: input.clearInterval } : {}),
	});
}
