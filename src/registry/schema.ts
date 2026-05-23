/**
 * Schemas for canopy `cn render` output and warren's normalized agent
 * definition (SPEC §4.2).
 *
 * `RenderResponseSchema` mirrors the wire shape canopy 0.2.x emits with
 * `--format json` — `{success, command, name, version, sections, ...}`.
 * Failure-shaped responses (`success: false`) are caught at the canopy
 * facade boundary, so the schema only needs to model the happy-path
 * envelope.
 *
 * `parseRenderedAgent` collapses the section list into a `name → body`
 * map (the rest of warren never cares about ordering — `cn render` already
 * resolved inheritance + mixins). It also enforces warren's semantic rule:
 * an agent prompt MUST include a `system` section. Other sections from
 * SPEC §4.2 (`skills`, `expertise_seed`, `burrow_config`, `workflow`) are
 * optional — they are consumed at run-spawn time (Phase 5), not now, and
 * canopy's own per-prompt schema is the right place to enforce richer
 * structural rules.
 *
 * Duplicate section names are rejected: canopy renders an inherited
 * prompt by overriding parent sections with same-named child sections, so
 * the rendered output should never contain dupes. If we see one, the
 * canopy install is corrupt — surface that loudly rather than silently
 * dropping data.
 */

import { z } from "zod";
import { AgentSchemaError } from "./errors.ts";

export const REQUIRED_AGENT_SECTIONS = ["system"] as const;
export type RequiredAgentSection = (typeof REQUIRED_AGENT_SECTIONS)[number];

const SectionSchema = z.object({
	name: z.string().min(1),
	body: z.string(),
});

export const RenderResponseSchema = z.object({
	success: z.literal(true),
	command: z.literal("render"),
	name: z.string().min(1),
	version: z.number().int().positive(),
	sections: z.array(SectionSchema),
	resolvedFrom: z.array(z.string()).optional(),
	frontmatter: z.record(z.string(), z.unknown()).optional(),
});

export type RenderResponse = z.infer<typeof RenderResponseSchema>;

export interface AgentDefinition {
	readonly name: string;
	readonly version: number;
	readonly sections: Readonly<Record<string, string>>;
	readonly resolvedFrom: readonly string[];
	readonly frontmatter: Readonly<Record<string, unknown>>;
}

/**
 * Well-known optional frontmatter fields the multi-provider surface reads:
 *
 *   provider — the runtime-side provider id (e.g. "anthropic", "openai",
 *              "google", "deepseek"). Free-form string; burrow's piRuntime
 *              maps it onto pi's --provider flag, claude-code ignores it.
 *   model    — provider-specific model id (e.g. "claude-sonnet-4-6",
 *              "gpt-4o", "gemini-2.0-pro"). Free-form string; the runtime
 *              decides how to interpret it.
 *   runtime  — burrow runtime id this canopy agent dispatches onto
 *              (e.g. "claude-code", "sapling", "pi"). When unset,
 *              warren falls back to `agent.name` — preserving the
 *              historical name=runtime convention for claude-code /
 *              sapling / pi. Interactive system-prompt-only agents like
 *              `brainstorm` / `planner` (warren-ebca) set this so they
 *              compose onto a real burrow runtime instead of looking up
 *              their own name in `BUILT_IN_RUNTIMES`.
 *
 * Both stay in the open `frontmatter` bag (no schema rev) so a canopy
 * author can set them inline. `POST /runs` accepts the same two fields
 * as overrides; the spawn composer merges overrides on top of frontmatter
 * before freezing onto `runs.rendered_agent_json`.
 */
export function readProviderFrontmatter(frontmatter: Readonly<Record<string, unknown>>): {
	provider?: string;
	model?: string;
} {
	const result: { provider?: string; model?: string } = {};
	const p = frontmatter.provider;
	if (typeof p === "string" && p.length > 0) result.provider = p;
	const m = frontmatter.model;
	if (typeof m === "string" && m.length > 0) result.model = m;
	return result;
}

/**
 * Resolve the burrow runtime id this canopy agent should dispatch onto.
 * Prefers an explicit `frontmatter.runtime` (set by interactive built-ins
 * like brainstorm/planner that layer a system prompt on top of an
 * existing runtime) and falls back to `agent.name` for the historical
 * name=runtime convention (claude-code / sapling / pi). See warren-ebca.
 */
export function readRuntimeId(agent: AgentDefinition): string {
	const r = agent.frontmatter.runtime;
	if (typeof r === "string" && r.length > 0) return r;
	return agent.name;
}

/**
 * Return a new AgentDefinition with the operator's provider/model overrides
 * folded into `frontmatter` (taking precedence over the agent's own values).
 * Empty / whitespace-only overrides are ignored — they're treated the same
 * as omitting the field. The original agent is not mutated.
 */
export function withProviderOverrides(
	agent: AgentDefinition,
	overrides: { providerOverride?: string; modelOverride?: string },
): AgentDefinition {
	const provider = overrides.providerOverride?.trim();
	const model = overrides.modelOverride?.trim();
	if ((provider === undefined || provider === "") && (model === undefined || model === "")) {
		return agent;
	}
	const nextFrontmatter: Record<string, unknown> = { ...agent.frontmatter };
	if (provider !== undefined && provider !== "") nextFrontmatter.provider = provider;
	if (model !== undefined && model !== "") nextFrontmatter.model = model;
	return { ...agent, frontmatter: nextFrontmatter };
}

/**
 * Parse and semantically validate the JSON body returned by
 * `cn render <name> --format json`. Throws `AgentSchemaError` for
 * any malformed or incomplete shape.
 */
export function parseRenderedAgent(raw: unknown, agentName?: string): AgentDefinition {
	const parsed = RenderResponseSchema.safeParse(raw);
	if (!parsed.success) {
		throw new AgentSchemaError(
			`canopy render output failed schema validation${agentName ? ` for "${agentName}"` : ""}: ${parsed.error.issues.map(formatZodIssue).join("; ")}`,
		);
	}
	const env = parsed.data;
	const sections: Record<string, string> = {};
	for (const section of env.sections) {
		if (Object.hasOwn(sections, section.name)) {
			throw new AgentSchemaError(
				`canopy render returned duplicate section "${section.name}" for agent "${env.name}"`,
			);
		}
		sections[section.name] = section.body;
	}
	const def: AgentDefinition = {
		name: env.name,
		version: env.version,
		sections,
		resolvedFrom: env.resolvedFrom ?? [],
		frontmatter: env.frontmatter ?? {},
	};
	validateAgentDefinition(def);
	return def;
}

/**
 * Enforce warren's required-sections rule on an already-built
 * `AgentDefinition`. Reused by `parseRenderedAgent` (post-canopy-render)
 * and by the cross-tier composer (warren-44a3) so a composed agent that
 * still ends up missing `system` is skipped with the same error shape.
 */
export function validateAgentDefinition(def: AgentDefinition): void {
	for (const required of REQUIRED_AGENT_SECTIONS) {
		if (!Object.hasOwn(def.sections, required)) {
			throw new AgentSchemaError(`agent "${def.name}" is missing required section "${required}"`, {
				recoveryHint: `add a "${required}" section to the canopy prompt and re-render`,
			});
		}
	}
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
	const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
	return `${path}: ${issue.message}`;
}
