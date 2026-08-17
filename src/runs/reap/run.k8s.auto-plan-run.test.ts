import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	RunHandle,
	RuntimeProvider,
	WorkspaceInfo,
} from "../../runtime/contract.ts";
import { reapRun } from "./index.ts";
import { createRepos, fakeExec, fakeFs, openDatabase, RunEventBroker } from "./test-helpers.ts";

/**
 * warren-486c: under K8s the pod pushes its run branch BEFORE the control plane
 * applies the finalize mirror bodies, so the merged `.seeds/` rows (new issues +
 * plan rows) exist ONLY in the host clone's `chore(warren): mirror state` commit
 * — which is never pushed and gets discarded by the next `git reset --hard
 * origin/<ref>`. A child pod then clones `origin/<plan-run ref>` and 404s on its
 * seed ids. These tests pin the durability contract: the mirror commit is pushed
 * to the exact ref child pods clone BEFORE the auto plan-run is created, and a
 * failed push suppresses auto-dispatch entirely.
 */

interface FakeProvider {
	provider: RuntimeProvider;
	calls: { finalize: number; terminate: number };
}

function fakeK8sProvider(finalizeResult: FinalizeResult): FakeProvider {
	const calls = { finalize: 0, terminate: 0 };
	const provider = {
		capabilities: {
			previewPorts: false,
			networkPolicy: "coarse",
			longLived: false,
			midRunSteering: false,
			enforcedResourceLimits: true,
			workspaceArchive: false,
		},
		workspaceInfo: async (_h: RunHandle): Promise<WorkspaceInfo> => ({
			workspacePath: null,
			branch: "warren/run-1",
		}),
		finalize: async (_h: RunHandle, _intent: FinalizeIntent): Promise<FinalizeResult> => {
			calls.finalize += 1;
			return finalizeResult;
		},
		terminate: async () => {
			calls.terminate += 1;
			return { archived: true, deletedEvents: 0, deletedMessages: 0, deletedRuns: 0 };
		},
	} as unknown as RuntimeProvider;
	return { provider, calls };
}

const NEW_PLAN_BODY = '{"id":"pl-new1","status":"approved","children":["warren-c1","warren-c2"]}\n';

/**
 * A K8s finalize result carrying a newly-created plan + its child issues as
 * mirror bodies (the exact shape that must be made durable before dispatch).
 */
function finalizeWithNewPlan(): FinalizeResult {
	return {
		pushed: true,
		commitsAhead: 0,
		emptyPush: true,
		dirty: false,
		workspacePlansBody: NEW_PLAN_BODY,
		events: [],
		artifacts: {
			seeds: {
				version: 1,
				files: [
					{
						path: ".seeds/issues.jsonl",
						mergedBody:
							'{"id":"warren-c1","status":"open","title":"a"}\n{"id":"warren-c2","status":"open","title":"b"}\n',
					},
				],
				counts: { closed: 0, created: 2 },
			},
			plans: {
				version: 1,
				files: [{ path: ".seeds/plans.jsonl", mergedBody: NEW_PLAN_BODY }],
				counts: { appended: 1 },
			},
		},
		prBranch: null,
		stages: [{ stage: "branch_push", status: "ok" }],
	};
}

interface K8sAutoCtx {
	db: WarrenDb;
	repos: ReturnType<typeof createRepos>;
	broker: RunEventBroker;
	runId: string;
	projectPath: string;
}

async function setupK8sAutoPlan(): Promise<K8sAutoCtx> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "patrol-bot", renderedJson: { sections: { system: "x" } } });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
		hasSeeds: true,
	});
	const run = await repos.runs.create({
		agentName: "patrol-bot",
		projectId: project.id,
		prompt: "patrol scan",
		renderedAgentJson: {
			name: "patrol-bot",
			version: 1,
			sections: { system: "you are a patrol bot" },
			resolvedFrom: [],
			frontmatter: { auto_plan_run: true },
		},
		trigger: "cron",
		sandboxId: "bur_aaaaaaaaaaaa",
		sandboxRunId: "run_zzzzzzzzzzzz",
	});
	await repos.runs.markRunning(run.id);
	return { db, repos, broker: new RunEventBroker(), runId: run.id, projectPath: project.localPath };
}

/** Empty baseline plans/issues in the host clone so the workspace plan is "new". */
function seededFs() {
	return fakeFs({
		"/data/projects/x/y/.seeds/issues.jsonl": "",
		"/data/projects/x/y/.seeds/plans.jsonl": "",
	});
}

describe("K8s auto-plan-run durability (warren-486c)", () => {
	let ctx: K8sAutoCtx;

	beforeEach(async () => {
		ctx = await setupK8sAutoPlan();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("pushes the mirror commit to origin/<plan-run ref> before creating the plan-run", async () => {
		const fake = fakeK8sProvider(finalizeWithNewPlan());
		const f = seededFs();
		const e = fakeExec({ stagedDelta: true });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			runtimeProvider: fake.provider,
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
		});

		// The mirror commit was authored in the host clone...
		const commit = e.calls.find((c) => c.cmd === "git" && c.args.includes("commit"));
		expect(commit?.cwd).toBe(ctx.projectPath);
		// ...and then pushed to the EXACT ref child pods clone (defaultBranch=main),
		// from the clone working dir, so the rows are reachable from origin.
		const push = e.calls.find(
			(c) => c.cmd === "git" && c.args[0] === "push" && c.args.includes("HEAD:main"),
		);
		expect(push).toBeDefined();
		expect(push?.args).toEqual(["push", "origin", "HEAD:main"]);
		expect(push?.cwd).toBe(ctx.projectPath);
		// The push happened BEFORE the plan-run was created (durability first).
		const commitIdx = e.calls.findIndex((c) => c.cmd === "git" && c.args.includes("commit"));
		const pushIdx = e.calls.findIndex(
			(c) => c.cmd === "git" && c.args[0] === "push" && c.args.includes("HEAD:main"),
		);
		expect(commitIdx).toBeLessThan(pushIdx);

		// The plan-run was created against the durable ref.
		expect(result.autoPlanRunCreated).toBe(true);
		expect(result.autoPlanRunPlanId).toBe("pl-new1");
		const planRun = await ctx.repos.planRuns.require(result.autoPlanRunId as string);
		expect(planRun.ref ?? "main").toBe("main");
		const children = await ctx.repos.planRuns.listChildren(planRun.id);
		expect(children.map((c) => c.seedId)).toEqual(["warren-c1", "warren-c2"]);

		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.some((ev) => ev.kind === "reap.clone_deltas_pushed")).toBe(true);
		expect(events.some((ev) => ev.kind === "auto_plan_run_created")).toBe(true);
	});

	test("suppresses auto-dispatch when the durability push fails (no plan-run against host-only state)", async () => {
		const fake = fakeK8sProvider(finalizeWithNewPlan());
		const f = seededFs();
		// Commit lands in the clone, but the origin push is rejected.
		const e = fakeExec({ stagedDelta: true, failPush: "! [rejected] main -> main (fetch first)" });

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			runtimeProvider: fake.provider,
			broker: ctx.broker,
			fs: f.fs,
			exec: e.exec,
		});

		// No plan-run was created against the un-pushed (host-only) mirror commit.
		expect(result.autoPlanRunCreated).toBe(false);
		expect(result.autoPlanRunId).toBeNull();
		expect(await ctx.repos.planRuns.listActive()).toHaveLength(0);

		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.some((ev) => ev.kind === "auto_plan_run_created")).toBe(false);
		const skipped = events.find((ev) => ev.kind === "auto_plan_run_skipped");
		expect(skipped?.payloadJson).toMatchObject({ reason: "mirror_durability_failed" });
		// The push failure is folded into reap's error trail.
		expect(result.errors.map((x) => x.step)).toContain("clone_apply_push");
	});
});
