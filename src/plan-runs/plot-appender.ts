/**
 * `plan_run_dispatched` Plot append for PlanRun creation
 * (warren-b89f / pl-7937 step 4).
 *
 * Mirrors `defaultPlotAppender` in src/runs/spawn/plot-append.ts: opens a
 * `UserPlotClient` against `<project>/.plot/`, appends one event, retries
 * once after `rebuildIndex` on first-attempt failure, then closes. The
 * caller-side wrapper (`emitPlanRunDispatchedToPlot`) is fire-and-log —
 * `plan_run.plot_append_failed` lands on the logger and the POST /plan-runs
 * response is unaffected, mirroring the single-run posture (acceptance
 * criteria #5 on pl-7937).
 *
 * Unlike single-run, the warren event isn't a row in the `events` table:
 * `events` is keyed by `run_id`, and at PlanRun creation no child run
 * exists yet. Logger-level surfacing is consistent with the existing
 * `plan_run.cancel_child_failed` posture in handlers/plan-runs.ts.
 */

import { UserPlotClient } from "../plot-client/index.ts";
import type { Logger } from "../server/types.ts";

export interface AppendPlanRunDispatchedInput {
	readonly plotDir: string;
	readonly plotId: string;
	readonly handle: string;
	readonly planRunId: string;
	readonly planId: string;
	readonly childrenCount: number;
}

export interface PlanRunPlotAppender {
	appendPlanRunDispatched(input: AppendPlanRunDispatchedInput): Promise<void>;
}

/**
 * Default appender — opens a `UserPlotClient` against the project's `.plot/`,
 * appends `plan_run_dispatched`, and closes. On first-attempt failure
 * (typical case: missing `.plot/.index.db` on the project's first ever
 * PlanRun-to-Plot append), `rebuildIndex` is called best-effort and the
 * append is retried once before the original error propagates.
 */
export const defaultPlanRunPlotAppender: PlanRunPlotAppender = {
	async appendPlanRunDispatched(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
		});
		try {
			const plot = client.get(input.plotId);
			const data = {
				plan_run_id: input.planRunId,
				plan_id: input.planId,
				children_count: input.childrenCount,
			};
			try {
				await plot.append({ type: "plan_run_dispatched", data });
			} catch (err) {
				try {
					await client.rebuildIndex();
				} catch {
					// Rebuild is best-effort recovery; if it fails we still
					// try the append once more so the original error wins.
				}
				try {
					await plot.append({ type: "plan_run_dispatched", data });
				} catch {
					throw err;
				}
			}
		} finally {
			client.close();
		}
	},
};

export interface EmitPlanRunDispatchedInput {
	readonly appender: PlanRunPlotAppender;
	readonly logger: Logger;
	readonly plotDir: string;
	readonly plotId: string;
	readonly handle: string;
	readonly planRunId: string;
	readonly planId: string;
	readonly childrenCount: number;
}

/**
 * Best-effort wrapper: append the `plan_run_dispatched` event and log
 * `plan_run.plot_append_failed` on failure. The POST /plan-runs handler
 * calls this AFTER `repos.planRuns.create` returns, so a Plot-write
 * failure never produces a half-row state — the PlanRun is durably
 * persisted before we touch the Plot.
 */
export async function emitPlanRunDispatchedToPlot(
	input: EmitPlanRunDispatchedInput,
): Promise<void> {
	try {
		await input.appender.appendPlanRunDispatched({
			plotDir: input.plotDir,
			plotId: input.plotId,
			handle: input.handle,
			planRunId: input.planRunId,
			planId: input.planId,
			childrenCount: input.childrenCount,
		});
	} catch (err) {
		input.logger.warn(
			{
				planRunId: input.planRunId,
				plotId: input.plotId,
				err: err instanceof Error ? err.message : String(err),
			},
			"plan_run.plot_append_failed",
		);
	}
}
