/**
 * `run_dispatched` Plot append for the spawn flow (warren-e848 /
 * pl-2047 step 5). Extracted from the legacy `src/runs/spawn.ts` under
 * warren-f71c / pl-9088 step 6.
 *
 * Failure is fire-and-log: any thrown error is surfaced as a
 * `plot_run_dispatched_failed` system event on the run and swallowed.
 * The dispatch already succeeded by the time this runs, so rolling
 * back over a Plot-append failure would be unambiguously worse.
 */

import { formatError } from "../../core/errors.ts";
import type { Repos } from "../../db/repos/index.ts";
import { UserPlotClient } from "../../plot-client/index.ts";
import type { SpawnPlotAppender } from "./types.ts";

/**
 * Default user handle used for the `run_dispatched` Plot event when the
 * caller doesn't supply one. Warren has no first-class user-auth surface
 * today (pl-2047 risk #4); a fixed fallback keeps the Plot's event log
 * well-formed and matches the `user:<handle>` actor regex.
 */
export const DEFAULT_DISPATCHER_HANDLE = "operator";

/**
 * Actor segment regex copied from `@os-eco/plot-cli`'s actor.ts:
 * `[A-Za-z0-9][A-Za-z0-9_-]*`. A handle that fails this check is
 * downgraded to `DEFAULT_DISPATCHER_HANDLE` rather than throwing — the
 * append is fire-and-log, and a malformed operator-supplied handle
 * shouldn't be the reason a dispatch's Plot record is missing.
 */
const ACTOR_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Validate a caller-supplied dispatcher handle against Plot's actor segment
 * regex; downgrade malformed / empty input to `DEFAULT_DISPATCHER_HANDLE`
 * so the Plot append's `user:<handle>` actor is always well-formed.
 * Exported so the PlanRun handler (warren-b89f / pl-7937 step 4) can apply
 * the same sanitization before emitting `plan_run_dispatched`.
 */
export function resolveDispatcherHandle(input: string | undefined): string {
	const trimmed = (input ?? "").trim();
	if (trimmed === "") return DEFAULT_DISPATCHER_HANDLE;
	if (!ACTOR_SEGMENT_RE.test(trimmed)) return DEFAULT_DISPATCHER_HANDLE;
	return trimmed;
}

export function extractModel(frontmatter: Record<string, unknown>): string | null {
	const model = frontmatter.model;
	if (typeof model === "string" && model.length > 0) return model;
	return null;
}

export interface EmitRunDispatchedToPlotInput {
	readonly repos: Repos;
	readonly runId: string;
	readonly plotDir: string;
	readonly plotId: string;
	readonly handle: string;
	readonly agentName: string;
	readonly model: string | null;
	readonly projectId: string;
	readonly executionRepo?: string;
	readonly appender: SpawnPlotAppender;
	readonly now: Date;
}

/**
 * Append a `run_dispatched` event to the originating Plot's event log
 * (warren-e848). The seed acceptance requires the event to be present
 * "within one tick of a successful spawn"; the spawn already succeeded
 * by the time we get here, so failure is logged as
 * `plot_run_dispatched_failed` and swallowed — see the rationale on
 * `writeSeedExtensions` and pl-2f15 risk #4 for the same posture on the
 * seeds extension write.
 */
export async function emitRunDispatchedToPlot(input: EmitRunDispatchedToPlotInput): Promise<void> {
	try {
		await input.appender.appendRunDispatched({
			plotDir: input.plotDir,
			plotId: input.plotId,
			handle: input.handle,
			runId: input.runId,
			agentName: input.agentName,
			model: input.model,
			projectId: input.projectId,
			...(input.executionRepo !== undefined ? { executionRepo: input.executionRepo } : {}),
		});
	} catch (err) {
		await recordPlotAppendFailure(
			input.repos,
			input.runId,
			input.plotId,
			formatError(err),
			input.now,
		);
	}
}

async function recordPlotAppendFailure(
	repos: Repos,
	runId: string,
	plotId: string,
	reason: string,
	now: Date,
): Promise<void> {
	try {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts: now.toISOString(),
			kind: "plot_run_dispatched_failed",
			stream: "system",
			payload: { plotId, reason },
		});
	} catch {
		// Event write failed too — the db handle is gone or the run row was
		// finalized in a race. Same fall-through shape as
		// recordExtensionWriteFailure in ./seed-extensions.ts.
	}
}

/**
 * Default `SpawnPlotAppender`: opens a `UserPlotClient` against the
 * project's `.plot/` directory, appends the `run_dispatched` event, and
 * closes the SQLite index handle. On a first-attempt failure (the
 * documented seed case is a missing `.plot/.index.db` on the project's
 * first ever dispatch), `rebuildIndex` is invoked best-effort and the
 * append is retried once before the error propagates to
 * `recordPlotAppendFailure`.
 */
export const defaultPlotAppender: SpawnPlotAppender = {
	async appendRunDispatched(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
		});
		try {
			const plot = client.get(input.plotId);
			const data = {
				run_id: input.runId,
				agent: input.agentName,
				model: input.model,
				project: input.projectId,
				...(input.executionRepo !== undefined ? { execution_repo: input.executionRepo } : {}),
			};
			try {
				await plot.append({ type: "run_dispatched", data });
			} catch (err) {
				try {
					await client.rebuildIndex();
				} catch {
					// Rebuild is a best-effort recovery; if it fails we still
					// try the append once more so the original error wins.
				}
				try {
					await plot.append({ type: "run_dispatched", data });
				} catch {
					throw err;
				}
			}
		} finally {
			client.close();
		}
	},
};
