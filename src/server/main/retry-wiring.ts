/**
 * Infra-lost auto-retry boot wiring (warren-4af7). Extracted from
 * `bootServer` in `index.ts` so the orchestrator stays under the per-file
 * size budget, mirroring the sibling `*-wiring.ts` precedent.
 *
 * Builds the run-level retry hook (`src/runs/retry/infra-lost-retry.ts`) once and hands the
 * caller the two seams it threads:
 *
 *   - `onInfraLostRun` — into reap (`bindReap`) and the bridge registry /
 *     boot ghost-reconcile (`bootBridges`).
 *   - `onRegistryCreated` — `bootBridges` calls this with the freshly-built
 *     registry BEFORE its ghost-reconcile loop can fire the hook, late-binding
 *     the hook's bridge facade so even a boot-time retry gets its event
 *     stream attached.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { Forge } from "../../forge/contract.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import { createInfraLostRetryHook, type InfraLostRetryHook } from "../../runs/index.ts";
import type { BridgeRegistry } from "../../runs/stream/types.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { EnvLike } from "../config.ts";
import type { Logger } from "../types.ts";
import { bridgeLoggerFromPino } from "./logging.ts";

export interface InfraLostRetryWiringInput {
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	readonly broker: Parameters<typeof createInfraLostRetryHook>[0]["broker"];
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	readonly warrenConfigs: WarrenConfigCache;
	readonly seedsCli: SeedsCliDeps;
	/** Boot-resolved IssueTracker (warren-5819) — forwarded to the retry hook. */
	readonly issueTracker?: IssueTracker;
	/** Boot-resolved forge, so the retry mints its refresh credential per dispatch. */
	readonly forge?: Forge;
	readonly env: EnvLike;
	readonly runBranchPrefixDefault?: string;
	readonly logger: Logger;
	readonly now?: () => Date;
}

export interface InfraLostRetryWiring {
	readonly onInfraLostRun: InfraLostRetryHook;
	readonly onRegistryCreated: (registry: BridgeRegistry) => void;
}

export function wireInfraLostRetry(input: InfraLostRetryWiringInput): InfraLostRetryWiring {
	const registryCell: { current?: BridgeRegistry } = {};
	return {
		onInfraLostRun: createInfraLostRetryHook({
			repos: input.repos,
			runtimeProvider: input.runtimeProvider,
			bridges: {
				start: (runId, sandboxRunId, sandboxId, mode) =>
					registryCell.current?.start(runId, sandboxRunId, sandboxId, mode),
			},
			...(input.broker !== undefined ? { broker: input.broker } : {}),
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			warrenConfigs: input.warrenConfigs,
			seedsCli: input.seedsCli,
			...(input.issueTracker !== undefined ? { issueTracker: input.issueTracker } : {}),
			...(input.forge !== undefined ? { forge: input.forge } : {}),
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			logger: bridgeLoggerFromPino(input.logger),
			...(input.now !== undefined ? { now: input.now } : {}),
		}),
		onRegistryCreated: (registry) => {
			registryCell.current = registry;
		},
	};
}
