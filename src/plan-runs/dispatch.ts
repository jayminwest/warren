/**
 * Spawn wrapper for the PlanRun coordinator (pl-a258 step 5 / warren-2623).
 *
 * `createPlanRunSpawn` mirrors `bootScheduler`'s spawnDispatch in
 * src/server/scheduler.ts: it composes a `CoordinatorSpawnFn` that the
 * coordinator can call without knowing about burrow pools, bridge
 * registries, project clones, or warren-config caches. The wrapper:
 *
 *   1. Loads the project so `ref` can fall back to `defaultBranch` when
 *      the PlanRun didn't pin one.
 *   2. Calls `spawnRun` with `trigger:'plan-run'`, the child's `seedId`
 *      (so spawnRun's existing post-dispatch `updateExtensions` write
 *      stamps `role`/`lastRunId`/`lastRunAt` onto the seed — mx-41ed65),
 *      and `metadata: {planRunId, planId, childSeq}` so the run is
 *      attributable to its PlanRun in audits.
 *   3. Hands the dispatched burrow run to `bridges.start` so its events
 *      stream into warren.events the same way scheduler and HTTP-dispatched
 *      runs do.
 *
 * Per-PlanRun spawn failures bubble as `RunSpawnError` (or a typed warren
 * error); the coordinator catches and marks the child failed.
 */

import type { Repos } from "../db/repos/index.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { spawnRun } from "../runs/index.ts";
import type { BridgeRegistry } from "../runs/stream/types.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { CoordinatorSpawnFn } from "./coordinator.ts";

export interface CreatePlanRunSpawnInput {
	readonly repos: Repos;
	/**
	 * Resolved runtime provider (warren-c42c: required — the spawn seam is now
	 * exclusively `provider.create()`, no burrow-client fallback). Boot threads
	 * the boot-selected instance (`resolveRuntimeProvider`, honoring
	 * `WARREN_RUNTIME`); `spawnRun` dispatches through it.
	 */
	readonly runtimeProvider: RuntimeProvider;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	/** Raw `GITHUB_TOKEN` for the pre-dispatch refresh fetch — see `SpawnRunInput.githubToken`. */
	readonly githubToken?: string;
	readonly seedsCli: SeedsCliDeps;
	readonly runBranchPrefixDefault?: string;
	readonly now?: () => Date;
	/** Test seam — defaults to the live `spawnRun`. */
	readonly spawnRunFn?: typeof spawnRun;
}

export function createPlanRunSpawn(input: CreatePlanRunSpawnInput): CoordinatorSpawnFn {
	const spawnRunFn = input.spawnRunFn ?? spawnRun;
	return async ({ planRun, child, prompt }) => {
		const project = await input.repos.projects.require(planRun.projectId);
		const ref = planRun.ref ?? project.defaultBranch;
		const result = await spawnRunFn({
			repos: input.repos,
			runtimeProvider: input.runtimeProvider,
			agentName: planRun.agentName,
			projectId: planRun.projectId,
			prompt,
			trigger: "plan-run",
			seedId: child.seedId,
			...(planRun.providerOverride !== null ? { providerOverride: planRun.providerOverride } : {}),
			...(planRun.modelOverride !== null ? { modelOverride: planRun.modelOverride } : {}),
			// warren-a63d: the plan-run's spend cap applies to EACH child dispatch
			// on the override tier, same slot a POST /runs body cap rides.
			...(planRun.maxCostUsd !== null ? { maxCostUsdOverride: planRun.maxCostUsd } : {}),
			ref,
			metadata: {
				planRunId: planRun.id,
				planId: planRun.planId,
				childSeq: child.seq,
			},
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			githubToken: input.githubToken,
			warrenConfigs: input.warrenConfigs,
			seedsCli: input.seedsCli,
			dispatcherHandle: planRun.dispatcherHandle,
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			...(input.now !== undefined ? { now: input.now } : {}),
		});
		input.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);
		return { runId: result.run.id };
	};
}
