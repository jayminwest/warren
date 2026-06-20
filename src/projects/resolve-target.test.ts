import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { TargetProjectUnresolvedError } from "./errors.ts";
import { resolveTargetProject } from "./resolve-target.ts";

describe("resolveTargetProject", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	async function seedProject(gitUrl: string): Promise<string> {
		const row = await repo.create({
			gitUrl,
			localPath: `/data/projects/${gitUrl}`,
			defaultBranch: "main",
		});
		return row.id;
	}

	test("matches a project by owner/name slug", async () => {
		const id = await seedProject("https://github.com/acme/widget.git");
		expect(await resolveTargetProject({ projects: repo }, "acme/widget")).toBe(id);
	});

	test("matches a project by a unique bare repo name", async () => {
		const id = await seedProject("https://github.com/acme/widget.git");
		expect(await resolveTargetProject({ projects: repo }, "widget")).toBe(id);
	});

	test("matches a project by https git remote URL", async () => {
		const id = await seedProject("https://github.com/acme/widget.git");
		expect(await resolveTargetProject({ projects: repo }, "https://github.com/acme/widget")).toBe(
			id,
		);
	});

	test("matches a project by ssh/scp git remote URL", async () => {
		const id = await seedProject("https://github.com/acme/widget.git");
		expect(await resolveTargetProject({ projects: repo }, "git@github.com:acme/widget.git")).toBe(
			id,
		);
	});

	test("normalizes a trailing .git on the reference", async () => {
		const id = await seedProject("https://github.com/acme/widget");
		expect(await resolveTargetProject({ projects: repo }, "acme/widget.git")).toBe(id);
	});

	test("matching is case-insensitive", async () => {
		const id = await seedProject("https://github.com/Acme/Widget.git");
		expect(await resolveTargetProject({ projects: repo }, "acme/widget")).toBe(id);
	});

	test("throws a typed error when nothing matches", async () => {
		await seedProject("https://github.com/acme/widget.git");
		await expect(resolveTargetProject({ projects: repo }, "other/repo")).rejects.toBeInstanceOf(
			TargetProjectUnresolvedError,
		);
	});

	test("throws a typed error for an empty reference", async () => {
		await expect(resolveTargetProject({ projects: repo }, "   ")).rejects.toBeInstanceOf(
			TargetProjectUnresolvedError,
		);
	});

	test("throws on an ambiguous bare repo name", async () => {
		await seedProject("https://github.com/acme/widget.git");
		await seedProject("https://github.com/other/widget.git");
		await expect(resolveTargetProject({ projects: repo }, "widget")).rejects.toBeInstanceOf(
			TargetProjectUnresolvedError,
		);
	});

	test("disambiguates same-name repos by full slug", async () => {
		await seedProject("https://github.com/acme/widget.git");
		const other = await seedProject("https://github.com/other/widget.git");
		expect(await resolveTargetProject({ projects: repo }, "other/widget")).toBe(other);
	});
});
