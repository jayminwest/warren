import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun } from "./coordinator.ts";

describe("advancePlanRun — completion phase", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("succeeded child with prUrl → pr_open then waiting_for_merge on open poll", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(runId, "https://github.com/x/y/pull/42");
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
			checkPrMerged: async () => ({ kind: "open" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("waiting_for_merge");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("pr_open");
		expect(h.events.some((e) => e.kind === "plan_run.waiting_for_merge")).toBe(true);
	});

	test("pr_open + open poll past merge budget → plan_failed child_pr_merge_timeout (warren-3937)", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(runId, "https://github.com/x/y/pull/42");
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "pr_open", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const later = new Date(NOW.getTime() + 60 * 60 * 1000); // +1h, past 30m default
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: async () => ({ kind: "open" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => later,
		});
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("child_pr_merge_timeout");
			expect(result.failedSeq).toBe(1);
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("child_pr_merge_timeout");
		const failedEvent = h.events.find((e) => e.kind === "plan_run.failed");
		expect(failedEvent?.payload.reason).toBe("child_pr_merge_timeout");
	});

	test("pr_open + merged poll → child merged, dispatch next, advanced result", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(runId, "https://github.com/x/y/pull/42");
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "pr_open", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: async () => ({ kind: "merged", mergedAt: "2026-05-17T01:00:00.000Z" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("advanced");
		if (result.kind === "advanced") {
			expect(result.mergedChildSeq).toBe(1);
			expect(result.dispatchedChildSeq).toBe(2);
		}
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("merged");
		expect(children.find((c) => c.seq === 1)?.prMergedAt).toBe("2026-05-17T01:00:00.000Z");
		expect(children.find((c) => c.seq === 2)?.state).toBe("dispatched");
		expect(h.events.map((e) => e.kind)).toEqual(
			expect.arrayContaining(["plan_run.merged", "plan_run.dispatched", "plan_run.advanced"]),
		);
	});

	test("pr_open + closed_unmerged → plan_failed pr_closed_without_merge", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(runId, "https://github.com/x/y/pull/42");
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "pr_open", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: async () => ({ kind: "closed_unmerged" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("pr_closed_without_merge");
			expect(result.failedSeq).toBe(1);
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("pr_closed_without_merge");
		expect(h.events.some((e) => e.kind === "plan_run.failed")).toBe(true);
	});

	test("pr_open + http 4xx → plan_failed pr_closed_without_merge", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(runId, "https://github.com/x/y/pull/42");
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "pr_open", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: async () => ({ kind: "http_error", status: 404, message: "Not Found" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("plan_failed");
	});

	test("child run failed → plan_failed with child_<reason>", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "failed", NOW, "crashed");
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
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
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("child_crashed");
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
	});

	test("dropped-commit child (failed/dropped_commit) fails the plan, not a trivial merge (warren-72b9)", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		// reap flips a zero-commit + dirty-tree run to failed/dropped_commit.
		await h.repos.runs.finalize(runId, "failed", NOW, "dropped_commit");
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
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
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("child_dropped_commit");
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
	});

	test("trivial merge: succeeded run with no prUrl + reap.empty_push event", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW);
		// Insert an empty-push event so the coordinator's trivial-merge probe finds it.
		await h.repos.events.append({
			runId,
			burrowEventSeq: 1,
			ts: NOW.toISOString(),
			kind: "reap.empty_push",
			stream: "system",
			payload: { branch: "burrow/run", baseBranch: "main", message: "no commits" },
		});
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "running", startedAt: NOW.toISOString() },
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
		expect(result.kind).toBe("advanced");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("merged");
		expect(children.find((c) => c.seq === 2)?.state).toBe("dispatched");
		expect(h.events.some((e) => e.kind === "plan_run.merged")).toBe(true);
	});
});
