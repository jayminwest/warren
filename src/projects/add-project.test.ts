import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { isId } from "../core/ids.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { SandboxGitPreflightError } from "../sandbox/git-preflight.ts";
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

	// warren-4fe1: found registering openclaw (~2.9GB) — the handler never
	// passes timeoutMs, so the config-level operator override
	// (WARREN_GIT_TIMEOUT_MS) must reach the cloner through the fallback chain.
	test("falls back to config.gitTimeoutMs when the caller passes no timeoutMs", async () => {
		let received: number | undefined;
		await addProject({
			repo,
			config: { ...CFG, gitTimeoutMs: 900_000 },
			gitUrl: "https://github.com/x/big.git",
			spawn: NOOP_SPAWN,
			clone: async (input) => {
				received = input.timeoutMs;
				return {
					localPath: `${input.config.root}/${input.owner}/${input.name}`,
					defaultBranch: "main",
				};
			},
		});

		expect(received).toBe(900_000);
	});

	test("persists hasSeeds=true after probe (warren-9990)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			detectFeatures: () => ({ hasSeeds: true, hasMulch: false }),
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

	test("registers a forge-owned non-GitHub URL via the forge fallback (warren-2600)", async () => {
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "fake://warren-acceptance/sample-fake-forge",
			forge: new FakeForge(),
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
		});
		expect(row.gitUrl).toBe("fake://warren-acceptance/sample-fake-forge");
		expect(row.localPath).toBe("/data/projects/warren-acceptance/sample-fake-forge");
	});

	test("a disowned non-GitHub URL still surfaces the original ValidationError", async () => {
		await expect(
			addProject({
				repo,
				config: CFG,
				gitUrl: "https://gitlab.com/o/r.git",
				forge: new FakeForge(),
				spawn: NOOP_SPAWN,
				clone: fakeClone(),
			}),
		).rejects.toBeInstanceOf(ValidationError);
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

	// warren-1219: a git that cannot execute inside the sandbox must fail
	// registration BEFORE the clone, with the binary named — not surface
	// later as a dropped_commit run failure.
	test("fails with the typed preflight error before cloning when the sandbox git probe fails", async () => {
		let cloneCalls = 0;
		let probeCalls = 0;
		await expect(
			addProject({
				repo,
				config: CFG,
				gitUrl: "https://github.com/x/y.git",
				spawn: NOOP_SPAWN,
				clone: async () => {
					cloneCalls += 1;
					return { localPath: "/data/projects/x/y", defaultBranch: "main" };
				},
				sandboxGitPreflight: async () => {
					probeCalls += 1;
					return {
						ok: false,
						gitPath: "/nix/store/abc-git-2.44/bin/git",
						effectiveGit: "/nix/store/abc-git-2.44/bin/git",
						substituted: false,
						message:
							"/nix/store/abc-git-2.44/bin/git does not execute inside the sandbox: dyld: Library not loaded",
					};
				},
			}),
		).rejects.toBeInstanceOf(SandboxGitPreflightError);
		expect(cloneCalls).toBe(0);
		expect(probeCalls).toBe(1);
		expect(await repo.listAll()).toHaveLength(0);
	});

	test("proceeds to clone when the preflight passes (or is not wired)", async () => {
		let probeCalls = 0;
		const row = await addProject({
			repo,
			config: CFG,
			gitUrl: "https://github.com/x/y.git",
			spawn: NOOP_SPAWN,
			clone: fakeClone(),
			sandboxGitPreflight: async () => {
				probeCalls += 1;
				return {
					ok: true,
					gitPath: "/usr/bin/git",
					effectiveGit: "/usr/bin/git",
					substituted: false,
					message: "ok",
				};
			},
		});
		expect(probeCalls).toBe(1);
		expect(isId("project", row.id)).toBe(true);
	});
});
