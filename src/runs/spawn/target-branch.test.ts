import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeBurrowClient, makePool, setupRepos } from "./test-helpers.ts";

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
		const { client, calls } = makeBurrowClient();
		const { run } = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "rerun ci",
			targetBranch: "fix/pr-head",
		});

		expect(run.targetBranch).toBe("fix/pr-head");
		const reread = await repos.runs.require(run.id);
		expect(reread.targetBranch).toBe("fix/pr-head");

		// The burrow workspace branch equals the push target, not
		// `${prefix}/${runId}`.
		const upBody = calls[0]?.body as { branch?: string };
		expect(upBody.branch).toBe("fix/pr-head");
	});

	test("defaults a root run's base ref to targetBranch when no ref is given", async () => {
		const { client } = makeBurrowClient();
		let refreshRef: string | undefined;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
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
		const { client } = makeBurrowClient();
		let refreshRef: string | undefined;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
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
		const { client, calls } = makeBurrowClient();
		const { run } = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "rerun ci",
			targetBranch: "   ",
		});

		expect(run.targetBranch).toBeNull();
		const upBody = calls[0]?.body as { branch?: string };
		expect(upBody.branch).toBe(`burrow/${run.id}`);
	});
});
