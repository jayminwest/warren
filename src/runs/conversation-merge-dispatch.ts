/**
 * Planner-dispatch wrapper for the conversation merge poller (warren-b872).
 *
 * `createMergePollerDispatch` composes a `PlannerDispatchFn` the poller
 * (`src/runs/conversation-merge-poller.ts`) can call without knowing about
 * burrow pools, bridge registries, project clones, or warren-config caches —
 * the same seam discipline as `createPlanRunSpawn` (src/plan-runs/dispatch.ts).
 * The wrapper:
 *
 *   1. Loads the project so `ref` falls back to its `defaultBranch` (the
 *      planner's fresh clone must contain the just-merged intent on the
 *      default branch).
 *   2. Calls `spawnRun` with `trigger:'send-off'`, the seed prompt from
 *      `buildPlannerDispatchPrompt`, the conversation's `plot_id`, and
 *      `metadata:{conversationId}` so the planner run is attributable.
 *   3. Hands the dispatched burrow run to `bridges.start` so its events stream
 *      into `warren.events` like every other run.
 */

import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import type { BridgeRegistry } from "../server/types.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import { buildPlannerDispatchPrompt, type PlannerDispatchFn } from "./conversation-merge-poller.ts";
import { spawnRun } from "./spawn/index.ts";

export interface CreateMergePollerDispatchInput {
	readonly repos: Repos;
	readonly burrowClientPool: BurrowClientPool;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	readonly seedsCli: SeedsCliDeps;
	readonly runBranchPrefixDefault?: string;
	readonly now?: () => Date;
	/** Test seam — defaults to the live `spawnRun`. */
	readonly spawnRunFn?: typeof spawnRun;
}

export function createMergePollerDispatch(
	input: CreateMergePollerDispatchInput,
): PlannerDispatchFn {
	const spawnRunFn = input.spawnRunFn ?? spawnRun;
	return async ({ conversationId, projectId, plotId, plannerAgent }) => {
		const project = await input.repos.projects.require(projectId);
		const result = await spawnRunFn({
			repos: input.repos,
			burrowClientPool: input.burrowClientPool,
			agentName: plannerAgent,
			projectId,
			prompt: buildPlannerDispatchPrompt(plotId),
			trigger: "send-off",
			ref: project.defaultBranch,
			plotId,
			metadata: { conversationId },
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			warrenConfigs: input.warrenConfigs,
			seedsCli: input.seedsCli,
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			...(input.now !== undefined ? { now: input.now } : {}),
		});
		input.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);
		return { runId: result.run.id };
	};
}
