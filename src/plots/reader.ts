/**
 * `PlotReader` — full-envelope Plot read seam for `GET /plots/:id`
 * (warren-961e / pl-9d6a step 8).
 *
 * Mirrors the `PlotCreator` shape (one-method interface +
 * `defaultPlotReader` production impl + `ServerDeps.plotReader` test
 * seam) so the handler can stay disk-free in unit tests. Unlike the
 * creator this surface is read-only — no `editIntent` / `setStatus` /
 * `attach` / `detach`. Per-Plot mutation handlers in later pl-9d6a
 * steps add their own seams.
 *
 * The envelope shape matches the seed body verbatim:
 *   `{ id, name, status, intent, attachments[], event_log[], project_id }`
 * — `project_id` is added by the handler from the resolved `ProjectRow`;
 * the rest comes from the underlying Plot + its event log.
 *
 * Event ordering: events are returned in ascending `at` (ISO 8601)
 * order. The Plot library writes the event log as JSONL append-only so
 * natural read order is already ascending, but the reader sorts
 * defensively so the wire contract doesn't depend on internal layout.
 */

import type { Attachment, Intent, Plot, PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import { UserPlotClient } from "../plot-client/index.ts";

export interface PlotEnvelope {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly intent: Intent;
	readonly attachments: readonly Attachment[];
	readonly event_log: readonly PlotEvent[];
	readonly project_id: string;
}

export interface ReadPlotRequest {
	/** Absolute path to the project's `.plot/` directory. */
	readonly plotDir: string;
	/** Target Plot id (`plot-xxxxxxxx`). */
	readonly plotId: string;
}

/**
 * Per-project subset of `PlotEnvelope` — the handler stitches
 * `project_id` on top from the resolved `ProjectRow`.
 */
export interface ReadPlotResult {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly intent: Intent;
	readonly attachments: readonly Attachment[];
	readonly event_log: readonly PlotEvent[];
}

export interface PlotReader {
	read(input: ReadPlotRequest): Promise<ReadPlotResult>;
}

/**
 * Production `PlotReader`. Opens a `UserPlotClient` against
 * `<project>/.plot/`, asks the store for the named Plot's handle,
 * snapshots `read()` + `events()` in parallel, then closes the index.
 *
 * The actor is fixed to `user:operator` — `GET /plots/:id` is a pure
 * read so no writes happen through this client; the actor only flows
 * into events the handle could append (none, here). Per-Plot mutation
 * handlers landing later in pl-9d6a use `resolveDispatcherHandle`
 * (mx-6a9788) to thread a real handle through to writes.
 */
export const defaultPlotReader: PlotReader = {
	async read(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: "operator", raw: "user:operator" },
		});
		try {
			const handle = client.get(input.plotId);
			const [plot, events] = await Promise.all([handle.read(), handle.events()]);
			return toResult(plot, events);
		} finally {
			client.close();
		}
	},
};

function toResult(plot: Plot, events: readonly PlotEvent[]): ReadPlotResult {
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
