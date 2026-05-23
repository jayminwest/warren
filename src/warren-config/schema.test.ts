import { describe, expect, test } from "bun:test";
import {
	DEFAULT_AGENT_PAUSE_TIMEOUT_MS,
	DEFAULT_PREVIEW_MODE,
	DefaultsConfigSchema,
	interactiveRuntimeOverride,
	KNOWN_RUNTIME_IDS,
	PreviewConfigSchema,
	PreviewModeSchema,
	parseDefaultsConfig,
	parsePreviewFile,
	parseTriggersConfig,
	TriggersConfigSchema,
} from "./schema.ts";

const VALID_TRIGGER = {
	id: "nightly-refactor",
	kind: "cron",
	cron: "0 3 * * *",
	timezone: "UTC",
	seed: "seeds-abc1",
	role: "refactor-bot",
};

describe("TriggersConfigSchema", () => {
	test("accepts an array of cron triggers", () => {
		const parsed = TriggersConfigSchema.safeParse([VALID_TRIGGER]);
		expect(parsed.success).toBe(true);
	});

	test("accepts the optional 6-field cron form (seconds first)", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, cron: "0 0 3 * * *" }]);
		expect(parsed.success).toBe(true);
	});

	test("rejects unknown kinds (preserves room for future webhook triggers)", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, kind: "webhook" }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects strict-extra fields so typos surface loudly", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, oops: 1 }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects malformed cron expressions", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, cron: "every minute" }]);
		expect(parsed.success).toBe(false);
	});

	test("rejects duplicate trigger ids", () => {
		const parsed = TriggersConfigSchema.safeParse([VALID_TRIGGER, VALID_TRIGGER]);
		expect(parsed.success).toBe(false);
	});

	test("rejects ids that aren't kebab/snake-case", () => {
		const parsed = TriggersConfigSchema.safeParse([{ ...VALID_TRIGGER, id: "Nightly Job" }]);
		expect(parsed.success).toBe(false);
	});
});

describe("parseTriggersConfig", () => {
	test("treats null/undefined as an empty trigger list", () => {
		expect(parseTriggersConfig(null)).toEqual({ ok: true, value: [] });
		expect(parseTriggersConfig(undefined)).toEqual({ ok: true, value: [] });
	});

	test("returns ok=true with parsed entries on success", () => {
		const result = parseTriggersConfig([VALID_TRIGGER]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toHaveLength(1);
			expect(result.value[0]?.id).toBe("nightly-refactor");
		}
	});

	test("returns ok=false with a joined message on failure (no throw)", () => {
		const result = parseTriggersConfig([{ ...VALID_TRIGGER, cron: "" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/cron/);
		}
	});
});

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

// warren-7be9 / SPEC §11.L: per-run preview environments (R-19). The schema
// must accept a `type` discriminator from day one so the static-mode follow-up
// (filed under pl-2c59) doesn't break the config.
const VALID_SERVER_PREVIEW = {
	type: "server",
	command: "bun run dev",
	port: 3000,
	readiness_path: "/healthz",
	idle_ttl: "30m",
	max_lifetime: "8h",
};

describe("PreviewConfigSchema", () => {
	test("accepts the full server-type shape from SPEC §11.L", () => {
		const parsed = PreviewConfigSchema.safeParse(VALID_SERVER_PREVIEW);
		expect(parsed.success).toBe(true);
	});

	test("accepts the minimum server shape (command + port only)", () => {
		const parsed = PreviewConfigSchema.safeParse({
			type: "server",
			command: "bun run dev",
			port: 3000,
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts type: 'static' at the parser level (launcher rejects later — warren-f156)", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "static" });
		expect(parsed.success).toBe(true);
	});

	test("rejects unknown type discriminators", () => {
		const parsed = PreviewConfigSchema.safeParse({
			type: "lambda",
			command: "bun run dev",
			port: 3000,
		});
		expect(parsed.success).toBe(false);
	});

	test("rejects missing command for type: server", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "server", port: 3000 });
		expect(parsed.success).toBe(false);
	});

	test("rejects missing port for type: server", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "server", command: "bun run dev" });
		expect(parsed.success).toBe(false);
	});

	test("rejects empty command", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			command: "",
		});
		expect(parsed.success).toBe(false);
	});

	test("rejects non-integer / out-of-range ports", () => {
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 0 }).success).toBe(false);
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 70000 }).success).toBe(
			false,
		);
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 3.14 }).success).toBe(
			false,
		);
		expect(PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: "3000" }).success).toBe(
			false,
		);
	});

	test("accepts privileged ports (1-1023) — sandbox runs unprivileged-by-namespace", () => {
		const parsed = PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, port: 80 });
		expect(parsed.success).toBe(true);
	});

	test("rejects readiness_path that doesn't start with '/'", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			readiness_path: "healthz",
		});
		expect(parsed.success).toBe(false);
	});

	test("accepts duration strings: 30m, 8h, 45s, 1d, 200ms, 1h30m", () => {
		for (const d of ["30m", "8h", "45s", "1d", "200ms", "1h30m"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				idle_ttl: d,
				max_lifetime: d,
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("rejects garbage duration strings", () => {
		for (const d of ["thirty minutes", "30", "m30", "30y", ""]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				idle_ttl: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	// warren-0928: readiness_timeout is shape-validated like idle_ttl but
	// additionally bounded 1s..1h so pathological config (sub-poll polls,
	// >1h ceilings) surfaces at load time rather than reap time.
	test("accepts readiness_timeout within 1s..1h", () => {
		for (const d of ["1s", "30s", "5m", "1h", "59m59s"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				readiness_timeout: d,
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("rejects readiness_timeout under 1s", () => {
		for (const d of ["500ms", "999ms"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				readiness_timeout: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	test("rejects readiness_timeout over 1h", () => {
		for (const d of ["2h", "1h1s", "1d"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				readiness_timeout: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	// warren-d9e7: setup splits dependency-install from dev-server bind so each
	// phase has its own timeout and failure reason. Schema accepts the field at
	// the parser layer; launcher (src/preview/launch.ts) skips the pre-step
	// when the field is absent so existing projects keep working unchanged.
	test("accepts a server preview with setup + setup_timeout (warren-d9e7)", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			setup: "pnpm install",
			setup_timeout: "5m",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "server") {
			expect(parsed.data.setup).toBe("pnpm install");
			expect(parsed.data.setup_timeout).toBe("5m");
		}
	});

	test("accepts setup without setup_timeout (launcher uses default)", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			setup: "pnpm install",
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects empty setup string", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			setup: "",
		});
		expect(parsed.success).toBe(false);
	});

	test("accepts setup_timeout within 1s..1h", () => {
		for (const d of ["1s", "30s", "5m", "1h", "59m59s"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				setup: "pnpm install",
				setup_timeout: d,
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("rejects setup_timeout outside 1s..1h", () => {
		for (const d of ["500ms", "999ms", "2h", "1h1s", "1d"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				setup: "pnpm install",
				setup_timeout: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	// warren-9b15: connect_timeout splits "did anything bind?" from
	// readiness_timeout's "did the bound server return 2xx?". Same 1s..1h
	// bounds and shape-validation pattern as the sibling timeouts.
	test("accepts connect_timeout within 1s..1h (warren-9b15)", () => {
		for (const d of ["1s", "30s", "5m", "1h", "59m59s"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				connect_timeout: d,
			});
			expect(parsed.success).toBe(true);
			if (parsed.success && parsed.data.type === "server") {
				expect(parsed.data.connect_timeout).toBe(d);
			}
		}
	});

	test("rejects connect_timeout outside 1s..1h", () => {
		for (const d of ["500ms", "999ms", "2h", "1h1s", "1d"]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				connect_timeout: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	test("rejects garbage setup_timeout duration strings", () => {
		for (const d of ["five minutes", "30", "m30", "30y", ""]) {
			const parsed = PreviewConfigSchema.safeParse({
				...VALID_SERVER_PREVIEW,
				setup: "pnpm install",
				setup_timeout: d,
			});
			expect(parsed.success).toBe(false);
		}
	});

	test("rejects strict-extra fields on server preview so typos surface loudly", () => {
		const parsed = PreviewConfigSchema.safeParse({
			...VALID_SERVER_PREVIEW,
			ttl: "30m", // common typo: design lock rejected single-TTL collapse
		});
		expect(parsed.success).toBe(false);
	});

	test("keeps idle_ttl and max_lifetime as separate fields (design lock — no single-ttl collapse)", () => {
		const parsed = PreviewConfigSchema.safeParse({
			type: "server",
			command: "bun run dev",
			port: 3000,
			idle_ttl: "30m",
			max_lifetime: "8h",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "server") {
			expect(parsed.data.idle_ttl).toBe("30m");
			expect(parsed.data.max_lifetime).toBe("8h");
		}
	});
});

// warren-fcb7 / SPEC §11.L path-mode addendum (pl-f4ea): operators can pin a
// routing mode in `.warren/preview.yaml`; env wins on conflict (asserted by
// the launch.test.ts loader tests). The schema accepts the field on both
// discriminated-union members so per-project pinning works regardless of
// whether the preview ends up implemented as type:'server' or type:'static'.
describe("PreviewConfigSchema preview mode", () => {
	test("DEFAULT_PREVIEW_MODE is 'path' (zero-domain operators win by default)", () => {
		expect(DEFAULT_PREVIEW_MODE).toBe("path");
	});

	test("PreviewModeSchema accepts 'path' and 'subdomain'", () => {
		expect(PreviewModeSchema.safeParse("path").success).toBe(true);
		expect(PreviewModeSchema.safeParse("subdomain").success).toBe(true);
	});

	test("PreviewModeSchema rejects unknown values (no silent typos)", () => {
		expect(PreviewModeSchema.safeParse("PATH").success).toBe(false);
		expect(PreviewModeSchema.safeParse("subDomain").success).toBe(false);
		expect(PreviewModeSchema.safeParse("").success).toBe(false);
		expect(PreviewModeSchema.safeParse(null).success).toBe(false);
	});

	test("accepts server preview with mode: 'path'", () => {
		const parsed = PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, mode: "path" });
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "server") {
			expect(parsed.data.mode).toBe("path");
		}
	});

	test("accepts server preview with mode: 'subdomain'", () => {
		const parsed = PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, mode: "subdomain" });
		expect(parsed.success).toBe(true);
	});

	test("accepts server preview without mode (operator env decides)", () => {
		const parsed = PreviewConfigSchema.safeParse(VALID_SERVER_PREVIEW);
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.type === "server") {
			expect(parsed.data.mode).toBeUndefined();
		}
	});

	test("rejects unknown mode values on server preview", () => {
		const parsed = PreviewConfigSchema.safeParse({ ...VALID_SERVER_PREVIEW, mode: "lambda" });
		expect(parsed.success).toBe(false);
	});

	test("accepts static preview with mode (passthrough stays permissive)", () => {
		const parsed = PreviewConfigSchema.safeParse({ type: "static", mode: "subdomain" });
		expect(parsed.success).toBe(true);
	});

	test("parsePreviewFile threads mode into the parsed value", () => {
		const result = parsePreviewFile({ ...VALID_SERVER_PREVIEW, mode: "subdomain" });
		expect(result.ok).toBe(true);
		if (result.ok && result.value !== null && result.value.type === "server") {
			expect(result.value.mode).toBe("subdomain");
		}
	});

	test("parsePreviewFile surfaces unknown mode values via the error envelope", () => {
		const result = parsePreviewFile({ ...VALID_SERVER_PREVIEW, mode: "weird" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/mode/);
		}
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
