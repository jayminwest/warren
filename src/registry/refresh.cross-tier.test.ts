import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { AgentsRepo } from "../db/repos/agents.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { buildSpawn, CanopyClient, renderMissingParent, showOk } from "./refresh.test-helpers.ts";
import { refreshProjectAgents } from "./refresh.ts";

// Cross-tier inheritance (warren-44a3) — extracted from refresh.test.ts.
describe("refreshProjectAgents cross-tier inheritance", () => {
	let db: WarrenDb;
	let agents: AgentsRepo;
	let projects: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		const adapter = DrizzleAdapter.for(db);
		agents = new AgentsRepo(adapter);
		projects = new ProjectsRepo(adapter);
	});

	afterEach(async () => {
		await db.close();
	});

	const seedProject = async () => {
		const p = await projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		return p.id;
	};

	test("composes a project-tier role that extends a built-in agent", async () => {
		const projectId = await seedProject();
		// Pre-seed the global tier with a "claude-code" built-in.
		await agents.upsert({
			name: "claude-code",
			renderedJson: {
				name: "claude-code",
				version: 1,
				sections: { system: "builtin-system", workflow: "builtin-workflow" },
				resolvedFrom: ["claude-code"],
				frontmatter: { source: "builtin", provider: "anthropic" },
			},
		});
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "refactor-bot", version: 1, status: "active" }],
			},
			{
				// cn render fails because canopy can't find the cross-tier parent.
				"refactor-bot": renderMissingParent("claude-code"),
			},
			{
				// cn show returns the raw project prompt with extends: claude-code.
				"refactor-bot": showOk("refactor-bot", {
					sections: { system: "refactor-system", expertise_seed: "refactor-seed" },
					extends: "claude-code",
					frontmatter: { model: "claude-sonnet-4-6" },
				}),
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		const result = await refreshProjectAgents({ client, agents, projectId });

		expect(result.skipped).toEqual([]);
		expect(result.registered.map((r) => r.name)).toEqual(["refactor-bot"]);
		const row = await agents.require("refactor-bot", { projectId });
		const def = row.renderedJson as {
			sections: Record<string, string>;
			frontmatter: { source: string; provider?: string; model?: string };
			resolvedFrom: string[];
		};
		// Built-in system overridden, built-in workflow preserved, project's expertise_seed added.
		expect(def.sections).toEqual({
			system: "refactor-system",
			workflow: "builtin-workflow",
			expertise_seed: "refactor-seed",
		});
		// Source stamp reflects the LEAF tier, not the built-in parent.
		expect(def.frontmatter.source).toBe(`project:${projectId}`);
		// Parent frontmatter merged in; focal frontmatter still applied; source overlay last.
		expect(def.frontmatter.provider).toBe("anthropic");
		expect(def.frontmatter.model).toBe("claude-sonnet-4-6");
		expect(def.resolvedFrom).toEqual(["claude-code", "refactor-bot"]);
	});

	test("composes a project-tier role whose chain walks through a library parent", async () => {
		const projectId = await seedProject();
		// Library-tier parent (no source stamp; readAgentSource collapses to library).
		await agents.upsert({
			name: "library-base",
			renderedJson: {
				name: "library-base",
				version: 2,
				sections: { system: "lib-system", verbose: "lib-verbose" },
				resolvedFrom: ["library-base"],
				frontmatter: {},
			},
		});
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "tuned", version: 1, status: "active" }],
			},
			{ tuned: renderMissingParent("library-base") },
			{
				tuned: showOk("tuned", {
					sections: { skills: "tuned-skills" },
					extends: "library-base",
				}),
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		const result = await refreshProjectAgents({ client, agents, projectId });
		expect(result.skipped).toEqual([]);
		const row = await agents.require("tuned", { projectId });
		const def = row.renderedJson as {
			sections: Record<string, string>;
			frontmatter: { source: string };
		};
		expect(def.sections).toEqual({
			system: "lib-system",
			verbose: "lib-verbose",
			skills: "tuned-skills",
		});
		expect(def.frontmatter.source).toBe(`project:${projectId}`);
	});

	test("source stamping walks past a same-named project-tier shadow to a real built-in parent", async () => {
		// The seed's open question: project has its own role NAMED claude-code
		// AND another role that `extends: claude-code`. Parent resolution
		// must NOT loop on the project shadow — it should bottom out at the
		// global built-in. Because both project prompts live in the project's
		// .canopy/, canopy's own resolver actually handles this case (in-tier
		// extends). We assert the merge result is correct end-to-end.
		const projectId = await seedProject();
		await agents.upsert({
			name: "claude-code",
			renderedJson: {
				name: "claude-code",
				version: 1,
				sections: { system: "builtin", workflow: "wf" },
				resolvedFrom: ["claude-code"],
				frontmatter: { source: "builtin" },
			},
		});
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					// The project-tier shadow of claude-code itself extends the built-in.
					{ name: "claude-code", version: 1, status: "active" },
					{ name: "tuned", version: 1, status: "active" },
				],
			},
			{
				// Both renders bail because the chain points outside the project.
				"claude-code": renderMissingParent("claude-code"),
				tuned: renderMissingParent("claude-code"),
			},
			{
				"claude-code": showOk("claude-code", {
					sections: { workflow: "project-workflow" },
					extends: "claude-code",
				}),
				tuned: showOk("tuned", {
					sections: { system: "tuned-system" },
					extends: "claude-code",
				}),
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		const result = await refreshProjectAgents({ client, agents, projectId });
		expect(result.skipped).toEqual([]);
		const tuned = (await agents.require("tuned", { projectId })).renderedJson as {
			sections: Record<string, string>;
			frontmatter: { source: string };
			resolvedFrom: string[];
		};
		// tuned → project-tier "claude-code" (workflow override) → built-in "claude-code"
		// (system + workflow). tuned's own system wins.
		expect(tuned.sections).toEqual({
			system: "tuned-system",
			workflow: "project-workflow",
		});
		expect(tuned.frontmatter.source).toBe(`project:${projectId}`);
		// Built-in claude-code, project shadow, focal — three hops.
		expect(tuned.resolvedFrom).toEqual(["claude-code", "claude-code", "tuned"]);
	});

	test("when compose fails because the parent doesn't exist anywhere, surface the compose error in skipped", async () => {
		const projectId = await seedProject();
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "orphan", version: 1, status: "active" }],
			},
			{ orphan: renderMissingParent("missing-parent") },
			{
				orphan: showOk("orphan", {
					sections: { system: "orphan-system" },
					extends: "missing-parent",
				}),
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		const result = await refreshProjectAgents({ client, agents, projectId });
		expect(result.registered).toEqual([]);
		expect(result.skipped[0]).toMatchObject({
			name: "orphan",
			code: "agent_schema_error",
			reason: expect.stringContaining("missing-parent"),
		});
	});

	test("falls back to the original canopy skip when the focal prompt has no inheritance", async () => {
		// A "Prompt not found" failure on a focal prompt with NO extends/mixins
		// is a genuine missing-prompt case (e.g. archived between list and
		// render) — compose should not mask it, and the original canopy
		// error should be returned.
		const projectId = await seedProject();
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "raced-bot", version: 1, status: "active" }],
			},
			{
				"raced-bot": {
					exit: 1,
					ok: { success: false, command: "render", error: `Prompt "raced-bot" not found` },
				},
			},
			{
				"raced-bot": showOk("raced-bot", {
					sections: { system: "x" },
					// No extends, no mixins → compose returns null and the canopy
					// render skip survives.
				}),
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		const result = await refreshProjectAgents({ client, agents, projectId });
		expect(result.registered).toEqual([]);
		expect(result.skipped[0]).toMatchObject({
			name: "raced-bot",
			code: "canopy_unavailable",
			reason: expect.stringContaining("raced-bot"),
		});
	});

	test("composed agent missing required system section is surfaced as agent_schema_error", async () => {
		const projectId = await seedProject();
		await agents.upsert({
			name: "minimal-base",
			renderedJson: {
				name: "minimal-base",
				version: 1,
				sections: { skills: "lib-skills" }, // no system section anywhere in the chain
				resolvedFrom: ["minimal-base"],
				frontmatter: {},
			},
		});
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "incomplete", version: 1, status: "active" }],
			},
			{ incomplete: renderMissingParent("minimal-base") },
			{
				incomplete: showOk("incomplete", {
					sections: { extras: "x" },
					extends: "minimal-base",
				}),
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });

		const result = await refreshProjectAgents({ client, agents, projectId });
		expect(result.registered).toEqual([]);
		expect(result.skipped[0]).toMatchObject({
			name: "incomplete",
			code: "agent_schema_error",
			reason: expect.stringContaining("system"),
		});
	});
});
