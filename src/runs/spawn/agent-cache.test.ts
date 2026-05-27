import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { RunSpawnError } from "../errors.ts";
import { spawnRun } from "./index.ts";
import {
	makeAgentJson,
	makeBurrowClient,
	makePool,
	readCanopyFrontmatter,
	setupRepos,
} from "./test-helpers.ts";

describe("readCachedAgent (via spawnRun)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("handles older cached envelopes (raw cn render output)", async () => {
		// Older registry refresh paths may have stored the raw envelope rather
		// than the parsed AgentDefinition. The spawn flow re-parses on read so
		// stale caches don't crash the flow.
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				success: true,
				command: "render",
				name: "refactor-bot",
				version: 2,
				sections: [{ name: "system", body: "s" }],
			},
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const stored = result.run.renderedAgentJson as { sections: Record<string, string> };
		expect(stored.sections.system).toBe("s");
	});

	test("rejects a corrupted cached agent JSON with RunSpawnError", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { name: "refactor-bot", version: 1, sections: { system: 42 } },
		});
		const { client } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
			}),
		).rejects.toBeInstanceOf(RunSpawnError);
	});
});

describe("agent tier resolution (R-03 / warren-0a7e)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("prefers the project-tier agent when one exists for the spawn's project", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			renderedJson: makeAgentJson({
				sections: { system: "project tier system" },
				frontmatter: { source: "project:prj_xxxxxxxxxxxx" },
			}),
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const stored = (await repos.runs.require(result.run.id)).renderedAgentJson as {
			sections: Record<string, string>;
			frontmatter: Record<string, unknown>;
		};
		expect(stored.sections.system).toBe("project tier system");
		expect(stored.frontmatter.source).toBe("project:prj_xxxxxxxxxxxx");
	});

	test("falls back to the global-tier agent when no project-tier row matches", async () => {
		// Only the global `refactor-bot` exists (seeded in beforeEach); no
		// project-tier row for `prj_xxxxxxxxxxxx`. The unrelated project-tier
		// row on a DIFFERENT project must not leak across.
		await repos.projects.create({
			id: "prj_otherrrrrrr",
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
		});
		await repos.agents.upsert({
			name: "refactor-bot",
			projectId: "prj_otherrrrrrr",
			renderedJson: makeAgentJson({
				sections: { system: "other project system" },
				frontmatter: { source: "project:prj_otherrrrrrr" },
			}),
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const stored = (await repos.runs.require(result.run.id)).renderedAgentJson as {
			sections: Record<string, string>;
			frontmatter: Record<string, unknown>;
		};
		expect(stored.sections.system).toBe("be a refactor agent");
		expect(stored.frontmatter.source).toBeUndefined();
	});
});

describe("provider/model override resolution (warren-618b / warren-f8c0)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("folds providerOverride + modelOverride onto frontmatter before freeze and seed", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { source: "builtin", provider: "anthropic", model: "claude-sonnet-4-6" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			providerOverride: "openai",
			modelOverride: "gpt-4o",
		});

		// The seed payload shipped on POST /burrows carries the override-applied
		// agent envelope verbatim (buildSeedFiles materializes the resolved
		// frontmatter into `.canopy/agent.json`).
		const seededFm = readCanopyFrontmatter(calls);
		expect(seededFm.provider).toBe("openai");
		expect(seededFm.model).toBe("gpt-4o");
		// Original builtin frontmatter preserved
		expect(seededFm.source).toBe("builtin");

		// Frozen rendered_agent_json carries the overrides
		const stored = (await repos.runs.require(result.run.id)).renderedAgentJson as {
			frontmatter: Record<string, unknown>;
		};
		expect(stored.frontmatter.provider).toBe("openai");
		expect(stored.frontmatter.model).toBe("gpt-4o");

		// Cached agent row is untouched — the override is per-run, not per-agent
		const reread = (await repos.agents.require("pi")).renderedJson as {
			frontmatter: Record<string, unknown>;
		};
		expect(reread.frontmatter.provider).toBe("anthropic");
		expect(reread.frontmatter.model).toBe("claude-sonnet-4-6");
	});

	test("falls back to .warren/defaults.json provider/model when no per-run override", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { source: "builtin", provider: "pi", model: "pi-default" },
			}),
		});
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-7" },
					prTemplate: null,
					errors: [],
					warnings: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});

		const seededFm = readCanopyFrontmatter(calls);
		expect(seededFm.provider).toBe("anthropic");
		expect(seededFm.model).toBe("claude-opus-4-7");
		expect(seededFm.source).toBe("builtin");
		const stored = (await repos.runs.require(result.run.id)).renderedAgentJson as {
			frontmatter: Record<string, unknown>;
		};
		expect(stored.frontmatter.provider).toBe("anthropic");
		expect(stored.frontmatter.model).toBe("claude-opus-4-7");
	});

	test("per-run override beats .warren/defaults.json beats agent frontmatter", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "pi", model: "pi-default" },
			}),
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			providerOverride: "openai",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-7" },
					prTemplate: null,
					errors: [],
					warnings: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});
		const stored = result.run.renderedAgentJson as { frontmatter: Record<string, unknown> };
		// Operator override wins for provider; project default wins for model
		// since no per-run modelOverride was supplied.
		expect(stored.frontmatter.provider).toBe("openai");
		expect(stored.frontmatter.model).toBe("claude-opus-4-7");
	});

	test("leaves frontmatter alone when overrides are empty / whitespace", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "anthropic" },
			}),
		});
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			providerOverride: "  ",
			modelOverride: "",
		});
		const stored = result.run.renderedAgentJson as { frontmatter: Record<string, unknown> };
		expect(stored.frontmatter.provider).toBe("anthropic");
		expect(stored.frontmatter.model).toBeUndefined();
	});
});
