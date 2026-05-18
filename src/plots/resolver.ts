/**
 * `PlotResolver` — resolves the owning project for a given `plot_id`
 * (warren-7e85 / pl-9d6a step 1).
 *
 * Used by every per-Plot handler (`GET /plots/:id`,
 * `POST /plots/:id/intent` / `/status` / `/attachments` /
 * `/questions/:event_id/answer`) so the URL can stay project-agnostic.
 * V1 Plot IDs are globally unique (`plot-xxxxxxxx`) so the first
 * project whose index contains the ID is the owner.
 *
 * Resolution scans every `hasPlot=true` project in parallel via the
 * same per-project cache the aggregator owns (so two `GET /plots`
 * calls bracketing a `GET /plots/:id` within the 5s window do at most
 * one index read per project).
 *
 * Returns the owning `ProjectRow`, or `null` when no project's index
 * contains the id. Handlers translate `null` to a typed 404 — the
 * resolver itself stays library-shaped.
 */

import type { ProjectRow } from "../db/schema.ts";
import type { PlotAggregator } from "./aggregate.ts";

export interface PlotResolver {
	/**
	 * Find the project that owns `plotId`, or `null` when no
	 * `hasPlot=true` project's index contains it.
	 */
	resolve(plotId: string): Promise<ProjectRow | null>;
}

export interface PlotResolverOptions {
	readonly projectsRepo: { listAll(): Promise<ProjectRow[]> };
	/**
	 * Aggregator backing the per-project cache. The resolver calls
	 * `aggregator.listSummaries()` (no status filter) so it shares the
	 * same in-memory entries; an explicit cache hop would double the
	 * memory footprint without changing correctness.
	 */
	readonly aggregator: PlotAggregator;
}

export function createPlotResolver(opts: PlotResolverOptions): PlotResolver {
	return {
		async resolve(plotId) {
			if (plotId === "") return null;
			const summaries = await opts.aggregator.listSummaries();
			const owning = summaries.find((s) => s.id === plotId);
			if (owning === undefined) return null;
			const projects = await opts.projectsRepo.listAll();
			return projects.find((p) => p.id === owning.project_id) ?? null;
		},
	};
}
