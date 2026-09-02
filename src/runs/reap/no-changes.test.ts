import { beforeEach, describe, expect, test } from "bun:test";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import { reapRun } from "./run.ts";
import {
	createRepos,
	FAKE_REV_PARSE_SHA,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	openDatabase,
	reapDeps,
} from "./test-helpers.ts";

/**
 * warren-89b0 / warren-ba08: a zero-commit push whose ONLY dirty paths are
 * warren-managed bookkeeping artifacts is a deliberate no-op on a FRESH-branch
 * dispatch (`succeeded`, `noChanges`), NOT a dropped commit (`failed`). On a
 * REF-dispatch (`ref` / `targetBranch` set) the same shape reaps
 * `failed`/`no_changes` so shepherds cannot read "agent did nothing" as fixed.
 */

const ISSUES =
	'{"id":"sd-target","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n';

/** Build a SeedsCliDeps stub whose `spawn` records calls and exits 0. */
function fakeSeedsCli(): { seedsCli: SeedsCliDeps; calls: Array<{ args: string[] }> } {
	const calls: Array<{ args: string[] }> = [];
	const seedsCli: SeedsCliDeps = {
		sdBinary: "sd",
		spawn: async (args) => {
			calls.push({ args: args as string[] });
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	};
	return { seedsCli, calls };
}

async function setupSeeded(
	seedId: string | null,
	opts: { ref?: string; targetBranch?: string } = {},
): Promise<{
	repos: Awaited<ReturnType<typeof createRepos>>;
	runId: string;
}> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: { sections: { system: "x" } } });
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
		...(seedId !== null ? { seedId } : {}),
		...(opts.ref !== undefined ? { ref: opts.ref } : {}),
		...(opts.targetBranch !== undefined ? { targetBranch: opts.targetBranch } : {}),
	});
	await repos.runs.markRunning(run.id);
	return { repos, runId: run.id };
}

describe("reapRun zero-commit classification (warren-89b0)", () => {
	let repos: Awaited<ReturnType<typeof createRepos>>;
	let runId: string;

	beforeEach(async () => {
		({ repos, runId } = await setupSeeded("sd-target"));
	});

	test("bookkeeping-only dirty tree is an intentional no-op, not a dropped commit", async () => {
		const { seedsCli } = fakeSeedsCli();
		const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": ISSUES });
		const e = fakeExec({
			revListCount: "0",
			gitStatus: " M .mulch/expertise/build.jsonl\n?? .seeds/issues.jsonl\n",
		});

		const result = await reapRun({
			runId,
			outcome: "succeeded",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			fs: f.fs,
			exec: e.exec,
			seedsCli,
		});

		expect(result.state).toBe("succeeded");
		expect(result.failureReason).toBeNull();
		const events = await repos.events.listByRun(runId);
		expect(events.find((ev) => ev.kind === "reap.empty_push")?.payloadJson).toMatchObject({
			dirty: true,
			droppedCommit: false,
			noChanges: true,
		});
		expect(events.find((ev) => ev.kind === "reap.completed")?.payloadJson).toMatchObject({
			noChanges: true,
		});
	});

	test("real uncommitted work is a dropped commit", async () => {
		const { seedsCli } = fakeSeedsCli();
		const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": ISSUES });
		const e = fakeExec({ revListCount: "0", gitStatus: " M src/foo.ts\n" });

		const result = await reapRun({
			runId,
			outcome: "succeeded",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			fs: f.fs,
			exec: e.exec,
			seedsCli,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("dropped_commit");
	});
});

describe("reapRun ref-dispatch zero-commit (warren-ba08)", () => {
	test("ref-dispatch with a clean zero-commit tree fails as no_changes", async () => {
		const { repos, runId } = await setupSeeded(null, {
			ref: "fix/pr-head",
			targetBranch: "fix/pr-head",
		});
		const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": ISSUES });
		const e = fakeExec({ revListCount: "0", gitStatus: "" });

		const result = await reapRun({
			runId,
			outcome: "succeeded",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("no_changes");
		const row = await repos.runs.require(runId);
		expect(row.state).toBe("failed");
		expect(row.failureReason).toBe("no_changes");
		const events = await repos.events.listByRun(runId);
		expect(events.find((ev) => ev.kind === "reap.empty_push")?.payloadJson).toMatchObject({
			noChanges: true,
			droppedCommit: false,
		});
		expect(events.find((ev) => ev.kind === "reap.completed")?.payloadJson).toMatchObject({
			state: "failed",
			failureReason: "no_changes",
			noChanges: true,
		});
	});

	test("ref-dispatch with commits made reaps as succeeded, counted from the pre-push origin tip", async () => {
		// Repair topology: the workspace branch IS the ref (branch === baseBranch).
		const { repos, runId } = await setupSeeded(null, {
			ref: "fix/pr-head",
			targetBranch: "fix/pr-head",
		});
		const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": ISSUES });
		const e = fakeExec({ revListCount: "2", gitStatus: "" });

		const result = await reapRun({
			runId,
			outcome: "succeeded",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow({ branch: "fix/pr-head" })), {
				fs: f.fs,
				exec: e.exec,
			}),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.state).toBe("succeeded");
		expect(result.failureReason).toBeNull();
		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBe(2);
		// The count and the outcome-facts diff both run against the PRE-PUSH
		// origin tip, never the structurally-empty `fix/pr-head..HEAD` range.
		const measured = e.calls
			.filter((c) => c.cmd === "git")
			.map((c) => c.args)
			.filter(
				(a) => ["rev-parse", "push", "rev-list"].includes(a[0] ?? "") || a.includes("--numstat"),
			);
		expect(measured).toEqual([
			["rev-parse", "--verify", "origin/fix/pr-head"],
			["push", "origin", "HEAD:fix/pr-head"],
			["rev-list", "--count", "--first-parent", `${FAKE_REV_PARSE_SHA}..HEAD`],
			["diff", "--numstat", `${FAKE_REV_PARSE_SHA}..HEAD`],
		]);
		const row = await repos.runs.require(runId);
		expect(row.commitsAhead).toBe(2);
		const events = await repos.events.listByRun(runId);
		expect(events.find((ev) => ev.kind === "reap.empty_push")).toBeUndefined();
	});

	test("targetBranch-only dispatch with bookkeeping-only dirt fails as no_changes", async () => {
		const { repos, runId } = await setupSeeded(null, { targetBranch: "fix/pr-head" });
		const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": ISSUES });
		const e = fakeExec({
			revListCount: "0",
			gitStatus: " M .mulch/expertise/build.jsonl\n?? .seeds/issues.jsonl\n",
		});

		const result = await reapRun({
			runId,
			outcome: "succeeded",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("no_changes");
		const row = await repos.runs.require(runId);
		expect(row.failureReason).toBe("no_changes");
	});

	test("ref-dispatch with real uncommitted work stays dropped_commit, not no_changes", async () => {
		const { repos, runId } = await setupSeeded(null, {
			ref: "fix/pr-head",
			targetBranch: "fix/pr-head",
		});
		const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": ISSUES });
		const e = fakeExec({ revListCount: "0", gitStatus: " M src/foo.ts\n" });

		const result = await reapRun({
			runId,
			outcome: "succeeded",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			fs: f.fs,
			exec: e.exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("dropped_commit");
	});
});
