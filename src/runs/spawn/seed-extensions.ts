/**
 * Post-dispatch seed extension write (pl-bb70 step 4, warren-46cd).
 * Extracted from the legacy `src/runs/spawn.ts` under warren-f71c /
 * pl-9088 step 6.
 *
 * Merges warren-namespaced keys (`role`, `trigger`, `lastRunId`,
 * `lastRunAt`) onto a seed's `extensions` after the run is dispatched.
 * Failures emit a `seeds_extension_write_failed` system event and are
 * swallowed — the dispatch already succeeded; rolling back over a
 * stale seed extension would be worse than the operator fixing it
 * manually.
 */

import { formatError } from "../../core/errors.ts";
import type { Repos } from "../../db/repos/index.ts";
import {
	type SeedsCliDeps,
	updateExtensions,
	type WarrenExtensions,
	WarrenTriggerKind,
} from "../../seeds-cli/index.ts";

export interface WriteSeedExtensionsInput {
	readonly repos: Repos;
	readonly seedsCli: SeedsCliDeps;
	readonly projectPath: string;
	readonly seedId: string;
	readonly runId: string;
	readonly agentName: string;
	readonly trigger?: string;
	readonly now: Date;
}

/**
 * Merge warren-namespaced keys onto a seed's `extensions` after the
 * run is dispatched. Trigger strings that don't match
 * `WarrenTriggerKind` (e.g. the legacy `manual-trigger` used by
 * `POST /projects/:id/triggers/:triggerId/run`) are dropped from the
 * payload rather than rejected — the strict schema would otherwise
 * fail the whole merge and lose `role` / `lastRunId` / `lastRunAt` too.
 */
export async function writeSeedExtensions(input: WriteSeedExtensionsInput): Promise<void> {
	const triggerParse = WarrenTriggerKind.safeParse(input.trigger ?? "manual");
	const payload: WarrenExtensions = {
		role: input.agentName,
		lastRunId: input.runId,
		lastRunAt: input.now.toISOString(),
		...(triggerParse.success ? { trigger: triggerParse.data } : {}),
	};
	try {
		await updateExtensions(input.seedsCli, input.projectPath, input.seedId, payload);
	} catch (err) {
		await recordExtensionWriteFailure(
			input.repos,
			input.runId,
			input.seedId,
			formatError(err),
			input.now,
		);
	}
}

async function recordExtensionWriteFailure(
	repos: Repos,
	runId: string,
	seedId: string,
	reason: string,
	now: Date,
): Promise<void> {
	try {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: now.toISOString(),
			kind: "seeds_extension_write_failed",
			stream: "system",
			payload: { seedId, reason },
		});
	} catch {
		// Event write failed too — db handle is gone or the run row was
		// finalized in a race. Nothing left to surface; rolling back the
		// dispatch over a logging failure is unambiguously worse.
	}
}
