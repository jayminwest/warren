/**
 * Provider-retry wiring (warren-339d).
 *
 * The run-level provider-error retry (`src/runs/retry/provider-retry.ts`)
 * is a Tier-1 lifecycle consumer like the healer and the seed-close net,
 * but it CANNOT register inside `bootLifecycleBus` — the redispatch needs
 * the runtime provider and the bridge registry, both of which only exist
 * after the provider/bridge boots in `main/index.ts`. So it gets its own
 * wiring step: called from `main/index.ts` once those exist, it registers
 * the extension on the already-installed bus and returns the
 * registration handle for teardown.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { Forge } from "../../forge/contract.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { RunEventBroker } from "../../runs/events.ts";
import {
	createProviderRetryLifecycleExtension,
	type ProviderRetryLogger,
} from "../../runs/index.ts";
import type { LifecycleBus, LifecycleRegistration } from "../../runs/lifecycle-bus.ts";
import type { BridgeRegistry } from "../../runs/stream/types.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { Logger } from "../types.ts";

export interface ProviderRetryWiringInput {
	readonly bus: LifecycleBus;
	readonly logger: Logger;
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	readonly bridges: BridgeRegistry;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	readonly forge: Forge;
	readonly warrenConfigs: WarrenConfigCache;
	readonly seedsCli: SeedsCliDeps;
	/** Boot-resolved IssueTracker (warren-5819) — forwarded to the retry extension. */
	readonly issueTracker?: IssueTracker;
	readonly broker?: RunEventBroker;
	readonly runBranchPrefixDefault?: string;
	readonly now?: () => Date;
}

/**
 * Register the provider-retry extension on the installed bus. Observes
 * `post_reap` and re-dispatches a `failed`/`provider_error` run ONCE when
 * the provider's terminal message is network-class (transient).
 */
export function wireProviderRetry(input: ProviderRetryWiringInput): LifecycleRegistration {
	const { logger } = input;
	const retryLogger: ProviderRetryLogger = {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
	};
	return input.bus.register(
		createProviderRetryLifecycleExtension({
			repos: input.repos,
			runtimeProvider: input.runtimeProvider,
			bridges: input.bridges,
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			forge: input.forge,
			warrenConfigs: input.warrenConfigs,
			seedsCli: input.seedsCli,
			...(input.issueTracker !== undefined ? { issueTracker: input.issueTracker } : {}),
			logger: retryLogger,
			...(input.broker !== undefined ? { broker: input.broker } : {}),
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			...(input.now !== undefined ? { now: input.now } : {}),
		}),
	);
}
