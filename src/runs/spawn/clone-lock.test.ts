import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * warren-232d: the dispatch critical section (clone refresh → working-tree
 * defaults read → provider materialization) is serialized per project. Two
 * concurrent dispatches on ONE project with different base refs must never
 * interleave their `checkout --force` / `reset --hard` with each other's
 * reads; two dispatches on DIFFERENT projects stay fully parallel.
 */
describe("spawnRun: per-project host-clone serialization (warren-232d)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("interleaved dispatches with different refs never overlap on one project", async () => {
		const { client } = makeSandboxClient();
		let active = 0;
		let maxActive = 0;
		const startedRefs: string[] = [];
		const finishedRefs: string[] = [];
		const refreshProjectFn = async (input: { id: string; ref?: string; fetchCommit?: string }) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			startedRefs.push(input.ref ?? "main");
			// Widen the race window: without the lock a second dispatch enters
			// while this one is still "resetting" the shared clone.
			await new Promise((resolve) => setTimeout(resolve, 15));
			finishedRefs.push(input.ref ?? "main");
			active -= 1;
			const updated = await repos.projects.recordRefresh({
				id: input.id,
				headSha: "feedface".repeat(5),
			});
			return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
		};

		const [a, b] = await Promise.all([
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "run against feature/a",
				ref: "feature/a",
				projectsConfig: { root: "/data/projects", gitBinary: "git" },
				projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				refreshProjectFn,
			}),
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "run against feature/b",
				ref: "feature/b",
				projectsConfig: { root: "/data/projects", gitBinary: "git" },
				projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				refreshProjectFn,
			}),
		]);

		expect(a.run.ref).toBe("feature/a");
		expect(b.run.ref).toBe("feature/b");
		// The clone-mutating critical sections ran strictly one at a time.
		expect(maxActive).toBe(1);
		expect(new Set(startedRefs)).toEqual(new Set(["feature/a", "feature/b"]));
		// And in FIFO order: the first acquisition's refresh completed before
		// the second one started.
		expect(startedRefs[0]).toBe(finishedRefs[0]);
	});

	test("dispatches on different projects refresh in parallel", async () => {
		await repos.projects.create({
			id: "prj_yyyyyyyyyyyy",
			gitUrl: "https://github.com/x/z.git",
			localPath: "/data/projects/x/z",
			defaultBranch: "main",
		});
		const { client } = makeSandboxClient();
		let active = 0;
		let maxActive = 0;
		const refreshProjectFn = async (input: { id: string; ref?: string }) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 15));
			active -= 1;
			const updated = await repos.projects.recordRefresh({
				id: input.id,
				headSha: "feedface".repeat(5),
			});
			return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
		};

		await Promise.all([
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "a",
				projectsConfig: { root: "/data/projects", gitBinary: "git" },
				projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				refreshProjectFn,
			}),
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_yyyyyyyyyyyy",
				prompt: "b",
				projectsConfig: { root: "/data/projects", gitBinary: "git" },
				projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				refreshProjectFn,
			}),
		]);

		expect(maxActive).toBe(2);
	});
});
