import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { isId } from "../core/ids.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { CFG, fakeClone, NOOP_SPAWN } from "./manage.test-helpers.ts";
import { addProject } from "./manage.ts";

describe("addProject", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("clones, persists a row, and returns it", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/jayminwest/warren.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			now: () => new Date("2026-05-08T12:00:00.000Z"),
		});

		expect(isId("project", row.id)).toBe(true);
		expect(row.gitUrl).toBe("https://github.com/jayminwest/warren.git");
		expect(row.localPath).toBe("/data/projects/jayminwest/warren");
		expect(row.defaultBranch).toBe("main");
		expect(row.addedAt).toBe("2026-05-08T12:00:00.000Z");
		expect(await repo.listAll()).toHaveLength(1);
	});

	test("propagates an explicit defaultBranch into the cloner and the row", async () => {
		let received: string | undefined;
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			defaultBranch: "trunk",
			spawn: NOOP_SPAWN,
			clone: async (input) => {
				received = input.defaultBranch;
				return {
					localPath: `${input.config.root}/${input.owner}/${input.name}`,
					defaultBranch: input.defaultBranch ?? "main",
				};
			},
		});

		expect(received).toBe("trunk");
		expect(row.defaultBranch).toBe("trunk");
	});

	test("probes for .plot/ after clone and persists hasPlot on the row (warren-4e20)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			detectFeatures: (localPath) => {
				expect(localPath).toBe("/data/projects/x/y");
				return { hasPlot: true, hasSeeds: false };
			},
		});
		expect(row.hasPlot).toBe(true);
		const persisted = await repo.require(row.id);
		expect(persisted.hasPlot).toBe(true);
	});

	test("defaults hasPlot=false when the probe returns false", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			detectFeatures: () => ({ hasPlot: false, hasSeeds: false }),
		});
		expect(row.hasPlot).toBe(false);
	});

	test("persists hasSeeds=true after probe (warren-9990)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			detectFeatures: () => ({ hasPlot: false, hasSeeds: true }),
		});
		expect(row.hasSeeds).toBe(true);
		const persisted = await repo.require(row.id);
		expect(persisted.hasSeeds).toBe(true);
	});

	test("rejects an invalid GitHub URL with ValidationError before touching the cloner", async () => {
		let cloneCalled = false;
		await expect(
			addProject({
				repo,
				config: CFG,
				gitUrl: "not a url",
				spawn: NOOP_SPAWN,
				clone: async () => {
					cloneCalled = true;
					return { localPath: "x", defaultBranch: "main" };
				},
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(cloneCalled).toBe(false);
		expect(await repo.listAll()).toHaveLength(0);
	});

	test("rejects a duplicate gitUrl with ValidationError without re-cloning", async () => {
		await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		let cloneCalls = 0;
		await expect(
			addProject({
				repo,
				config: CFG,
				gitUrl: "https://github.com/x/y.git",
				spawn: NOOP_SPAWN,
				clone: async (input) => {
					cloneCalls += 1;
					return {
						localPath: `${input.config.root}/${input.owner}/${input.name}`,
						defaultBranch: "main",
					};
				},
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(cloneCalls).toBe(0);
	});

	test("does not insert a row when the cloner throws", async () => {
		await expect(
			addProject({
				repo,
				config: CFG,
				gitUrl: "https://github.com/x/y.git",
				spawn: NOOP_SPAWN,
				clone: async () => {
					throw new ProjectUnavailableError("git clone failed: network down");
				},
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
		expect(await repo.listAll()).toHaveLength(0);
	});
});
