import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * warren-afeb: a run dispatched with an explicit `ref` persists it on
 * `runs.ref` so `POST /runs` and the run projections echo that a ref-pinned
 * dispatch took (the warren-709e targetBranch precedent). A dispatch with no
 * `ref` reads back null.
 */
describe("spawnRun: ref persistence (warren-afeb)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("persists the explicit ref on the run row and echoes it", async () => {
		const { client, calls } = makeSandboxClient();
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "repair the PR",
			ref: "fix/pr-head",
		});

		expect(run.ref).toBe("fix/pr-head");
		// The projection round-trips the same value from storage.
		const reread = await repos.runs.require(run.id);
		expect(reread.ref).toBe("fix/pr-head");
		// And the workspace still forks off that ref.
		const upBody = calls[0]?.body as { branch?: string };
		expect(upBody.branch).toBeDefined();
	});

	test("a dispatch without ref reads back null", async () => {
		const { client } = makeSandboxClient();
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "ordinary run",
		});

		expect(run.ref).toBeNull();
		const reread = await repos.runs.require(run.id);
		expect(reread.ref).toBeNull();
	});
});
