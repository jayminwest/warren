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
import { normalizeRunTriggerKind } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import {
	type SeedsCliDeps,
	updateExtensions,
	type WarrenExtensions,
} from "../../seeds-cli/index.ts";
import type { SpawnLogger } from "./types.ts";

/** System-event kind emitted when a trigger string is outside the vocabulary. */
export const UNKNOWN_TRIGGER_EVENT = "seeds_trigger_kind_unknown";

export interface WriteSeedExtensionsInput {
	readonly repos: Repos;
	readonly seedsCli: SeedsCliDeps;
	readonly projectPath: string;
	readonly seedId: string;
	readonly runId: string;
	readonly agentName: string;
	readonly trigger?: string;
	readonly now: Date;
	readonly logger?: SpawnLogger;
}

/**
 * Merge warren-namespaced keys onto a seed's `extensions` after the
 * run is dispatched. The trigger is resolved through
 * `normalizeRunTriggerKind` (`src/core/wire.ts`), which covers every kind
 * a live dispatcher passes plus the legacy `manual-trigger` alias.
 *
 * A string still outside that vocabulary is dropped from the payload
 * rather than rejected — the strict schema would otherwise fail the whole
 * merge and lose `role` / `lastRunId` / `lastRunAt` too — but the drop is
 * LOUD as of warren-c486: it logs a warning and appends a
 * `seeds_trigger_kind_unknown` system event on the run, so lost
 * provenance shows up instead of vanishing.
 */
export async function writeSeedExtensions(input: WriteSeedExtensionsInput): Promise<void> {
	const raw = input.trigger ?? "manual";
	const trigger = normalizeRunTriggerKind(raw);
	if (trigger === undefined) {
		input.logger?.warn?.(
			{ event: "seeds.trigger_kind_unknown", seed_id: input.seedId, trigger: raw },
			"seeds: unknown trigger kind, dropping seed trigger provenance",
		);
		await recordEvent(input.repos, input.runId, UNKNOWN_TRIGGER_EVENT, input.now, {
			seedId: input.seedId,
			trigger: raw,
		});
	}
	const payload: WarrenExtensions = {
		role: input.agentName,
		lastRunId: input.runId,
		lastRunAt: input.now.toISOString(),
		...(trigger !== undefined ? { trigger } : {}),
	};
	try {
		await updateExtensions(input.seedsCli, input.projectPath, input.seedId, payload);
	} catch (err) {
		await recordEvent(input.repos, input.runId, "seeds_extension_write_failed", input.now, {
			seedId: input.seedId,
			reason: formatError(err),
		});
	}
}

async function recordEvent(
	repos: Repos,
	runId: string,
	kind: string,
	now: Date,
	payload: Record<string, unknown>,
): Promise<void> {
	try {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: now.toISOString(),
			kind,
			stream: "system",
			payload,
		});
	} catch {
		// Event write failed too — db handle is gone or the run row was
		// finalized in a race. Nothing left to surface; rolling back the
		// dispatch over a logging failure is unambiguously worse.
	}
}
