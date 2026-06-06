import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { CFG, fakeClone, NOOP_SPAWN, recordingCache } from "./manage.test-helpers.ts";
import { addProject, refreshProject } from "./manage.ts";

describe("refreshProject", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("calls refresh with the row's localPath + default branch and stamps lastFetchedAt + lastHeadSha", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone({ defaultBranch: "trunk" }),
		});

		let receivedRef: string | undefined;
		let receivedPath: string | undefined;
		const result = await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			spawn: NOOP_SPAWN,
			refresh: async (input) => {
				receivedRef = input.ref;
				receivedPath = input.localPath;
				return {
					headSha: "abcd1234abcd1234abcd1234abcd1234abcd1234",
					ref: input.ref,
					features: { hasPlot: false, hasSeeds: false },
				};
			},
			now: () => new Date("2026-05-09T19:00:00.000Z"),
		});

		expect(receivedRef).toBe("trunk");
		expect(receivedPath).toBe(row.localPath);
		expect(result.headSha).toBe("abcd1234abcd1234abcd1234abcd1234abcd1234");
		expect(result.project.lastFetchedAt).toBe("2026-05-09T19:00:00.000Z");
		expect(result.project.lastHeadSha).toBe("abcd1234abcd1234abcd1234abcd1234abcd1234");

		const persisted = await repo.require(row.id);
		expect(persisted.lastFetchedAt).toBe("2026-05-09T19:00:00.000Z");
		expect(persisted.lastHeadSha).toBe("abcd1234abcd1234abcd1234abcd1234abcd1234");
	});

	test("forwards an explicit ref override", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone({ defaultBranch: "main" }),
		});

		let receivedRef: string | undefined;
		await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			ref: "feature/123",
			spawn: NOOP_SPAWN,
			refresh: async (input) => {
				receivedRef = input.ref;
				return {
					headSha: "deadbeef".repeat(5),
					ref: input.ref,
					features: { hasPlot: false, hasSeeds: false },
				};
			},
		});

		expect(receivedRef).toBe("feature/123");
	});

	test("does not stamp the row when refresh throws", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		await expect(
			refreshProject({
				repo,
				config: CFG,
				id: row.id,
				spawn: NOOP_SPAWN,
				refresh: async () => {
					throw new ProjectUnavailableError("git fetch failed");
				},
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);

		const persisted = await repo.require(row.id);
		expect(persisted.lastFetchedAt).toBeNull();
		expect(persisted.lastHeadSha).toBeNull();
	});

	test("rejects an empty ref override with ValidationError", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		await expect(
			refreshProject({
				repo,
				config: CFG,
				id: row.id,
				ref: "",
				spawn: NOOP_SPAWN,
				refresh: async () => ({
					headSha: "x",
					ref: "",
					features: { hasPlot: false, hasSeeds: false },
				}),
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("throws NotFoundError when the project id is unknown", async () => {
		await expect(
			refreshProject({
				repo,
				config: CFG,
				id: "prj_nope",
				spawn: NOOP_SPAWN,
				refresh: async () => ({
					headSha: "x",
					ref: "main",
					features: { hasPlot: false, hasSeeds: false },
				}),
			}),
		).rejects.toMatchObject({ code: "not_found" });
	});

	test("persists the .plot/ probe outcome onto the project row (warren-4e20)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			detectFeatures: () => ({ hasPlot: false, hasSeeds: false }),
		});
		expect(row.hasPlot).toBe(false);

		const result = await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			spawn: NOOP_SPAWN,
			refresh: async (input) => ({
				headSha: "1234".repeat(10),
				ref: input.ref,
				features: { hasPlot: true, hasSeeds: false },
			}),
		});

		expect(result.project.hasPlot).toBe(true);
		const persisted = await repo.require(row.id);
		expect(persisted.hasPlot).toBe(true);
	});

	test("flips hasPlot back to false when .plot/ is removed upstream", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			detectFeatures: () => ({ hasPlot: true, hasSeeds: false }),
		});
		expect(row.hasPlot).toBe(true);

		const result = await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			spawn: NOOP_SPAWN,
			refresh: async (input) => ({
				headSha: "5678".repeat(10),
				ref: input.ref,
				features: { hasPlot: false, hasSeeds: false },
			}),
		});

		expect(result.project.hasPlot).toBe(false);
	});

	test("persists hasSeeds=true after probe (warren-9990)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			detectFeatures: () => ({ hasPlot: false, hasSeeds: false }),
		});
		expect(row.hasSeeds).toBe(false);

		const result = await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			spawn: NOOP_SPAWN,
			refresh: async (input) => ({
				headSha: "1234".repeat(10),
				ref: input.ref,
				features: { hasPlot: false, hasSeeds: true },
			}),
		});

		expect(result.project.hasSeeds).toBe(true);
		const persisted = await repo.require(row.id);
		expect(persisted.hasSeeds).toBe(true);
	});

	test("flips hasSeeds back to false when .seeds/ is removed upstream (warren-9990)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			detectFeatures: () => ({ hasPlot: false, hasSeeds: true }),
		});
		expect(row.hasSeeds).toBe(true);

		const result = await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			spawn: NOOP_SPAWN,
			refresh: async (input) => ({
				headSha: "5678".repeat(10),
				ref: input.ref,
				features: { hasPlot: false, hasSeeds: false },
			}),
		});

		expect(result.project.hasSeeds).toBe(false);
	});

	test("invalidates the warren-config cache BEFORE refresh runs (pl-5d74 risk #4)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const cache = recordingCache();
		const order: string[] = [];
		await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			spawn: NOOP_SPAWN,
			warrenConfigs: {
				...cache,
				invalidate: (id) => {
					order.push(`invalidate:${id}`);
					cache.invalidate(id);
				},
			},
			refresh: async (input) => {
				order.push("refresh");
				return {
					headSha: "deadbeef".repeat(5),
					ref: input.ref,
					features: { hasPlot: false, hasSeeds: false },
				};
			},
		});

		expect(order).toEqual([`invalidate:${row.id}`, "refresh"]);
		expect(cache.invalidations).toEqual([row.id]);
	});

	test("invalidates even when refresh throws (cache stays empty)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const cache = recordingCache();
		await expect(
			refreshProject({
				repo,
				config: CFG,
				id: row.id,
				spawn: NOOP_SPAWN,
				warrenConfigs: cache,
				refresh: async () => {
					throw new ProjectUnavailableError("git fetch failed");
				},
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);

		expect(cache.invalidations).toEqual([row.id]);
	});
});

describe("refreshProject git-hooks knob (warren-8f4c)", () => {
	let db: WarrenDb;
	let repo: ProjectsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new ProjectsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("passes armHooks:true to refreshProjectClone by default", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		let receivedArmHooks: boolean | undefined;
		await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			spawn: NOOP_SPAWN,
			refresh: async (input) => {
				receivedArmHooks = input.armHooks;
				return {
					headSha: "a".repeat(40),
					ref: input.ref,
					features: { hasPlot: false, hasSeeds: false },
				};
			},
		});

		expect(receivedArmHooks).toBe(true);
	});

	test("passes armHooks:false when agent.skipGitHooks is true in config", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});

		const skipHooksCache: WarrenConfigCache = {
			get: async () => ({
				triggers: null,
				defaults: { agent: { pauseTimeoutMs: 1_800_000, skipGitHooks: true } },
				prTemplate: null,
				errors: [],
				warnings: [],
			}),
			invalidate: () => undefined,
			clear: () => undefined,
			size: () => 0,
		};

		let receivedArmHooks: boolean | undefined;
		await refreshProject({
			repo,
			config: CFG,
			id: row.id,
			spawn: NOOP_SPAWN,
			warrenConfigs: skipHooksCache,
			refresh: async (input) => {
				receivedArmHooks = input.armHooks;
				return {
					headSha: "b".repeat(40),
					ref: input.ref,
					features: { hasPlot: false, hasSeeds: false },
				};
			},
		});

		expect(receivedArmHooks).toBe(false);
	});
});
