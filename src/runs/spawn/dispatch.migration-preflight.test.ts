import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import type { MigrationHealOutcome } from "./migration-preflight.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * warren-1f03: spawnRun runs the drizzle migration journal preflight for
 * ref-dispatches onto an existing branch (host clone refreshed onto the
 * branch) and records a `migration_journal_heal` system event when a
 * collision was healed. Fresh dispatches from the default branch skip it.
 */
describe("spawnRun: migration journal preflight (warren-1f03)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	function refreshStub() {
		return {
			projectsConfig: { root: "/data/projects", gitBinary: "git" } as const,
			projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			refreshProjectFn: async (input: { id: string; ref?: string }) => {
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		};
	}

	test("a healed collision on a ref-dispatch emits a migration_journal_heal system event", async () => {
		const { client } = makeSandboxClient();
		let healBaseRef: string | undefined;
		const outcome: MigrationHealOutcome = {
			collisions: [
				{
					migrationsDir: "src/db/migrations",
					idx: 46,
					branchTag: "0046_branch",
					mainTag: "0046_main",
				},
			],
			commitSha: "deadbeef".repeat(5),
		};
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "continue the plan child",
			ref: "burrow/run_parent",
			...refreshStub(),
			migrationHealFn: async (input) => {
				healBaseRef = input.baseRef;
				return outcome;
			},
		});

		expect(healBaseRef).toBe("burrow/run_parent");
		const events = await repos.events.listByRun(run.id);
		const healEvent = events.find((e) => e.kind === "migration_journal_heal");
		expect(healEvent).toBeDefined();
		expect(healEvent?.stream).toBe("system");
		expect(healEvent?.payloadJson).toMatchObject({
			baseRef: "burrow/run_parent",
			commitSha: "deadbeef".repeat(5),
		});
	});

	test("no collision → no event; a fresh dispatch from main skips the preflight entirely", async () => {
		const { client } = makeSandboxClient();
		let healCalls = 0;
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "branch with a free-slot migration",
			ref: "burrow/run_parent",
			...refreshStub(),
			migrationHealFn: async () => {
				healCalls += 1;
				return { collisions: [], commitSha: null };
			},
		});
		expect(healCalls).toBe(1);
		expect(
			(await repos.events.listByRun(run.id)).some((e) => e.kind === "migration_journal_heal"),
		).toBe(false);

		// No ref → refresh bases on the default branch, which cannot collide.
		const { run: fresh } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fresh dispatch",
			...refreshStub(),
			migrationHealFn: async () => {
				healCalls += 1;
				return { collisions: [], commitSha: null };
			},
		});
		expect(fresh.ref).toBeNull();
		expect(healCalls).toBe(1);
	});
});
