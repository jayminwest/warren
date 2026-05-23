import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { AgentsRepo } from "../../db/repos/agents.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { parseRenderedAgent, type RenderResponse } from "../schema.ts";
import {
	agentSourceTier,
	BRAINSTORM_BUILTIN,
	BUILTIN_AGENT_NAMES,
	BUILTIN_AGENTS,
	CLAUDE_CODE_BUILTIN,
	isProjectAgentSource,
	makeProjectAgentSource,
	PI_BUILTIN,
	PLANNER_BUILTIN,
	projectIdFromAgentSource,
	readAgentSource,
	SAPLING_BUILTIN,
	seedBuiltinAgents,
	stampAgentSource,
} from "./index.ts";

describe("BUILTIN_AGENTS", () => {
	test("includes claude-code, sapling, pi, brainstorm, and planner", () => {
		expect(BUILTIN_AGENT_NAMES.has("claude-code")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("sapling")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("pi")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("brainstorm")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("planner")).toBe(true);
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

	test("each builtin's frontmatter declares source = 'builtin' for provenance", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(builtin.frontmatter.source).toBe("builtin");
		}
	});
});

describe("readAgentSource", () => {
	test("returns 'builtin' when frontmatter.source === 'builtin'", () => {
		expect(readAgentSource(CLAUDE_CODE_BUILTIN)).toBe("builtin");
		expect(readAgentSource(SAPLING_BUILTIN)).toBe("builtin");
		expect(readAgentSource(PI_BUILTIN)).toBe("builtin");
		expect(readAgentSource(BRAINSTORM_BUILTIN)).toBe("builtin");
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

	test("returns 'project:<id>' when frontmatter.source carries the project prefix", () => {
		expect(
			readAgentSource({
				name: "refactor-bot",
				sections: { system: "..." },
				frontmatter: { source: "project:prj_aaaaaaaaaaaa" },
			}),
		).toBe("project:prj_aaaaaaaaaaaa");
	});

	test("collapses an empty-suffix project: source back to 'library'", () => {
		// A bare 'project:' string isn't a valid project tier — refusing to
		// pass it through keeps `agentSourceTier` honest for malformed rows.
		expect(
			readAgentSource({
				name: "refactor-bot",
				sections: { system: "..." },
				frontmatter: { source: "project:" },
			}),
		).toBe("library");
	});
});

describe("makeProjectAgentSource / isProjectAgentSource / projectIdFromAgentSource", () => {
	test("round-trip: makeProjectAgentSource then projectIdFromAgentSource", () => {
		const source = makeProjectAgentSource("prj_aaaaaaaaaaaa");
		expect(source).toBe("project:prj_aaaaaaaaaaaa");
		expect(isProjectAgentSource(source)).toBe(true);
		expect(projectIdFromAgentSource(source)).toBe("prj_aaaaaaaaaaaa");
	});

	test("rejects empty projectId", () => {
		expect(() => makeProjectAgentSource("")).toThrow(/non-empty/);
	});

	test("isProjectAgentSource is false for builtin / library / empty-suffix strings", () => {
		expect(isProjectAgentSource("builtin")).toBe(false);
		expect(isProjectAgentSource("library")).toBe(false);
		expect(isProjectAgentSource("project:")).toBe(false);
		expect(isProjectAgentSource("")).toBe(false);
	});

	test("projectIdFromAgentSource returns null for non-project tiers", () => {
		expect(projectIdFromAgentSource("builtin")).toBeNull();
		expect(projectIdFromAgentSource("library")).toBeNull();
	});
});

describe("agentSourceTier", () => {
	test("classifies each tier to a coarse string", () => {
		expect(agentSourceTier("builtin")).toBe("builtin");
		expect(agentSourceTier("library")).toBe("library");
		expect(agentSourceTier(makeProjectAgentSource("prj_aaaaaaaaaaaa"))).toBe("project");
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

	test("stamps a project-tier source via makeProjectAgentSource", () => {
		const stamped = stampAgentSource(
			{
				name: "refactor-bot",
				version: 1,
				sections: { system: "..." },
				resolvedFrom: [],
				frontmatter: {},
			},
			makeProjectAgentSource("prj_aaaaaaaaaaaa"),
		);
		expect(stamped.frontmatter.source).toBe("project:prj_aaaaaaaaaaaa");
		expect(readAgentSource(stamped)).toBe("project:prj_aaaaaaaaaaaa");
		expect(agentSourceTier(readAgentSource(stamped))).toBe("project");
	});
});

describe("BRAINSTORM_BUILTIN", () => {
	test("is registered as an interactive read-only scout", () => {
		// pl-0344 step 6 / warren-3de8: brainstorm pairs with planner as
		// the first interactive built-ins. The interactive tag lets the UI
		// surface it under interactive-run pickers without parsing the
		// system prompt.
		expect(BRAINSTORM_BUILTIN.name).toBe("brainstorm");
		expect(BRAINSTORM_BUILTIN.frontmatter.tags).toContain("interactive");
	});

	test("system prompt forbids workspace writes, plot writes, and dispatch", () => {
		// Warren's burrow_config only forwards [sandbox].network onto
		// POST /burrows (src/runs/burrow_config.ts), so the read-only
		// scout contract is enforced in the prompt for now. These string
		// checks pin the contract so a casual edit doesn't silently widen
		// the role.
		const system = BRAINSTORM_BUILTIN.sections.system ?? "";
		expect(system).toMatch(/read-only scout/i);
		expect(system).toMatch(/must NOT/);
		expect(system).toMatch(/Edit, create, or delete files/);
		expect(system).toMatch(/\.plot\//);
		expect(system).toMatch(/Dispatch runs/);
	});

	test("requires open network for web-fetch scouting", () => {
		expect(BRAINSTORM_BUILTIN.sections.burrow_config).toContain('network = "open"');
	});

	test("drives the user toward the four Plot intent fields", () => {
		// The interactive-run primitive (warren-1117) and the formalize
		// flow (warren-d22e) both expect brainstorm to produce material
		// that maps onto goal / non_goals / constraints / success_criteria.
		const system = BRAINSTORM_BUILTIN.sections.system ?? "";
		expect(system).toMatch(/goal/);
		expect(system).toMatch(/non_goals/);
		expect(system).toMatch(/constraints/);
		expect(system).toMatch(/success_criteria/);
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

	test("system prompt allows .plot/ and .seeds/ writes only, forbids source + dispatch", () => {
		// Warren's burrow_config only forwards [sandbox].network onto
		// POST /burrows (src/runs/burrow_config.ts), so the path-scoped
		// write contract is enforced in the prompt for now. These string
		// checks pin the contract so a casual edit doesn't silently widen
		// the role.
		const system = PLANNER_BUILTIN.sections.system ?? "";
		expect(system).toMatch(/must NOT/);
		expect(system).toMatch(/source files/);
		expect(system).toMatch(/Dispatch agent runs/);
		expect(system).toMatch(/\.plot\//);
		expect(system).toMatch(/\.seeds\//);
	});

	test("references the sd plan submit pipeline that produces seeds", () => {
		// The planner's only side effect on work items is via
		// `sd plan submit`, which spawns child seeds (mx-77117c documents
		// the 0-BASED `steps[i].blocks` index semantics — the prompt
		// reiterates that so the agent doesn't off-by-one).
		const system = PLANNER_BUILTIN.sections.system ?? "";
		expect(system).toMatch(/sd plan prompt/);
		expect(system).toMatch(/sd plan submit/);
		expect(system).toMatch(/0-BASED/);
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
});
