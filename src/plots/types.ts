/**
 * Server-side Plot aggregation types (warren-7e85 / pl-9d6a step 1).
 *
 * `PlotSummary` is the row shape returned by `GET /plots` (warren-c167)
 * and the JSON body of `POST /plots` (warren-194e). It deliberately
 * carries only fields that are cheap to derive from a Plot read + the
 * tail of its event log — the full Plot envelope (intent body,
 * attachments[], event_log[]) lives behind `GET /plots/:id`
 * (warren-961e).
 *
 * The shape mirrors the cross-project list the Plots UI page renders
 * (warren-e3e6): one row per Plot across every project with
 * `hasPlot=true`, sortable by `last_event_ts` desc.
 */

import type { PlotStatus } from "@os-eco/plot-cli";

export interface PlotSummary {
	/** Plot id (`plot-xxxxxxxx`). Globally unique across projects in V1. */
	readonly id: string;
	/** Human-facing Plot name from the Plot file. */
	readonly name: string;
	/** Current Plot status — drives the status filter chip group in the UI. */
	readonly status: PlotStatus;
	/**
	 * First ~160 characters of `intent.goal`, with ellipsis when truncated.
	 * Empty string when the Plot has no goal yet (drafting phase). The full
	 * intent body lives behind `GET /plots/:id`.
	 */
	readonly intent_goal_preview: string;
	/** Number of attachments on the Plot (cheap aggregate; UI shows a chip). */
	readonly attachments_count: number;
	/**
	 * ISO 8601 timestamp of the most recent event in the Plot's event log,
	 * or the Plot's `updated_at` when the event log is empty (which would
	 * be unusual — `plot_created` is the first event — but defensive).
	 * Drives the default `last_event_ts desc` sort on the Plots page.
	 */
	readonly last_event_ts: string;
	/**
	 * Actor string of the most recent event (e.g. `user:alice` or
	 * `agent:claude-code:run_abc`), empty when the event log is empty.
	 */
	readonly last_event_actor: string;
	/** Warren project id (`prj_xxx`) the Plot lives in. */
	readonly project_id: string;
}

/**
 * Maximum characters of `intent.goal` surfaced in `intent_goal_preview`.
 * 160 keeps a one-line preview readable in the Plots table without
 * pulling the whole intent body into the list response.
 */
export const INTENT_GOAL_PREVIEW_MAX = 160;

/**
 * Truncate a goal string for the list-row preview.
 * Exported so the handler tests + the resolver tests share the contract.
 */
export function buildIntentGoalPreview(goal: string): string {
	const trimmed = goal.trim();
	if (trimmed.length <= INTENT_GOAL_PREVIEW_MAX) return trimmed;
	return `${trimmed.slice(0, INTENT_GOAL_PREVIEW_MAX - 1).trimEnd()}…`;
}
