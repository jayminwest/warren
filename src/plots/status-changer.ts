/**
 * `PlotStatusChanger` \u2014 Plot status-transition seam for
 * `POST /plots/:id/status` (warren-e868 / pl-9d6a step 10).
 *
 * Mirrors the `PlotCreator` / `PlotIntentEditor` / `PlotReader` shape
 * (one-method interface + `defaultPlotStatusChanger` production impl +
 * `ServerDeps.plotStatusChanger` test seam) so the handler can stay
 * disk-free in unit tests.
 *
 * The transition matrix below pins SPEC \u00a76.5 \u2014 the same whitelist the
 * `@os-eco/plot-cli` library enforces internally. Warren validates it at
 * the handler edge BEFORE opening a `UserPlotClient` so we never
 * construct an invalid transition; the library's own guard is defense
 * in depth (see seed body: \u201cvalidates the transition against SPEC \u00a76.5
 * whitelist BEFORE the library call \u2014 defense in depth \u2014 facade rejects
 * too but warren shouldn\u2019t construct invalid transitions\u201d).
 *
 * The compile-time ACL guard on `UserPlotClient` (mx-bd4d67) makes the
 * agent-actor mistake unreachable from this code path: `setStatus` does
 * not exist on `AgentPlotHandle`, so threading the actor kind via the
 * typed client class is the SPEC \u00a76 ACL guarantee. The handler test
 * pins this with a type-level assertion alongside the runtime matrix.
 *
 * Unlike `defaultPlanRunPlotAppender` this surface is NOT fire-and-log:
 * the user is waiting on the result of a status transition, so failure
 * must surface synchronously as the HTTP response.
 */

import type { Plot, PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import { type PlotProjectionSink, UserPlotClient } from "../plot-client/index.ts";
import { PlotIllegalStatusTransitionError } from "./errors.ts";
import { buildIntentGoalPreview } from "./types.ts";

/**
 * SPEC \u00a76.5 status transition whitelist. Each key is the current
 * status; the value is the set of legal next statuses.
 *
 *   - `drafting`  \u2192 `ready`, `archived`
 *   - `ready`     \u2192 `active`, `archived`
 *   - `active`    \u2192 `done`, `archived`
 *   - `done`      \u2192 `archived`
 *   - `archived`  \u2192 (terminal)
 *
 * No same-status self-transitions, no back-edges (drafting from ready
 * etc.). The `done`-only entry into `archived` matches the
 * \u201cintent is frozen at done\u201d invariant pinned in
 * `assertIntentMutable`: archived is the only legal exit from done.
 */
export const STATUS_TRANSITIONS: Readonly<Record<PlotStatus, readonly PlotStatus[]>> = {
	drafting: ["ready", "archived"],
	ready: ["active", "archived"],
	active: ["done", "archived"],
	done: ["archived"],
	archived: [],
};

export function isLegalStatusTransition(from: PlotStatus, to: PlotStatus): boolean {
	return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Throw `PlotIllegalStatusTransitionError` when `next` is not reachable
 * from `current` per `STATUS_TRANSITIONS`. Exported so the handler can
 * fire it at the request edge (before the library round-trip) and
 * unit-test reuse stays anchored to one spot.
 */
export function assertStatusTransitionAllowed(
	plotId: string,
	current: PlotStatus,
	next: PlotStatus,
): void {
	if (isLegalStatusTransition(current, next)) return;
	const allowed = STATUS_TRANSITIONS[current];
	const allowedHint =
		allowed.length === 0
			? `${current} is terminal; no further transitions are permitted`
			: `legal transitions from ${current}: ${allowed.join(", ")}`;
	throw new PlotIllegalStatusTransitionError(
		`plot ${plotId} cannot transition ${current} \u2192 ${next} per SPEC \u00a76.5`,
		{ recoveryHint: allowedHint },
	);
}

export interface ChangePlotStatusRequest {
	/** Absolute path to the project's `.plot/` directory. */
	readonly plotDir: string;
	/** Target Plot id (`pt-xxxxxxxx`). */
	readonly plotId: string;
	/** Resolved dispatcher handle (already passed through `resolveDispatcherHandle`). */
	readonly handle: string;
	/** Requested next status \u2014 already validated against `STATUS_TRANSITIONS` at the handler edge. */
	readonly next: PlotStatus;
	/** Optional read-cache upsert seam (warren-7b60). */
	readonly projection?: PlotProjectionSink;
}

/**
 * Per-project subset of the wire response. The handler stitches
 * `project_id` on top to build the full `PlotSummary` and returns the
 * accompanying `status_changed` event for optimistic UI.
 *
 * Field shape matches `CreatePlotResult` exactly so the UI can reuse
 * one summary-row renderer across create / status-change.
 */
export interface ChangePlotStatusResult {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly intent_goal_preview: string;
	readonly attachments_count: number;
	readonly last_event_ts: string;
	readonly last_event_actor: string;
	/**
	 * The `status_changed` event the library appended for this
	 * transition. Returned alongside the summary so the UI can splice
	 * it into the live event feed without waiting for the next
	 * polling tick.
	 */
	readonly event: PlotEvent;
}

export interface PlotStatusChanger {
	change(input: ChangePlotStatusRequest): Promise<ChangePlotStatusResult>;
}

/**
 * Production `PlotStatusChanger`. Opens a `UserPlotClient`, reads the
 * current Plot to confirm the transition is still legal under the
 * latest on-disk state (the handler-edge check uses the resolver cache,
 * which can lag a concurrent transition), calls `setStatus(next)`, then
 * snapshots the fresh Plot + event log under the same open-close
 * lifecycle to build the summary and find the emitted `status_changed`
 * event.
 *
 * Status check sequencing: the read happens BEFORE `setStatus`. This
 * is the same shape as `defaultPlotIntentEditor`'s frozen-at-done
 * check. The handler runs the SPEC \u00a76.5 whitelist FIRST (before
 * opening a client) using the resolver-cached status; this second read
 * inside the changer catches races between the cached check and the
 * actual write.
 */
export const defaultPlotStatusChanger: PlotStatusChanger = {
	async change(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
			projection: input.projection,
		});
		try {
			const handle = client.get(input.plotId);
			const current = await handle.read();
			assertStatusTransitionAllowed(input.plotId, current.status, input.next);
			await handle.setStatus(input.next);
			const [plot, events] = await Promise.all([handle.read(), handle.events()]);
			return toResult(plot, events, input.handle);
		} finally {
			client.close();
		}
	},
};

function toResult(
	plot: Plot,
	events: readonly PlotEvent[],
	fallbackHandle: string,
): ChangePlotStatusResult {
	const event = findStatusChangedEventFor(events, plot.status);
	const tail = events.length > 0 ? events[events.length - 1] : undefined;
	return {
		id: plot.id,
		name: plot.name,
		status: plot.status,
		intent_goal_preview: buildIntentGoalPreview(plot.intent.goal),
		attachments_count: plot.attachments.length,
		last_event_ts: tail?.at ?? plot.updated_at,
		last_event_actor: tail?.actor ?? `user:${fallbackHandle}`,
		event,
	};
}

/**
 * Walk the event log from the tail backward and return the most recent
 * `status_changed` event whose `data.to` matches the Plot's current
 * status. This deliberately doesn't trust positional order alone \u2014
 * concurrent `attach`/`question_*`/etc. events can follow the
 * transition before the read settles. Throws when no matching event is
 * found, which would indicate a library contract break.
 */
function findStatusChangedEventFor(events: readonly PlotEvent[], status: PlotStatus): PlotEvent {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev === undefined) continue;
		if (ev.type !== "status_changed") continue;
		const to = (ev.data as { to?: unknown }).to;
		if (to === status) return ev;
	}
	throw new Error(
		`plot status changer: no status_changed event found for status=${status} in event log`,
	);
}
