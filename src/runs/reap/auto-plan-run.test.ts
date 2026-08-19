import { describe, expect, test } from "bun:test";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import { SeedsTracker } from "../../tracker/seeds-tracker.ts";
import { dispatchAutoPlanRuns, trackerSupportsAutoPlanRun } from "./auto-plan-run.ts";
import { reapRun } from "./index.ts";
import {
	createRepos,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	openDatabase,
	RunEventBroker,
	reapDeps,
} from "./test-helpers.ts";

/* Auto plan-run from reap (warren-a32a)                                    */
/* ----------------------------------------------------------------------- */

describe("auto_plan_run (warren-a32a)", () => {
	async function setupAutoPlanRun(opts: { frontmatter?: Record<string, unknown> } = {}) {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		await repos.agents.upsert({
			name: "patrol-bot",
			renderedJson: { sections: { system: "x" } },
		});
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
				frontmatter: opts.frontmatter ?? { auto_plan_run: true },
			},
			trigger: "cron",
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
			projectId: project.id,
		};
	}

	test("auto-dispatches a plan-run when agent has auto_plan_run: true and creates a new plan", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/sandbox/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1","warren-c2"]}\n',
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

			expect(result.autoPlanRunCreated).toBe(true);
			expect(result.autoPlanRunPlanId).toBe("pl-new1");
			expect(result.autoPlanRunId).not.toBeNull();
			const events = await ctx.repos.events.listByRun(ctx.runId);
			expect(events.find((ev) => ev.kind === "auto_plan_run_created")).toBeDefined();
			const planRun = await ctx.repos.planRuns.require(result.autoPlanRunId as string);
			expect(planRun.planId).toBe("pl-new1");
			expect(planRun.agentName).toBe("patrol-bot");
			expect(planRun.trigger).toBe("auto_plan_run");
			expect(planRun.parentRunId).toBe(ctx.runId);
			const children = await ctx.repos.planRuns.listChildren(planRun.id);
			expect(children).toHaveLength(2);
			expect(children[0]?.seedId).toBe("warren-c1");
			expect(children[1]?.seedId).toBe("warren-c2");
		} finally {
			await ctx.db.close();
		}
	});

	test("auto-dispatches even when mirrorPlans runs first (regression for ordering bug)", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const plansBody =
				'{"id":"pl-new1","status":"approved","children":["warren-c1","warren-c2"]}\n';
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/sandbox/ws/.seeds/plans.jsonl": plansBody,
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				...reapDeps(fakeBurrowClient(makeBurrow(), { seedsPlansBody: plansBody }), {
					fs: f.fs,
					exec: e.exec,
				}),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(true);
			expect(result.autoPlanRunPlanId).toBe("pl-new1");
		} finally {
			await ctx.db.close();
		}
	});

	test("uses auto_plan_run_agent override instead of parent agent name (warren-65b2)", async () => {
		const ctx = await setupAutoPlanRun({
			frontmatter: { auto_plan_run: true, auto_plan_run_agent: "pi" },
		});
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/sandbox/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1","warren-c2"]}\n',
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

			expect(result.autoPlanRunCreated).toBe(true);
			const planRun = await ctx.repos.planRuns.require(result.autoPlanRunId as string);
			expect(planRun.agentName).toBe("pi");
		} finally {
			await ctx.db.close();
		}
	});

	test("does not dispatch when agent lacks auto_plan_run frontmatter", async () => {
		const ctx = await setupAutoPlanRun({ frontmatter: {} });
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/sandbox/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1"]}\n',
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

			expect(result.autoPlanRunCreated).toBe(false);
			expect(result.autoPlanRunId).toBeNull();
		} finally {
			await ctx.db.close();
		}
	});

	test("does not dispatch when run failed", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/sandbox/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1"]}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "failed",
				repos: ctx.repos,
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(false);
		} finally {
			await ctx.db.close();
		}
	});

	test("does not dispatch when no new plans detected", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const existingPlan = '{"id":"pl-old1","status":"approved","children":["warren-c1"]}\n';
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": existingPlan,
				"/data/sandbox/ws/.seeds/plans.jsonl": existingPlan,
			});
			const e = fakeExec({ stagedDelta: false });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(false);
		} finally {
			await ctx.db.close();
		}
	});

	test("handles multiple new plans — one plan-run per plan", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/sandbox/ws/.seeds/plans.jsonl":
					'{"id":"pl-a","status":"approved","children":["warren-a1"]}\n' +
					'{"id":"pl-b","status":"approved","children":["warren-b1","warren-b2"]}\n',
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

			expect(result.autoPlanRunCreated).toBe(true);
			const events = await ctx.repos.events.listByRun(ctx.runId);
			const autoPlanEvents = events.filter((ev) => ev.kind === "auto_plan_run_created");
			expect(autoPlanEvents).toHaveLength(2);
		} finally {
			await ctx.db.close();
		}
	});

	test("project without .seeds/ skips auto_plan_run gracefully", async () => {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		await repos.agents.upsert({
			name: "patrol-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
			hasSeeds: false,
		});
		const run = await repos.runs.create({
			agentName: "patrol-bot",
			projectId: project.id,
			prompt: "patrol scan",
			renderedAgentJson: {
				name: "patrol-bot",
				version: 1,
				sections: { system: "x" },
				resolvedFrom: [],
				frontmatter: { auto_plan_run: true },
			},
			trigger: "cron",
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: "run_zzzzzzzzzzzz",
		});
		await repos.runs.markRunning(run.id);
		try {
			const f = fakeFs({
				"/data/sandbox/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1"]}\n',
			});
			const e = fakeExec();

			const result = await reapRun({
				runId: run.id,
				outcome: "succeeded",
				repos,
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
				fs: f.fs,
				exec: e.exec,
			});

			expect(result.autoPlanRunCreated).toBe(false);
		} finally {
			await db.close();
		}
	});

	// warren-41d5: child-seed validation on the auto path mirrors the
	// manual POST /plan-runs handler. `seedsCli.spawn` answers `sd show
	// <id> --json`; "missing" resolves to a `SeedNotFoundError` (exit 1,
	// "Issue not found"), "closed"/"open" to a valid envelope.
	function fakeSeedsCli(statuses: Record<string, "open" | "closed" | "missing">): SeedsCliDeps {
		return {
			sdBinary: "sd",
			spawn: async (cmd) => {
				const seedId = cmd[2];
				const status = seedId !== undefined ? statuses[seedId] : undefined;
				if (status === undefined || status === "missing") {
					return { stdout: "", stderr: `Issue not found: ${seedId}`, exitCode: 1 };
				}
				return {
					stdout: JSON.stringify({ success: true, issue: { id: seedId, status } }),
					stderr: "",
					exitCode: 0,
				};
			},
		};
	}

	test("dispatches when seedsCli is wired and every child seed resolves", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/sandbox/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1","warren-c2"]}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
				fs: f.fs,
				exec: e.exec,
				issueTracker: new SeedsTracker(
					fakeSeedsCli({ "warren-c1": "open", "warren-c2": "closed" }),
				),
			});

			expect(result.autoPlanRunCreated).toBe(true);
			expect(result.autoPlanRunPlanId).toBe("pl-new1");
		} finally {
			await ctx.db.close();
		}
	});

	test("skips dispatch and emits auto_plan_run_skipped when a child seed is missing", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/sandbox/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1","warren-gone"]}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
				fs: f.fs,
				exec: e.exec,
				issueTracker: new SeedsTracker(
					fakeSeedsCli({ "warren-c1": "open", "warren-gone": "missing" }),
				),
			});

			expect(result.autoPlanRunCreated).toBe(false);
			expect(result.autoPlanRunId).toBeNull();
			const events = await ctx.repos.events.listByRun(ctx.runId);
			const skipped = events.find((ev) => ev.kind === "auto_plan_run_skipped");
			expect(skipped).toBeDefined();
			expect((skipped?.payloadJson as { reason: string }).reason).toBe("missing_child_seeds");
			expect((skipped?.payloadJson as { missing: string[] }).missing).toEqual(["warren-gone"]);
		} finally {
			await ctx.db.close();
		}
	});

	test("skips dispatch with all_children_closed when every child seed is closed", async () => {
		const ctx = await setupAutoPlanRun();
		try {
			const f = fakeFs({
				"/data/projects/x/y/.seeds/issues.jsonl": "",
				"/data/projects/x/y/.seeds/plans.jsonl": "",
				"/data/sandbox/ws/.seeds/plans.jsonl":
					'{"id":"pl-new1","status":"approved","children":["warren-c1","warren-c2"]}\n',
			});
			const e = fakeExec({ stagedDelta: true });

			const result = await reapRun({
				runId: ctx.runId,
				outcome: "succeeded",
				repos: ctx.repos,
				...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
				fs: f.fs,
				exec: e.exec,
				issueTracker: new SeedsTracker(
					fakeSeedsCli({ "warren-c1": "closed", "warren-c2": "closed" }),
				),
			});

			expect(result.autoPlanRunCreated).toBe(false);
			const events = await ctx.repos.events.listByRun(ctx.runId);
			const skipped = events.find((ev) => ev.kind === "auto_plan_run_skipped");
			expect((skipped?.payloadJson as { reason: string }).reason).toBe("all_children_closed");
		} finally {
			await ctx.db.close();
		}
	});
});

describe("auto_plan_run tracker fence (warren-2d98)", () => {
	/** A hosted tracker: plan-ignorant state lives off-repo. */
	const remoteTracker: IssueTracker = {
		capabilities: {
			supportsPlans: true,
			supportsMetadata: false,
			supportsScheduledIssues: false,
			isGitNative: false,
		},
		getIssue: async (_ctx, id) => ({ id, status: "open" }),
		listIssueStatuses: async () => new Map(),
		closeIssue: async () => {},
	};

	test("trackerSupportsAutoPlanRun requires git-native + plans", () => {
		expect(trackerSupportsAutoPlanRun(remoteTracker)).toBe(false);
	});

	test("a non-git-native tracker fences the feature off entirely", async () => {
		const created: unknown[] = [];
		const result = await dispatchAutoPlanRuns({
			run: { id: "run_x", renderedAgentJson: null, agentName: "patrol-bot" },
			project: { id: "pr_x", defaultBranch: "main", localPath: "/data/projects/x/y" },
			workspacePlanIds: new Set(["pl-new1"]),
			baselinePlanIds: new Set(),
			workspacePlansBody: '{"id":"pl-new1","status":"approved","children":["warren-c1"]}',
			planRuns: {
				create: async (input) => {
					created.push(input);
					return { planRun: { id: "plr_x" } };
				},
			},
			emit: async () => {},
			fail: async () => {},
			issueTracker: remoteTracker,
		});
		expect(result.created).toBe(false);
		expect(created).toEqual([]);
	});
});
