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
 * carry a `.seeds/` directory (`project.hasSeeds === false`). 400 status,
 * stable code so HTTP consumers branch on it without parsing the message.
 * Mapped to 400 in src/server/errors.ts alongside ValidationError.
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
