/**
 * The dispatch overrides a retry inherits from the run it replaces
 * (warren-0d80).
 *
 * A run's EFFECTIVE provider, model and spend cap are folded onto its
 * frozen `renderedAgentJson.frontmatter` at dispatch time, whichever tier
 * supplied them: the agent's own frontmatter, the project defaults, or an
 * explicit override on the request. Reading them back is the only way a
 * retry can resolve the same three values, because `spawnRun` re-resolves
 * from the agent and the project defaults when no override arrives, and
 * those defaults may have moved since.
 *
 * Both retry modules read this. The HTTP clone path (`resolveCloneDefaults`
 * in `src/server/handlers/runs/dispatch.ts`) already did the same thing by
 * hand, which is where the shape comes from.
 */

import { readProviderFrontmatter } from "../../registry/schema.ts";
import { readMaxCostUsd } from "../cost-cap.ts";

/** Override slots on `SpawnRunInput`, filled only where the parent had one. */
export interface InheritedDispatchOverrides {
	readonly providerOverride?: string;
	readonly modelOverride?: string;
	readonly maxCostUsdOverride?: number;
}

/**
 * Read the three override slots off a failed run's rendered agent. A run
 * whose frontmatter carries none yields `{}`, so a spread of the result
 * leaves the retry resolving exactly as the original did.
 *
 * `renderedAgentJson` is `unknown` on the row, and a hand-built fixture or
 * an older row can carry anything, so the shape is narrowed rather than
 * asserted.
 */
export function inheritedDispatchOverrides(renderedAgentJson: unknown): InheritedDispatchOverrides {
	const frontmatter = readFrontmatter(renderedAgentJson);
	const provider = readProviderFrontmatter(frontmatter);
	const capUsd = readMaxCostUsd(frontmatter);
	return {
		...(provider.provider !== undefined ? { providerOverride: provider.provider } : {}),
		...(provider.model !== undefined ? { modelOverride: provider.model } : {}),
		...(capUsd !== null ? { maxCostUsdOverride: capUsd } : {}),
	};
}

function readFrontmatter(renderedAgentJson: unknown): Readonly<Record<string, unknown>> {
	if (renderedAgentJson === null || typeof renderedAgentJson !== "object") return {};
	const { frontmatter } = renderedAgentJson as { frontmatter?: unknown };
	if (frontmatter === null || typeof frontmatter !== "object") return {};
	return frontmatter as Readonly<Record<string, unknown>>;
}
