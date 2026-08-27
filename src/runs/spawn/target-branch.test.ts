import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * warren-709e (#419): a run dispatched with an explicit `targetBranch`
 * persists it on `runs.target_branch`, pins the burrow workspace branch to
 * that ref (short-circuiting the composed `${prefix}/${runId}`), and — for a
 * root run with no explicit `ref` — defaults its base ref to the target branch
 * so the workspace forks from the PR head before re-pushing onto it.
 */
describe("spawnRun: targetBranch (warren-709e)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("persists targetBranch on the run row and pins the burrow branch", async () => {
		const { client, calls } = makeSandboxClient();
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "rerun ci",
			targetBranch: "fix/pr-head",
		});

		expect(run.targetBranch).toBe("fix/pr-head");
		const reread = await repos.runs.require(run.id);
		expect(reread.targetBranch).toBe("fix/pr-head");
		// warren-5255: the frozen workspace branch equals the override.
		expect(reread.branch).toBe("fix/pr-head");

		// The burrow workspace branch equals the push target, not
		// `${prefix}/${runId}`.
		const upBody = calls[0]?.body as { branch?: string };
		expect(upBody.branch).toBe("fix/pr-head");
	});

	test("defaults a root run's base ref to targetBranch when no ref is given", async () => {
		const { client } = makeSandboxClient();
		let refreshRef: string | undefined;
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "rerun ci",
			targetBranch: "fix/pr-head",
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

		expect(refreshRef).toBe("fix/pr-head");
	});

	test("an explicit ref still wins over targetBranch for the base ref", async () => {
		const { client } = makeSandboxClient();
		let refreshRef: string | undefined;
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "rerun ci",
			ref: "release/v2",
			targetBranch: "fix/pr-head",
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

		expect(refreshRef).toBe("release/v2");
	});

	test("a whitespace-only targetBranch falls through to a null row + composed branch", async () => {
		const { client, calls } = makeSandboxClient();
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "rerun ci",
			targetBranch: "   ",
		});

		expect(run.targetBranch).toBeNull();
		const upBody = calls[0]?.body as { branch?: string };
		expect(upBody.branch).toBe(`warren/${run.id}`);
		// warren-5255: a default dispatch freezes the composed branch onto the
		// row, so HTTP consumers read it instead of re-deriving the prefix.
		const reread = await repos.runs.require(run.id);
		expect(reread.branch).toBe(`warren/${run.id}`);
	});
});

/**
 * warren-3a75: `targetBranch` is an unreviewed push target — finalize pushes
 * `HEAD:<branch>` with no PR, so the Article IX auto-merge gate never sees the
 * change. `spawnRun` refuses the project default branch and any ref git itself
 * would reject, before creating a run row. Repair runs aimed at an existing PR
 * head branch keep working.
 */
describe("spawnRun: targetBranch policy (warren-3a75)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	const dispatch = (targetBranch: string) => {
		const { client } = makeSandboxClient();
		return spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "rerun ci",
			targetBranch,
		});
	};

	test("refuses a targetBranch equal to the project default branch", async () => {
		await expect(dispatch("main")).rejects.toThrow(/default branch/);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("refuses a fully-qualified ref that resolves to the default branch", async () => {
		await expect(dispatch("refs/heads/main")).rejects.toThrow(/default branch/);
	});

	test("refuses a grammar-invalid targetBranch", async () => {
		await expect(dispatch("bad branch")).rejects.toThrow(/not a valid git branch name/);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("keeps accepting an existing PR head branch for repair runs", async () => {
		const { run } = await dispatch("fix/pr-head");
		expect(run.targetBranch).toBe("fix/pr-head");
	});
});
