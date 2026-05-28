import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun, type CoordinatorSpawnFn } from "./coordinator.ts";

describe("advancePlanRun — dispatch phase", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("queued → running, dispatches first child", async () => {
		const result = await advancePlanRun({
			planRun: h.planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "run_x"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		expect(reloaded.startedAt).toBe(NOW.toISOString());
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		const first = children.find((c) => c.seq === 1);
		expect(first?.state).toBe("dispatched");
		expect(first?.runId).not.toBeNull();
		expect(h.events.map((e) => e.kind)).toContain("plan_run.dispatched");
	});

	test("non-terminal child run → waiting_for_run; running run syncs child.state", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "dispatched", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("waiting_for_run");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("running");
	});

	test("spawn receives the PlanRun.plotId so per-child PLOT_ID injection lights up", async () => {
		// Seed a Plot-bound PlanRun directly so the coordinator's spawn
		// closure sees a non-null plotId on the row passed through.
		const { planRun: plotBound } = await h.repos.planRuns.create({
			planId: "pl-plot",
			projectId: h.projectId,
			agentName: "claude-code",
			plotId: "plot_acc",
			children: [{ seq: 1, seedId: "warren-p" }],
			now: NOW,
		});
		const captured: { plotId: string | null }[] = [];
		const spawn: CoordinatorSpawnFn = async ({ planRun, child, prompt }) => {
			captured.push({ plotId: planRun.plotId });
			const run = await h.repos.runs.create({
				agentName: "claude-code",
				projectId: h.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "plan-run",
				seedId: child.seedId,
				now: NOW,
			});
			return { runId: run.id };
		};
		const result = await advancePlanRun({
			planRun: plotBound,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn,
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
		expect(captured).toEqual([{ plotId: "plot_acc" }]);
	});

	test("dispatch failure → plan_failed with dispatch_failed:<message>", async () => {
		const failingSpawn: CoordinatorSpawnFn = async () => {
			throw new Error("burrow unreachable");
		};
		const result = await advancePlanRun({
			planRun: h.planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: failingSpawn,
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("dispatch_failed:burrow unreachable");
			expect(result.failedSeq).toBe(1);
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("dispatch_failed:burrow unreachable");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("failed");
	});
});
