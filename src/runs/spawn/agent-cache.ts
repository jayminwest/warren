/**
 * Read-side helpers for the spawn flow: re-validate the cached
 * rendered-agent envelope, resolve operator / project frontmatter
 * overrides, and read the project's `.warren/defaults.json`. Extracted
 * from the legacy `src/runs/spawn.ts` under warren-f71c / pl-9088 step 6.
 */

import {
	type AgentDefinition,
	parseRenderedAgent,
	RenderResponseSchema,
} from "../../registry/schema.ts";
import type { DefaultsConfig, WarrenConfigCache } from "../../warren-config/index.ts";
import { RunSpawnError } from "../errors.ts";

/**
 * Re-validate the cached row's renderedJson before use. Refresh.ts stores
 * a parsed `AgentDefinition` directly, so the column shape is normally
 * exactly that — but the column type is `unknown`, and a corrupted row
 * shouldn't crash the spawn flow with a TypeError. If the cache holds the
 * raw `cn render` envelope (older registry refresh path), fall back to
 * parsing it.
 */
export function readCachedAgent(raw: unknown, name: string): AgentDefinition {
	if (typeof raw !== "object" || raw === null) {
		throw new RunSpawnError(`cached agent "${name}" has malformed renderedJson`);
	}
	const candidate = raw as Record<string, unknown>;
	if (
		typeof candidate.name === "string" &&
		typeof candidate.version === "number" &&
		typeof candidate.sections === "object" &&
		candidate.sections !== null &&
		!Array.isArray(candidate.sections)
	) {
		const sections = candidate.sections as Record<string, unknown>;
		for (const [key, value] of Object.entries(sections)) {
			if (typeof value !== "string") {
				throw new RunSpawnError(`cached agent "${name}" has non-string section "${key}"`);
			}
		}
		return {
			name: candidate.name,
			version: candidate.version,
			sections: sections as Record<string, string>,
			resolvedFrom: Array.isArray(candidate.resolvedFrom)
				? candidate.resolvedFrom.filter((s): s is string => typeof s === "string")
				: [],
			frontmatter:
				typeof candidate.frontmatter === "object" &&
				candidate.frontmatter !== null &&
				!Array.isArray(candidate.frontmatter)
					? (candidate.frontmatter as Record<string, unknown>)
					: {},
		};
	}
	if (RenderResponseSchema.safeParse(raw).success) {
		return parseRenderedAgent(raw, name);
	}
	throw new RunSpawnError(`cached agent "${name}" does not match AgentDefinition shape`);
}

/**
 * Pick the effective frontmatter override given a per-run operator value and
 * a project default. Empty / whitespace-only strings are treated the same as
 * "not provided" (matches `withProviderOverrides`'s shape). Returns the
 * operator value when present, otherwise the project default, otherwise
 * `undefined` so the agent's own frontmatter remains in force.
 */
export function resolveOverride(
	operator: string | undefined,
	projectDefault: string | undefined,
): string | undefined {
	const op = operator?.trim();
	if (op !== undefined && op !== "") return op;
	const pd = projectDefault?.trim();
	if (pd !== undefined && pd !== "") return pd;
	return undefined;
}

/**
 * Load the project's `.warren/defaults.json` envelope through the cache.
 * Returns `null` when no cache is wired (CLI/tests that don't care about
 * project defaults) or when the load fails — a malformed `.warren/` should
 * never abort a spawn, just downgrade to "no project default" behavior.
 */
export async function readProjectDefaults(
	cache: WarrenConfigCache | undefined,
	projectId: string,
	projectPath: string,
): Promise<DefaultsConfig | null> {
	if (cache === undefined) return null;
	try {
		const envelope = await cache.get(projectId, projectPath);
		return envelope.defaults;
	} catch {
		// Project clone vanished or .warren/ I/O errored — leave the agent
		// frontmatter as the final source of truth and let the rest of the
		// flow surface any project-state failure on its own path.
		return null;
	}
}
