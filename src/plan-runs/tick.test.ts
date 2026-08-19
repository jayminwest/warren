import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { PrMergeChecker } from "../runs/pr-merge.ts";
import type { CoordinatorGetIssueFn, CoordinatorSpawnFn } from "./coordinator.ts";
import { bootPlanRunCoordinator, runPlanRunTick } from "./tick.ts";

const NOW = new Date("2026-05-17T00:00:00.000Z");

const noopPoll: PrMergeChecker = async () => ({ kind: "open" });
const openSeed: CoordinatorGetIssueFn = async (_p, id) => ({ id, status: "open" });

interface Harness {
	db: WarrenDb;
	repos: Repos;
	projectId: string;
}

async function setup(): Promise<Harness> {
	const db = await openDatabase({ path: ":memory:" });
	db.drizzle
		.insert(agents)
		.values({
			name: "claude-code",
			renderedJson: { sections: {} },
			registeredAt: "2026-05-10T00:00:00.000Z",
			lastRefreshed: "2026-05-10T00:00:00.000Z",
		})
		.run();
	const repos = createRepos(db);
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	return { db, repos, projectId: project.id };
}

describe("runPlanRunTick", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("returns empty advances + errors when no plan_runs are active", async () => {
		const result = await runPlanRunTick({
			repos: h.repos,
			getIssue: openSeed,
			checkPrMerged: noopPoll,
			spawn: async () => ({ runId: "unused" }),
			now: () => NOW,
		});
		expect(result.advances).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("per-PlanRun isolation: one throwing advance doesn't stop the others", async () => {
		const a = await h.repos.planRuns.create({
			planId: "pl-a",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const b = await h.repos.planRuns.create({
			planId: "pl-b",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-b" }],
			now: NOW,
		});

		const dispatched: string[] = [];
		const spawn: CoordinatorSpawnFn = async ({ planRun, child, prompt }) => {
			if (planRun.id === a.planRun.id) {
				throw new Error("boom");
			}
			const run = await h.repos.runs.create({
				agentName: "claude-code",
				projectId: h.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
			});
			dispatched.push(run.id);
			return { runId: run.id };
		};

		const result = await runPlanRunTick({
			repos: h.repos,
			getIssue: openSeed,
			checkPrMerged: noopPoll,
			spawn,
			now: () => NOW,
		});

		// Both PlanRuns must have been visited despite the boom on `a`.
		expect(result.advances).toHaveLength(2);
		const reloadedA = await h.repos.planRuns.require(a.planRun.id);
		const reloadedB = await h.repos.planRuns.require(b.planRun.id);
		// Plan A's child failed to dispatch → coordinator marked the plan failed
		// (the throw inside spawn is converted into an AdvanceResult, not a tick-
		// level error). Plan B dispatched cleanly.
		expect(reloadedA.state).toBe("failed");
		expect(reloadedA.failureReason).toContain("dispatch_failed");
		expect(reloadedB.state).toBe("running");
		expect(dispatched).toHaveLength(1);
		expect(result.errors).toEqual([]);
	});

	test("catches internal coordinator errors per-PlanRun via the tick try/catch", async () => {
		const a = await h.repos.planRuns.create({
			planId: "pl-a",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const b = await h.repos.planRuns.create({
			planId: "pl-b",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-b" }],
			now: NOW,
		});

		let spawned = 0;
		const spawn: CoordinatorSpawnFn = async ({ child, prompt }) => {
			spawned += 1;
			const run = await h.repos.runs.create({
				agentName: "claude-code",
				projectId: h.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
			});
			return { runId: run.id };
		};

		// Force a coordinator throw on plan A by making listChildren raise via
		// a poisoned getIssue for warren-a.
		const getIssue: CoordinatorGetIssueFn = async (_p, id) => {
			if (id === "warren-a") throw new Error("getIssue exploded");
			return { id, status: "open" };
		};

		const result = await runPlanRunTick({
			repos: h.repos,
			getIssue,
			checkPrMerged: noopPoll,
			spawn,
			now: () => NOW,
		});

		// getIssue throw is caught inside the coordinator → returns noop, not an
		// advance error. Plan B still advances.
		expect(result.errors).toEqual([]);
		expect(result.advances).toHaveLength(2);
		const aAdvance = result.advances.find((adv) => adv.planRunId === a.planRun.id);
		expect(aAdvance?.result.kind).toBe("noop");
		const bAdvance = result.advances.find((adv) => adv.planRunId === b.planRun.id);
		expect(bAdvance?.result.kind).toBe("dispatched");
		expect(spawned).toBe(1);
	});

	test("default emit appends plan_run.* system events to the dispatched child run", async () => {
		await h.repos.planRuns.create({
			planId: "pl-a",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const spawn: CoordinatorSpawnFn = async ({ child, prompt }) => {
			const run = await h.repos.runs.create({
				agentName: "claude-code",
				projectId: h.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
			});
			return { runId: run.id };
		};

		await runPlanRunTick({
			repos: h.repos,
			getIssue: openSeed,
			checkPrMerged: noopPoll,
			spawn,
			now: () => NOW,
		});

		const runs = await h.repos.runs.listAll();
		expect(runs).toHaveLength(1);
		const childRun = runs[0];
		if (!childRun) throw new Error("expected one run");
		const events = await h.repos.events.listByRun(childRun.id);
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("plan_run.dispatched");
		expect(events.every((e) => e.stream === "system")).toBe(true);
	});
});

describe("bootPlanRunCoordinator", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("disabled flag returns a stop-only handle without scheduling", async () => {
		let scheduled = 0;
		const handle = bootPlanRunCoordinator({
			repos: h.repos,
			getIssue: openSeed,
			checkPrMerged: noopPoll,
			spawn: async () => ({ runId: "unused" }),
			tickMs: 100,
			disabled: true,
			setInterval: () => {
				scheduled += 1;
				return {};
			},
			clearInterval: () => {},
		});
		expect(scheduled).toBe(0);
		await handle.stop();
	});

	test("runOnce fires a single tick and increments tickCount", async () => {
		const handle = bootPlanRunCoordinator({
			repos: h.repos,
			getIssue: openSeed,
			checkPrMerged: noopPoll,
			spawn: async () => ({ runId: "unused" }),
			tickMs: 100,
			disabled: true,
			setInterval: () => ({}),
			clearInterval: () => {},
			now: () => NOW,
		});
		try {
			const result = await handle.runOnce();
			expect(result).not.toBeNull();
			expect(handle.tickCount()).toBe(1);
		} finally {
			await handle.stop();
		}
	});

	test("single-flight: a tick fired while another is in flight is skipped", async () => {
		let release: () => void = () => {};
		const block = new Promise<void>((resolve) => {
			release = resolve;
		});
		await h.repos.planRuns.create({
			planId: "pl-a",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		const slowSpawn: CoordinatorSpawnFn = async ({ child, prompt }) => {
			await block;
			const run = await h.repos.runs.create({
				agentName: "claude-code",
				projectId: h.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
			});
			return { runId: run.id };
		};
		const handle = bootPlanRunCoordinator({
			repos: h.repos,
			getIssue: openSeed,
			checkPrMerged: noopPoll,
			spawn: slowSpawn,
			tickMs: 100,
			disabled: true,
			setInterval: () => ({}),
			clearInterval: () => {},
			now: () => NOW,
		});
		try {
			const first = handle.runOnce();
			const second = await handle.runOnce();
			expect(second).toBeNull();
			release();
			await first;
			expect(handle.tickCount()).toBe(1);
		} finally {
			await handle.stop();
		}
	});
});
