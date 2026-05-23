/**
 * Built-in agent definitions shipped with warren.
 *
 * Warren seeds these into the agents registry on every server boot so a
 * fresh install can dispatch a run without `CANOPY_REPO_URL` being set.
 * Library agents loaded from a configured canopy repo are additive: a
 * same-named library agent overrides the built-in via `agents.upsert`.
 *
 * Provenance is encoded in `frontmatter.source` on each row's rendered
 * JSON. Three tiers (R-03, pl-fef5):
 *
 *   - `"builtin"`            — built-in agents shipped inline.
 *   - `"library"`            — canopy-loaded agents from `CANOPY_REPO_URL`.
 *                              Canopy doesn't set the field, so unset
 *                              frontmatter falls back to library.
 *   - `"project:<projectId>"` — agents rendered from a project's
 *                              `<projectPath>/.canopy/` (project tier).
 *                              `refreshProjectAgents` stamps this on each
 *                              row at render time.
 *
 * The HTTP layer reads that field to surface `source` on `GET /agents`
 * responses; the UI parses the prefix to render provenance.
 */

import type { AgentsRepo } from "../../db/repos/agents.ts";
import type { AgentDefinition } from "../schema.ts";
import { BRAINSTORM_BUILTIN } from "./brainstorm.ts";
import { CLAUDE_CODE_BUILTIN } from "./claude-code.ts";
import { PI_BUILTIN } from "./pi.ts";
import { PLANNER_BUILTIN } from "./planner.ts";
import { SAPLING_BUILTIN } from "./sapling.ts";

export const BUILTIN_AGENT_SOURCE = "builtin" as const;
export const LIBRARY_AGENT_SOURCE = "library" as const;
/**
 * Prefix for project-tier source strings (R-03, pl-fef5). The full source
 * is `project:<projectId>` — `makeProjectAgentSource` is the constructor,
 * `agentSourceTier` and `readAgentSource` classify on the prefix.
 */
export const PROJECT_AGENT_SOURCE_PREFIX = "project:" as const;

export type BuiltinAgentSource = typeof BUILTIN_AGENT_SOURCE;
export type LibraryAgentSource = typeof LIBRARY_AGENT_SOURCE;
export type ProjectAgentSource = `${typeof PROJECT_AGENT_SOURCE_PREFIX}${string}`;
export type AgentSource = BuiltinAgentSource | LibraryAgentSource | ProjectAgentSource;

/**
 * Coarse tier classification: collapses `project:<projectId>` rows to
 * `"project"` so callers that only care about which tier a row belongs to
 * (UI badge, scope-aware repo reads) don't have to parse the suffix.
 */
export type AgentSourceTier = "builtin" | "library" | "project";

export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
	CLAUDE_CODE_BUILTIN,
	SAPLING_BUILTIN,
	PI_BUILTIN,
	BRAINSTORM_BUILTIN,
	PLANNER_BUILTIN,
];

export const BUILTIN_AGENT_NAMES: ReadonlySet<string> = new Set(BUILTIN_AGENTS.map((a) => a.name));

export interface SeedBuiltinAgentsResult {
	readonly seeded: readonly string[];
	readonly skipped: readonly string[];
}

/**
 * Insert each built-in into the agents table only if a row with the
 * same name does not already exist. Pre-existing rows (whether seeded
 * by an earlier boot or upserted by a refresh of a same-named library
 * agent) are preserved.
 */
export async function seedBuiltinAgents(
	repo: AgentsRepo,
	builtins: readonly AgentDefinition[] = BUILTIN_AGENTS,
	now?: () => Date,
): Promise<SeedBuiltinAgentsResult> {
	const seeded: string[] = [];
	const skipped: string[] = [];
	for (const builtin of builtins) {
		if ((await repo.get(builtin.name)) !== null) {
			skipped.push(builtin.name);
			continue;
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
 * Read the `source` provenance from a row's renderedJson. The three tiers
 * (R-03, pl-fef5):
 *
 *   - `frontmatter.source === "builtin"`        → `"builtin"`.
 *   - `frontmatter.source` starts with `project:` and has a non-empty
 *     suffix → the same `project:<projectId>` string (project tier).
 *   - everything else                            → `"library"`. Canopy
 *     doesn't emit `frontmatter.source`, so unset frontmatter or a bare
 *     `"library"` string both collapse here.
 *
 * Source of truth for the `source` field on `GET /agents` responses.
 */
export function readAgentSource(renderedJson: unknown): AgentSource {
	if (typeof renderedJson === "object" && renderedJson !== null) {
		const fm = (renderedJson as { frontmatter?: unknown }).frontmatter;
		if (typeof fm === "object" && fm !== null) {
			const source = (fm as { source?: unknown }).source;
			if (source === BUILTIN_AGENT_SOURCE) return BUILTIN_AGENT_SOURCE;
			if (typeof source === "string" && isProjectAgentSource(source)) return source;
		}
	}
	return LIBRARY_AGENT_SOURCE;
}

/**
 * Construct a project-tier source string from a project id. Empty ids are
 * rejected — a `project:` prefix with no suffix would round-trip back to
 * `library` through `readAgentSource`, masking a programming error.
 */
export function makeProjectAgentSource(projectId: string): ProjectAgentSource {
	if (projectId.length === 0) {
		throw new Error("makeProjectAgentSource: projectId must be non-empty");
	}
	return `${PROJECT_AGENT_SOURCE_PREFIX}${projectId}`;
}

/**
 * Type guard for project-tier source strings. Accepts any string that
 * starts with `project:` and has a non-empty suffix.
 */
export function isProjectAgentSource(source: string): source is ProjectAgentSource {
	return (
		source.startsWith(PROJECT_AGENT_SOURCE_PREFIX) &&
		source.length > PROJECT_AGENT_SOURCE_PREFIX.length
	);
}

/**
 * Extract the project id from a `project:<projectId>` source. Returns
 * `null` for non-project tiers so callers that gate UI badges or
 * scope-aware reads on tier can ignore them.
 */
export function projectIdFromAgentSource(source: AgentSource): string | null {
	if (!isProjectAgentSource(source)) return null;
	return source.slice(PROJECT_AGENT_SOURCE_PREFIX.length);
}

/**
 * Coarse-tier classifier — collapses `project:<id>` to `"project"`. Use
 * this when the caller doesn't need the project id (UI badge color,
 * "is this the global tier?" scope checks).
 */
export function agentSourceTier(source: AgentSource): AgentSourceTier {
	if (source === BUILTIN_AGENT_SOURCE) return "builtin";
	if (isProjectAgentSource(source)) return "project";
	return "library";
}

/**
 * Return a new AgentDefinition whose `frontmatter.source` is set to the
 * given source. Used by the registry refresh path to stamp project-tier
 * rows at render time (`refreshProjectAgents`, pl-fef5 step 5) — canopy
 * itself doesn't emit `source`, so warren overlays it before persisting.
 *
 * The original agent is not mutated. Existing `frontmatter` fields are
 * preserved; only `source` is replaced.
 */
export function stampAgentSource(agent: AgentDefinition, source: AgentSource): AgentDefinition {
	return {
		...agent,
		frontmatter: { ...agent.frontmatter, source },
	};
}

export { BRAINSTORM_BUILTIN, CLAUDE_CODE_BUILTIN, PI_BUILTIN, PLANNER_BUILTIN, SAPLING_BUILTIN };
