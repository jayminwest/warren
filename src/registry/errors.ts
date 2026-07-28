/**
 * Errors specific to the agent registry.
 *
 * `AgentSchemaError` covers a single agent definition that fails warren's
 * semantic validation (e.g., missing `system` section). Built-in seeding
 * surfaces it when a shipped definition is malformed.
 */

import { WarrenError } from "../core/errors.ts";

export class AgentSchemaError extends WarrenError {
	readonly code = "agent_schema_error";
}
