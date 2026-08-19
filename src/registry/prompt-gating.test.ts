import { describe, expect, test } from "bun:test";
import { BUILTIN_AGENTS } from "./builtins/index.ts";
import {
	ALL_PROMPT_CAPABILITIES,
	NO_PROMPT_CAPABILITIES,
	type ProjectPromptCapabilities,
	withGatedPromptFragments,
} from "./prompt-gating.ts";
import type { AgentDefinition } from "./schema.ts";

function builtin(name: string): AgentDefinition {
	const def = BUILTIN_AGENTS.find((a) => a.name === name);
	if (def === undefined) throw new Error(`no such builtin: ${name}`);
	return def;
}

const TRACKER_ONLY: ProjectPromptCapabilities = { tracker: true, mulch: false };

describe("withGatedPromptFragments", () => {
	test("passes an agent without gatedPrompts through unchanged (identity)", () => {
		const agent: AgentDefinition = {
			name: "refactor-bot",
			version: 1,
			sections: { system: "be a refactor agent" },
			resolvedFrom: [],
			frontmatter: {},
		};
		expect(withGatedPromptFragments(agent, ALL_PROMPT_CAPABILITIES)).toBe(agent);
		expect(withGatedPromptFragments(agent, NO_PROMPT_CAPABILITIES)).toBe(agent);
	});

	test("renders no tracker/mulch text against a capability-less project (warren-cb46)", () => {
		for (const def of BUILTIN_AGENTS) {
			const system = withGatedPromptFragments(def, NO_PROMPT_CAPABILITIES).sections.system;
			expect(system).not.toContain(".seeds");
			expect(system).not.toContain(".mulch");
			expect(system).not.toMatch(/\bml prime\b/);
			expect(system).not.toMatch(/`sd /);
			expect(system).not.toMatch(/sd plan/);
		}
	});

	test("renders the tracker workflow and expertise text against a fully-tooled project", () => {
		for (const def of BUILTIN_AGENTS) {
			const system = withGatedPromptFragments(def, ALL_PROMPT_CAPABILITIES).sections.system;
			expect(system).toContain(".seeds/issues.jsonl");
			expect(system).toContain(".mulch/expertise");
			expect(system).toMatch(/`sd /);
			expect(system).toMatch(/`ml prime`/);
		}
	});

	test("composes only the admitted fragment (tracker without mulch)", () => {
		const system = withGatedPromptFragments(builtin("pi"), TRACKER_ONLY).sections.system;
		expect(system).toContain(".seeds/issues.jsonl");
		expect(system).not.toContain(".mulch");
	});

	test("strips gatedPrompts so the frozen rendered agent captures what the run saw", () => {
		for (const def of BUILTIN_AGENTS) {
			const composed = withGatedPromptFragments(def, ALL_PROMPT_CAPABILITIES);
			expect(composed.gatedPrompts).toBeUndefined();
			// Frontmatter (provider/model/cap overrides) survives composition.
			expect(composed.frontmatter).toEqual(def.frontmatter);
		}
	});

	test("quality-gate chain is stack-neutral: no bare `bun run check:all` assumption", () => {
		for (const def of BUILTIN_AGENTS) {
			for (const caps of [NO_PROMPT_CAPABILITIES, ALL_PROMPT_CAPABILITIES]) {
				const system = withGatedPromptFragments(def, caps).sections.system;
				expect(system).not.toContain("bun run check:all");
			}
		}
		// The neutral chain itself: env var → AGENTS.md/CLAUDE.md → discover
		// the project's own commands.
		const pi = withGatedPromptFragments(builtin("pi"), ALL_PROMPT_CAPABILITIES).sections.system;
		expect(pi).toContain("$WARREN_QUALITY_GATE");
		expect(pi).toContain("discover the project's own test and lint commands");
	});
});
