/**
 * Scheduled-for seed pass for the R-06 tick. Extracted from `tick.ts`
 * (warren-1ec7) so `runProjectTick` stays under the cognitive-complexity
 * gate once the self-heal + notice-gate branches landed, and to keep
 * `tick.ts` under its file-size budget.
 *
 * Shells out for past-due `scheduledFor` seeds, dispatches each, and merges
 * the post-fire extension payload (pl-bb70 step 5). The `sd list` failure
 * notice is rate-limited through `TickDeps.noticeGate` (warren-1ec7): a
 * project without `.seeds/` ("Not in a seeds project") is a stable
 * configuration state, not a per-tick error.
 */

import { formatError } from "../core/errors.ts";
import type { ProjectRow } from "../db/schema.ts";
import type { WarrenExtensions } from "../seeds-cli/index.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import { type DispatchScheduledResult, dispatchScheduledSeed } from "./dispatch.ts";
import type { ListScheduledSeedsFn, TickDeps, TickLogger } from "./tick.ts";

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

	let seedsResult: Awaited<ReturnType<ListScheduledSeedsFn>>;
	try {
		seedsResult = await deps.listScheduledSeeds(project.localPath);
	} catch (err) {
		// pl-2f15 risk #4: shell-out failures must not double-dispatch on the
		// next tick. We never wrote a warren-side row for these seeds, so
		// retrying next tick is correct. warren-1ec7: gate the notice so a
		// project without `.seeds/` logs once per interval, not every tick.
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

	for (const err of seedsResult.errors) {
		deps.logger?.warn(
			{ projectId: project.id, seedId: err.seedId, reason: err.message },
			"scheduler.scheduled_for_parse_error",
		);
	}

	for (const seed of seedsResult.scheduled) {
		const result = await dispatchScheduledSeed({
			projectId: project.id,
			seed,
			defaults: config.defaults,
			now,
			spawn: deps.spawn,
		});
		scheduled.push(result);
		logScheduledResult(deps.logger, project.id, result);
		if (result.kind === "fired") {
			await clearFiredSeedExtension(deps, project, result, nowIso);
		}
	}
}

/**
 * Merge the post-fire extension payload for a dispatched scheduled seed
 * (pl-bb70 step 5): one sd update carrying scheduledFor clear +
 * lastScheduledRun pointer + the warren common keys. Risk #4 write-once —
 * the run row is authoritative, so a failed write only stamps a system event.
 */
async function clearFiredSeedExtension(
	deps: TickDeps,
	project: ProjectRow,
	result: Extract<DispatchScheduledResult, { kind: "fired" }>,
	nowIso: string,
): Promise<void> {
	const extensions: WarrenExtensions = {
		role: result.role,
		trigger: "scheduled",
		lastRunId: result.runId,
		lastRunAt: nowIso,
		scheduledFor: null,
		lastScheduledRun: result.runId,
	};
	try {
		await deps.updateExtensions(project.localPath, result.seedId, extensions);
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
