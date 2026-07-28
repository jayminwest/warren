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
 * "Removing the healer" is deleting its entry from the batch below —
 * not loading it — never surgery on the run loop.
 */

import { formatError } from "../../core/errors.ts";
import { createHealerLifecycleExtension } from "../../healer/lifecycle.ts";
import {
	clearLifecycleBus,
	installLifecycleBus,
	LifecycleBus,
	registerExtensions,
} from "../../runs/index.ts";
import type { Logger } from "../types.ts";

export interface LifecycleBusWiringInput {
	readonly logger: Logger;
}

export interface LifecycleBusHandle {
	readonly bus: LifecycleBus;
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
	const { logger } = input;
	const bus = new LifecycleBus({
		onError: ({ extension, hook, runId, error }) => {
			logger.error(
				{ extension, hook, runId, reason: formatError(error) },
				"lifecycle.subscriber_error",
			);
		},
	});

	const registration = registerExtensions(bus, [
		createHealerLifecycleExtension({
			logger: { info: (obj, msg) => logger.info(obj, msg) },
		}),
	]);

	installLifecycleBus(bus);
	logger.info({ extensions: bus.extensionNames() }, "lifecycle bus wired");

	return {
		bus,
		stop() {
			registration.unregisterAll();
			clearLifecycleBus();
		},
	};
}
