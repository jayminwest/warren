/**
 * Plot read-view HTTP handlers — `GET /plots/:id` and
 * `GET /plots/:id/summary` (warren-332b / pl-369d).
 *
 * Extracted from `src/server/handlers/plots.ts`. The resolve-project,
 * paused-runs, and envelope-assembly plumbing lives in `./shared.ts`.
 */

import { join } from "node:path";
import {
	defaultPlotReader,
	type PlotSummaryArtifact,
	summarizePlot,
} from "../../../plots/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { requireParam } from "../index.ts";
import { buildPlotEnvelope, loadPausedRunsForPlot, resolvePlotProject } from "./shared.ts";

/**
 * `GET /plots/:id` — full Plot envelope by id (warren-961e /
 * pl-9d6a step 8).
 *
 * Handler order:
 *   (1) resolve the owning project via `deps.plotResolver` (built on top
 *       of `plotAggregator`'s per-project cache so the typical UI flow —
 *       `GET /plots` followed by `GET /plots/:id` — does at most one index
 *       read per project within the 5s TTL). `null` → typed 404. When no
 *       resolver is wired (non-Plot deployment), the handler also returns
 *       404 so the empty-deployments contract stays stable. The
 *       defensive `hasPlot` re-check (`ProjectLacksPlotError` / 400) is
 *       folded into `resolvePlotProject`.
 *   (2) hand off to `deps.plotReader` (default `defaultPlotReader`),
 *       which opens a `UserPlotClient` against `<project>/.plot/`,
 *       snapshots `read()` + `events()` in parallel, and returns the
 *       per-project envelope subset. The handler stitches `project_id`
 *       on top to build the wire shape.
 *
 * `event_log` is returned in ascending `at` order — the reader sorts
 * defensively so the wire contract doesn't depend on the Plot
 * library's internal append order. The UI collapses long chains of
 * same-kind same-actor events client-side (see warren-bdbf).
 */
function getPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const project = await resolvePlotProject(deps, plotId, "read plot");

		const reader = deps.plotReader ?? defaultPlotReader;
		const result = await reader.read({
			plotDir: join(project.localPath, ".plot"),
			plotId,
		});

		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		return jsonResponse(200, buildPlotEnvelope(result, project.id, paused_runs));
	};
}

/**
 * `GET /plots/:id/summary` — curated artifact view (warren-8917 /
 * pl-0344 step 15). Same resolver + reader stack as `GET /plots/:id`,
 * but the response is the institutional-memory projection produced by
 * `summarizePlot`: formatted intent, decisions filtered by
 * `decision_made`, linked PRs (with merge audit trail) + commits, and
 * a curated structural timeline. Pure derivation — no extra IO beyond
 * the reader.
 */
function getPlotSummaryHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const project = await resolvePlotProject(deps, plotId, "read plot");
		const reader = deps.plotReader ?? defaultPlotReader;
		const result = await reader.read({
			plotDir: join(project.localPath, ".plot"),
			plotId,
		});
		const artifact: PlotSummaryArtifact = summarizePlot({
			id: result.id,
			name: result.name,
			status: result.status,
			project_id: project.id,
			intent: result.intent,
			attachments: result.attachments,
			event_log: result.event_log,
		});
		return jsonResponse(200, artifact);
	};
}

export { getPlotHandler, getPlotSummaryHandler };
