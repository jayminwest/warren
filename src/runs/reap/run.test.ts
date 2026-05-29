import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reapRun } from "./index.ts";
import {
	type Burrow,
	BurrowClient,
	type Ctx,
	createRepos,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	makePool,
	openDatabase,
	setup,
} from "./test-helpers.ts";

/* ----------------------------------------------------------------------- */
/* End-to-end reapRun cases                                                 */
/* ----------------------------------------------------------------------- */

describe("reapRun", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("merges burrow .mulch into project .mulch and pushes the workspace branch", async () => {
		const f = fakeFs({
			"/data/burrow/ws/.mulch/expertise/build.jsonl":
				'{"id":"mx-1","recorded_at":"2026-05-08T21:00:00Z","content":"new"}\n',
			"/data/projects/x/y/.mulch/expertise/build.jsonl":
				'{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"old"}\n',
		});
		const e = fakeExec();

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.state).toBe("succeeded");
		expect(result.mulchUpdated).toBe(1);
		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBe(1);
		expect(result.errors).toEqual([]);
		expect(f.files.get("/data/projects/x/y/.mulch/expertise/build.jsonl")).toContain(
			'"content":"new"',
		);
		// Reap runs `git push` then `git rev-list --count <base>..HEAD`
		// (warren-f3bb).
		expect(e.calls).toHaveLength(2);
		expect(e.calls[0]?.cmd).toBe("git");
		expect(e.calls[0]?.args).toEqual(["push", "origin", "HEAD:agent/refactor-bot/run-1"]);
		expect(e.calls[0]?.cwd).toBe("/data/burrow/ws");
		expect(e.calls[1]?.cmd).toBe("git");
		expect(e.calls[1]?.args).toEqual(["rev-list", "--count", "main..HEAD"]);
	});

	test("emits reap.empty_push when push lands zero commits (warren-f3bb)", async () => {
		const f = fakeFs();
		const e = fakeExec({ revListCount: "0" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBe(0);
		// Clean tree (default fakeExec gitStatus="") => deliberate no-op, the
		// run still succeeds (warren-72b9).
		expect(result.state).toBe("succeeded");
		expect(result.failureReason).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const empty = events.find((ev) => ev.kind === "reap.empty_push");
		expect(empty).toBeDefined();
		expect(empty?.payloadJson).toMatchObject({
			branch: "agent/refactor-bot/run-1",
			baseBranch: "main",
			dirty: false,
			droppedCommit: false,
		});
		const completed = events.find((ev) => ev.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({ branchPushed: true, commitsAhead: 0 });
	});

	test("flags a dropped commit (zero commits + dirty tree) and fails the run (warren-72b9)", async () => {
		const e = fakeExec({ revListCount: "0", gitStatus: " M src/foo.ts\n?? new.ts\n" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.commitsAhead).toBe(0);
		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("dropped_commit");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const empty = events.find((ev) => ev.kind === "reap.empty_push");
		expect(empty?.payloadJson).toMatchObject({ dirty: true, droppedCommit: true });
		const run = await ctx.repos.runs.require(ctx.runId);
		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("dropped_commit");
	});

	test("git status probe failure degrades a zero-commit push to a no-op success (warren-72b9)", async () => {
		const e = fakeExec({ revListCount: "0", failGitStatus: "fatal: not a git repo" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.commitsAhead).toBe(0);
		expect(result.state).toBe("succeeded");
		expect(result.failureReason).toBeNull();
	});

	test("does not emit reap.empty_push when push lands real commits", async () => {
		const e = fakeExec({ revListCount: "3" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.commitsAhead).toBe(3);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
	});

	test("rev-list failure degrades commitsAhead to null without failing reap", async () => {
		const e = fakeExec({ failRevList: "fatal: bad revision 'main..HEAD'" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBeNull();
		// Non-fatal: not a reap_failed step.
		expect(result.errors.map((x) => x.step)).not.toContain("branch_push");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
	});

	test("uses project.defaultBranch as the rev-list base", async () => {
		// Override the project's defaultBranch to verify reap reads it
		// (not a hardcoded `main`) when computing the empty-push count.
		const customDb = await openDatabase({ path: ":memory:" });
		const customRepos = createRepos(customDb);
		await customRepos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await customRepos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "develop",
		});
		const run = await customRepos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		await customRepos.runs.markRunning(run.id);

		const e = fakeExec({ revListCount: "2" });
		const result = await reapRun({
			runId: run.id,
			outcome: "succeeded",
			repos: customRepos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.commitsAhead).toBe(2);
		const revList = e.calls.find((c) => c.args[0] === "rev-list");
		expect(revList?.args).toEqual(["rev-list", "--count", "develop..HEAD"]);
		await customDb.close();
	});

	test("transitions warren run state to the supplied terminal outcome", async () => {
		await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.state).toBe("failed");
		expect(row.endedAt).not.toBeNull();
	});

	test("queued → succeeded transition is bridged via markRunning first", async () => {
		// Reset the run back to queued for this case.
		await ctx.repos.runs.finalize(ctx.runId, "cancelled"); // park previous state
		const repos = ctx.repos;
		const project = (await repos.projects.listAll())[0];
		expect(project).toBeDefined();
		const fresh = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: (project as { id: string }).id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_freshfreshfr",
		});
		await reapRun({
			runId: fresh.id,
			outcome: "succeeded",
			repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		const row = await repos.runs.require(fresh.id);
		expect(row.state).toBe("succeeded");
		expect(row.startedAt).not.toBeNull();
	});

	test("logs reap_failed but does not throw when the branch push fails", async () => {
		const f = fakeFs();
		const e = fakeExec({ fail: "remote rejected: not allowed" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.branchPushed).toBe(false);
		expect(result.errors.map((x) => x.step)).toContain("branch_push");
		expect(result.state).toBe("succeeded");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.some((ev) => ev.kind === "reap_failed")).toBe(true);
	});

	test("logs reap_failed when burrow lookup fails and skips file work", async () => {
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: (async () =>
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch,
		});
		(client.http.burrows as unknown as { get: () => Promise<Burrow> }).get = async () => {
			throw new Error("burrow gone");
		};
		const e = fakeExec();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(client, ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});
		expect(result.errors.map((x) => x.step)).toContain("workspace_lookup");
		expect(result.branchPushed).toBe(false);
		expect(e.calls).toHaveLength(0);
		expect(result.state).toBe("succeeded");
	});

	test("is idempotent against runs already in a terminal state", async () => {
		await ctx.repos.runs.finalize(ctx.runId, "succeeded");
		const e = fakeExec();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: e.exec,
		});
		expect(result.alreadyTerminal).toBe(true);
		expect(e.calls).toHaveLength(0);
		expect(await ctx.repos.events.countByRun(ctx.runId)).toBe(0);
	});
	test("destroys the burrow workspace and removes the burrows row after reap (warren-0d89)", async () => {
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.workspaceDestroyed).toBe(true);
		expect(await ctx.repos.burrows.get("bur_aaaaaaaaaaaa")).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const destroyed = events.find((ev) => ev.kind === "reap.workspace_destroyed");
		expect(destroyed?.payloadJson).toMatchObject({ burrowId: "bur_aaaaaaaaaaaa" });
		// Emitted after the terminal transition, so reap.completed precedes it.
		const order = events.map((ev) => ev.kind);
		expect(order.indexOf("reap.completed")).toBeLessThan(order.indexOf("reap.workspace_destroyed"));
	});

	test("publishes reap-emitted events to the broker for live tailers", async () => {
		const f = fakeFs({
			"/data/burrow/ws/.mulch/expertise/build.jsonl":
				'{"id":"mx-1","recorded_at":"2026-05-08T21:00:00Z","content":"new"}\n',
		});
		const sub = ctx.broker.subscribe(ctx.runId);
		const consumed: string[] = [];
		const consumer = (async () => {
			for await (const row of sub) {
				consumed.push(row.kind);
				if (row.kind === "reap.completed") break;
			}
		})();

		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: f.fs,
			exec: fakeExec().exec,
		});
		await consumer;
		expect(consumed).toContain("mulch.record.added");
		expect(consumed).toContain("reap.completed");
	});
});
