import { beforeEach, describe, expect, test } from "bun:test";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import { reapRun } from "./run.ts";
import {
	createRepos,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	openDatabase,
	reapDeps,
} from "./test-helpers.ts";

/**
 * warren-89b0: a zero-commit push whose ONLY dirty paths are warren-managed
 * bookkeeping artifacts is a deliberate no-op (`succeeded`, `noChanges`), NOT a
 * dropped commit (`failed`); and the host-side seed close never fires for a run
 * whose terminal state is `failed`.
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

async function setupSeeded(seedId: string | null): Promise<{
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
		burrowId: "bur_aaaaaaaaaaaa",
		burrowRunId: "run_zzzzzzzzzzzz",
		...(seedId !== null ? { seedId } : {}),
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
