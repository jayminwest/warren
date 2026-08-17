import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	gitRepoContextScrubEnv,
	WARREN_BOT_IDENTITY,
	warrenCommitIdentityEnv,
} from "../../bot-identity.ts";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	createRepos,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	openDatabase,
	RunEventBroker,
	reapDeps,
	setup,
} from "./test-helpers.ts";

describe("reapRun commit-through-reap sub-steps (warren-7ecc)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
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
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: "run_zzzzzzzzzzzz",
		});
		await repos.runs.markRunning(run.id);
		return {
			db,
			repos,
			broker: new RunEventBroker(),
			runId: run.id,
			projectPath: project.localPath,
			workspacePath: "/data/sandbox/ws",
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
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.seedsCommitted).toBe(true);
			expect(f.files.get("/data/sandbox/ws/.seeds/issues.jsonl")).toContain("warren-1234");
			expect(f.files.get("/data/sandbox/ws/.seeds/plans.jsonl")).toContain("pl-abcd");
			const gitArgs = e.calls.filter((c) => c.cmd === "git").map((c) => c.args);
			expect(gitArgs).toContainEqual(["add", "--", ".seeds/"]);
			expect(gitArgs).toContainEqual([
				"diff",
				"--cached",
				"--quiet",
				"--",
				".seeds/issues.jsonl",
				".seeds/plans.jsonl",
			]);
			const commit = gitArgs.find((a) => a[0] === "-c" && a.includes("commit"));
			expect(commit).toEqual([
				"-c",
				"user.name=warren",
				"-c",
				`user.email=${WARREN_BOT_IDENTITY.email}`,
				"commit",
				"--no-verify",
				"--only",
				"-m",
				"chore(warren): seeds state",
				"--",
				".seeds/issues.jsonl",
				".seeds/plans.jsonl",
			]);
			const events = await seedsCtx.repos.events.listByRun(seedsCtx.runId);
			expect(events.find((ev) => ev.kind === "reap.seeds_committed")).toBeDefined();
			// warren-035c: the commit spawn also pins the identity in env so an
			// inherited GIT_AUTHOR_*/GIT_COMMITTER_* can't out-rank the `-c` config.
			// warren-23dd: it also carries the repo-context GIT_* scrub (keys
			// present-and-undefined) so a leaked GIT_DIR can't divert the commit.
			const commitCall = e.calls.find((c) => c.cmd === "git" && c.args.includes("commit"));
			expect(commitCall?.env).toEqual({
				...gitRepoContextScrubEnv(),
				...warrenCommitIdentityEnv(),
			});
			// warren-23dd: the non-commit git calls (add / diff --cached) in the
			// same flow carry the scrub alone, mirroring clone-apply.ts.
			const addCall = e.calls.find((c) => c.cmd === "git" && c.args[0] === "add");
			expect(addCall?.env).toEqual(gitRepoContextScrubEnv());
			const diffCall = e.calls.find(
				(c) => c.cmd === "git" && c.args[0] === "diff" && c.args.includes("--cached"),
			);
			expect(diffCall?.env).toEqual(gitRepoContextScrubEnv());
		} finally {
			await seedsCtx.db.close();
		}
	});

	test("path-limits the seeds commit to the two carriers so pre-staged unrelated files aren't swept in (warren-be12)", async () => {
		const seedsCtx = await setupWithSeeds();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl":
					'{"id":"warren-1234","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
				"/data/projects/x/y/.seeds/plans.jsonl":
					'{"id":"pl-abcd","status":"open","updatedAt":"2026-05-22T10:00:00Z"}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			await reapRun({
				runId: seedsCtx.runId,
				outcome: "succeeded",
				repos: seedsCtx.repos,
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
				fs: f.fs,
				exec: e.exec,
			});

			const commit = e.calls
				.filter((c) => c.cmd === "git")
				.map((c) => c.args)
				.find((a) => a[0] === "-c" && a.includes("commit"));
			// `--only -- .seeds/issues.jsonl .seeds/plans.jsonl` confines the
			// commit to the two carriers, never an unrelated pre-staged file.
			expect(commit).toContain("--only");
			const dashDash = commit?.indexOf("--") ?? -1;
			expect(dashDash).toBeGreaterThan(-1);
			expect(commit?.slice(dashDash + 1)).toEqual([".seeds/issues.jsonl", ".seeds/plans.jsonl"]);
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
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
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
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
				fs: f.fs,
				exec: e.exec,
			});

			expect(f.files.get("/data/sandbox/ws/.seeds/issues.jsonl")).toBeDefined();
			expect(f.files.get("/data/sandbox/ws/.seeds/config.yaml")).toBeUndefined();
			expect(f.files.get("/data/sandbox/ws/.seeds/templates.jsonl")).toBeUndefined();
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
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
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
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.seedsCommitted).toBe(false);
		expect(f.files.get("/data/sandbox/ws/.seeds/issues.jsonl")).toBeUndefined();
		const gitArgs = e.calls.filter((c) => c.cmd === "git").map((c) => c.args);
		expect(gitArgs.find((a) => a.includes("add") && a.includes(".seeds/"))).toBeUndefined();
		expect(gitArgs.find((a) => a.includes("commit"))).toBeUndefined();
	});
});
