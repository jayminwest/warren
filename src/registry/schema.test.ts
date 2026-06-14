import { describe, expect, test } from "bun:test";
import { AgentSchemaError } from "./errors.ts";
import {
	type AgentDefinition,
	parseRenderedAgent,
	RenderResponseSchema,
	readProviderFrontmatter,
	readRuntimeId,
	readToolsFrontmatter,
	withMaxCostUsdOverride,
	withProviderOverrides,
} from "./schema.ts";

const VALID = {
	success: true,
	command: "render",
	name: "refactor-bot",
	version: 3,
	sections: [
		{ name: "system", body: "You are a refactor agent." },
		{ name: "skills", body: "- run-tests\n- open-pr" },
		{ name: "expertise_seed", body: '{"type":"convention","domain":"refactor","content":"..."}' },
	],
	resolvedFrom: ["base-coding-agent", "refactor-bot"],
	frontmatter: { owner: "platform" },
};

describe("RenderResponseSchema", () => {
	test("accepts the canonical wire shape", () => {
		const parsed = RenderResponseSchema.safeParse(VALID);
		expect(parsed.success).toBe(true);
	});

	test("rejects success: false envelopes (caller handles those)", () => {
		const parsed = RenderResponseSchema.safeParse({
			success: false,
			command: "render",
			error: "Prompt not found",
		});
		expect(parsed.success).toBe(false);
	});

	test("requires version to be a positive integer", () => {
		const parsed = RenderResponseSchema.safeParse({ ...VALID, version: 0 });
		expect(parsed.success).toBe(false);
	});
});

describe("parseRenderedAgent", () => {
	test("collapses sections into a name → body map", () => {
		const def = parseRenderedAgent(VALID);
		expect(def.name).toBe("refactor-bot");
		expect(def.version).toBe(3);
		expect(def.sections.system).toBe("You are a refactor agent.");
		expect(def.sections.skills).toBe("- run-tests\n- open-pr");
		expect(def.resolvedFrom).toEqual(["base-coding-agent", "refactor-bot"]);
		expect(def.frontmatter).toEqual({ owner: "platform" });
	});

	test("defaults resolvedFrom and frontmatter when canopy omits them", () => {
		const def = parseRenderedAgent({
			success: true,
			command: "render",
			name: "minimal",
			version: 1,
			sections: [{ name: "system", body: "hi" }],
		});
		expect(def.resolvedFrom).toEqual([]);
		expect(def.frontmatter).toEqual({});
	});

	test("rejects prompts missing the system section", () => {
		const raw = {
			...VALID,
			sections: [
				{ name: "skills", body: "..." },
				{ name: "workflow", body: "..." },
			],
		};
		expect(() => parseRenderedAgent(raw)).toThrow(AgentSchemaError);
	});

	test("rejects duplicate section names from a corrupt render", () => {
		const raw = {
			...VALID,
			sections: [
				{ name: "system", body: "first" },
				{ name: "system", body: "second" },
			],
		};
		expect(() => parseRenderedAgent(raw)).toThrow(/duplicate section "system"/);
	});

	test("includes the agent name in schema-failure messages when provided", () => {
		expect(() => parseRenderedAgent({ success: true }, "broken-bot")).toThrow(/broken-bot/);
	});

	test("rejects malformed envelopes", () => {
		expect(() => parseRenderedAgent({ success: false })).toThrow(AgentSchemaError);
		expect(() => parseRenderedAgent(null)).toThrow(AgentSchemaError);
		expect(() => parseRenderedAgent("not an object")).toThrow(AgentSchemaError);
	});
});

describe("readRuntimeId", () => {
	const INTERACTIVE: AgentDefinition = {
		name: "brainstorm",
		version: 1,
		sections: { system: "hi" },
		resolvedFrom: ["builtin:brainstorm"],
		frontmatter: { source: "builtin", runtime: "pi" },
	};

	const NAME_MATCH: AgentDefinition = {
		name: "claude-code",
		version: 1,
		sections: { system: "hi" },
		resolvedFrom: ["builtin:claude-code"],
		frontmatter: { source: "builtin" },
	};

	test("falls back to the pi default when frontmatter.runtime is absent (warren-16f8)", () => {
		expect(readRuntimeId(NAME_MATCH)).toBe("pi");
	});

	test("prefers frontmatter.runtime over agent.name", () => {
		expect(readRuntimeId(INTERACTIVE)).toBe("pi");
	});

	test("config override wins over frontmatter.runtime (warren-b802)", () => {
		expect(readRuntimeId(INTERACTIVE, "claude-code")).toBe("claude-code");
	});

	test("config override wins over agent.name fallback", () => {
		expect(readRuntimeId(NAME_MATCH, "sapling")).toBe("sapling");
	});

	test("ignores empty / undefined config override", () => {
		expect(readRuntimeId(INTERACTIVE, undefined)).toBe("pi");
		expect(readRuntimeId(INTERACTIVE, "")).toBe("pi");
	});
});

describe("readProviderFrontmatter", () => {
	test("returns empty object when neither field is set", () => {
		expect(readProviderFrontmatter({})).toEqual({});
		expect(readProviderFrontmatter({ tags: ["agent"] })).toEqual({});
	});

	test("returns provider and model when both are strings", () => {
		expect(readProviderFrontmatter({ provider: "openai", model: "gpt-4o" })).toEqual({
			provider: "openai",
			model: "gpt-4o",
		});
	});

	test("ignores empty / non-string values", () => {
		expect(readProviderFrontmatter({ provider: "", model: 42 })).toEqual({});
		expect(readProviderFrontmatter({ provider: null, model: undefined })).toEqual({});
	});
});

describe("withProviderOverrides", () => {
	const BASE: AgentDefinition = {
		name: "pi",
		version: 1,
		sections: { system: "hi" },
		resolvedFrom: ["builtin:pi"],
		frontmatter: { source: "builtin", provider: "anthropic" },
	};

	test("returns the same reference when no override is supplied", () => {
		expect(withProviderOverrides(BASE, {})).toBe(BASE);
		expect(withProviderOverrides(BASE, { providerOverride: "" })).toBe(BASE);
		expect(withProviderOverrides(BASE, { providerOverride: "   " })).toBe(BASE);
	});

	test("folds provider override onto frontmatter", () => {
		const result = withProviderOverrides(BASE, { providerOverride: "openai" });
		expect(result).not.toBe(BASE);
		expect(result.frontmatter.provider).toBe("openai");
		// other frontmatter keys preserved
		expect(result.frontmatter.source).toBe("builtin");
	});

	test("folds model override onto frontmatter without touching provider", () => {
		const result = withProviderOverrides(BASE, { modelOverride: "gpt-4o" });
		expect(result.frontmatter.model).toBe("gpt-4o");
		expect(result.frontmatter.provider).toBe("anthropic");
	});

	test("trims whitespace from overrides", () => {
		const result = withProviderOverrides(BASE, {
			providerOverride: "  openai  ",
			modelOverride: " gpt-4o ",
		});
		expect(result.frontmatter.provider).toBe("openai");
		expect(result.frontmatter.model).toBe("gpt-4o");
	});

	test("does not mutate the input agent", () => {
		const original = { ...BASE, frontmatter: { ...BASE.frontmatter } };
		withProviderOverrides(BASE, { providerOverride: "openai", modelOverride: "gpt-4o" });
		expect(BASE.frontmatter).toEqual(original.frontmatter);
	});
});

describe("withMaxCostUsdOverride", () => {
	const BASE: AgentDefinition = {
		name: "pi",
		version: 1,
		sections: { system: "hi" },
		resolvedFrom: ["builtin:pi"],
		frontmatter: { source: "builtin", maxCostUsd: 2 },
	};

	test("returns the same reference when no override is supplied", () => {
		expect(withMaxCostUsdOverride(BASE, undefined)).toBe(BASE);
	});

	test("folds the cap onto frontmatter, overriding the agent's own value (trigger > agent)", () => {
		const result = withMaxCostUsdOverride(BASE, 10);
		expect(result).not.toBe(BASE);
		expect(result.frontmatter.maxCostUsd).toBe(10);
		expect(result.frontmatter.source).toBe("builtin");
	});

	test("does not mutate the input agent", () => {
		const original = { ...BASE, frontmatter: { ...BASE.frontmatter } };
		withMaxCostUsdOverride(BASE, 10);
		expect(BASE.frontmatter).toEqual(original.frontmatter);
	});
});

describe("readToolsFrontmatter", () => {
	test("returns undefined when no tools policy is declared", () => {
		expect(readToolsFrontmatter({})).toBeUndefined();
		expect(readToolsFrontmatter({ provider: "openai" })).toBeUndefined();
		expect(readToolsFrontmatter({ tools: null })).toBeUndefined();
	});

	test("normalizes allow/deny string arrays", () => {
		expect(readToolsFrontmatter({ tools: { allow: ["read", "grep"], deny: ["write"] } })).toEqual({
			allow: ["read", "grep"],
			deny: ["write"],
		});
	});

	test("coerces comma/whitespace-separated strings into arrays (cn --fm shape)", () => {
		expect(readToolsFrontmatter({ tools: { allow: "read, grep  bash" } })).toEqual({
			allow: ["read", "grep", "bash"],
		});
	});

	test("coerces boolean flags and tolerates true/false strings (warren-5f07 trap)", () => {
		expect(readToolsFrontmatter({ tools: { noTools: true } })).toEqual({ noTools: true });
		expect(readToolsFrontmatter({ tools: { noBuiltins: "true" } })).toEqual({
			noBuiltins: true,
		});
		expect(readToolsFrontmatter({ tools: { noBuiltins: "false" } })).toEqual({
			noBuiltins: false,
		});
	});

	test("drops empty allow/deny so they are indistinguishable from omitted", () => {
		expect(readToolsFrontmatter({ tools: { allow: [], deny: "  " } })).toBeUndefined();
	});

	test("rejects a non-object tools value", () => {
		expect(() => readToolsFrontmatter({ tools: "read" }, "patrol")).toThrow(AgentSchemaError);
		expect(() => readToolsFrontmatter({ tools: ["read"] }, "patrol")).toThrow(/must be an object/);
	});

	test("rejects malformed allow entries and flag values", () => {
		expect(() => readToolsFrontmatter({ tools: { allow: 42 } }, "patrol")).toThrow(
			AgentSchemaError,
		);
		expect(() => readToolsFrontmatter({ tools: { allow: [1, 2] } }, "patrol")).toThrow(
			/entries must be strings/,
		);
		expect(() => readToolsFrontmatter({ tools: { noTools: "yes" } }, "patrol")).toThrow(
			/must be a boolean/,
		);
	});

	test("parseRenderedAgent freezes the normalized policy onto frontmatter", () => {
		const def = parseRenderedAgent({
			success: true,
			command: "render",
			name: "reviewer",
			version: 1,
			sections: [{ name: "system", body: "review only" }],
			frontmatter: { tools: { allow: "read, grep", noBuiltins: "true" } },
		});
		expect(def.frontmatter.tools).toEqual({ allow: ["read", "grep"], noBuiltins: true });
	});

	test("parseRenderedAgent rejects a malformed tools policy", () => {
		expect(() =>
			parseRenderedAgent({
				success: true,
				command: "render",
				name: "reviewer",
				version: 1,
				sections: [{ name: "system", body: "x" }],
				frontmatter: { tools: "read" },
			}),
		).toThrow(/frontmatter\.tools must be an object/);
	});
});
