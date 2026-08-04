/**
 * The one agent-name grammar (warren-2b75). Shared by the registry
 * (`RenderResponseSchema.name`, the operator seed file) and the config
 * layer's `RoleNameSchema` (src/warren-config/schema.ts), so the
 * registry, the config schema, and the router all agree on what a legal
 * agent name is: lowercase alphanumerics plus dots/dashes/underscores,
 * starting with an alphanumeric. A name outside this grammar (e.g.
 * `foo/bar`) fails at registration / seed time with a useful validation
 * error instead of silently 404ing at `GET /agents/:name`.
 *
 * Lives in its own module (not schema.ts) to keep schema.ts under the
 * file-size budget; schema.ts re-exports both names.
 */

import { z } from "zod";

export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Zod schema for an agent / role name. */
export const AgentNameSchema = z
	.string()
	.min(1, "name must be non-empty")
	.regex(
		AGENT_NAME_PATTERN,
		"name must be kebab/snake-case (lowercase, digits, dots, dashes, underscores)",
	);
