import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { RunsRepo } from "../db/repos/runs.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { CFG, fakeClone, NOOP_SPAWN, recordingCache } from "./manage.test-helpers.ts";
import { addProject, deleteProject } from "./manage.ts";

describe("deleteProject", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("removes the on-disk clone and the row, returning the deleted row", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const rmCalls: string[] = [];
		const deleted = await deleteProject({
			repo,
			config: CFG,
			id: row.id,
			exists: () => true,
			rmrf: async (p) => {
				rmCalls.push(p);
			},
		});

		expect(deleted.id).toBe(row.id);
		expect(rmCalls).toEqual(["/data/projects/x/y"]);
		expect(await repo.get(row.id)).toBeNull();
	});

	test("skips rmrf when the directory no longer exists but still removes the row", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		let rmCalled = false;
		await deleteProject({
			repo,
			config: CFG,
			id: row.id,
			exists: () => false,
			rmrf: async () => {
				rmCalled = true;
			},
		});
		expect(rmCalled).toBe(false);
		expect(await repo.get(row.id)).toBeNull();
	});

	test("removes the row even when rmrf throws and surfaces a logger warning", async () => {
		// Reordered behaviour (warren-5f19): the row delete is the
		// transactional fix that orphans referencing runs via ON DELETE
		// SET NULL; a stranded clone on disk is a recoverable
		// inconvenience, not a blocker. The prior contract ("rm fails →
		// row remains registered") left the system in 'row exists, disk
		// gone' if the operator hit `delete` again, which then wedged
		// every subsequent dispatch.
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const warnings: { obj: object; msg?: string }[] = [];
		const result = await deleteProject({
			repo,
			config: CFG,
			id: row.id,
			exists: () => true,
			rmrf: async () => {
				throw new Error("EBUSY");
			},
			logger: {
				warn: (obj, msg) => {
					warnings.push({ obj, msg });
				},
			},
		});
		expect(result.id).toBe(row.id);
		expect(await repo.get(row.id)).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.msg).toContain("stranded clone");
	});

	test("orphans referencing runs via ON DELETE SET NULL instead of failing the FK", async () => {
		// SPEC §11.E + warren-5f19: deleting a project with run history
		// must succeed and keep the runs as orphans (project_id null), so
		// the UI can still render the historical runs and operators can
		// re-register the same gitUrl without an FK conflict.
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const runsRepo = new RunsRepo(DrizzleAdapter.for(db));
		// Seed a referencing agent + run before the delete.
		db.raw.exec(
			"INSERT INTO agents (name, rendered_json, registered_at, last_refreshed) VALUES ('claude-code', '{}', '2026-05-09T00:00:00.000Z', '2026-05-09T00:00:00.000Z')",
		);
		const created = await runsRepo.create({
			agentName: "claude-code",
			projectId: row.id,
			prompt: "test",
			renderedAgentJson: { name: "claude-code" },
			trigger: "manual",
		});

		await deleteProject({
			repo,
			config: CFG,
			id: row.id,
			exists: () => false,
			rmrf: async () => undefined,
		});

		expect(await repo.get(row.id)).toBeNull();
		const orphan = await runsRepo.require(created.id);
		expect(orphan.projectId).toBeNull();
	});

	test("refuses to delete a project whose localPath escaped the configured root", async () => {
		// Forge a row by writing directly with the repo (defense-in-depth: bad data
		// in the db should not let warren rm an arbitrary path).
		const stranded = await repo.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/etc/passwd",
			defaultBranch: "main",
		});

		let rmCalled = false;
		await expect(
			deleteProject({
				repo,
				config: CFG,
				id: stranded.id,
				exists: () => true,
				rmrf: async () => {
					rmCalled = true;
				},
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
		expect(rmCalled).toBe(false);
		expect(await repo.get(stranded.id)).not.toBeNull();
	});

	test("throws NotFoundError when the id is unknown", async () => {
		await expect(
			deleteProject({
				repo,
				config: CFG,
				id: "prj_doesnotexist",
				exists: () => false,
				rmrf: async () => undefined,
			}),
		).rejects.toMatchObject({ code: "not_found" });
	});

	test("invalidates the warren-config cache after the row delete", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const cache = recordingCache();
		await deleteProject({
			repo,
			config: CFG,
			id: row.id,
			exists: () => false,
			rmrf: async () => undefined,
			warrenConfigs: cache,
		});

		expect(cache.invalidations).toEqual([row.id]);
	});
});
