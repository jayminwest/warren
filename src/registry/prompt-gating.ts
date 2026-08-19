/**
 * Capability-gated prompt composition (warren-cb46, plan pl-a37b).
 *
 * Builtin prompts used to assert `sd` / `ml` / `.seeds/` / `.mulch/` /
 * `bun run check:all` as facts. On a mirror repo with none of that
 * tooling, every assertion is false and costs the agent turns of
 * confused exploration. The fix is prompt-fragment assembly at dispatch:
 * the agent definition carries its tracker-workflow and expertise
 * paragraphs as gated fragments (`AgentDefinition.gatedPrompts`), the
 * spawn path resolves the project's capability facts, and
 * {@link withGatedPromptFragments} composes the system body the run
 * actually sees — core body plus only the fragments the project admits.
 *
 * The returned definition drops `gatedPrompts`, so the frozen
 * `runs.rendered_agent_json` captures exactly what the run saw (the same
 * freeze discipline the provider/model override chain follows).
 *
 * The quality-gate paragraph is deliberately NOT a gated fragment: it is
 * always present, worded stack-neutral. Its fallback chain is
 * `$WARREN_QUALITY_GATE` → the command documented in CLAUDE.md /
 * AGENTS.md → discover the project's own test and lint commands — never a
 * bare `bun run check:all` assumption on an unknown repo.
 */
import { AgentSchemaError } from "./errors.ts";
import type { AgentDefinition } from "./schema.ts";

/**
 * Prompt fragments gated on the dispatched project's capabilities
 * (warren-cb46). `tracker` rides only when the project has a git-native
 * issue tracker (`.seeds/`); `mulch` only when `.mulch/` expertise exists.
 * A capability-less project gets neither — no false assertions about
 * tooling it does not have.
 */
export interface GatedPromptFragments {
	/** Tracker-workflow text (sd CLI, `.seeds/` paths). */
	readonly tracker?: string;
	/** Project-expertise text (`ml prime`, `.mulch/` paths). */
	readonly mulch?: string;
}

/** Reject non-string gated prompt fragments (warren-cb46). */
export function validateGatedPrompts(def: AgentDefinition): void {
	const gated = def.gatedPrompts;
	if (gated === undefined) return;
	for (const key of ["tracker", "mulch"] as const) {
		const value = gated[key];
		if (value !== undefined && typeof value !== "string") {
			throw new AgentSchemaError(`agent "${def.name}" gatedPrompts.${key} must be a string`);
		}
	}
}

/**
 * The capability facts prompt composition branches on (warren-cb46).
 *
 *   tracker — the project has a git-native issue tracker configured
 *             (`.seeds/` on disk + a boot-wired tracker whose
 *             `capabilities.isGitNative` holds). Gates the sd-workflow
 *             paragraphs.
 *   mulch   — the project has `.mulch/` expertise. Gates the `ml prime` /
 *             expertise paragraphs.
 */
export interface ProjectPromptCapabilities {
	readonly tracker: boolean;
	readonly mulch: boolean;
}

/** Every fragment admitted — the render a fully-tooled warren project sees. */
export const ALL_PROMPT_CAPABILITIES: ProjectPromptCapabilities = {
	tracker: true,
	mulch: true,
};

/** No fragments admitted — the render a bare foreign repo sees. */
export const NO_PROMPT_CAPABILITIES: ProjectPromptCapabilities = {
	tracker: false,
	mulch: false,
};

/**
 * Compose the agent's system body for a project with the given
 * capabilities: core body first, then the admitted fragments, joined by
 * blank lines. An agent without `gatedPrompts` passes through unchanged
 * (identity — same object), so library/legacy rows render exactly as
 * before.
 */
export function withGatedPromptFragments(
	agent: AgentDefinition,
	caps: ProjectPromptCapabilities,
): AgentDefinition {
	const fragments = agent.gatedPrompts;
	if (fragments === undefined) return agent;
	const parts = [(agent.sections.system ?? "").trim()];
	const tracker = fragments.tracker?.trim();
	const mulch = fragments.mulch?.trim();
	if (caps.tracker && tracker !== undefined && tracker !== "") {
		parts.push(tracker);
	}
	if (caps.mulch && mulch !== undefined && mulch !== "") {
		parts.push(mulch);
	}
	const { gatedPrompts: _stripped, ...rest } = agent;
	return {
		...rest,
		sections: { ...agent.sections, system: parts.filter((part) => part !== "").join("\n\n") },
	};
}
