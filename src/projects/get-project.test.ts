import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { CFG, fakeClone, NOOP_SPAWN } from "./manage.test-helpers.ts";
import { addProject, getProject } from "./manage.ts";

describe("getProject", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("returns the row for a registered project", async () => {
		const created = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/a.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});
		const row = await getProject(repo, created.id);
		expect(row).toEqual(created);
	});

	test("throws NotFoundError for an unknown id", async () => {
		await expect(getProject(repo, "warren-nope")).rejects.toBeInstanceOf(NotFoundError);
	});
});
