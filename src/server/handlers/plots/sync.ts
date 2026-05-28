/**
 * Sync Plot HTTP handlers and background tasks.
 *
 * Extracted from `src/server/handlers/plots.ts` (warren-3f46 / pl-3255 step 1).
 */

import { NotFoundError } from "../../../core/errors.ts";
import { ProjectLacksPlotError } from "../../../plan-runs/errors.ts";
import { defaultPlotSyncer } from "../../../plots/index.ts";
import { loadWarrenConfig } from "../../../warren-config/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { defaultSpawn, requireParam } from "../index.ts";

function triggerBackgroundSync(
	deps: ServerDeps,
	project: { id: string; localPath: string; gitUrl: string; defaultBranch: string },
	plotId: string,
): void {
	const syncer = deps.plotSyncer ?? defaultPlotSyncer;
	const token = deps.autoOpenPr?.token ?? "";
	void (async () => {
		const config =
			deps.warrenConfigs !== undefined
				? await deps.warrenConfigs.get(project.id, project.localPath)
				: await loadWarrenConfig({ projectPath: project.localPath });
		return syncer.sync({
			projectPath: project.localPath,
			gitUrl: project.gitUrl,
			defaultBranch: project.defaultBranch,
			token,
			handle: "warren",
			plotSyncConfig: config.defaults?.plotSync,
			spawn: deps.spawn ?? defaultSpawn,
			gitBinary: deps.projectsConfig.gitBinary,
		});
	})()
		.then((result) => {
			deps.logger.info({ projectId: project.id, plotId, result }, "background plot sync complete");
		})
		.catch((err) => {
			deps.logger.error(
				{
					projectId: project.id,
					plotId,
					error: err instanceof Error ? err.message : String(err),
				},
				"background plot sync failed",
			);
		});
}

function syncPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");

		const project =
			deps.plotResolver !== undefined ? await deps.plotResolver.resolve(plotId) : null;
		if (project === null) {
			throw new NotFoundError(`plot not found: ${plotId}`, {
				recoveryHint:
					"check the plot id; only Plots in projects with hasPlot=true are visible to warren",
			});
		}

		if (!project.hasPlot) {
			throw new ProjectLacksPlotError(
				`project ${project.id} no longer has a .plot/ directory; cannot sync plot ${plotId}`,
				{
					recoveryHint:
						"refresh the project so warren picks up the current .plot/ state, or recreate .plot/ via `plot init`",
				},
			);
		}

		const syncer = deps.plotSyncer ?? defaultPlotSyncer;
		const token = deps.autoOpenPr?.token ?? "";
		let plotSyncConfig: import("../../../warren-config/index.ts").PlotSyncConfig | undefined;
		try {
			const config =
				deps.warrenConfigs !== undefined
					? await deps.warrenConfigs.get(project.id, project.localPath)
					: await loadWarrenConfig({ projectPath: project.localPath });
			plotSyncConfig = config.defaults?.plotSync;
		} catch {
			// Config unavailable — proceed with defaults.
		}
		const result = await syncer.sync({
			projectPath: project.localPath,
			gitUrl: project.gitUrl,
			defaultBranch: project.defaultBranch,
			token,
			handle: "warren",
			plotSyncConfig,
			spawn: deps.spawn ?? defaultSpawn,
			gitBinary: deps.projectsConfig.gitBinary,
		});

		return jsonResponse(200, result);
	};
}

export { syncPlotHandler, triggerBackgroundSync };
