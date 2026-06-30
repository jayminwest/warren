/**
 * Shared internal helpers for the spawn flow's fire-and-log paths
 * (`plot-append.ts`, `seed-extensions.ts`). Not exported from
 * `./index.ts` — strictly module-private.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";

/**
 * Resolve the coordination project (warren-c1a4): the host clone the
 * post-dispatch seed stamp + Plot append target. Defaults to the
 * execution project (byte-identical same-repo behavior); when
 * `seedProjectId` names a different registered project, that clone is
 * loaded instead while the burrow workspace still clones the execution
 * project. Not refreshed — bookkeeping writes against the host clone
 * as-is.
 */
export async function resolveCoordinationProject(
	repos: Repos,
	seedProjectId: string | undefined,
	executionProject: ProjectRow,
): Promise<ProjectRow> {
	if (
		seedProjectId === undefined ||
		seedProjectId === "" ||
		seedProjectId === executionProject.id
	) {
		return executionProject;
	}
	return repos.projects.require(seedProjectId);
}
