/**
 * Post-dispatch seed extension write (pl-bb70 step 4, warren-46cd).
 * Extracted from the legacy `src/runs/spawn.ts` under warren-f71c /
 * pl-9088 step 6.
 *
 * Merges warren-namespaced keys (`role`, `trigger`, `lastRunId`,
 * `lastRunAt`) onto the issue's tracker metadata after the run is
 * dispatched — routed through the IssueTracker seam's
 * `mergeIssueMetadata` (warren-6234). Seeds semantics ARE the contract:
 * shallow merge, `null` clears.
 *
 * When the tracker does not declare `supportsMetadata`, the write is
 * skipped with a debug log — a hosted tracker without metadata support
 * must not fail the dispatch over provenance bookkeeping.
 *
 * Failures emit a `seeds_extension_write_failed` system event and are
 * swallowed — the dispatch already succeeded; rolling back over a
 * stale extension would be worse than the operator fixing it
 * manually.
 */

import { formatError } from "../../core/errors.ts";
import { normalizeRunTriggerKind } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type {
	IssueTracker,
	MetadataCapableTracker,
	TrackerContext,
} from "../../tracker/contract.ts";
import { SeedsTracker } from "../../tracker/seeds-tracker.ts";
import type { SpawnLogger } from "./types.ts";

/**
 * warren-6234: resolve the tracker the post-dispatch write goes through.
 * The boot-resolved `issueTracker` wins; a caller still on the legacy
 * `seedsCli` field (plan-runs domain port pending, warren-2d98) gets it
 * wrapped in a SeedsTracker so the write is not silently dropped.
 * Neither wired → undefined → no write.
 */
export function resolveSeedTracker(
	issueTracker: (IssueTracker & Partial<MetadataCapableTracker>) | undefined,
	seedsCli: SeedsCliDeps | undefined,
): (IssueTracker & Partial<MetadataCapableTracker>) | undefined {
	return issueTracker ?? (seedsCli !== undefined ? new SeedsTracker(seedsCli) : undefined);
}

/** System-event kind emitted when a trigger string is outside the vocabulary. */
export const UNKNOWN_TRIGGER_EVENT = "seeds_trigger_kind_unknown";

export interface WriteSeedExtensionsInput {
	readonly repos: Repos;
	/**
	 * warren-6234: the write runs through the IssueTracker seam. The merge
	 * arm is optional on the type — the `supportsMetadata` flag gates it.
	 */
	readonly issueTracker: IssueTracker & Partial<MetadataCapableTracker>;
	readonly projectId: string;
	readonly projectPath: string;
	readonly seedId: string;
	readonly runId: string;
	readonly agentName: string;
	readonly trigger?: string;
	readonly now: Date;
	readonly logger?: SpawnLogger;
}

/**
 * Merge warren-namespaced keys onto the issue's tracker metadata after
 * the run is dispatched. The trigger is resolved through
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
	if (!input.issueTracker.capabilities.supportsMetadata) {
		// warren-6234: no metadata capability — skip with a debug log rather
		// than failing a dispatch that already succeeded.
		input.logger?.debug?.(
			{ event: "seeds.metadata_unsupported", seed_id: input.seedId, run_id: input.runId },
			"tracker does not support metadata writes; skipping post-dispatch extension write",
		);
		return;
	}
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
	const payload: Record<string, unknown> = {
		role: input.agentName,
		lastRunId: input.runId,
		lastRunAt: input.now.toISOString(),
		...(trigger !== undefined ? { trigger } : {}),
	};
	const ctx: TrackerContext = { projectId: input.projectId, localPath: input.projectPath };
	try {
		await input.issueTracker.mergeIssueMetadata?.(ctx, input.seedId, payload);
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
			sandboxEventSeq: seq,
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
