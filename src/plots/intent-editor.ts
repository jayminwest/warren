/**
 * `PlotIntentEditor` — Plot intent-edit seam for `POST /plots/:id/intent`
 * (warren-896f / pl-9d6a step 9).
 *
 * Mirrors the `PlotCreator` / `PlotReader` shape (one-method interface +
 * `defaultPlotIntentEditor` production impl + `ServerDeps.plotIntentEditor`
 * test seam) so the handler can stay disk-free in unit tests.
 *
 * The editor opens a `UserPlotClient` against the project's `.plot/`,
 * reads the current Plot to enforce SPEC §6's "intent is frozen at done"
 * rule (extended to `archived` per the seed body), applies the patch via
 * `PlotHandle.editIntent`, snapshots the resulting Plot + event log, and
 * returns the per-project envelope subset. The handler stitches
 * `project_id` on top to build the wire shape.
 *
 * Unlike `defaultPlanRunPlotAppender` this surface is NOT fire-and-log:
 * the user is waiting on the result of an intent edit, so failure must
 * surface synchronously as the HTTP response (see seed body — "Fire-and-log
 * is NOT applied here — intent edits are user-driven and the user is
 * waiting on the result; surface failures synchronously").
 *
 * The compile-time ACL guard on `UserPlotClient` (mx-bd4d67) makes the
 * agent-actor mistake unreachable from this code path — `editIntent`
 * does not exist on `AgentPlotHandle`, so threading the actor kind via
 * the typed client class is the SPEC §6 ACL guarantee.
 */

import type { Attachment, Intent, Plot, PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import { UserPlotClient } from "../plot-client/index.ts";
import { PlotIntentFrozenError } from "./errors.ts";

/**
 * Partial intent body accepted on `POST /plots/:id/intent`. Same shape
 * as `CreatePlotIntentPatch` (kept independent so the two endpoints can
 * diverge later without breaking the other's wire contract).
 */
export interface EditPlotIntentPatch {
	readonly goal?: string;
	readonly non_goals?: readonly string[];
	readonly constraints?: readonly string[];
	readonly success_criteria?: readonly string[];
}

export interface EditPlotIntentRequest {
	/** Absolute path to the project's `.plot/` directory. */
	readonly plotDir: string;
	/** Target Plot id (`pt-xxxxxxxx`). */
	readonly plotId: string;
	/** Resolved dispatcher handle (already passed through `resolveDispatcherHandle`). */
	readonly handle: string;
	/** Intent patch — at least one field is expected, but an empty patch is a no-op. */
	readonly patch: EditPlotIntentPatch;
}

/**
 * Per-project subset of `PlotEnvelope`. The handler adds `project_id`
 * from the resolved `ProjectRow` to build the full wire shape — same
 * pattern as `defaultPlotReader.read`.
 */
export interface EditPlotIntentResult {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly intent: Intent;
	readonly attachments: readonly Attachment[];
	readonly event_log: readonly PlotEvent[];
}

export interface PlotIntentEditor {
	edit(input: EditPlotIntentRequest): Promise<EditPlotIntentResult>;
}

/**
 * Production `PlotIntentEditor`. Opens a `UserPlotClient`, reads the
 * current Plot to enforce the frozen-at-done invariant, applies the
 * patch via `editIntent`, then snapshots the fresh Plot + event log
 * under the same open-close lifecycle.
 *
 * Status check sequencing: the read happens BEFORE the call to
 * `editIntent`. The `@os-eco/plot-cli` library does not gate intent
 * edits on status — warren owns this rule per SPEC §6. A racy concurrent
 * `setStatus → done` between our read and write is acceptable here: the
 * lib's per-Plot transact serializes inside a single process and the
 * UI's optimistic flow re-fetches on every event anyway. The handler
 * surfaces the typed error synchronously so the UI can disable the
 * intent panel and prompt the user.
 */
export const defaultPlotIntentEditor: PlotIntentEditor = {
	async edit(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
		});
		try {
			const handle = client.get(input.plotId);
			const current = await handle.read();
			assertIntentMutable(current);
			await handle.editIntent(toEditIntentPatch(input.patch));
			const [plot, events] = await Promise.all([handle.read(), handle.events()]);
			return toResult(plot, events);
		} finally {
			client.close();
		}
	},
};

/**
 * Throw `PlotIntentFrozenError` when the Plot's status forbids further
 * intent edits. Exported for unit-test reuse so the assertion shape
 * stays anchored to one spot.
 */
export function assertIntentMutable(plot: Plot): void {
	if (plot.status === "done" || plot.status === "archived") {
		throw new PlotIntentFrozenError(
			`plot ${plot.id} is ${plot.status}; intent is frozen per SPEC §6`,
			{
				recoveryHint:
					"intent edits are not permitted after the Plot transitions to done or archived; reopen the Plot via a status transition if further intent changes are needed",
			},
		);
	}
}

function toEditIntentPatch(patch: EditPlotIntentPatch): {
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

function toResult(plot: Plot, events: readonly PlotEvent[]): EditPlotIntentResult {
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
