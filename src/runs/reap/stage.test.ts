import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

describe("reapRun commit-through-reap sub-steps (warren-343a + warren-7ecc)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	/* ------------------------------------------------------------------ */
	/* warren-343a: commit-through-reap for .plot/                         */
	/* ------------------------------------------------------------------ */

	async function setupWithPlot(): Promise<Ctx> {
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
			hasPlot: true,
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

	test("authors a warren commit when project .plot/ has a delta the agent never committed (warren-343a)", async () => {
		const plotCtx = await setupWithPlot();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl":
					'{"type":"run_dispatched","actor":"user:operator","at":"2026-05-18T10:00:00Z","data":{}}\n',
				"/data/projects/x/y/.plot/plot-abc.json":
					'{"id":"plot-abc","status":"active","updated_at":"2026-05-18T10:00:00Z"}',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: plotCtx.runId,
				outcome: "succeeded",
				repos: plotCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), plotCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.plotCommitted).toBe(true);
			expect(f.files.get("/data/burrow/ws/.plot/plot-abc.events.jsonl")).toContain(
				"run_dispatched",
			);
			expect(f.files.get("/data/burrow/ws/.plot/plot-abc.json")).toContain('"status":"active"');
			const gitArgs = e.calls.filter((c) => c.cmd === "git").map((c) => c.args);
			expect(gitArgs).toContainEqual(["add", "--", ".plot/"]);
			expect(gitArgs).toContainEqual(["diff", "--cached", "--quiet", "--", ".plot/"]);
			const commit = gitArgs.find((a) => a[0] === "-c" && a.includes("commit"));
			expect(commit).toEqual([
				"-c",
				"user.name=warren",
				"-c",
				"user.email=warren@os-eco.dev",
				"commit",
				"--no-verify",
				"-m",
				"chore(warren): plot state",
			]);
			const events = await plotCtx.repos.events.listByRun(plotCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.plot_committed")).toBeDefined();
		} finally {
			await plotCtx.db.close();
		}
	});

	test("does not commit when the agent already committed every .plot/ delta", async () => {
		const plotCtx = await setupWithPlot();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl":
					'{"type":"run_dispatched","actor":"user:operator","at":"2026-05-18T10:00:00Z","data":{}}\n',
			});
			const e = fakeExec({ stagedDelta: false });

			const result = await reapRun({
				runId: plotCtx.runId,
				outcome: "succeeded",
				repos: plotCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), plotCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.plotCommitted).toBe(false);
			const commit = e.calls.find((c) => c.cmd === "git" && c.args.includes("commit"));
			expect(commit).toBeUndefined();
			const events = await plotCtx.repos.events.listByRun(plotCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.plot_committed")).toBeUndefined();
		} finally {
			await plotCtx.db.close();
		}
	});

	test("skips .plot/.index.db* and non-plot-* entries when copying into the workspace", async () => {
		const plotCtx = await setupWithPlot();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl": '{"type":"note"}\n',
				"/data/projects/x/y/.plot/.index.db": "binary-sqlite",
				"/data/projects/x/y/.plot/.index.db-wal": "wal",
				"/data/projects/x/y/.plot/README.md": "# docs",
			});
			const e = fakeExec({ stagedDelta: true });

			await reapRun({
				runId: plotCtx.runId,
				outcome: "succeeded",
				repos: plotCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), plotCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(f.files.get("/data/burrow/ws/.plot/plot-abc.events.jsonl")).toBeDefined();
			expect(f.files.get("/data/burrow/ws/.plot/.index.db")).toBeUndefined();
			expect(f.files.get("/data/burrow/ws/.plot/.index.db-wal")).toBeUndefined();
			expect(f.files.get("/data/burrow/ws/.plot/README.md")).toBeUndefined();
		} finally {
			await plotCtx.db.close();
		}
	});

	test("trivial-merge child: warren commit keeps reap.empty_push silent", async () => {
		const plotCtx = await setupWithPlot();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.plot/plot-abc.events.jsonl":
					'{"type":"run_dispatched","actor":"user:operator","at":"2026-05-18T10:00:00Z","data":{}}\n',
			});
			const e = fakeExec({ stagedDelta: true, revListCount: "1" });

			const result = await reapRun({
				runId: plotCtx.runId,
				outcome: "succeeded",
				repos: plotCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), plotCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.plotCommitted).toBe(true);
			expect(result.branchPushed).toBe(true);
			expect(result.commitsAhead).toBe(1);
			const events = await plotCtx.repos.events.listByRun(plotCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
		} finally {
			await plotCtx.db.close();
		}
	});

	test("project without .plot/ skips the plot_commit step entirely", async () => {
		const f = fakeFs({
			"/data/projects/x/y/.plot/plot-abc.events.jsonl": '{"type":"x"}\n',
		});
		const e = fakeExec({ stagedDelta: true });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.plotCommitted).toBe(false);
		expect(f.files.get("/data/burrow/ws/.plot/plot-abc.events.jsonl")).toBeUndefined();
		const gitArgs = e.calls.filter((c) => c.cmd === "git").map((c) => c.args);
		expect(gitArgs.find((a) => a.includes("add"))).toBeUndefined();
		expect(gitArgs.find((a) => a.includes("commit"))).toBeUndefined();
	});

	/* ------------------------------------------------------------------ */
	/* warren-7ecc: commit-through-reap for .seeds/                        */
	/* ------------------------------------------------------------------ */

	async function setupWithSeeds(): Promise<Ctx> {
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

	test("authors a warren commit when project .seeds/ has a delta the agent never committed (warren-7ecc)", async () => {
		const seedsCtx = await setupWithSeeds();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
				"/data/projects/x/y/.seeds/plans.jsonl":
					'{"id":"pl-abcd","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: seedsCtx.runId,
				outcome: "succeeded",
				repos: seedsCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), seedsCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.seedsCommitted).toBe(true);
			expect(f.files.get("/data/burrow/ws/.seeds/issues.jsonl")).toContain("warren-1234");
			expect(f.files.get("/data/burrow/ws/.seeds/plans.jsonl")).toContain("pl-abcd");
			const gitArgs = e.calls.filter((c) => c.cmd === "git").map((c) => c.args);
			expect(gitArgs).toContainEqual(["add", "--", ".seeds/"]);
			expect(gitArgs).toContainEqual(["diff", "--cached", "--quiet", "--", ".seeds/"]);
			const commit = gitArgs.find((a) => a[0] === "-c" && a.includes("commit"));
			expect(commit).toEqual([
				"-c",
				"user.name=warren",
				"-c",
				"user.email=warren@os-eco.dev",
				"commit",
				"--no-verify",
				"-m",
				"chore(warren): seeds state",
			]);
			const events = await seedsCtx.repos.events.listByRun(seedsCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.seeds_committed")).toBeDefined();
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("does not commit when the agent already committed every .seeds/ delta", async () => {
		const seedsCtx = await setupWithSeeds();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
			});
			const e = fakeExec({ stagedDelta: false });

			const result = await reapRun({
				runId: seedsCtx.runId,
				outcome: "succeeded",
				repos: seedsCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), seedsCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.seedsCommitted).toBe(false);
			const commit = e.calls.find((c) => c.cmd === "git" && c.args.includes("commit"));
			expect(commit).toBeUndefined();
			const events = await seedsCtx.repos.events.listByRun(seedsCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.seeds_committed")).toBeUndefined();
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("skips .seeds/config.yaml + .seeds/templates.jsonl when copying into the workspace", async () => {
		const seedsCtx = await setupWithSeeds();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
				"/data/projects/x/y/.seeds/config.yaml": 'project: "x"\n',
				"/data/projects/x/y/.seeds/templates.jsonl": '{"id":"t1"}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			await reapRun({
				runId: seedsCtx.runId,
				outcome: "succeeded",
				repos: seedsCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), seedsCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(f.files.get("/data/burrow/ws/.seeds/issues.jsonl")).toBeDefined();
			expect(f.files.get("/data/burrow/ws/.seeds/config.yaml")).toBeUndefined();
			expect(f.files.get("/data/burrow/ws/.seeds/templates.jsonl")).toBeUndefined();
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("planner-default-prompt round trip: warren commit keeps reap.empty_push silent (warren-7ecc)", async () => {
		const seedsCtx = await setupWithSeeds();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
				"/data/projects/x/y/.seeds/plans.jsonl":
					'{"id":"pl-abcd","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
			});
			const e = fakeExec({ stagedDelta: true, revListCount: "1" });

			const result = await reapRun({
				runId: seedsCtx.runId,
				outcome: "succeeded",
				repos: seedsCtx.repos,
				burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), seedsCtx.repos),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.seedsCommitted).toBe(true);
			expect(result.branchPushed).toBe(true);
			expect(result.commitsAhead).toBe(1);
			const events = await seedsCtx.repos.events.listByRun(seedsCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("project without .seeds/ skips the seeds_commit step entirely", async () => {
		const f = fakeFs({
			"/data/projects/x/y/.seeds/issues.jsonl": '{"id":"warren-1234","status":"open"}\n',
		});
		const e = fakeExec({ stagedDelta: true });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.seedsCommitted).toBe(false);
		expect(f.files.get("/data/burrow/ws/.seeds/issues.jsonl")).toBeUndefined();
		const gitArgs = e.calls.filter((c) => c.cmd === "git").map((c) => c.args);
		expect(gitArgs.find((a) => a.includes("add") && a.includes(".seeds/"))).toBeUndefined();
		expect(gitArgs.find((a) => a.includes("commit"))).toBeUndefined();
	});
});
