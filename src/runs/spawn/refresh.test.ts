import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeBurrowClient, makePool, setupRepos } from "./test-helpers.ts";

describe("spawnRun: project refresh (warren-1bb6)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("refreshes the project clone before provisioning burrow when projectsConfig + projectSpawn are wired", async () => {
		const { client, calls } = makeBurrowClient();
		let refreshCalled = false;
		let refreshRef: string | undefined;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				refreshCalled = true;
				refreshRef = input.ref;
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		});

		expect(refreshCalled).toBe(true);
		expect(refreshRef).toBeUndefined();
		expect(calls[0]?.body).toMatchObject({ projectRoot: "/data/projects/x/y" });

		const persisted = await repos.projects.require("prj_xxxxxxxxxxxx");
		expect(persisted.lastHeadSha).toBe("feedface".repeat(5));
		expect(persisted.lastFetchedAt).not.toBeNull();
	});

	test("forwards an explicit ref override into refreshProjectFn", async () => {
		const { client } = makeBurrowClient();
		let receivedRef: string | undefined;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			ref: "feature/x",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				receivedRef = input.ref;
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "abcd".repeat(10),
				});
				return { project: updated, headSha: "abcd".repeat(10), ref: input.ref ?? "" };
			},
		});
		expect(receivedRef).toBe("feature/x");
	});

	test("aborts spawn when refresh fails — no warren row, no burrow", async () => {
		const { client, calls } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "p",
				projectsConfig: { root: "/data/projects", gitBinary: "git" },
				projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				refreshProjectFn: async () => {
					throw new Error("git fetch failed");
				},
			}),
		).rejects.toBeDefined();

		expect(await repos.runs.listAll()).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	test("skips refresh when projectsConfig is not wired (back-compat for tests)", async () => {
		const { client, calls } = makeBurrowClient();
		let refreshCalled = false;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			refreshProjectFn: async () => {
				refreshCalled = true;
				return {
					project: await repos.projects.require("prj_xxxxxxxxxxxx"),
					headSha: "x",
					ref: "main",
				};
			},
		});
		expect(refreshCalled).toBe(false);
		expect((await repos.projects.require("prj_xxxxxxxxxxxx")).lastHeadSha).toBeNull();
		expect(calls.length).toBeGreaterThan(0);
	});
});

describe("spawnRun: burrow branch composition (warren-9993)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("composes burrow branch as '<default-prefix>/<run.id>' when no override is set", async () => {
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});
		const upBody = calls.find((c) => c.path === "/burrows")?.body as { branch?: string };
		expect(upBody.branch).toBe(`burrow/${result.run.id}`);
	});

	test("env-level runBranchPrefixDefault overrides the built-in 'burrow' default", async () => {
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			runBranchPrefixDefault: "warren",
		});
		const upBody = calls.find((c) => c.path === "/burrows")?.body as { branch?: string };
		expect(upBody.branch).toBe(`warren/${result.run.id}`);
	});

	test("project default runBranchPrefix beats env-level fallback", async () => {
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			runBranchPrefixDefault: "warren",
			warrenConfigs: {
				get: async () => ({
					triggers: null,
					defaults: { runBranchPrefix: "bot" },
					prTemplate: null,
					sourceFile: null,
					errors: [],
					warnings: [],
				}),
				invalidate: () => undefined,
				clear: () => undefined,
				size: () => 0,
			},
		});
		const upBody = calls.find((c) => c.path === "/burrows")?.body as { branch?: string };
		expect(upBody.branch).toBe(`bot/${result.run.id}`);
	});
});
