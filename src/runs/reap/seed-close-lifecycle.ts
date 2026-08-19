/**
 * Clone-side seed-close safety net as an observation-bus subscriber
 * (warren-df3e, pl-3a79 step 18).
 *
 * ## What moved, and why
 *
 * warren dispatches a run against a seed and expects the agent to `sd close` it
 * on success. The safety net closes it host-side even when the agent forgot:
 * `sd close` is idempotent, and the updated `issues.jsonl` in the project clone
 * becomes the next run's materialization source. This used to be a step inside
 * the reap success pipeline (`seedIdCloseStep`), one more feature the run loop
 * enumerated inline. It is NOT part of `provider.finalize` — it always ran
 * host-side against the project CLONE, after finalize's push — so it is exactly
 * the "genuinely bus-movable" piece: it observes a settled reap and reacts.
 *
 * It now subscribes to the Tier-1 `post_reap` hook (`../lifecycle-bus.ts`) and
 * registers through the bus's boot-time registration API — "removing it" is not
 * registering it, never surgery on the pipeline.
 *
 * ## Observe-only, within the frozen warren-ext/v1 contract (rule 6)
 *
 * The `post_reap` payload is observe-only and carries NO workspace path, seed
 * id, or clone path — and it is NOT widened for this consumer. The subscriber
 * resolves everything it needs from the control-plane's own state, keyed off the
 * payload's `runId` / `projectId`: the run row (its `seedId`), the project row
 * (its `localPath` clone + `hasSeeds`), and the boot-wired issue tracker (warren-6234: `tracker.closeIssue`). It gates on
 * the payload's `outcome === "succeeded"` (already folded past dropped-commit /
 * finalize-failed / provider-error flips by reap), `branchPushed`, and a positive
 * `commitsAhead`. Its tracker close mutates the tracker state (seeds: the clone); a `seeds.seed_id_closed` event
 * is appended to the run's stream for observability, best-effort.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { EventRow } from "../../db/schema.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import type { RunEventBroker } from "../events.ts";
import { type LifecycleExtension, WARREN_EXT_PROTOCOL } from "../lifecycle-bus.ts";
import { closeRunSeedId } from "./seeds.ts";

/** Minimal structured-logger surface the subscriber needs for best-effort failures. */
export interface SeedCloseObserverLogger {
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface SeedCloseLifecycleExtensionInput {
	readonly repos: Repos;
	/** warren-6234: the close runs through the IssueTracker seam. */
	readonly issueTracker: IssueTracker;
	readonly logger: SeedCloseObserverLogger;
	/** Optional broker so the observability event reaches live tailers too. */
	readonly broker?: RunEventBroker;
	/** Injectable clock for the appended event timestamp (tests). */
	readonly now?: () => Date;
}

/**
 * Build the clone-side seed-close observe-only lifecycle extension. Register it
 * via `registerExtensions(bus, [createSeedCloseLifecycleExtension({ … })])` at
 * boot. The handshake protocol is stamped so the bus rejects a version mismatch.
 */
export function createSeedCloseLifecycleExtension(
	input: SeedCloseLifecycleExtensionInput,
): LifecycleExtension {
	const now = input.now ?? (() => new Date());
	return {
		name: "seed-close",
		protocol: WARREN_EXT_PROTOCOL,
		hooks: {
			post_reap: async (envelope) => {
				const { payload } = envelope;
				// Capability, not conditional (rule 7): this hook IS "close the run's
				// seed after a clean reap that pushed at least one commit." `outcome`
				// already accounts for reap's flips-to-failed.
				if (
					payload.outcome !== "succeeded" ||
					!payload.branchPushed ||
					payload.commitsAhead === null ||
					payload.commitsAhead <= 0
				) {
					return;
				}
				await closeSeedForReap(input, now, payload.runId, payload.projectId);
			},
		},
	};
}

/** Resolve the run/project/clone and run the idempotent host-side close. */
async function closeSeedForReap(
	input: SeedCloseLifecycleExtensionInput,
	now: () => Date,
	runId: string,
	projectId: string,
): Promise<void> {
	const run = await input.repos.runs.get(runId);
	if (run === null || run.seedId === null) return;
	const project = projectId === "" ? null : await input.repos.projects.get(projectId);
	if (project === null || !project.hasSeeds) return;

	const emit = makeRunEventEmitter(input, now, runId);
	try {
		await closeRunSeedId({
			seedId: run.seedId,
			projectId: project.id,
			projectPath: project.localPath,
			issueTracker: input.issueTracker,
			emit,
		});
	} catch (err) {
		input.logger.error(
			{ runId, seedId: run.seedId, reason: err instanceof Error ? err.message : String(err) },
			"seed-close.failed",
		);
	}
}

/**
 * An `emit` closure that appends a run event with a fresh monotonic seq and
 * publishes it to the broker (best-effort). Post-reap the broker may already be
 * closed for the run; the append still persists the observability row.
 */
function makeRunEventEmitter(
	input: SeedCloseLifecycleExtensionInput,
	now: () => Date,
	runId: string,
): (kind: string, payload: unknown) => Promise<EventRow> {
	return async (kind, payload) => {
		const maxSeq = (await input.repos.events.maxSeqForRun(runId)) ?? 0;
		const row = await input.repos.events.append({
			runId,
			sandboxEventSeq: maxSeq + 1,
			ts: now().toISOString(),
			kind,
			stream: "system",
			payload,
		});
		input.broker?.publish(runId, row);
		return row;
	};
}
