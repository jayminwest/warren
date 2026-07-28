/**
 * Built-in agent definitions shipped with warren.
 *
 * Warren seeds these into the agents registry on every server boot so a
 * fresh install can dispatch a run out of the box. The external canopy
 * agent library was removed in the deletion pass (pl-3a79); the registry
 * is now the built-ins alone.
 *
 * Provenance is encoded in `frontmatter.source` on each row's rendered
 * JSON. Two tiers:
 *
 *   - `"builtin"` — built-in agents shipped inline.
 *   - `"library"` — legacy provenance retained for pre-existing rows.
 *                   Unset frontmatter falls back to library.
 *
 * The HTTP layer reads that field to surface `source` on `GET /agents`
 * responses; the UI renders provenance from it.
 */

import type { AgentSource } from "../../core/wire.ts";
import type { AgentsRepo } from "../../db/repos/agents.ts";
import type { AgentDefinition } from "../schema.ts";
import { BUGWATCH_BUILTIN } from "./bugwatch.ts";
import { CLAUDE_CODE_BUILTIN } from "./claude-code.ts";
import { HEALER_BUILTIN } from "./healer.ts";
import { NIGHTWATCH_BUILTIN } from "./nightwatch.ts";
import { PI_BUILTIN } from "./pi.ts";
import { PLANNER_BUILTIN } from "./planner.ts";
import { PR_FIXER_BUILTIN } from "./pr-fixer.ts";
import { SAPLING_BUILTIN } from "./sapling.ts";

export const BUILTIN_AGENT_SOURCE = "builtin" as const;
export const LIBRARY_AGENT_SOURCE = "library" as const;

export type BuiltinAgentSource = typeof BUILTIN_AGENT_SOURCE;
export type LibraryAgentSource = typeof LIBRARY_AGENT_SOURCE;
/**
 * The union is canonical wire vocabulary — it is what `GET /agents` puts on
 * `source` — so it is DEFINED in `src/core/wire.ts` and re-exported here
 * (warren-b229). The two arms above stay local because they are derived
 * from this module's own constants.
 */
export type { AgentSource };

export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
	CLAUDE_CODE_BUILTIN,
	SAPLING_BUILTIN,
	PI_BUILTIN,
	PLANNER_BUILTIN,
	NIGHTWATCH_BUILTIN,
	BUGWATCH_BUILTIN,
	PR_FIXER_BUILTIN,
	HEALER_BUILTIN,
];

export const BUILTIN_AGENT_NAMES: ReadonlySet<string> = new Set(BUILTIN_AGENTS.map((a) => a.name));

export interface SeedBuiltinAgentsResult {
	readonly seeded: readonly string[];
	readonly skipped: readonly string[];
}

function areDeepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
		return false;
	}
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	for (const key of keysA) {
		if (!Object.hasOwn(b, key)) return false;
		if (!areDeepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
			return false;
		}
	}
	return true;
}

/**
 * Insert each built-in into the agents table only if a row with the
 * same name does not already exist, or if the existing row is a built-in
 * whose content/frontmatter has drifted from the code's definition.
 * Pre-existing overridden rows (library or project tier) are preserved.
 */
export async function seedBuiltinAgents(
	repo: AgentsRepo,
	builtins: readonly AgentDefinition[] = BUILTIN_AGENTS,
	now?: () => Date,
): Promise<SeedBuiltinAgentsResult> {
	const seeded: string[] = [];
	const skipped: string[] = [];
	for (const builtin of builtins) {
		const existing = await repo.get(builtin.name);
		if (existing !== null) {
			const source = readAgentSource(existing.renderedJson);
			if (source !== BUILTIN_AGENT_SOURCE) {
				skipped.push(builtin.name);
				continue;
			}
			if (areDeepEqual(existing.renderedJson, builtin)) {
				skipped.push(builtin.name);
				continue;
			}
		}
		await repo.upsert({
			name: builtin.name,
			renderedJson: builtin,
			...(now !== undefined ? { now: now() } : {}),
		});
		seeded.push(builtin.name);
	}
	return { seeded, skipped };
}

/**
 * Read the `source` provenance from a row's renderedJson. Two tiers:
 *
 *   - `frontmatter.source === "builtin"` → `"builtin"`.
 *   - everything else                    → `"library"`. Unset frontmatter
 *     or a bare `"library"` string both collapse here.
 *
 * Source of truth for the `source` field on `GET /agents` responses.
 */
export function readAgentSource(renderedJson: unknown): AgentSource {
	if (typeof renderedJson === "object" && renderedJson !== null) {
		const fm = (renderedJson as { frontmatter?: unknown }).frontmatter;
		if (typeof fm === "object" && fm !== null) {
			const source = (fm as { source?: unknown }).source;
			if (source === BUILTIN_AGENT_SOURCE) return BUILTIN_AGENT_SOURCE;
		}
	}
	return LIBRARY_AGENT_SOURCE;
}

/**
 * Return a new AgentDefinition whose `frontmatter.source` is set to the
 * given source. The original agent is not mutated. Existing `frontmatter`
 * fields are preserved; only `source` is replaced.
 */
export function stampAgentSource(agent: AgentDefinition, source: AgentSource): AgentDefinition {
	return {
		...agent,
		frontmatter: { ...agent.frontmatter, source },
	};
}

export {
	BUGWATCH_BUILTIN,
	CLAUDE_CODE_BUILTIN,
	HEALER_BUILTIN,
	NIGHTWATCH_BUILTIN,
	PI_BUILTIN,
	PLANNER_BUILTIN,
	PR_FIXER_BUILTIN,
	SAPLING_BUILTIN,
};
