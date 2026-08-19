/**
 * Scheduled-issue pass for the R-06 tick. Extracted from `tick.ts`
 * (warren-1ec7) so `runProjectTick` stays under the cognitive-complexity
 * gate once the self-heal + notice-gate branches landed, and to keep
 * `tick.ts` under its file-size budget.
 *
 * warren-6234: the pass routes through the IssueTracker seam —
 * `tracker.listScheduledIssues` for the past-due scan and
 * `tracker.mergeIssueMetadata` for the post-fire write (shallow merge,
 * `null` clears). It is skipped when the tracker does not declare
 * `supportsScheduledIssues`; the post-fire write is additionally skipped
 * (debug log) without `supportsMetadata`. The tracker failure notice is
 * rate-limited through `TickDeps.noticeGate` (warren-1ec7): a project
 * without `.seeds/` ("Not in a seeds project") is a stable configuration
 * state, not a per-tick error.
 */

import { formatError } from "../core/errors.ts";
import type { ProjectRow } from "../db/schema.ts";
import type { WarrenExtensions } from "../seeds-cli/index.ts";
import type { TrackerContext } from "../tracker/contract.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import { type DispatchScheduledResult, dispatchScheduledSeed } from "./dispatch.ts";
import type { TickDeps, TickLogger } from "./tick.ts";

export interface RunScheduledSeedsPassInput {
	readonly deps: TickDeps;
	readonly project: ProjectRow;
	readonly config: LoadedWarrenConfig;
	readonly now: Date;
	readonly nowIso: string;
	readonly scheduled: DispatchScheduledResult[];
}

export async function runScheduledSeedsPass(input: RunScheduledSeedsPassInput): Promise<void> {
	const { deps, project, config, now, nowIso, scheduled } = input;

	// warren-6234: capability gate — a tracker without scheduled-issue
	// support has nothing for this pass to walk.
	const tracker = deps.issueTracker;
	if (tracker === undefined || !tracker.capabilities.supportsScheduledIssues) {
		deps.logger?.debug?.(
			{ projectId: project.id },
			"scheduler.scheduled_pass_skipped_no_capability",
		);
		return;
	}
	const ctx: TrackerContext = { projectId: project.id, localPath: project.localPath };

	const listScheduled = tracker.listScheduledIssues?.bind(tracker);
	if (listScheduled === undefined) return;
	let issues: Awaited<ReturnType<typeof listScheduled>>;
	try {
		issues = await listScheduled(ctx);
	} catch (err) {
		// pl-2f15 risk #4: tracker failures must not double-dispatch on the
		// next tick. We never wrote a warren-side row for these issues, so
		// retrying next tick is correct. warren-1ec7: gate the notice so a
		// stable configuration failure logs once per interval, not every tick.
		if (deps.noticeGate?.shouldNotify(`sd_list_failed:${project.id}`, now.getTime()) ?? true) {
			deps.logger?.warn(
				{ projectId: project.id, reason: formatError(err) },
				"scheduler.sd_list_failed",
			);
		}
		return;
	}
	// Recovered (or never broken) — let the next failure log immediately.
	deps.noticeGate?.clearNotice(`sd_list_failed:${project.id}`);

	for (const issue of issues) {
		const result = await dispatchScheduledSeed({
			projectId: project.id,
			seed: issue,
			defaults: config.defaults,
			now,
			spawn: deps.spawn,
		});
		scheduled.push(result);
		logScheduledResult(deps.logger, project.id, result);
		if (result.kind === "fired") {
			await clearFiredSeedExtension(deps, ctx, result, nowIso);
		}
	}
}

/**
 * Merge the post-fire metadata payload for a dispatched scheduled issue
 * (pl-bb70 step 5): one tracker merge carrying the scheduledFor clear +
 * lastScheduledRun pointer + the warren common keys. Risk #4 write-once —
 * the run row is authoritative, so a failed write only stamps a system event.
 */
async function clearFiredSeedExtension(
	deps: TickDeps,
	ctx: TrackerContext,
	result: Extract<DispatchScheduledResult, { kind: "fired" }>,
	nowIso: string,
): Promise<void> {
	// warren-6234: metadata capability gate — skip with a debug log; the
	// dispatched run row remains the authoritative fire record.
	if (deps.issueTracker === undefined || !deps.issueTracker.capabilities.supportsMetadata) {
		deps.logger?.debug?.(
			{ runId: result.runId, seedId: result.seedId },
			"scheduler.clear_scheduled_for_skipped_no_capability",
		);
		return;
	}
	const extensions: WarrenExtensions = {
		role: result.role,
		trigger: "scheduled",
		lastRunId: result.runId,
		lastRunAt: nowIso,
		scheduledFor: null,
		lastScheduledRun: result.runId,
	};
	try {
		await deps.issueTracker.mergeIssueMetadata?.(ctx, result.seedId, extensions);
	} catch (err) {
		await recordClearFailure(deps, result.runId, result.seedId, formatError(err));
	}
}

function logScheduledResult(
	logger: TickLogger | undefined,
	projectId: string,
	result: DispatchScheduledResult,
): void {
	if (result.kind === "fired") {
		logger?.info(
			{ projectId, seedId: result.seedId, runId: result.runId },
			"scheduler.scheduled_fired",
		);
	} else if (result.kind === "error") {
		logger?.warn(
			{ projectId, seedId: result.seedId, reason: result.reason },
			"scheduler.scheduled_failed",
		);
	}
}

async function recordClearFailure(
	deps: TickDeps,
	runId: string,
	seedId: string,
	reason: string,
): Promise<void> {
	try {
		const seq = ((await deps.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		const now = deps.now?.() ?? new Date();
		await deps.repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: now.toISOString(),
			kind: "trigger.cleared_extension_failed",
			stream: "system",
			payload: { seedId, reason },
		});
	} catch (err) {
		deps.logger?.error(
			{ runId, seedId, reason: formatError(err) },
			"scheduler.system_event_failed",
		);
	}
	deps.logger?.warn({ runId, seedId, reason }, "scheduler.clear_scheduled_for_failed");
}
