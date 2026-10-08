import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import { spawnRun } from "./index.ts";
import type { MigrationPreflightOutcome } from "./migration-preflight.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * warren-1f03 / warren-4371: spawnRun runs the drizzle migration journal
 * preflight for ref-dispatches onto an existing branch (host clone refreshed
 * onto the branch). A detected collision is surfaced to the agent as a
 * prompt note and recorded as a `migration_journal_collision` system event;
 * the host never runs a repository-defined script or commits. Fresh
 * dispatches from the default branch skip it.
 */
describe("spawnRun: migration journal preflight (warren-4371)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	function refreshStub(
		projectSpawn: SpawnFn = async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	) {
		return {
			projectsConfig: { root: "/data/projects", gitBinary: "git" } as const,
			projectSpawn,
			refreshProjectFn: async (input: { id: string; ref?: string }) => {
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		};
	}

	const warrenConfigs = (regenerateCommand: string) => ({
		get: async () => ({
			triggers: null,
			defaults: { migrations: { regenerateCommand } },
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		}),
		invalidate: () => undefined,
		clear: () => undefined,
		size: () => 0,
	});

	const COLLISION = {
		migrationsDir: "src/db/migrations",
		idx: 46,
		branchTag: "0046_branch",
		mainTag: "0046_main",
	};

	function dispatchedPrompt(calls: { path: string; body: unknown }[]): string {
		const dispatch = calls.find((c) => c.path.endsWith("/runs"));
		return (dispatch?.body as { prompt: string } | undefined)?.prompt ?? "";
	}

	test("a detected collision reaches the agent prompt and emits a system event", async () => {
		const { client, calls } = makeSandboxClient();
		let detectBaseRef: string | undefined;
		const outcome: MigrationPreflightOutcome = { collisions: [COLLISION] };
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "continue the plan child",
			ref: "burrow/run_parent",
			...refreshStub(),
			warrenConfigs: warrenConfigs("bun run db:generate"),
			migrationPreflightFn: async (input) => {
				detectBaseRef = input.baseRef;
				return outcome;
			},
		});

		expect(detectBaseRef).toBe("burrow/run_parent");
		const prompt = dispatchedPrompt(calls);
		// The note rides after the user task, behind the same `---` delimiter.
		expect(prompt).toContain("continue the plan child\n\n---\n\n## Migration journal collision");
		expect(prompt).toContain("run `bun run db:generate`");
		const events = await repos.events.listByRun(run.id);
		const event = events.find((e) => e.kind === "migration_journal_collision");
		expect(event?.stream).toBe("system");
		expect(event?.payloadJson).toMatchObject({
			baseRef: "burrow/run_parent",
			regenerateCommand: "bun run db:generate",
			resolution: "agent_in_sandbox",
		});
		expect(events.some((e) => e.kind === "migration_journal_heal")).toBe(false);
	});

	test("real detection on a colliding branch never executes repository scripts on the host", async () => {
		const root = await mkdtemp(join(tmpdir(), "warren-4371-dispatch-"));
		try {
			const dir = join(root, "src/db/migrations");
			await mkdir(join(dir, "meta"), { recursive: true });
			const branchJournal = JSON.stringify({ entries: [{ idx: 0, tag: "0000_branch" }] });
			await writeFile(join(dir, "meta/_journal.json"), branchJournal);
			await writeFile(join(dir, "0000_branch.sql"), "-- branch\n");
			await repos.projects.create({
				id: "prj_migrations01",
				gitUrl: "https://github.com/x/m.git",
				localPath: root,
				defaultBranch: "main",
			});
			const hostCalls: string[] = [];
			const projectSpawn: SpawnFn = async (cmd) => {
				const joined = cmd.join(" ");
				hostCalls.push(joined);
				if (joined.includes("ls-files")) {
					return { stdout: "src/db/migrations/meta/_journal.json\n", stderr: "", exitCode: 0 };
				}
				if (joined.includes("cat-file")) {
					const main = { entries: [{ idx: 0, tag: "0000_main" }] };
					return { stdout: JSON.stringify(main), stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			};
			const { client, calls } = makeSandboxClient();

			// spawnRun resolving (not throwing) is the repair-run dispatch succeeding.
			await spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_migrations01",
				prompt: "repair the PR",
				ref: "warren/run_parent",
				...refreshStub(projectSpawn),
			});

			// Default posture: detection only — no generate script, no commit.
			expect(hostCalls.length).toBeGreaterThan(0);
			for (const call of hostCalls) expect(call).toMatch(/^git (ls-files|cat-file) /);
			expect(await readFile(join(dir, "meta/_journal.json"), "utf8")).toBe(branchJournal);
			// No configured command → the note names none.
			const prompt = dispatchedPrompt(calls);
			expect(prompt).toContain("run this project's migration generator");
			expect(prompt).not.toContain("db:generate");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("no collision → no event, unchanged prompt; a fresh dispatch from main skips the preflight", async () => {
		const { client, calls } = makeSandboxClient();
		let detectCalls = 0;
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "branch with a free-slot migration",
			ref: "burrow/run_parent",
			...refreshStub(),
			migrationPreflightFn: async () => {
				detectCalls += 1;
				return { collisions: [] };
			},
		});
		expect(detectCalls).toBe(1);
		expect(dispatchedPrompt(calls)).not.toContain("Migration journal collision");
		expect(
			(await repos.events.listByRun(run.id)).some((e) => e.kind === "migration_journal_collision"),
		).toBe(false);

		// No ref → refresh bases on the default branch, which cannot collide.
		const { run: fresh } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fresh dispatch",
			...refreshStub(),
			migrationPreflightFn: async () => {
				detectCalls += 1;
				return { collisions: [] };
			},
		});
		expect(fresh.ref).toBeNull();
		expect(detectCalls).toBe(1);
	});
});
