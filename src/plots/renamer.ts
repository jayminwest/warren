/**
 * `PlotRenamer` — Plot rename seam for `POST /plots/:id/rename`
 * (warren-bed0 / pl-b0c0 step 3).
 *
 * Mirrors the `PlotIntentEditor` shape (one-method interface +
 * `defaultPlotRenamer` production impl + `ServerDeps.plotRenamer`
 * test seam) so the handler can stay disk-free in unit tests.
 *
 * The renamer opens a `UserPlotClient` against the project's `.plot/`,
 * calls `UserPlotClient.rename`, then snapshots the resulting Plot +
 * event log and returns the per-project envelope subset. The handler
 * stitches `project_id` on top to build the wire shape.
 *
 * Unlike intent edits, Plot names are pure metadata — there is no
 * SPEC §6 "frozen at done" rule for the name. Renames are allowed in
 * every status (drafting/ready/active/done/archived). plot-cli v0.3
 * has no `plot_renamed` event type, so the rename writes a `note`
 * event recording the from→to transition.
 *
 * NOT fire-and-log: the user is waiting on the result of the rename,
 * so failure must surface synchronously as the HTTP response.
 */

import type { Attachment, Intent, Plot, PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import { UserPlotClient } from "../plot-client/index.ts";

export interface RenamePlotRequest {
	/** Absolute path to the project's `.plot/` directory. */
	readonly plotDir: string;
	/** Target Plot id (`pt-xxxxxxxx`). */
	readonly plotId: string;
	/** Resolved dispatcher handle (already passed through `resolveDispatcherHandle`). */
	readonly handle: string;
	/** New name. Trimmed; must be non-empty after trim. */
	readonly name: string;
}

/**
 * Per-project subset of `PlotEnvelope`. The handler adds `project_id`
 * from the resolved `ProjectRow` to build the full wire shape — same
 * pattern as `defaultPlotIntentEditor`.
 */
export interface RenamePlotResult {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly intent: Intent;
	readonly attachments: readonly Attachment[];
	readonly event_log: readonly PlotEvent[];
}

export interface PlotRenamer {
	rename(input: RenamePlotRequest): Promise<RenamePlotResult>;
}

/**
 * Production `PlotRenamer`. Opens a `UserPlotClient`, calls
 * `rename`, then re-reads the Plot + event log under the same
 * open-close lifecycle.
 */
export const defaultPlotRenamer: PlotRenamer = {
	async rename(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
		});
		try {
			await client.rename(input.plotId, input.name);
			const handle = client.get(input.plotId);
			const [plot, events] = await Promise.all([handle.read(), handle.events()]);
			return toResult(plot, events);
		} finally {
			client.close();
		}
	},
};

function toResult(plot: Plot, events: readonly PlotEvent[]): RenamePlotResult {
	const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	return {
		id: plot.id,
		name: plot.name,
		status: plot.status,
		intent: plot.intent,
		attachments: plot.attachments,
		event_log: sorted,
	};
}
