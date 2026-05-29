/**
 * Sync Plot HTTP handlers and background tasks.
 *
 * Extracted from `src/server/handlers/plots.ts` (warren-3f46 / pl-3255 step 1).
 */

import { defaultPlotSyncer } from "../../../plots/index.ts";
import { loadWarrenConfig } from "../../../warren-config/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { defaultSpawn, requireParam } from "../index.ts";
import { resolvePlotProject } from "./shared.ts";

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
		const project = await resolvePlotProject(deps, plotId, "sync plot");

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
