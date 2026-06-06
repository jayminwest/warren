/**
 * `PlotProjectionSink` — the read-cache upsert seam threaded through the
 * `PlotClient` read/write paths (warren-7b60 / LEVERET §0.0.A / §0.0.F).
 *
 * Background: the `plots` projection table (warren-9022) is a read-CACHE
 * that mirrors full git-backed Plot state (`.plot/<id>.json` +
 * `<id>.events.jsonl`). Git stays the source of truth; the projection only
 * exists to back list / index queries (`PlotsRepo.listByProject`, status
 * rollups) without fanning a `UserPlotClient` open across every project on
 * every request.
 *
 * To keep the cache current without a separate rebuild pass, the
 * `PlotClient` invokes a sink with the freshly-read Plot whenever it reads
 * or writes a Plot through the single facade write path. A `PlotClient`
 * constructed without a sink is a no-op on this axis — the projection only
 * lights up when a caller that knows the owning `project_id` + has a
 * `PlotsRepo` hands one in (see `createPlotsProjectionSink` in
 * `src/plots/projection-sink.ts`).
 *
 * Contract: implementations MUST be best-effort. The git write/read has
 * already committed by the time the sink runs, so a sink that throws would
 * surface a spurious error for an operation that actually succeeded — and
 * the row is fully rebuildable from git anyway. Swallow + log inside the
 * implementation rather than letting the throw escape; the `PlotClient`
 * awaits the sink (for deterministic ordering) but does not guard it.
 */

import type { Plot } from "@os-eco/plot-cli";

export interface PlotProjectionSink {
	/**
	 * Refresh the projection row for `plot` from freshly-read git state.
	 * Called after every read and every write through the `PlotClient`
	 * facade. Idempotent + last-writer-wins downstream (`PlotsRepo.upsert`).
	 * Implementations must not throw — see the module docstring.
	 */
	upsert(plot: Plot): void | Promise<void>;
}
