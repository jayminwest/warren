/**
 * `PlotCreator` — Plot creation seam for `POST /plots`
 * (warren-194e / pl-9d6a step 3).
 *
 * Wraps the `UserPlotClient` open → `create({name})` → optional
 * `editIntent` → close round-trip in a single testable surface so the
 * handler can stay disk-free in unit tests. Mirrors the
 * `PlanRunPlotAppender` (src/plan-runs/plot-appender.ts) shape — a
 * one-method interface with a `defaultPlotCreator` production impl and
 * a `ServerDeps.plotCreator` injection point for tests.
 *
 * Unlike `defaultPlanRunPlotAppender` this surface is NOT fire-and-log:
 * the user is waiting on the create result, so failure must surface
 * synchronously as the HTTP response (see seed body — "Failure to
 * create is hard-rejected (no fire-and-log here — the user is waiting
 * on the create result)"). The handler lets the error propagate.
 *
 * Returned shape is the per-project subset of `PlotSummary` (project_id
 * is added by the handler from the resolved `ProjectRow`). Reading the
 * fresh Plot + its event tail inside the creator keeps the
 * read-after-create coherent under the same open-close lifecycle —
 * splitting into "create" + "summarize" would either re-open the
 * client (extra index cost) or push the read concern into the handler
 * (leakier seam).
 */

import type { PlotStatus } from "@os-eco/plot-cli";
import { type PlotProjectionSink, UserPlotClient } from "../plot-client/index.ts";
import { buildIntentGoalPreview } from "./types.ts";

/**
 * Optional partial intent body accepted on `POST /plots`. Every field
 * is optional; omitted fields stay at the `PlotStore.create` defaults
 * (empty string / empty arrays).
 */
export interface CreatePlotIntentPatch {
	readonly goal?: string;
	readonly non_goals?: readonly string[];
	readonly constraints?: readonly string[];
	readonly success_criteria?: readonly string[];
}

export interface CreatePlotRequest {
	/** Absolute path to the project's `.plot/` directory. */
	readonly plotDir: string;
	/** Resolved dispatcher handle (already passed through `resolveDispatcherHandle`). */
	readonly handle: string;
	/** Plot name (`PlotStore.create` requires non-empty). */
	readonly name: string;
	/** Optional initial intent body — applied via `editIntent` post-create. */
	readonly intent?: CreatePlotIntentPatch;
	/**
	 * Optional read-cache upsert seam (warren-7b60). When supplied, the
	 * freshly-created Plot is written into the `plots` projection table.
	 * The handler builds it from `deps.repos.plots` + `project.id`.
	 */
	readonly projection?: PlotProjectionSink;
}

/**
 * Per-project subset of `PlotSummary` returned from the creator. The
 * handler adds `project_id` from the resolved `ProjectRow` to build the
 * full wire shape.
 */
export interface CreatePlotResult {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly intent_goal_preview: string;
	readonly attachments_count: number;
	readonly last_event_ts: string;
	readonly last_event_actor: string;
}

export interface PlotCreator {
	create(input: CreatePlotRequest): Promise<CreatePlotResult>;
}

/**
 * Production `PlotCreator`. Opens a `UserPlotClient` against the project's
 * `.plot/`, calls `create({name})`, optionally applies the intent patch,
 * snapshots the Plot + event tail to build the summary, then closes.
 *
 * No retry/rebuild dance — Plot creation always writes a fresh
 * `pl-<id>.json` + `.events.jsonl` pair and upserts the index inline
 * (see `@os-eco/plot-cli` `PlotStore.create`). If the create itself
 * fails (e.g. `.plot/` lacks write permission), the error propagates
 * to the handler and surfaces synchronously per seed contract.
 */
export const defaultPlotCreator: PlotCreator = {
	async create(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
			projection: input.projection,
		});
		try {
			const handle = await client.create({ name: input.name });
			if (input.intent !== undefined && hasIntentPatch(input.intent)) {
				await handle.editIntent(toEditIntentPatch(input.intent));
			}
			const [plot, events] = await Promise.all([handle.read(), handle.events()]);
			const tail = events.length > 0 ? events[events.length - 1] : undefined;
			return {
				id: plot.id,
				name: plot.name,
				status: plot.status,
				intent_goal_preview: buildIntentGoalPreview(plot.intent.goal),
				attachments_count: plot.attachments.length,
				last_event_ts: tail?.at ?? plot.updated_at,
				last_event_actor: tail?.actor ?? `user:${input.handle}`,
			};
		} finally {
			client.close();
		}
	},
};

function hasIntentPatch(patch: CreatePlotIntentPatch): boolean {
	if (patch.goal !== undefined && patch.goal.length > 0) return true;
	if (patch.non_goals !== undefined && patch.non_goals.length > 0) return true;
	if (patch.constraints !== undefined && patch.constraints.length > 0) return true;
	if (patch.success_criteria !== undefined && patch.success_criteria.length > 0) return true;
	return false;
}

function toEditIntentPatch(patch: CreatePlotIntentPatch): {
	goal?: string;
	non_goals?: string[];
	constraints?: string[];
	success_criteria?: string[];
} {
	return {
		...(patch.goal !== undefined ? { goal: patch.goal } : {}),
		...(patch.non_goals !== undefined ? { non_goals: [...patch.non_goals] } : {}),
		...(patch.constraints !== undefined ? { constraints: [...patch.constraints] } : {}),
		...(patch.success_criteria !== undefined
			? { success_criteria: [...patch.success_criteria] }
			: {}),
	};
}
