import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeBurrowClient, makePool, setupRepos } from "./test-helpers.ts";

/**
 * warren-4b11: a continuation run ("re-run with follow-up") seeds its
 * workspace from the prior run's pushed branch instead of the project
 * default branch, and records the parent link on `runs.parent_run_id`.
 */
describe("spawnRun: continuation (warren-4b11)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	async function makeParent(): Promise<string> {
		const parent = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "first pass",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
		});
		return parent.id;
	}

	test("refreshes to the parent's pushed branch and records parent_run_id", async () => {
		const parentId = await makeParent();
		const { client } = makeBurrowClient();
		let refreshRef: string | undefined;
		const { run } = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "follow up",
			parentRunId: parentId,
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				refreshRef = input.ref;
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		});

		// Default prefix is "burrow"; parent branch is burrow/<parentId>.
		expect(refreshRef).toBe(`burrow/${parentId}`);
		expect(run.parentRunId).toBe(parentId);
	});

	test("honors a project runBranchPrefix when recomposing the parent branch", async () => {
		const parentId = await makeParent();
		const { client } = makeBurrowClient();
		let refreshRef: string | undefined;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "follow up",
			parentRunId: parentId,
			runBranchPrefixDefault: "warren",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				refreshRef = input.ref;
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		});

		expect(refreshRef).toBe(`warren/${parentId}`);
	});

	test("parent branch wins over an explicit ref", async () => {
		const parentId = await makeParent();
		const { client } = makeBurrowClient();
		let refreshRef: string | undefined;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "follow up",
			parentRunId: parentId,
			ref: "main",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				refreshRef = input.ref;
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		});

		expect(refreshRef).toBe(`burrow/${parentId}`);
	});

	test("targetBranch pins the burrow branch to the PR head ref (warren-a993)", async () => {
		const parentId = await makeParent();
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix ci",
			parentRunId: parentId,
			targetBranch: `burrow/${parentId}`,
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		});

		// The burrow workspace branch is the PR head (parent's branch), not a
		// fresh `burrow/<fixerRunId>` — so reap pushes back onto the open PR.
		const up = calls.find((c) => c.method === "POST" && c.path === "/burrows");
		expect((up?.body as { branch?: string }).branch).toBe(`burrow/${parentId}`);
	});

	test("rejects a parent run from a different project", async () => {
		await repos.projects.create({
			id: "prj_yyyyyyyyyyyy",
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
		});
		const otherParent = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: "prj_yyyyyyyyyyyy",
			prompt: "elsewhere",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
		});
		const { client } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "follow up",
				parentRunId: otherParent.id,
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("a missing parent run id is a NotFoundError", async () => {
		const { client } = makeBurrowClient();
		await expect(
			spawnRun({
				repos,
				burrowClientPool: await makePool(repos, client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "follow up",
				parentRunId: "run_nonexistent0",
			}),
		).rejects.toThrow();
	});

	test("omitting parentRunId leaves parent_run_id null (root run)", async () => {
		const { client } = makeBurrowClient();
		const { run } = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fresh",
		});
		expect(run.parentRunId).toBeNull();
	});
});
