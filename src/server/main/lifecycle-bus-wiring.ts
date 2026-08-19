/**
 * Tier-1 observation event-bus boot wiring (warren-4e74, pl-3a79 step 17).
 *
 * Constructs the process-wide {@link LifecycleBus} (warren-bb60), points
 * its error sink at the boot logger, and registers the first-party
 * consumers through the bus's boot-time registration API
 * ({@link registerExtensions}) — no per-consumer plumbing, no `ServerDeps`
 * field (PHILOSOPHY rule 2 + rule 3). The bus is then INSTALLED as the
 * process singleton so the run-lifecycle emit call-sites (`spawnRun`,
 * `reapRun`) can publish without threading it down every seam.
 *
 * Proof consumer #1 is the healer (`src/healer/lifecycle.ts`): it
 * observes `run_dispatched` and reacts only to `healer`-triggered runs.
 * Consumer #2 is the clone-side seed-close safety net
 * (`src/runs/reap/seed-close-lifecycle.ts`, warren-df3e): it observes
 * `post_reap` and closes the run's seed host-side. Consumer #3 is the
 * merge watcher (`src/runs/reap/pr-merge-watcher.ts`, warren-3bc6): it
 * observes `post_reap` and settles the run's `pr_state` / `pr_merged_at`
 * through the boot-resolved forge. "Removing" any of them is deleting
 * its entry from the batch below — not loading it — never surgery on
 * the run loop.
 */

import { formatError } from "../../core/errors.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { Forge } from "../../forge/contract.ts";
import { createHealerLifecycleExtension } from "../../healer/lifecycle.ts";
import type { RunEventBroker } from "../../runs/events.ts";
import {
	clearLifecycleBus,
	createLifecycleStreamExtension,
	installLifecycleBus,
	LifecycleBus,
	LifecycleStreamBroker,
	registerExtensions,
} from "../../runs/index.ts";
import {
	createPrMergeWatcher,
	DEFAULT_INITIAL_INTERVAL_MS,
} from "../../runs/reap/pr-merge-watcher.ts";
import { createSeedCloseLifecycleExtension } from "../../runs/reap/seed-close-lifecycle.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import type { Logger } from "../types.ts";

export interface LifecycleBusWiringInput {
	readonly logger: Logger;
	readonly repos: Repos;
	/** warren-6234: the seed-close consumer closes through the tracker seam. */
	readonly issueTracker: IssueTracker;
	/** Broker so the seed-close observability event reaches live tailers too. */
	readonly broker?: RunEventBroker;

	/**
	 * Boot-resolved forge (warren-3bc6). When present, the merge watcher
	 * subscribes to post_reap and settles each run's `pr_state` /
	 * `pr_merged_at`; when absent (tests), no watcher is registered.
	 */
	readonly forge?: Forge;
}

export interface LifecycleBusHandle {
	readonly bus: LifecycleBus;
	/**
	 * The global lifecycle notification broker (warren-f566) serving
	 * `GET /events/stream`, built here and fed by a bus extension in the
	 * batch below. The orchestrator threads the same instance onto
	 * `ServerDeps`.
	 */
	readonly lifecycleStream: LifecycleStreamBroker;
	/** Detach every registered consumer and uninstall the process singleton. */
	stop(): void;
}

/**
 * Boot the observe-only lifecycle bus, register the first-party
 * consumers, and install it as the process singleton. Returns a handle
 * whose `stop()` unwinds the registrations and clears the singleton so a
 * teardown (or a test) leaves no global state behind.
 */
export function bootLifecycleBus(input: LifecycleBusWiringInput): LifecycleBusHandle {
	const { logger, repos, issueTracker, broker } = input;
	const lifecycleStream = new LifecycleStreamBroker();
	const bus = new LifecycleBus({
		onError: ({ extension, hook, runId, error }) => {
			logger.error(
				{ extension, hook, runId, reason: formatError(error) },
				"lifecycle.subscriber_error",
			);
		},
	});

	// warren-3bc6: consumer 3 is the merge watcher — it subscribes to
	// post_reap and polls the run's PR through the boot-resolved forge
	// until terminal, writing `pr_state` + `pr_merged_at` onto the run row.
	// On boot it re-adopts every run whose PR is still unresolved so a
	// restart never orphans an in-flight poll; `stop()` cancels the lot.
	const mergeWatcher =
		input.forge !== undefined
			? createPrMergeWatcher({
					repos,
					forge: input.forge,
					logger: {
						warn: (obj, msg) => logger.warn(obj, msg),
						error: (obj, msg) => logger.error(obj, msg),
					},
				})
			: undefined;

	const registration = registerExtensions(bus, [
		createHealerLifecycleExtension({
			logger: { info: (obj, msg) => logger.info(obj, msg) },
		}),
		createSeedCloseLifecycleExtension({
			repos,
			issueTracker,
			logger: { error: (obj, msg) => logger.error(obj, msg) },
			...(broker !== undefined ? { broker } : {}),
		}),
		...(mergeWatcher !== undefined ? [mergeWatcher.extension] : []),
		// warren-f566: consumer 4 is the global lifecycle stream broker —
		// it projects lifecycle envelopes into the slim notifications the
		// list pages consume over GET /events/stream.
		createLifecycleStreamExtension(lifecycleStream),
	]);

	if (mergeWatcher !== undefined) {
		readoptUnresolvedPrs(repos, logger, mergeWatcher);
	}

	installLifecycleBus(bus);
	logger.info({ extensions: bus.extensionNames() }, "lifecycle bus wired");

	return {
		bus,
		lifecycleStream,
		stop() {
			mergeWatcher?.stop();
			registration.unregisterAll();
			clearLifecycleBus();
		},
	};
}

/**
 * Boot re-adoption (warren-3bc6): every run with a `pr_url` whose
 * `pr_state` never settled gets its watch restarted, staggered one
 * initial interval per run so a fleet of stale open PRs fans out across
 * the backoff ladder instead of hammering the forge in one burst.
 * Fire-and-forget: a failed enumeration logs and moves on — the next
 * post_reap still adopts new PRs.
 */
function readoptUnresolvedPrs(
	repos: Repos,
	logger: Logger,
	watcher: ReturnType<typeof createPrMergeWatcher>,
): void {
	void repos.runs
		.listWithUnresolvedPr()
		.then((runs) => {
			let index = 0;
			for (const run of runs) {
				if (run.prUrl === null) continue;
				watcher.adopt(run.id, run.prUrl, index * DEFAULT_INITIAL_INTERVAL_MS);
				index += 1;
			}
			if (index > 0) logger.info({ adopted: index }, "pr_merge_watch.readopted");
		})
		.catch((error) => {
			logger.error({ reason: formatError(error) }, "pr_merge_watch.readopt_failed");
		});
}
