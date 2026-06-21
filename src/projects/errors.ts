/**
 * Errors specific to project management.
 *
 * `ProjectUnavailableError` covers shell-out + filesystem failures during
 * clone/delete: `git` binary missing, network down, repo not found, mkdir
 * refused, rm failed. Maps to a 503 at the warren HTTP boundary — the right
 * operator action is "fix the host" rather than "retry the request".
 *
 * URL validation, duplicate-project, and stranded-clone conflicts surface
 * as the shared `ValidationError` from core: callers want the same
 * 400-shaped envelope on every "your input doesn't match warren's state".
 */

import { WarrenError } from "../core/errors.ts";

export class ProjectUnavailableError extends WarrenError {
	readonly code = "project_unavailable";
}

/**
 * Raised by `resolveTargetProject` (cross-repo plan-runs, pl-fb43 step 2)
 * when a seed's `extensions.repo` (a project slug or git remote URL) does
 * not map to any registered project. Pure lookup failure — distinct from
 * `ProjectUnavailableError` (host/git failure) and `NotFoundError`
 * (lookup by warren project id) — so callers can route it to the
 * plan-failed path with a clear "register this repo first" hint.
 */
export class TargetProjectUnresolvedError extends WarrenError {
	readonly code = "target_project_unresolved";
}
