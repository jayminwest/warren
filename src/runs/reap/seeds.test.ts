import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	createRepos,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	makePool,
	openDatabase,
	RunEventBroker,
	setup,
} from "./test-helpers.ts";

describe("reapRun seeds-close mirror", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("mirrors closed seeds into the project's .seeds/issues.jsonl via HttpClient.files.read", async () => {
		const f = fakeFs({
			"/data/projects/x/y/.seeds/issues.jsonl":
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(
				fakeBurrowClient(makeBurrow(), {
					seedsIssuesBody:
						'{"id":"sd-1","status":"closed","updatedAt":"2026-05-08T22:00:00Z","title":"x"}\n' +
						'{"id":"sd-2","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"y"}\n',
				}),
				ctx.repos,
			),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(1);
		expect(result.seedsCreated).toBe(1);
		const merged = f.files.get("/data/projects/x/y/.seeds/issues.jsonl") ?? "";
		expect(merged).toContain('"status":"closed"');
		expect(merged).toContain('"id":"sd-2"');
	});

	test("mirrors newly-created open seeds from planner runs into the project clone", async () => {
		const f = fakeFs({
			"/data/projects/x/y/.seeds/issues.jsonl":
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(
				fakeBurrowClient(makeBurrow(), {
					seedsIssuesBody:
						'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n' +
						'{"id":"sd-new1","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"planned-a"}\n' +
						'{"id":"sd-new2","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"planned-b"}\n',
				}),
				ctx.repos,
			),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(0);
		expect(result.seedsCreated).toBe(2);
		const merged = f.files.get("/data/projects/x/y/.seeds/issues.jsonl") ?? "";
		expect(merged).toContain('"id":"sd-new1"');
		expect(merged).toContain('"id":"sd-new2"');
		expect(merged).toContain('"id":"sd-1"');
	});

	test("does not overwrite existing open seeds with workspace copies", async () => {
		const f = fakeFs({
			"/data/projects/x/y/.seeds/issues.jsonl":
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"original"}\n',
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(
				fakeBurrowClient(makeBurrow(), {
					seedsIssuesBody:
						'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T22:00:00Z","title":"modified"}\n',
				}),
				ctx.repos,
			),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(0);
		expect(result.seedsCreated).toBe(0);
		const merged = f.files.get("/data/projects/x/y/.seeds/issues.jsonl") ?? "";
		expect(merged).toContain('"title":"original"');
		expect(merged).not.toContain('"title":"modified"');
	});

	test("seeds_close treats NotFoundError from files.read as 'no seeds file' (no error, no mirror)", async () => {
		// Default fakeBurrowClient throws NotFoundError from files.read —
		// the workspace-side seeds file does not exist, which is the
		// agent-never-created-it shape. seeds_close should be a no-op,
		// not a reap_failed.
		const f = fakeFs({
			"/data/projects/x/y/.seeds/issues.jsonl":
				'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		});
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(0);
		expect(result.errors.map((x) => x.step)).not.toContain("seeds_close");
		// Project-side file untouched.
		expect(f.files.get("/data/projects/x/y/.seeds/issues.jsonl")).toBe(
			'{"id":"sd-1","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
		);
	});

	test("seeds_close surfaces non-NotFound errors from files.read as reap_failed", async () => {
		const f = fakeFs();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(
				fakeBurrowClient(makeBurrow(), {
					filesRead: async () => {
						throw new Error("boom");
					},
				}),
				ctx.repos,
			),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.seedsClosed).toBe(0);
		expect(result.errors.map((x) => x.step)).toContain("seeds_close");
	});
});

/* ----------------------------------------------------------------------- */
/* Plans mirror (warren-d9a2)                                               */
/* ----------------------------------------------------------------------- */

describe("mirrorPlans (warren-d9a2)", () => {
	async function setupWithSeeds() {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
			hasSeeds: true,
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		await repos.runs.markRunning(run.id);
		return {
			db,
			repos,
			broker: new RunEventBroker(),
			runId: run.id,
			projectPath: project.localPath,
			workspacePath: "/data/burrow/ws",
		};
	}

	test("mirrors new plans from workspace into project clone", async () => {
		const ctx = await setupWithSeeds();
		try {
			const existingPlan = '{"id":"pl-existing","status":"approved","children":["warren-a"]}\n';
			const newPlan = '{"id":"pl-new","status":"approved","children":["warren-b","warren-c"]}\n';
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": existingPlan,
			});
			const e = fakeExec({ stagedDelta: true });

			await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				burrowClientPool: await makePool(
					fakeBurrowClient(makeBurrow(), {
						seedsPlansBody: `${existingPlan}${newPlan}`,
					}),
					ctx.repos,
				),
				fs: f.fs,
				exec: e.exec,
			});

			const projectPlans = f.files.get("/data/projects/x/y/.seeds/plans.jsonl") ?? "";
			expect(projectPlans).toContain("pl-existing");
			expect(projectPlans).toContain("pl-new");
			const events = await ctx.repos.events.listByRun(ctx.runId);
			expect(events.find((ev) => ev.kind === "seeds.plan_mirrored")).toBeDefined();
		} finally {
			await ctx.db.close();
		}
	});

	test("does not duplicate existing plans during mirror", async () => {
		const ctx = await setupWithSeeds();
		try {
			const existingPlan = '{"id":"pl-existing","status":"approved","children":["warren-a"]}\n';
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": existingPlan,
			});
			const e = fakeExec({ stagedDelta: false });

			await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				burrowClientPool: await makePool(
					fakeBurrowClient(makeBurrow(), { seedsPlansBody: existingPlan }),
					ctx.repos,
				),
				fs: f.fs,
				exec: e.exec,
			});

			const projectPlans = f.files.get("/data/projects/x/y/.seeds/plans.jsonl") ?? "";
			const count = projectPlans.split("pl-existing").length - 1;
			expect(count).toBe(1);
		} finally {
			await ctx.db.close();
		}
	});

	test("mirrored plans survive into workspace via stageSeedsForCommit", async () => {
		const ctx = await setupWithSeeds();
		try {
			const newPlan = '{"id":"pl-agent-created","status":"approved","children":["warren-x"]}\n';
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
			});
			const e = fakeExec({ stagedDelta: true });

			await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				burrowClientPool: await makePool(
					fakeBurrowClient(makeBurrow(), { seedsPlansBody: newPlan }),
					ctx.repos,
				),
				fs: f.fs,
				exec: e.exec,
			});

			const workspacePlans = f.files.get("/data/burrow/ws/.seeds/plans.jsonl") ?? "";
			expect(workspacePlans).toContain("pl-agent-created");
		} finally {
			await ctx.db.close();
		}
	});
});

/* ----------------------------------------------------------------------- */
/* Host-side seed-id close (warren-0d2d)                                   */
/* ----------------------------------------------------------------------- */

/** Build a SeedsCliDeps stub whose `spawn` tracks calls and returns exit 0. */
function fakeSeedsCli(opts: { exitCode?: number } = {}): {
	seedsCli: SeedsCliDeps;
	calls: Array<{ args: string[]; cwd: string }>;
} {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const seedsCli: SeedsCliDeps = {
		sdBinary: "sd",
		spawn: async (args, spawnOpts) => {
			calls.push({ args: args as string[], cwd: spawnOpts?.cwd ?? "" });
			const exitCode = opts.exitCode ?? 0;
			return { exitCode, stdout: "", stderr: exitCode !== 0 ? "error" : "" };
		},
	};
	return { seedsCli, calls };
}

describe("closeRunSeedId (warren-0d2d)", () => {
	/** Setup helper: project with hasSeeds=true + run with seedId. */
	async function setupWithSeedId(seedId: string | null = "sd-target"): Promise<{
		db: ReturnType<typeof openDatabase> extends Promise<infer T> ? T : never;
		repos: Awaited<ReturnType<typeof setup>>["repos"];
		runId: string;
	}> {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
			hasSeeds: true,
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
			...(seedId !== null ? { seedId } : {}),
		});
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		await repos.runs.markRunning(run.id);
		return { db, repos, runId: run.id };
	}

	test("closes the run seedId via sd cli when outcome=succeeded and run has a seedId", async () => {
		const { db, repos, runId } = await setupWithSeedId("sd-target");
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"sd-target","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n',
			});
			const { seedsCli, calls } = fakeSeedsCli();

			const result = await reapRun({
				runId,
				outcome: "succeeded",
				repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), repos),
				fs: f.fs,
				exec: fakeExec().exec,
				seedsCli,
			});

			expect(result.seedIdClosed).toBe(true);
			const closeCall = calls.find((c) => c.args.includes("close") && c.args.includes("sd-target"));
			expect(closeCall).toBeDefined();
			expect(closeCall?.cwd).toBe("/data/projects/x/y");
			const events = await repos.events.listByRun(runId);
			expect(events.find((ev) => ev.kind === "seeds.seed_id_closed")).toBeDefined();
		} finally {
			await db.close();
		}
	});

	test("skips close when run has no seedId", async () => {
		const { db, repos, runId } = await setupWithSeedId(null);
		try {
			const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": "" });
			const { seedsCli, calls } = fakeSeedsCli();

			const result = await reapRun({
				runId,
				outcome: "succeeded",
				repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), repos),
				fs: f.fs,
				exec: fakeExec().exec,
				seedsCli,
			});

			expect(result.seedIdClosed).toBe(false);
			expect(calls.some((c) => c.args.includes("close"))).toBe(false);
		} finally {
			await db.close();
		}
	});

	test("skips close when outcome is failed", async () => {
		const { db, repos, runId } = await setupWithSeedId("sd-target");
		try {
			const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": "" });
			const { seedsCli, calls } = fakeSeedsCli();

			const result = await reapRun({
				runId,
				outcome: "failed",
				repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), repos),
				fs: f.fs,
				exec: fakeExec().exec,
				seedsCli,
			});

			expect(result.seedIdClosed).toBe(false);
			expect(calls.some((c) => c.args.includes("close"))).toBe(false);
		} finally {
			await db.close();
		}
	});

	test("surfaces sd close failure as reap_failed step=seed_id_close (best-effort)", async () => {
		const { db, repos, runId } = await setupWithSeedId("sd-target");
		try {
			const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": "" });
			const { seedsCli } = fakeSeedsCli({ exitCode: 1 });

			const result = await reapRun({
				runId,
				outcome: "succeeded",
				repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), repos),
				fs: f.fs,
				exec: fakeExec().exec,
				seedsCli,
			});

			expect(result.seedIdClosed).toBe(false);
			expect(result.errors.map((e) => e.step)).toContain("seed_id_close");
			expect(result.state).toBe("succeeded");
		} finally {
			await db.close();
		}
	});

	test("skips close when seedsCli is not provided", async () => {
		const { db, repos, runId } = await setupWithSeedId("sd-target");
		try {
			const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": "" });

			const result = await reapRun({
				runId,
				outcome: "succeeded",
				repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), repos),
				fs: f.fs,
				exec: fakeExec().exec,
			});

			expect(result.seedIdClosed).toBe(false);
			expect(result.errors.map((e) => e.step)).not.toContain("seed_id_close");
		} finally {
			await db.close();
		}
	});
});
