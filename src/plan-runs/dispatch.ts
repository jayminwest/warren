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

import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PlanRunRow } from "../db/schema.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { resolveTargetProject } from "../projects/resolve-target.ts";
import { spawnRun } from "../runs/index.ts";
import { readTargetRepo, type SeedsCliDeps } from "../seeds-cli/index.ts";
import type { BridgeRegistry } from "../server/types.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type {
	ChildExecution,
	CoordinatorResolveExecutionFn,
	CoordinatorSpawnFn,
} from "./coordinator.ts";

/**
 * Resolve a child's execution project from its seed `extensions.repo`
 * (pl-fb43 step 5 / warren-d9f3). An absent tag falls back to the
 * coordination project (`planRun.projectId`); a present tag is resolved
 * to a registered project via `resolveTargetProject`, which throws
 * `TargetProjectUnresolvedError` when nothing matches. Pure lookup — no
 * clone, no git I/O.
 */
export async function resolveChildExecution(
	repos: Pick<Repos, "projects">,
	planRun: Pick<PlanRunRow, "projectId">,
	seedExtensions: Record<string, unknown> | undefined,
): Promise<ChildExecution> {
	const repoRef = readTargetRepo(seedExtensions);
	if (repoRef === undefined) {
		return { executionProjectId: planRun.projectId, repoRef: null };
	}
	const executionProjectId = await resolveTargetProject(repos, repoRef);
	return { executionProjectId, repoRef };
}

/**
 * Build the coordinator's per-child execution resolver bound to `repos`
 * (pl-fb43 step 5). Wired into `bootPlanRunCoordinator` so the dispatch
 * arm and the merged-event legibility path share one resolution policy.
 */
export function createResolveExecution(
	repos: Pick<Repos, "projects">,
): CoordinatorResolveExecutionFn {
	return (planRun, seedExtensions) => resolveChildExecution(repos, planRun, seedExtensions);
}

export interface CreatePlanRunSpawnInput {
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

export function createPlanRunSpawn(input: CreatePlanRunSpawnInput): CoordinatorSpawnFn {
	const spawnRunFn = input.spawnRunFn ?? spawnRun;
	return async ({ planRun, child, prompt, execution }) => {
		// pl-fb43 step 5: clone the child's *execution* repo into the
		// workspace while `seedProjectId` keeps the post-dispatch seed stamp +
		// Plot append pointed at the coordination project. Defaults to the
		// coordination project so an untagged child is byte-identical.
		const exec: ChildExecution = execution ?? {
			executionProjectId: planRun.projectId,
			repoRef: null,
		};
		const project = await input.repos.projects.require(exec.executionProjectId);
		const ref = planRun.ref ?? project.defaultBranch;
		const result = await spawnRunFn({
			repos: input.repos,
			burrowClientPool: input.burrowClientPool,
			agentName: planRun.agentName,
			projectId: exec.executionProjectId,
			seedProjectId: planRun.projectId,
			...(exec.repoRef !== null ? { executionRepo: exec.repoRef } : {}),
			prompt,
			trigger: "plan-run",
			seedId: child.seedId,
			...(planRun.providerOverride !== null ? { providerOverride: planRun.providerOverride } : {}),
			...(planRun.modelOverride !== null ? { modelOverride: planRun.modelOverride } : {}),
			ref,
			...(planRun.plotId !== null ? { plotId: planRun.plotId } : {}),
			metadata: {
				planRunId: planRun.id,
				planId: planRun.planId,
				childSeq: child.seq,
			},
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
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
