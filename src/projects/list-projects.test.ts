import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { CFG, fakeClone, NOOP_SPAWN } from "./manage.test-helpers.ts";
import { addProject, listProjects } from "./manage.ts";

describe("listProjects", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("returns rows in insertion order", async () => {
		const a = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/a.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			now: () => new Date("2026-05-08T12:00:00.000Z"),
		});
		const b = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/b.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			now: () => new Date("2026-05-08T13:00:00.000Z"),
		});
		expect((await listProjects(repo)).map((r) => r.id)).toEqual([a.id, b.id]);
	});
});
