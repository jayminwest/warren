/**
 * `PlotAttacher` — Plot attach/detach seam for
 * `POST /plots/:id/attachments` and `DELETE /plots/:id/attachments/:ref`
 * (warren-589c / pl-9d6a step 11).
 *
 * Mirrors the `PlotCreator` / `PlotIntentEditor` / `PlotStatusChanger`
 * shape (one interface + `defaultPlotAttacher` production impl +
 * `ServerDeps.plotAttacher` test seam) so handlers can stay disk-free
 * in unit tests.
 *
 * The attacher opens a `UserPlotClient` against the project's `.plot/`,
 * calls `PlotHandle.attach` / `PlotHandle.detach`, and snapshots the
 * resulting Plot + event log to build the wire envelope. The compile-
 * time ACL guard on `UserPlotClient` (mx-bd4d67) makes the agent-actor
 * mistake unreachable from this code path — `detach` does not exist
 * on `AgentPlotHandle`, and `attach` is allowed on both but warren
 * routes attach-mutating handlers through `UserPlotClient` for SPEC §6
 * consistency with intent/status writes.
 *
 * Like `defaultPlotIntentEditor` and `defaultPlotStatusChanger`, this
 * surface is NOT fire-and-log: the user is waiting on the result, so
 * failure must surface synchronously as the HTTP response.
 *
 * DELETE-by-ref: `@os-eco/plot-cli`'s `detach` is keyed by attachment
 * id (`att-NNN`), but the wire contract on warren is keyed by the
 * external `ref` (the seed body — "DELETE detaches by ref"). The
 * attacher reads the current Plot, walks `attachments[]` for the
 * matching ref, and detaches that attachment id. When the ref does
 * not match any current attachment we surface
 * `PlotAttachmentNotFoundError`. Multiple matches on the same ref are
 * disambiguated by detaching the first (oldest) match — same Plot
 * lib's ref shape is `string` so multi-attachments are uncommon, and
 * UI-level callers always know the specific attachment they're
 * deleting because they just rendered the list.
 */

import type {
	Attachment,
	AttachmentType,
	Intent,
	Plot,
	PlotEvent,
	PlotStatus,
} from "@os-eco/plot-cli";
import { type PlotProjectionSink, UserPlotClient } from "../plot-client/index.ts";
import { PlotAttachmentNotFoundError } from "./errors.ts";

export interface AttachPlotRequest {
	/** Absolute path to the project's `.plot/` directory. */
	readonly plotDir: string;
	/** Target Plot id (`pt-xxxxxxxx`). */
	readonly plotId: string;
	/** Resolved dispatcher handle (already passed through `resolveDispatcherHandle`). */
	readonly handle: string;
	/** Attachment kind — already narrowed to `AttachmentType` at the handler edge. */
	readonly kind: AttachmentType;
	/** External reference (seeds issue id, mulch record id, etc.) — already shape-validated at the handler edge. */
	readonly ref: string;
	/** Optional role override; defaults to `"tracks"` when omitted. */
	readonly role?: string;
	/** Optional read-cache upsert seam (warren-7b60). */
	readonly projection?: PlotProjectionSink;
}

export interface DetachPlotRequest {
	readonly plotDir: string;
	readonly plotId: string;
	readonly handle: string;
	/** External reference of the attachment to remove (NOT the att-NNN id). */
	readonly ref: string;
	/** Optional read-cache upsert seam (warren-7b60). */
	readonly projection?: PlotProjectionSink;
}

/**
 * Per-project subset of `PlotEnvelope` — the handler stitches
 * `project_id` on top to build the full wire shape.
 *
 * Identical shape to `EditPlotIntentResult` / `defaultPlotReader`'s
 * `ReadPlotResult` so the UI can reuse one envelope renderer across
 * read / intent / attach / detach.
 */
export interface AttachPlotResult {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly intent: Intent;
	readonly attachments: readonly Attachment[];
	readonly event_log: readonly PlotEvent[];
	/** The freshly added attachment — surfaced for optimistic UI. */
	readonly attachment: Attachment;
}

export interface DetachPlotResult {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly intent: Intent;
	readonly attachments: readonly Attachment[];
	readonly event_log: readonly PlotEvent[];
	/** The id of the attachment that was removed. */
	readonly removed_id: string;
}

export interface PlotAttacher {
	attach(input: AttachPlotRequest): Promise<AttachPlotResult>;
	detach(input: DetachPlotRequest): Promise<DetachPlotResult>;
}

/**
 * Production `PlotAttacher`. Opens a `UserPlotClient`, performs the
 * attach/detach via the typed handle, then snapshots the fresh Plot +
 * event log to build the per-project envelope subset.
 *
 * Detach sequencing: the read happens BEFORE `detach` so we can map
 * the external `ref` to the lib's `att-NNN` id. A racy concurrent
 * removal between our read and write surfaces as a generic
 * lib-side error and propagates as 500; the handler treats this as
 * acceptable since the UI will re-fetch on the next polling tick and
 * see the consistent state.
 */
export const defaultPlotAttacher: PlotAttacher = {
	async attach(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
			projection: input.projection,
		});
		try {
			const handle = client.get(input.plotId);
			const attachment = await handle.attach({
				type: input.kind,
				ref: input.ref,
				role: input.role ?? "tracks",
			});
			const [plot, events] = await Promise.all([handle.read(), handle.events()]);
			return toAttachResult(plot, events, attachment);
		} finally {
			client.close();
		}
	},

	async detach(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
			projection: input.projection,
		});
		try {
			const handle = client.get(input.plotId);
			const current = await handle.read();
			const target = current.attachments.find((a) => a.ref === input.ref);
			if (target === undefined) {
				throw new PlotAttachmentNotFoundError(
					`plot ${input.plotId} has no attachment with ref '${input.ref}'`,
					{
						recoveryHint:
							"check the ref against the Plot's current attachments[] — the attachment may have already been removed",
					},
				);
			}
			await handle.detach(target.id);
			const [plot, events] = await Promise.all([handle.read(), handle.events()]);
			return toDetachResult(plot, events, target.id);
		} finally {
			client.close();
		}
	},
};

function toAttachResult(
	plot: Plot,
	events: readonly PlotEvent[],
	attachment: Attachment,
): AttachPlotResult {
	return {
		id: plot.id,
		name: plot.name,
		status: plot.status,
		intent: plot.intent,
		attachments: plot.attachments,
		event_log: sortEvents(events),
		attachment,
	};
}

function toDetachResult(
	plot: Plot,
	events: readonly PlotEvent[],
	removedId: string,
): DetachPlotResult {
	return {
		id: plot.id,
		name: plot.name,
		status: plot.status,
		intent: plot.intent,
		attachments: plot.attachments,
		event_log: sortEvents(events),
		removed_id: removedId,
	};
}

function sortEvents(events: readonly PlotEvent[]): PlotEvent[] {
	return [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
