import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * warren-aaf7: a run dispatched with `baseCommit` pins the workspace cut to
 * that SHA — the RunSpec's baseBranch (what both providers materialize the
 * workspace from) carries the SHA — while `runs.ref` stays unset (or stays a
 * branch) so the reap PR base resolution (`run.ref ?? defaultBranch`) is
 * byte-identical for branch refs.
 */
describe("spawnRun: baseCommit pinning (warren-aaf7)", () => {
	let db: WarrenDb;
	let repos: Repos;
	const SHA = "0123456789abcdef0123456789abcdef01234567";

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("a baseCommit dispatch pins the RunSpec baseBranch and persists the column", async () => {
		const { client, calls } = makeSandboxClient();
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "replay history",
			baseCommit: SHA,
		});

		// The workspace cut point is the SHA.
		const upBody = calls[0]?.body as { baseBranch?: string };
		expect(upBody.baseBranch).toBe(SHA);
		// The pin is frozen on the row; ref stays unset (no branch supplied).
		expect(run.baseCommit).toBe(SHA);
		expect(run.ref).toBeNull();
		const reread = await repos.runs.require(run.id);
		expect(reread.baseCommit).toBe(SHA);
		expect(reread.ref).toBeNull();
	});

	test("baseCommit overrides ref for the workspace cut, ref still persists", async () => {
		const { client, calls } = makeSandboxClient();
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "replay at a pinned commit on a branch base",
			ref: "fix/pr-head",
			baseCommit: SHA,
		});

		const upBody = calls[0]?.body as { baseBranch?: string };
		expect(upBody.baseBranch).toBe(SHA);
		// Both fields freeze independently: ref (the PR base) stays a branch.
		expect(run.ref).toBe("fix/pr-head");
		expect(run.baseCommit).toBe(SHA);
	});

	test("a branch-ref dispatch without baseCommit is byte-identical to the old path", async () => {
		const { client, calls } = makeSandboxClient();
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "repair the PR",
			ref: "fix/pr-head",
		});

		const upBody = calls[0]?.body as { baseBranch?: string };
		expect(upBody.baseBranch).toBe("fix/pr-head");
		expect(run.ref).toBe("fix/pr-head");
		expect(run.baseCommit).toBeNull();
	});

	test("a dispatch without either field reads both back null", async () => {
		const { client } = makeSandboxClient();
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "ordinary run",
		});

		expect(run.ref).toBeNull();
		expect(run.baseCommit).toBeNull();
	});
});
