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
