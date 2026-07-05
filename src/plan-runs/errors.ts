/**
 * Errors specific to the PlanRun coordinator (pl-a258 step 5 / warren-2623).
 *
 * Each typed error here is a `POST /plan-runs` (warren-f923) rejection with
 * a stable `code` so HTTP consumers can branch without parsing the message.
 * All are mapped to 400 in src/server/errors.ts alongside ValidationError.
 */

import { WarrenError } from "../core/errors.ts";

/**
 * `POST /plan-runs` (warren-f923) rejection when the target project doesn't
 * carry a `.seeds/` directory (`project.hasSeeds === false`). Mirrors the
 * plot reject shape at warren-a8c3: 400 status, stable code so HTTP
 * consumers branch on it without parsing the message. Mapped to 400 in
 * src/server/errors.ts alongside ValidationError.
 */
export class ProjectLacksSeedsError extends WarrenError {
	readonly code = "project_lacks_seeds";
}

/**
 * `POST /plan-runs` (warren-f923) rejection when the target plan has no
 * open child seeds — every child is already closed, so the coordinator
 * would immediately succeed without dispatching anything. Same 400-status
 * posture as ProjectLacksSeedsError.
 */
export class PlanHasNoOpenChildrenError extends WarrenError {
	readonly code = "plan_has_no_open_children";
}

/**
 * `POST /plan-runs` (warren-c900 / pl-7937 Phase 2) rejection when the
 * caller supplies `plot_id` but the target project has no `.plot/`
 * directory (`project.hasPlot === false`). Mirrors ProjectLacksSeedsError's
 * shape so HTTP consumers branch on `code === "project_lacks_plot"`
 * without parsing the message. Mapped to 400 in src/server/errors.ts.
 *
 * Symmetric to the single-run gate in src/runs/spawn/dispatch.ts (warren-a8c3),
 * just routed through a typed error here so the plan-runs error surface
 * is uniform.
 */
export class ProjectLacksPlotError extends WarrenError {
	readonly code = "project_lacks_plot";
}
