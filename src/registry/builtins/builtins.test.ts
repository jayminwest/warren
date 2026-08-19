import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isKnownRuntimeId } from "../../core/wire.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { AgentsRepo } from "../../db/repos/agents.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { ALL_PROMPT_CAPABILITIES, withGatedPromptFragments } from "../prompt-gating.ts";
import {
	AgentNameSchema,
	parseRenderedAgent,
	type RenderResponse,
	readRuntimeId,
} from "../schema.ts";
import {
	BUILTIN_AGENT_NAMES,
	BUILTIN_AGENTS,
	CLAUDE_CODE_BUILTIN,
	PI_BUILTIN,
	PLANNER_BUILTIN,
	PR_FIXER_BUILTIN,
	readAgentSource,
	seedBuiltinAgents,
	stampAgentSource,
} from "./index.ts";

describe("BUILTIN_AGENTS", () => {
	test("includes claude-code, pi, planner, pr-fixer, and healer", () => {
		expect(BUILTIN_AGENT_NAMES.has("claude-code")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("sapling")).toBe(false);
		expect(BUILTIN_AGENT_NAMES.has("pi")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("brainstorm")).toBe(false);
		expect(BUILTIN_AGENT_NAMES.has("planner")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("pr-fixer")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("leveret")).toBe(false);
		expect(BUILTIN_AGENT_NAMES.has("healer")).toBe(true);
	});

	test("each builtin name passes the shared kebab grammar (warren-2b75)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(AgentNameSchema.safeParse(builtin.name).success).toBe(true);
		}
	});

	test("each builtin has a non-empty system section (warren's required schema field)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(builtin.sections.system?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("each builtin round-trips through parseRenderedAgent (the canopy schema)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			const renderResponse: RenderResponse = {
				success: true,
				command: "render",
				name: builtin.name,
				version: builtin.version,
				sections: Object.entries(builtin.sections).map(([name, body]) => ({ name, body })),
				resolvedFrom: [...builtin.resolvedFrom],
				frontmatter: { ...builtin.frontmatter },
			};
			const parsed = parseRenderedAgent(renderResponse, builtin.name);
			expect(parsed.name).toBe(builtin.name);
			expect(parsed.sections.system).toBe(builtin.sections.system);
		}
	});

	// warren-c4be: every shipped built-in must resolve to a runtime burrow
	// actually knows. warren-ebca was exactly this failing at dispatch instead.
	test("each builtin resolves to a known runtime id (warren-c4be)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(isKnownRuntimeId(readRuntimeId(builtin))).toBe(true);
		}
	});

	test("each builtin's frontmatter declares source = 'builtin' for provenance", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(builtin.frontmatter.source).toBe("builtin");
		}
	});

	// warren-3305: no builtin runtime consumes steering mid-run (pi reads
	// stdin only at a turn boundary and warren closes stdin at agent_end), so
	// every builtin must declare spawn-only — the flag drives the 409 that
	// replaced the silent steer.sent no-op.
	test("each builtin declares steering: 'spawn-only' (warren-3305)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(builtin.frontmatter.steering).toBe("spawn-only");
		}
	});

	// warren-6a34: the operating-contract block for the three interactive
	// coding built-ins must frame the quality gate as terminal, not advisory.
	// This regression test prevents the bullet from drifting back to softer
	// "run gates before committing" wording that lets agents declare success
	// on a red tree.
	test("claude-code / pi declare the quality gate as terminal (warren-6a34)", () => {
		for (const builtin of [CLAUDE_CODE_BUILTIN, PI_BUILTIN]) {
			const system = builtin.sections.system ?? "";
			expect(system).toContain("$WARREN_QUALITY_GATE");
			expect(system).toContain("NOT done until the gate exits zero");
			expect(system).toContain("Do not declare the task complete");
			expect(system).toContain("red gate");
		}
	});
});

describe("readAgentSource", () => {
	test("returns 'builtin' when frontmatter.source === 'builtin'", () => {
		expect(readAgentSource(CLAUDE_CODE_BUILTIN)).toBe("builtin");
		expect(readAgentSource(PI_BUILTIN)).toBe("builtin");
		expect(readAgentSource(PLANNER_BUILTIN)).toBe("builtin");
	});

	test("returns 'library' for arbitrary library-shaped renderedJson", () => {
		expect(readAgentSource({ name: "foo", sections: { system: "..." }, frontmatter: {} })).toBe(
			"library",
		);
		// Canopy doesn't set frontmatter.source, so unset frontmatter falls back to library.
		expect(readAgentSource({ name: "foo" })).toBe("library");
	});

	test("returns 'library' for malformed renderedJson", () => {
		expect(readAgentSource(null)).toBe("library");
		expect(readAgentSource("not-an-object")).toBe("library");
		expect(readAgentSource(42)).toBe("library");
	});
});

describe("stampAgentSource", () => {
	test("returns a new agent with frontmatter.source set to the given source", () => {
		const stamped = stampAgentSource(CLAUDE_CODE_BUILTIN, "library");
		expect(stamped).not.toBe(CLAUDE_CODE_BUILTIN);
		expect(stamped.frontmatter.source).toBe("library");
		// Original is untouched.
		expect(CLAUDE_CODE_BUILTIN.frontmatter.source).toBe("builtin");
	});

	test("preserves other frontmatter fields", () => {
		const stamped = stampAgentSource(CLAUDE_CODE_BUILTIN, "library");
		expect(stamped.frontmatter.tags).toEqual(["agent"]);
	});
});

describe("PLANNER_BUILTIN", () => {
	test("is registered as an interactive scout with narrow write scope", () => {
		// pl-0344 step 7 / warren-543d: planner pairs with brainstorm as
		// the second interactive built-in. The interactive tag lets the UI
		// surface it under interactive-run pickers without parsing the
		// system prompt.
		expect(PLANNER_BUILTIN.name).toBe("planner");
		expect(PLANNER_BUILTIN.frontmatter.tags).toContain("interactive");
	});

	test("system prompt allows .seeds/ writes only, forbids source + dispatch", () => {
		// Warren's burrow_config only forwards [sandbox].network onto
		// POST /burrows (src/runs/burrow_config.ts), so the path-scoped
		// write contract is enforced in the prompt for now. These string
		// checks pin the contract so a casual edit doesn't silently widen
		// the role. Asserted against the fully-composed render (warren-cb46)
		// because the tracker text now rides gatedPrompts.
		const system = withGatedPromptFragments(PLANNER_BUILTIN, ALL_PROMPT_CAPABILITIES).sections
			.system;
		expect(system).toMatch(/must NOT/);
		expect(system).toMatch(/source files/);
		expect(system).toMatch(/Dispatch agent runs/);
		expect(system).toMatch(/\.seeds\//);
		// warren-427b: plot integration retired (pl-3a79); the prompt must
		// not promise .plot/ writes or a `chore(warren): plot state` commit.
		expect(system).not.toMatch(/\.plot\//);
		expect(system).not.toMatch(/plot state/);
	});

	test("references the sd plan submit pipeline that produces seeds", () => {
		// The planner's only side effect on work items is via
		// `sd plan submit`, which spawns child seeds (mx-77117c documents
		// the 0-BASED `steps[i].blocks` index semantics — the prompt
		// reiterates that so the agent doesn't off-by-one). That text rides
		// gatedPrompts.tracker (warren-cb46) — assert on the composed render.
		const system = withGatedPromptFragments(PLANNER_BUILTIN, ALL_PROMPT_CAPABILITIES).sections
			.system;
		expect(system).toMatch(/sd plan prompt/);
		expect(system).toMatch(/sd plan submit/);
		expect(system).toMatch(/0-BASED/);
	});

	test("declares runtime = 'pi' so dispatch composes on the real runtime", () => {
		// warren-ebca: see BRAINSTORM_BUILTIN's matching test — planner is
		// the other system-prompt-only canopy agent whose name does not
		// match any burrow runtime.
		expect(PLANNER_BUILTIN.frontmatter.runtime).toBe("pi");
	});

	test("refuses to invent Plot intent and defers to brainstorm + formalize", () => {
		// The interactive run primitive (warren-1117) loads Plot context
		// into the prompt. If intent is empty, planner must bounce the user
		// to the brainstorm/formalize flow (warren-3de8 / warren-d22e)
		// rather than fabricate goals.
		const system = PLANNER_BUILTIN.sections.system ?? "";
		expect(system).toMatch(/brainstorm/);
		expect(system).toMatch(/formalize/);
	});

	test("requires open network for scouting external references", () => {
		expect(PLANNER_BUILTIN.sections.burrow_config).toContain('network = "open"');
	});
});

describe("PR_FIXER_BUILTIN", () => {
	test("is registered as a source-editing CI-repair agent (warren-05ea)", () => {
		expect(PR_FIXER_BUILTIN.name).toBe("pr-fixer");
		expect(PR_FIXER_BUILTIN.frontmatter.source).toBe("builtin");
		// Unlike the patrol agents it has no auto_plan_run frontmatter — the
		// CI poller dispatches it directly, not via reap's plan-run path.
		expect(PR_FIXER_BUILTIN.frontmatter.auto_plan_run).toBeUndefined();
	});

	test("declares runtime = 'pi' so dispatch composes on the real runtime", () => {
		expect(PR_FIXER_BUILTIN.frontmatter.runtime).toBe("pi");
	});

	test("system prompt frames the quality gate as terminal and forbids a new PR", () => {
		const system = PR_FIXER_BUILTIN.sections.system ?? "";
		expect(system).toContain("$WARREN_QUALITY_GATE");
		expect(system).toContain("NOT done until the gate exits zero");
		expect(system).toMatch(/do NOT open a new pull request/i);
		expect(system).toMatch(/Do not run `git push`/);
	});

	test("system prompt forbids deleting/skipping failing tests as a workaround", () => {
		const system = PR_FIXER_BUILTIN.sections.system ?? "";
		expect(system).toMatch(/disable, skip, or delete failing tests/i);
	});
});

describe("seedBuiltinAgents", () => {
	let db: WarrenDb;
	let repo: AgentsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new AgentsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("inserts every builtin into an empty registry", async () => {
		const now = () => new Date("2026-05-10T00:00:00.000Z");
		const result = await seedBuiltinAgents(repo, undefined, now);
		expect([...result.seeded].sort()).toEqual([...BUILTIN_AGENT_NAMES].sort());
		expect(result.skipped).toEqual([]);
		const stored = await repo.get("claude-code");
		expect(stored).not.toBeNull();
		expect(readAgentSource(stored?.renderedJson)).toBe("builtin");
	});

	// warren-c4be: registration is the boundary that can still answer 4xx, but
	// seeding is a BOOT path — it refuses the row loudly instead of throwing,
	// so a legacy/seed-file definition can never take the server down.
	test("refuses to seed an agent whose runtime id is unknown (warren-c4be)", async () => {
		const bad = {
			name: "stub-shell",
			version: 1,
			sections: { system: "hi" },
			resolvedFrom: [],
			frontmatter: { source: "builtin", runtime: "planner" },
		};
		const result = await seedBuiltinAgents(repo, [bad]);
		expect(result.seeded).toEqual([]);
		expect(result.rejected).toHaveLength(1);
		expect(result.rejected[0]?.name).toBe("stub-shell");
		expect(result.rejected[0]?.reason).toMatch(/is not a known runtime id/);
		expect(await repo.get("stub-shell")).toBeNull();
	});

	test("seeds the good agents alongside a rejected one (boot completes)", async () => {
		const bad = {
			name: "bad-runtime",
			version: 1,
			sections: { system: "hi" },
			resolvedFrom: [],
			frontmatter: { source: "builtin", runtime: "nope" },
		};
		const result = await seedBuiltinAgents(repo, [bad, CLAUDE_CODE_BUILTIN]);
		expect(result.seeded).toEqual(["claude-code"]);
		expect(result.rejected.map((r) => r.name)).toEqual(["bad-runtime"]);
		expect(await repo.get("claude-code")).not.toBeNull();
	});

	test("accepts an operator-declared extra runtime id (warren-c4be)", async () => {
		const previous = process.env.WARREN_EXTRA_RUNTIME_IDS;
		process.env.WARREN_EXTRA_RUNTIME_IDS = "stub-shell";
		try {
			const result = await seedBuiltinAgents(repo, [
				{
					name: "stub-shell",
					version: 1,
					sections: { system: "hi" },
					resolvedFrom: [],
					frontmatter: { source: "builtin", runtime: "stub-shell" },
				},
			]);
			expect(result.rejected).toEqual([]);
			expect(result.seeded).toEqual(["stub-shell"]);
		} finally {
			if (previous === undefined) delete process.env.WARREN_EXTRA_RUNTIME_IDS;
			else process.env.WARREN_EXTRA_RUNTIME_IDS = previous;
		}
	});

	test("preserves existing rows (library override) and skips them", async () => {
		// Simulate a prior refresh having installed a canopy 'claude-code' override.
		await repo.upsert({
			name: "claude-code",
			renderedJson: { name: "claude-code", sections: { system: "library override" } },
		});
		const result = await seedBuiltinAgents(repo);
		expect(result.skipped).toContain("claude-code");
		// Library override is preserved; not overwritten by the builtin.
		const stored = await repo.get("claude-code");
		expect(stored).not.toBeNull();
		expect(readAgentSource(stored?.renderedJson)).toBe("library");
	});

	test("is idempotent — second call seeds nothing", async () => {
		await seedBuiltinAgents(repo);
		const second = await seedBuiltinAgents(repo);
		expect(second.seeded).toEqual([]);
		expect([...second.skipped].sort()).toEqual([...BUILTIN_AGENT_NAMES].sort());
	});

	test("re-upserts pre-existing builtin rows when their content/frontmatter has drifted", async () => {
		const oldPlanner = {
			...PLANNER_BUILTIN,
			frontmatter: {
				...PLANNER_BUILTIN.frontmatter,
				runtime: undefined, // Simulates pre-v0.5.1 state where runtime wasn't set
			},
		};

		await repo.upsert({
			name: "planner",
			renderedJson: oldPlanner,
		});

		// Now run seedBuiltinAgents. It should recognize the drift and re-upsert planner.
		const result = await seedBuiltinAgents(repo);
		expect(result.seeded).toContain("planner");

		// The stored version should now have the updated frontmatter with 'runtime' set to 'pi'.
		const stored = await repo.get("planner");
		expect(stored).not.toBeNull();
		const rendered = stored?.renderedJson as { frontmatter: { runtime: string } };
		expect(rendered.frontmatter.runtime).toBe("pi");
	});
});
