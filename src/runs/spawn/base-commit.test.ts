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

describe("spawnRun: baseCommit dispatch is detached-HEAD safe (warren-232d)", () => {
	let db: WarrenDb;
	let repos: Repos;
	const SHA = "0123456789abcdef0123456789abcdef01234567";

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("refreshes in fetch-only mode — fetchCommit carried, no checkout ref", async () => {
		const { client } = makeSandboxClient();
		let receivedRef: string | undefined;
		let receivedFetchCommit: string | undefined;
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "replay history",
			baseCommit: SHA,
			ref: "fix/pr-head",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				receivedRef = input.ref;
				receivedFetchCommit = input.fetchCommit;
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: SHA,
				});
				return { project: updated, headSha: SHA, ref: input.ref ?? "" };
			},
		});

		// The refresh runs in fetch-only mode: the SHA rides fetchCommit (which
		// never moves the host clone's HEAD), never as the checkout ref.
		expect(receivedFetchCommit).toBe(SHA);
		expect(receivedRef).toBeUndefined();
	});

	test("skips the migration journal preflight (heal path would commit on the wrong base)", async () => {
		const { client } = makeSandboxClient();
		let healCalls = 0;
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "replay history",
			baseCommit: SHA,
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input) => {
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: SHA,
				});
				return { project: updated, headSha: SHA, ref: input.ref ?? "" };
			},
			migrationHealFn: async () => {
				healCalls += 1;
				return { collisions: [], commitSha: null };
			},
		});

		// A SHA baseRef always differs from the default branch name, but the
		// preflight must not fire: the host clone was never checked out onto
		// the pin, so a heal commit would land on the wrong base.
		expect(healCalls).toBe(0);
		const events = await repos.events.listByRun(run.id);
		expect(events.find((e) => e.kind === "migration_journal_heal")).toBeUndefined();
	});
});
