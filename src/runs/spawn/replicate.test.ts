import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeBurrowClient, makePool, setupRepos } from "./test-helpers.ts";

/**
 * warren-e96f: a replicate run ("re-run from scratch") re-dispatches the
 * parent's exact config against the project default base (or the caller's
 * explicit ref) — NOT the parent's pushed branch. It records the same
 * `parent_run_id` column as a continuation but tags `clone_kind=replicate`.
 */
describe("spawnRun: replicate (warren-e96f)", () => {
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

	function refresher(record: (ref: string | undefined) => void) {
		return async (input: { id: string; ref?: string }) => {
			record(input.ref);
			const updated = await repos.projects.recordRefresh({
				id: input.id,
				headSha: "feedface".repeat(5),
			});
			return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
		};
	}

	test("uses the project default base (NOT the parent's pushed branch) and records clone_kind", async () => {
		const parentId = await makeParent();
		const { client } = makeBurrowClient();
		let refreshRef: string | undefined = "sentinel";
		const { run } = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "first pass",
			parentRunId: parentId,
			cloneKind: "replicate",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: refresher((ref) => {
				refreshRef = ref;
			}),
		});

		// Replicate must NOT check out burrow/<parentId>; with no explicit ref,
		// the refresh ref is undefined → refreshProject resolves the project
		// default branch.
		expect(refreshRef).toBeUndefined();
		expect(run.parentRunId).toBe(parentId);
		expect(run.cloneKind).toBe("replicate");
	});

	test("honors an explicit ref instead of the parent's pushed branch", async () => {
		const parentId = await makeParent();
		const { client } = makeBurrowClient();
		let refreshRef: string | undefined;
		await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "first pass",
			parentRunId: parentId,
			cloneKind: "replicate",
			ref: "release/v2",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: refresher((ref) => {
				refreshRef = ref;
			}),
		});

		expect(refreshRef).toBe("release/v2");
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
				prompt: "first pass",
				parentRunId: otherParent.id,
				cloneKind: "replicate",
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("defaults a parented run to clone_kind=continue when cloneKind is omitted", async () => {
		const parentId = await makeParent();
		const { client } = makeBurrowClient();
		const { run } = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "follow up",
			parentRunId: parentId,
		});
		expect(run.cloneKind).toBe("continue");
	});

	test("a root run leaves clone_kind null", async () => {
		const { client } = makeBurrowClient();
		const { run } = await spawnRun({
			repos,
			burrowClientPool: await makePool(repos, client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fresh",
		});
		expect(run.cloneKind).toBeNull();
	});
});
