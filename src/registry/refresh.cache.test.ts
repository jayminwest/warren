import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { AgentsRepo } from "../db/repos/agents.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { buildSpawn, CanopyClient, rendered } from "./refresh.test-helpers.ts";
import {
	RENDERED_CACHE_SUBPATH,
	type RenderedCacheWriter,
	refreshProjectAgents,
} from "./refresh.ts";
import type { AgentDefinition } from "./schema.ts";

// On-disk rendered cache (warren-44e3) — extracted from refresh.test.ts.
describe("refreshProjectAgents on-disk rendered cache", () => {
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

	const trackWriter = (): {
		writer: RenderedCacheWriter;
		calls: {
			init: string[];
			write: Array<{ projectPath: string; name: string; definition: AgentDefinition }>;
			prune: Array<{ projectPath: string; name: string }>;
		};
	} => {
		const calls = {
			init: [] as string[],
			write: [] as Array<{
				projectPath: string;
				name: string;
				definition: AgentDefinition;
			}>,
			prune: [] as Array<{ projectPath: string; name: string }>,
		};
		const writer: RenderedCacheWriter = {
			async init(projectPath) {
				calls.init.push(projectPath);
			},
			async write(projectPath, name, definition) {
				calls.write.push({ projectPath, name, definition });
			},
			async prune(projectPath, name) {
				calls.prune.push({ projectPath, name });
			},
		};
		return { writer, calls };
	};

	test("does not invoke the cache writer when projectPath is omitted", async () => {
		const projectId = await seedProject();
		const { writer, calls } = trackWriter();
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "docs-bot", version: 1, status: "active" }],
			},
			{ "docs-bot": { ok: rendered("docs-bot", { system: "ok" }) } },
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });
		await refreshProjectAgents({ client, agents, projectId, cacheWriter: writer });
		expect(calls.init).toEqual([]);
		expect(calls.write).toEqual([]);
		expect(calls.prune).toEqual([]);
	});

	test("calls init once, write per registered agent, prune per removed row", async () => {
		const projectId = await seedProject();
		// Pre-seed a stale row that will be pruned on this refresh.
		await agents.upsert({ name: "stale-bot", projectId, renderedJson: { v: 0 } });
		const { writer, calls } = trackWriter();
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "refactor-bot", version: 1, status: "active" },
					{ name: "docs-bot", version: 2, status: "active" },
				],
			},
			{
				"refactor-bot": { ok: rendered("refactor-bot", { system: "rf" }) },
				"docs-bot": { ok: rendered("docs-bot", { system: "doc" }, 2) },
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });
		await refreshProjectAgents({
			client,
			agents,
			projectId,
			projectPath: "/proj/tree",
			cacheWriter: writer,
		});
		expect(calls.init).toEqual(["/proj/tree"]);
		expect(calls.write.map((c) => c.name).sort()).toEqual(["docs-bot", "refactor-bot"]);
		expect(calls.write.every((c) => c.projectPath === "/proj/tree")).toBe(true);
		// Stamped frontmatter.source survives the write path.
		const refactor = calls.write.find((c) => c.name === "refactor-bot");
		expect(refactor?.definition.frontmatter.source).toBe(`project:${projectId}`);
		expect(calls.prune).toEqual([{ projectPath: "/proj/tree", name: "stale-bot" }]);
	});

	test("skipped agents (render or schema failure) do not produce a cache write", async () => {
		const projectId = await seedProject();
		const { writer, calls } = trackWriter();
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "ok-bot", version: 1, status: "active" },
					{ name: "bad-bot", version: 1, status: "active" },
				],
			},
			{
				"ok-bot": { ok: rendered("ok-bot", { system: "ok" }) },
				"bad-bot": { ok: rendered("bad-bot", { skills: "no system" }) },
			},
		);
		const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });
		await refreshProjectAgents({
			client,
			agents,
			projectId,
			projectPath: "/proj/tree",
			cacheWriter: writer,
		});
		expect(calls.write.map((c) => c.name)).toEqual(["ok-bot"]);
	});

	test("default writer writes <projectPath>/.canopy/.rendered/<name>.json and seeds .gitignore", async () => {
		const projectId = await seedProject();
		const projectPath = await mkdtemp(join(tmpdir(), "warren-44e3-"));
		try {
			const spawn = buildSpawn(
				{
					success: true,
					command: "list",
					prompts: [{ name: "docs-bot", version: 2, status: "active" }],
				},
				{ "docs-bot": { ok: rendered("docs-bot", { system: "doc body" }, 2) } },
			);
			const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });
			await refreshProjectAgents({ client, agents, projectId, projectPath });

			const cacheDir = join(projectPath, RENDERED_CACHE_SUBPATH);
			const entries = (await readdir(cacheDir)).sort();
			expect(entries).toEqual([".gitignore", "docs-bot.json"]);
			const gitignore = await readFile(join(cacheDir, ".gitignore"), "utf8");
			expect(gitignore).toBe("*\n");
			const cached = JSON.parse(await readFile(join(cacheDir, "docs-bot.json"), "utf8")) as {
				name: string;
				version: number;
				sections: Record<string, string>;
				frontmatter: { source: string };
			};
			expect(cached.name).toBe("docs-bot");
			expect(cached.version).toBe(2);
			expect(cached.sections.system).toBe("doc body");
			expect(cached.frontmatter.source).toBe(`project:${projectId}`);
		} finally {
			await rm(projectPath, { recursive: true, force: true });
		}
	});

	test("default writer prunes the JSON when a row is removed", async () => {
		const projectId = await seedProject();
		const projectPath = await mkdtemp(join(tmpdir(), "warren-44e3-"));
		try {
			// First refresh registers stale-bot AND writes its cache file.
			const spawn1 = buildSpawn(
				{
					success: true,
					command: "list",
					prompts: [{ name: "stale-bot", version: 1, status: "active" }],
				},
				{ "stale-bot": { ok: rendered("stale-bot", { system: "x" }) } },
			);
			await refreshProjectAgents({
				client: CanopyClient.forProjectPath({ projectPath: "/proj", spawn: spawn1 }),
				agents,
				projectId,
				projectPath,
			});
			const cacheDir = join(projectPath, RENDERED_CACHE_SUBPATH);
			expect((await readdir(cacheDir)).includes("stale-bot.json")).toBe(true);

			// Second refresh drops stale-bot from the listing → file removed.
			const spawn2 = buildSpawn({ success: true, command: "list", prompts: [] }, {});
			const result = await refreshProjectAgents({
				client: CanopyClient.forProjectPath({ projectPath: "/proj", spawn: spawn2 }),
				agents,
				projectId,
				projectPath,
			});
			expect(result.removed).toEqual(["stale-bot"]);
			expect((await readdir(cacheDir)).includes("stale-bot.json")).toBe(false);
		} finally {
			await rm(projectPath, { recursive: true, force: true });
		}
	});

	test("default writer skips unsafe agent names (defense-in-depth at the filesystem boundary)", async () => {
		const projectId = await seedProject();
		const projectPath = await mkdtemp(join(tmpdir(), "warren-44e3-"));
		try {
			const spawn = buildSpawn(
				{
					success: true,
					command: "list",
					prompts: [{ name: "../escape", version: 1, status: "active" }],
				},
				{ "../escape": { ok: rendered("../escape", { system: "x" }) } },
			);
			const client = CanopyClient.forProjectPath({ projectPath: "/proj", spawn });
			await refreshProjectAgents({ client, agents, projectId, projectPath });
			const cacheDir = join(projectPath, RENDERED_CACHE_SUBPATH);
			// Only the .gitignore was seeded; no JSON written for the unsafe name.
			expect(await readdir(cacheDir)).toEqual([".gitignore"]);
		} finally {
			await rm(projectPath, { recursive: true, force: true });
		}
	});
});
