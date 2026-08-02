/**
 * Errors specific to the run-spawn / composition flow (docs/design/agent-composition.md).
 *
 * `RunSpawnError` covers anything that goes wrong between "we have an
 * agent + project" and "we have a dispatched burrow run" that isn't
 * already a `BurrowError` (server envelope), `BurrowUnreachableError`
 * (transport), `NotFoundError` (missing agent/project), or
 * `ValidationError` (caller passed bad input). Examples: malformed
 * cached agent JSON, broken `expertise_seed` line, filesystem write
 * failure while seeding the burrow workspace.
 */

import { WarrenError } from "../core/errors.ts";

export class RunSpawnError extends WarrenError {
	readonly code = "run_spawn_error";
}
