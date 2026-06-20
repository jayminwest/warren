/**
 * Per-child execution-project routing in the coordinator + dispatch
 * (pl-fb43 step 5 / warren-d9f3).
 *
 * Asserts the four acceptance cases:
 *   (a) a child tagged with `extensions.repo` clones the *execution* repo
 *       while the coordinator's seed reads stay on the coordination project;
 *   (b) an untagged child falls back to `planRun.projectId`;
 *   (c) an unresolved repo tag fails that child via the plan_failed path
 *       with a typed `unresolved_repo:` reason;
 *   (d) the resolved execution project/repo appears in the emitted
 *       `plan_run.*` event payloads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents, type PlanRunRow } from "../db/schema.ts";
import { type CapturedEvent, NOW, neverPoll } from "./coordinator.test-helpers.ts";
import {
	advancePlanRun,
	type ChildExecution,
	type CoordinatorEmitFn,
	type CoordinatorShowSeedFn,
	type CoordinatorSpawnFn,
	type CoordinatorSpawnInput,
} from "./coordinator.ts";
import { createResolveExecution } from "./dispatch.ts";

interface Ctx {
	db: WarrenDb;
	repos: Repos;
	coordinationProjectId: string;
	childProjectId: string;
	planRun: PlanRunRow;
	events: CapturedEvent[];
	emit: CoordinatorEmitFn;
}

async function setup(): Promise<Ctx> {
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
	const coordination = await repos.projects.create({
		gitUrl: "https://github.com/acme/meta.git",
		localPath: "/data/projects/acme/meta",
		defaultBranch: "main",
	});
	const child = await repos.projects.create({
		gitUrl: "https://github.com/acme/service.git",
		localPath: "/data/projects/acme/service",
		defaultBranch: "trunk",
	});
	const { planRun } = await repos.planRuns.create({
		planId: "pl-route",
		projectId: coordination.id,
		agentName: "claude-code",
		children: [{ seq: 1, seedId: "warren-a" }],
		now: NOW,
	});
	const events: CapturedEvent[] = [];
	const emit: CoordinatorEmitFn = async (runId, kind, payload) => {
		events.push({ runId, kind, payload });
	};
	return {
		db,
		repos,
		coordinationProjectId: coordination.id,
		childProjectId: child.id,
		planRun,
		events,
		emit,
	};
}

/** showSeed stub returning a fixed extensions record on the next seed. */
function showSeedWith(extensions: Record<string, unknown> | undefined): CoordinatorShowSeedFn {
	return async (_projectId, seedId) => ({ id: seedId, status: "open", extensions });
}

describe("advancePlanRun — per-child execution routing (warren-d9f3)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("routed child clones the execution repo while seed reads hit the coordination project", async () => {
		const seedReads: string[] = [];
		const showSeed: CoordinatorShowSeedFn = async (projectId, seedId) => {
			seedReads.push(projectId);
			return { id: seedId, status: "open", extensions: { repo: "acme/service" } };
		};
		const captured: CoordinatorSpawnInput[] = [];
		const spawn: CoordinatorSpawnFn = async (input) => {
			captured.push(input);
			const run = await ctx.repos.runs.create({
				agentName: "claude-code",
				projectId: input.execution?.executionProjectId ?? ctx.coordinationProjectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: input.child.seedId,
				now: NOW,
			});
			return { runId: run.id };
		};

		const result = await advancePlanRun({
			planRun: ctx.planRun,
			repos: ctx.repos,
			showSeed,
			resolveExecution: createResolveExecution(ctx.repos),
			checkPrMerged: neverPoll,
			spawn,
			emit: ctx.emit,
			now: () => NOW,
		});

		expect(result.kind).toBe("dispatched");
		// seed reads use the coordination project, never the child repo
		expect(seedReads).toEqual([ctx.coordinationProjectId]);
		// the spawn was routed to the child execution project
		const exec = captured[0]?.execution as ChildExecution;
		expect(exec.executionProjectId).toBe(ctx.childProjectId);
		expect(exec.repoRef).toBe("acme/service");
	});

	test("untagged child falls back to the coordination project", async () => {
		const captured: CoordinatorSpawnInput[] = [];
		const spawn: CoordinatorSpawnFn = async (input) => {
			captured.push(input);
			const run = await ctx.repos.runs.create({
				agentName: "claude-code",
				projectId: ctx.coordinationProjectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: input.child.seedId,
				now: NOW,
			});
			return { runId: run.id };
		};

		const result = await advancePlanRun({
			planRun: ctx.planRun,
			repos: ctx.repos,
			showSeed: showSeedWith(undefined),
			resolveExecution: createResolveExecution(ctx.repos),
			checkPrMerged: neverPoll,
			spawn,
			emit: ctx.emit,
			now: () => NOW,
		});

		expect(result.kind).toBe("dispatched");
		const exec = captured[0]?.execution as ChildExecution;
		expect(exec.executionProjectId).toBe(ctx.coordinationProjectId);
		expect(exec.repoRef).toBeNull();
	});

	test("unresolved repo tag fails the child via plan_failed with a typed reason", async () => {
		let spawnCalled = false;
		const spawn: CoordinatorSpawnFn = async () => {
			spawnCalled = true;
			return { runId: "unused" };
		};

		const result = await advancePlanRun({
			planRun: ctx.planRun,
			repos: ctx.repos,
			showSeed: showSeedWith({ repo: "acme/does-not-exist" }),
			resolveExecution: createResolveExecution(ctx.repos),
			checkPrMerged: neverPoll,
			spawn,
			emit: ctx.emit,
			now: () => NOW,
		});

		expect(spawnCalled).toBe(false);
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.failedSeq).toBe(1);
			expect(result.reason).toStartWith("unresolved_repo:");
		}
		const reloaded = await ctx.repos.planRuns.require(ctx.planRun.id);
		expect(reloaded.state).toBe("failed");
		const children = await ctx.repos.planRuns.listChildren(ctx.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("failed");
	});

	test("execution project + repo appear in the plan_run.dispatched payload", async () => {
		const spawn: CoordinatorSpawnFn = async (input) => {
			const run = await ctx.repos.runs.create({
				agentName: "claude-code",
				projectId: input.execution?.executionProjectId ?? ctx.coordinationProjectId,
				prompt: input.prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: input.child.seedId,
				now: NOW,
			});
			return { runId: run.id };
		};

		await advancePlanRun({
			planRun: ctx.planRun,
			repos: ctx.repos,
			showSeed: showSeedWith({ repo: "https://github.com/acme/service.git" }),
			resolveExecution: createResolveExecution(ctx.repos),
			checkPrMerged: neverPoll,
			spawn,
			emit: ctx.emit,
			now: () => NOW,
		});

		const dispatched = ctx.events.find((e) => e.kind === "plan_run.dispatched");
		expect(dispatched?.payload.executionProjectId).toBe(ctx.childProjectId);
		expect(dispatched?.payload.repo).toBe("https://github.com/acme/service.git");
	});
});
