import { describe, expect, test } from "bun:test";
import { VALID_SERVER_PREVIEW } from "./schema.test-helpers.ts";
import {
	DEFAULT_AGENT_PAUSE_TIMEOUT_MS,
	DefaultsConfigSchema,
	interactiveRuntimeOverride,
	KNOWN_RUNTIME_IDS,
	parseDefaultsConfig,
} from "./schema.ts";

describe("DefaultsConfigSchema", () => {
	test("accepts the full shape", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			defaultRole: "claude-code",
			defaultBranch: "main",
			defaultPrompt: "Read the issue, plan, execute.",
			defaultProvider: "anthropic",
			defaultModel: "claude-opus-4-7",
			runBranchPrefix: "warren",
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts an empty object (operators may keep the file as documentation)", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
	});

	test("rejects extra fields so typos surface loudly", () => {
		const parsed = DefaultsConfigSchema.safeParse({ defaultRoll: "claude-code" });
		expect(parsed.success).toBe(false);
	});

	test("rejects empty-string overrides", () => {
		expect(DefaultsConfigSchema.safeParse({ defaultRole: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultBranch: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultPrompt: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultProvider: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ defaultModel: "" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "" }).success).toBe(false);
	});

	test("rejects role names that aren't canopy-shaped", () => {
		const parsed = DefaultsConfigSchema.safeParse({ defaultRole: "Refactor Bot" });
		expect(parsed.success).toBe(false);
	});

	test("rejects runBranchPrefix that contains slashes or other invalid chars (warren-9993)", () => {
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "bot/agent" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "Warren" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: ".warren" }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "warren agent" }).success).toBe(false);
	});

	test("accepts kebab-case runBranchPrefix (warren-9993)", () => {
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "warren" }).success).toBe(true);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "agent-1" }).success).toBe(true);
		expect(DefaultsConfigSchema.safeParse({ runBranchPrefix: "bot.fix" }).success).toBe(true);
	});
});

describe("DefaultsConfigSchema agent block (warren-cd37)", () => {
	test("DEFAULT_AGENT_PAUSE_TIMEOUT_MS is 30 minutes in milliseconds", () => {
		expect(DEFAULT_AGENT_PAUSE_TIMEOUT_MS).toBe(1_800_000);
	});

	test("applies DEFAULT_AGENT_PAUSE_TIMEOUT_MS when agent block is present but field omitted", () => {
		const parsed = DefaultsConfigSchema.safeParse({ agent: {} });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.agent?.pauseTimeoutMs).toBe(DEFAULT_AGENT_PAUSE_TIMEOUT_MS);
		}
	});

	test("accepts an explicit pauseTimeoutMs override", () => {
		const parsed = DefaultsConfigSchema.safeParse({ agent: { pauseTimeoutMs: 60_000 } });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.agent?.pauseTimeoutMs).toBe(60_000);
		}
	});

	test("leaves agent undefined when the block is omitted entirely", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.agent).toBeUndefined();
		}
	});

	test("rejects pauseTimeoutMs below 1s", () => {
		expect(DefaultsConfigSchema.safeParse({ agent: { pauseTimeoutMs: 500 } }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ agent: { pauseTimeoutMs: 0 } }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ agent: { pauseTimeoutMs: -1 } }).success).toBe(false);
	});

	test("rejects pauseTimeoutMs above 24h", () => {
		expect(DefaultsConfigSchema.safeParse({ agent: { pauseTimeoutMs: 86_400_001 } }).success).toBe(
			false,
		);
	});

	test("accepts the boundary values", () => {
		expect(DefaultsConfigSchema.safeParse({ agent: { pauseTimeoutMs: 1_000 } }).success).toBe(true);
		expect(DefaultsConfigSchema.safeParse({ agent: { pauseTimeoutMs: 86_400_000 } }).success).toBe(
			true,
		);
	});

	test("rejects non-integer pauseTimeoutMs", () => {
		expect(DefaultsConfigSchema.safeParse({ agent: { pauseTimeoutMs: 1500.5 } }).success).toBe(
			false,
		);
	});

	test("rejects unknown fields inside agent (strict)", () => {
		expect(
			DefaultsConfigSchema.safeParse({
				agent: { pauseTimeoutMs: 60_000, unknownField: true },
			}).success,
		).toBe(false);
	});
});

describe("DefaultsConfigSchema interactiveAgents block (warren-b802)", () => {
	test("accepts all known runtime ids for brainstormRuntime", () => {
		for (const id of KNOWN_RUNTIME_IDS) {
			const parsed = DefaultsConfigSchema.safeParse({
				interactiveAgents: { brainstormRuntime: id },
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("accepts all known runtime ids for plannerRuntime", () => {
		for (const id of KNOWN_RUNTIME_IDS) {
			const parsed = DefaultsConfigSchema.safeParse({
				interactiveAgents: { plannerRuntime: id },
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("accepts both fields together", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			interactiveAgents: { brainstormRuntime: "claude-code", plannerRuntime: "sapling" },
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.interactiveAgents?.brainstormRuntime).toBe("claude-code");
			expect(parsed.data.interactiveAgents?.plannerRuntime).toBe("sapling");
		}
	});

	test("accepts empty block (both fields optional)", () => {
		const parsed = DefaultsConfigSchema.safeParse({ interactiveAgents: {} });
		expect(parsed.success).toBe(true);
	});

	test("leaves interactiveAgents undefined when the block is omitted", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.interactiveAgents).toBeUndefined();
		}
	});

	test("rejects unknown runtime ids (typo protection)", () => {
		expect(
			DefaultsConfigSchema.safeParse({
				interactiveAgents: { brainstormRuntime: "openai" },
			}).success,
		).toBe(false);
		expect(
			DefaultsConfigSchema.safeParse({
				interactiveAgents: { plannerRuntime: "gpt-4o" },
			}).success,
		).toBe(false);
	});

	test("rejects unknown fields inside interactiveAgents (strict)", () => {
		expect(
			DefaultsConfigSchema.safeParse({
				interactiveAgents: { brainstormRuntime: "pi", extra: true },
			}).success,
		).toBe(false);
	});
});

describe("DefaultsConfigSchema plotSync block (warren-cd22)", () => {
	test("accepts valid mergeStrategy values", () => {
		for (const strategy of ["immediate", "auto", "manual"] as const) {
			const parsed = DefaultsConfigSchema.safeParse({
				plotSync: { mergeStrategy: strategy },
			});
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(parsed.data.plotSync?.mergeStrategy).toBe(strategy);
			}
		}
	});

	test("accepts a valid targetBranch", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			plotSync: { targetBranch: "main" },
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.plotSync?.targetBranch).toBe("main");
		}
	});

	test("accepts both fields together", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			plotSync: { mergeStrategy: "immediate", targetBranch: "develop" },
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.plotSync?.mergeStrategy).toBe("immediate");
			expect(parsed.data.plotSync?.targetBranch).toBe("develop");
		}
	});

	test("accepts empty block (both fields optional)", () => {
		const parsed = DefaultsConfigSchema.safeParse({ plotSync: {} });
		expect(parsed.success).toBe(true);
	});

	test("leaves plotSync undefined when the block is omitted", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.plotSync).toBeUndefined();
		}
	});

	test("rejects unknown mergeStrategy values (typo protection)", () => {
		expect(
			DefaultsConfigSchema.safeParse({
				plotSync: { mergeStrategy: "always" },
			}).success,
		).toBe(false);
		expect(
			DefaultsConfigSchema.safeParse({
				plotSync: { mergeStrategy: "never" },
			}).success,
		).toBe(false);
	});

	test("rejects empty-string targetBranch", () => {
		expect(
			DefaultsConfigSchema.safeParse({
				plotSync: { targetBranch: "" },
			}).success,
		).toBe(false);
	});

	test("rejects unknown fields inside plotSync (strict)", () => {
		expect(
			DefaultsConfigSchema.safeParse({
				plotSync: { mergeStrategy: "auto", extra: true },
			}).success,
		).toBe(false);
	});
});

describe("interactiveRuntimeOverride (warren-b802)", () => {
	test("returns undefined when defaults is null/undefined", () => {
		expect(interactiveRuntimeOverride("brainstorm", null)).toBeUndefined();
		expect(interactiveRuntimeOverride("planner", undefined)).toBeUndefined();
	});

	test("returns undefined when interactiveAgents block is absent", () => {
		expect(interactiveRuntimeOverride("brainstorm", {})).toBeUndefined();
		expect(interactiveRuntimeOverride("planner", {})).toBeUndefined();
	});

	test("returns the configured runtime for brainstorm", () => {
		const defaults = { interactiveAgents: { brainstormRuntime: "claude-code" as const } };
		expect(interactiveRuntimeOverride("brainstorm", defaults)).toBe("claude-code");
	});

	test("returns the configured runtime for planner", () => {
		const defaults = { interactiveAgents: { plannerRuntime: "sapling" as const } };
		expect(interactiveRuntimeOverride("planner", defaults)).toBe("sapling");
	});

	test("returns undefined for non-interactive agents", () => {
		const defaults = {
			interactiveAgents: {
				brainstormRuntime: "claude-code" as const,
				plannerRuntime: "sapling" as const,
			},
		};
		expect(interactiveRuntimeOverride("claude-code", defaults)).toBeUndefined();
		expect(interactiveRuntimeOverride("pi", defaults)).toBeUndefined();
	});

	test("returns undefined when the specific field is not set", () => {
		const defaults = { interactiveAgents: { brainstormRuntime: "pi" as const } };
		expect(interactiveRuntimeOverride("planner", defaults)).toBeUndefined();
	});
});

describe("parseDefaultsConfig", () => {
	test("treats null/undefined as an empty defaults block", () => {
		expect(parseDefaultsConfig(null)).toEqual({ ok: true, value: {} });
		expect(parseDefaultsConfig(undefined)).toEqual({ ok: true, value: {} });
	});

	test("returns ok=false on schema failure (no throw)", () => {
		const result = parseDefaultsConfig({ defaultBranch: 42 });
		expect(result.ok).toBe(false);
	});
});

describe("DefaultsConfigSchema preview block", () => {
	test("accepts defaults with no preview block (opt-in, missing is not an error)", () => {
		const parsed = DefaultsConfigSchema.safeParse({ defaultRole: "claude-code" });
		expect(parsed.success).toBe(true);
	});

	test("accepts defaults with a valid preview block", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			defaultRole: "claude-code",
			preview: VALID_SERVER_PREVIEW,
		});
		expect(parsed.success).toBe(true);
	});

	test("propagates preview parse failures up through DefaultsConfig (surfaces in errors envelope)", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			preview: { type: "server", command: "bun run dev" /* missing port */ },
		});
		expect(parsed.success).toBe(false);
	});

	test("propagates preview parse failures via parseDefaultsConfig too (no throw)", () => {
		const result = parseDefaultsConfig({
			preview: { type: "server", command: "", port: 3000 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/preview/);
			expect(result.message).toMatch(/command/);
		}
	});
});
