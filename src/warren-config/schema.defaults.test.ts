import { describe, expect, test } from "bun:test";
import { VALID_SERVER_PREVIEW } from "./schema.test-helpers.ts";
import {
	DEFAULT_CI_FIXER_COOLDOWN_MINUTES,
	DEFAULT_CI_FIXER_LOG_TAIL_LINES,
	DEFAULT_CI_FIXER_MAX_RETRIES,
	DEFAULT_CI_FIXER_ROLE,
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

	test("accepts a positive maxCostUsd project-wide spend cap (warren-a63d)", () => {
		const parsed = DefaultsConfigSchema.safeParse({ maxCostUsd: 2.5 });
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.maxCostUsd).toBe(2.5);
	});

	test("rejects a non-positive or string maxCostUsd", () => {
		for (const bad of [0, -1, "2.5"]) {
			expect(DefaultsConfigSchema.safeParse({ maxCostUsd: bad }).success).toBe(false);
		}
	});

	test("rejects extra fields so typos surface loudly", () => {
		const parsed = DefaultsConfigSchema.safeParse({ defaultRoll: "claude-code" });
		expect(parsed.success).toBe(false);
	});

	test("accepts an admission block with a positive maxConcurrentRuns (warren-b6f2)", () => {
		const parsed = DefaultsConfigSchema.safeParse({ admission: { maxConcurrentRuns: 3 } });
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.admission?.maxConcurrentRuns).toBe(3);
	});

	test("accepts an empty admission block (uses the provider default)", () => {
		expect(DefaultsConfigSchema.safeParse({ admission: {} }).success).toBe(true);
	});

	test("rejects a non-positive / non-integer maxConcurrentRuns (warren-b6f2)", () => {
		expect(DefaultsConfigSchema.safeParse({ admission: { maxConcurrentRuns: 0 } }).success).toBe(
			false,
		);
		expect(DefaultsConfigSchema.safeParse({ admission: { maxConcurrentRuns: -1 } }).success).toBe(
			false,
		);
		expect(DefaultsConfigSchema.safeParse({ admission: { maxConcurrentRuns: 2.5 } }).success).toBe(
			false,
		);
	});

	test("rejects unknown keys inside the admission block", () => {
		expect(DefaultsConfigSchema.safeParse({ admission: { maxConcurrent: 3 } }).success).toBe(false);
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

describe("DefaultsConfigSchema agent block (warren-8f4c)", () => {
	test("accepts an explicit skipGitHooks flag", () => {
		const parsed = DefaultsConfigSchema.safeParse({ agent: { skipGitHooks: true } });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.agent?.skipGitHooks).toBe(true);
		}
	});

	test("accepts an empty agent block", () => {
		const parsed = DefaultsConfigSchema.safeParse({ agent: {} });
		expect(parsed.success).toBe(true);
	});

	test("leaves agent undefined when the block is omitted entirely", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.agent).toBeUndefined();
		}
	});

	test("rejects unknown fields inside agent (strict)", () => {
		expect(
			DefaultsConfigSchema.safeParse({
				agent: { skipGitHooks: true, unknownField: true },
			}).success,
		).toBe(false);
	});
});

describe("DefaultsConfigSchema interactiveAgents block (warren-b802)", () => {
	test("accepts all known runtime ids for plannerRuntime", () => {
		for (const id of KNOWN_RUNTIME_IDS) {
			const parsed = DefaultsConfigSchema.safeParse({
				interactiveAgents: { plannerRuntime: id },
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("accepts plannerRuntime field", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			interactiveAgents: { plannerRuntime: "sapling" },
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.interactiveAgents?.plannerRuntime).toBe("sapling");
		}
	});

	test("accepts empty block (plannerRuntime optional)", () => {
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
				interactiveAgents: { plannerRuntime: "gpt-4o" },
			}).success,
		).toBe(false);
	});

	test("rejects unknown fields inside interactiveAgents (strict)", () => {
		expect(
			DefaultsConfigSchema.safeParse({
				interactiveAgents: { plannerRuntime: "pi", extra: true },
			}).success,
		).toBe(false);
	});
});

describe("interactiveRuntimeOverride (warren-b802)", () => {
	test("returns undefined when defaults is null/undefined", () => {
		expect(interactiveRuntimeOverride("planner", null)).toBeUndefined();
		expect(interactiveRuntimeOverride("planner", undefined)).toBeUndefined();
	});

	test("returns undefined when interactiveAgents block is absent", () => {
		expect(interactiveRuntimeOverride("planner", {})).toBeUndefined();
	});

	test("returns the configured runtime for planner", () => {
		const defaults = { interactiveAgents: { plannerRuntime: "sapling" as const } };
		expect(interactiveRuntimeOverride("planner", defaults)).toBe("sapling");
	});

	test("returns undefined for non-interactive agents", () => {
		const defaults = {
			interactiveAgents: {
				plannerRuntime: "sapling" as const,
			},
		};
		expect(interactiveRuntimeOverride("claude-code", defaults)).toBeUndefined();
		expect(interactiveRuntimeOverride("pi", defaults)).toBeUndefined();
	});

	test("returns undefined when the specific field is not set", () => {
		const defaults = { interactiveAgents: {} };
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

describe("DefaultsConfigSchema ciFixer block (warren-05ea)", () => {
	test("applies defaults when the block is present but fields are omitted", () => {
		const parsed = DefaultsConfigSchema.safeParse({ ciFixer: {} });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.ciFixer?.enabled).toBe(false);
			expect(parsed.data.ciFixer?.maxRetries).toBe(DEFAULT_CI_FIXER_MAX_RETRIES);
			expect(parsed.data.ciFixer?.cooldownMinutes).toBe(DEFAULT_CI_FIXER_COOLDOWN_MINUTES);
			expect(parsed.data.ciFixer?.logTailLines).toBe(DEFAULT_CI_FIXER_LOG_TAIL_LINES);
			expect(parsed.data.ciFixer?.role).toBe(DEFAULT_CI_FIXER_ROLE);
		}
	});

	test("accepts an explicit opt-in with overrides", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			ciFixer: {
				enabled: true,
				maxRetries: 3,
				cooldownMinutes: 5,
				logTailLines: 50,
				role: "my-fixer",
			},
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.ciFixer?.enabled).toBe(true);
			expect(parsed.data.ciFixer?.maxRetries).toBe(3);
			expect(parsed.data.ciFixer?.role).toBe("my-fixer");
		}
	});

	test("leaves ciFixer undefined when the block is omitted", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.ciFixer).toBeUndefined();
	});

	test("rejects out-of-range knobs and unknown fields", () => {
		expect(DefaultsConfigSchema.safeParse({ ciFixer: { maxRetries: -1 } }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ ciFixer: { maxRetries: 11 } }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ ciFixer: { cooldownMinutes: 2000 } }).success).toBe(
			false,
		);
		expect(DefaultsConfigSchema.safeParse({ ciFixer: { logTailLines: 0 } }).success).toBe(false);
		expect(DefaultsConfigSchema.safeParse({ ciFixer: { unknownField: true } }).success).toBe(false);
	});
});
