/**
 * `frontmatter.steering` — the steering-consumption capability reader
 * (warren-3305), split out of ./schema.ts for the file-size budget and
 * re-exported there. The vocabulary itself is wire: `STEERING_CAPABILITIES`
 * in `src/core/wire.ts`.
 */

import { STEERING_CAPABILITIES, type SteeringCapability } from "../core/wire.ts";
import { AgentSchemaError } from "./errors.ts";

/**
 * Read `frontmatter.steering` (warren-3305). Returns `undefined` when the
 * agent declares no capability — the legacy fail-open case `steerRun` treats
 * as "allowed" so pre-flag agents keep their historical behavior. Throws
 * `AgentSchemaError` on a declared value outside STEERING_CAPABILITIES so a
 * typo fails at registration / refresh, not silently at steer time.
 */
export function readSteeringCapability(
	frontmatter: Readonly<Record<string, unknown>>,
	agentName = "<agent>",
): SteeringCapability | undefined {
	const raw = frontmatter.steering;
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "string" && (STEERING_CAPABILITIES as readonly string[]).includes(raw)) {
		return raw as SteeringCapability;
	}
	throw new AgentSchemaError(
		`agent "${agentName}" frontmatter.steering must be one of: ${STEERING_CAPABILITIES.join(", ")}`,
	);
}
