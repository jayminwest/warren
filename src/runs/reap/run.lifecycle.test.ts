import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	clearLifecycleBus,
	installLifecycleBus,
	LifecycleBus,
	type LifecycleEnvelope,
	type LifecycleHook,
} from "../lifecycle-bus.ts";
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
 * warren-4e74: the observe-only lifecycle emits reap fires along a run's
 * terminal path — `pre_reap` before the pipeline touches the workspace,
 * then `post_reap` (always) and `branch_pushed` (only when finalize
 * pushed commits) after the terminal transition.
 */

async function setup(): Promise<{
	repos: Awaited<ReturnType<typeof createRepos>>;
	runId: string;
	projectId: string;
}> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: { sections: { system: "x" } } });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
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
	return { repos, runId: run.id, projectId: project.id };
}

function spyBus(): { bus: LifecycleBus; seen: LifecycleEnvelope[] } {
	const seen: LifecycleEnvelope[] = [];
	const bus = new LifecycleBus();
	const hooks: LifecycleHook[] = ["pre_reap", "post_reap", "branch_pushed"];
	const map = Object.fromEntries(
		hooks.map((h) => [h, (env: LifecycleEnvelope) => void seen.push(env)]),
	);
	bus.register({ name: "spy", protocol: "warren-ext/v1", hooks: map });
	return { bus, seen };
}

describe("reapRun lifecycle emits (warren-4e74)", () => {
	let repos: Awaited<ReturnType<typeof createRepos>>;
	let runId: string;
	let projectId: string;

	beforeEach(async () => {
		({ repos, runId, projectId } = await setup());
	});
	afterEach(() => clearLifecycleBus());

	test("emits pre_reap then post_reap around a successful reap; branch_pushed on a real push", async () => {
		const { bus, seen } = spyBus();
		installLifecycleBus(bus);
		const f = fakeFs({});
		const e = fakeExec({ revListCount: "3" });

		await reapRun({
			runId,
			outcome: "succeeded",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			fs: f.fs,
			exec: e.exec,
		});

		const hooks = seen.map((env) => env.hook);
		expect(hooks[0]).toBe("pre_reap");
		expect(hooks).toContain("post_reap");
		expect(hooks).toContain("branch_pushed");
		// pre_reap comes before both post-terminal emits.
		expect(hooks.indexOf("pre_reap")).toBeLessThan(hooks.indexOf("post_reap"));

		const pre = seen.find((env) => env.hook === "pre_reap");
		expect(pre?.payload).toMatchObject({ runId, projectId, outcome: "succeeded" });
		const post = seen.find((env) => env.hook === "post_reap");
		expect(post?.payload).toMatchObject({ runId, projectId, branchPushed: true, commitsAhead: 3 });

		// warren-bc9c: the push is also persisted as a real event row so
		// delivery analytics can read it back — not just the bus emit.
		const pushEvents = await repos.events.listByKind("reap.branch_pushed");
		expect(pushEvents.find((e) => e.runId === runId)).toMatchObject({
			runId,
			stream: "system",
		});
	});

	test("no bus installed ⇒ reap still completes (emit is a no-op)", async () => {
		const f = fakeFs({});
		const e = fakeExec({ revListCount: "0" });
		const result = await reapRun({
			runId,
			outcome: "succeeded",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			fs: f.fs,
			exec: e.exec,
		});
		expect(result.state).toBe("succeeded");
	});
});
