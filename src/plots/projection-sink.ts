/**
 * `createPlotsProjectionSink` — binds a `PlotClient` read-cache upsert seam
 * (`PlotProjectionSink`, warren-7b60) to the `plots` projection table via
 * `PlotsRepo` (warren-9022 / LEVERET §0.0.A / §0.0.F).
 *
 * The `PlotClient` (src/plot-client/) owns no `project_id` and no DB handle
 * by design — it is a per-`.plot/` facade. This adapter closes that gap: a
 * caller that has resolved the owning project (`ProjectRow.id`) and holds a
 * `PlotsRepo` builds a sink here and threads it into the `PlotClient`. Every
 * read/write the client performs then refreshes the matching projection row
 * from freshly-read git state.
 *
 * The mapping is mechanical:
 *   - `id`         ← `plot.id` (PLOT_ID_REGEX, mx-28a262)
 *   - `projectId`  ← the project this sink is bound to (the Plot blob has no
 *                    `project_id`; it lives in warren's project record)
 *   - `status`     ← `plot.status`
 *   - `title`      ← `plot.name`
 *   - `updatedAt`  ← `plot.updated_at`
 *   - `state`      ← the whole Plot blob, mirrored verbatim into `state_json`
 *
 * Best-effort by contract (see `PlotProjectionSink`): the git read/write has
 * already committed by the time we run, so a projection failure must NOT
 * surface as an error on the originating operation — the row is rebuildable
 * from git. We swallow + log at `warn` instead of throwing.
 */

import type { Plot } from "@os-eco/plot-cli";
import type { PlotsRepo } from "../db/repos/plots.ts";
import type { PlotProjectionSink } from "../plot-client/index.ts";
import type { Logger } from "../server/types.ts";

export interface PlotsProjectionSinkOptions {
	readonly repo: PlotsRepo;
	/** Owning project id — the Plot blob does not carry it. */
	readonly projectId: string;
	/** Optional logger for best-effort failures; defaults to silent. */
	readonly logger?: Logger;
}

export function createPlotsProjectionSink(opts: PlotsProjectionSinkOptions): PlotProjectionSink {
	const { repo, projectId, logger } = opts;
	return {
		async upsert(plot: Plot): Promise<void> {
			try {
				await repo.upsert({
					id: plot.id,
					projectId,
					status: plot.status,
					title: plot.name,
					updatedAt: plot.updated_at,
					state: plot as unknown as Record<string, unknown>,
				});
			} catch (err) {
				logger?.warn(
					{ plotId: plot.id, projectId, err: err instanceof Error ? err.message : String(err) },
					"plots projection upsert failed; row will be stale until the next read/write or rebuild",
				);
			}
		},
	};
}
