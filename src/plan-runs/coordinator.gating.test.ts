import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlanRunRow } from "../db/schema.ts";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun } from "./coordinator.ts";

describe("advancePlanRun — parentRunId gate (warren-d9a2)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	async function createPlanRunWithParent(parentRunId: string): Promise<PlanRunRow> {
		const { planRun } = await h.repos.planRuns.create({
			planId: "pl-parent-gate",
			projectId: h.projectId,
			agentName: "claude-code",
			parentRunId,
			children: [
				{ seq: 1, seedId: "warren-c" },
				{ seq: 2, seedId: "warren-d" },
			],
			now: NOW,
		});
		return planRun;
	}

	test("no parentRunId → existing behavior, dispatches immediately", async () => {
		const result = await advancePlanRun({
			planRun: h.planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "run_x"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
	});

	test("parentRunId set, parent PR merged → gate passes, dispatches child", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const pr = await createPlanRunWithParent(parentRunId);
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "merged", mergedAt: NOW.toISOString() }),
			spawn: h.spawnStub(() => "run_child"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
	});

	test("plan-run with ref: parent PR merged-into-ref passes the gate and the child spawn keeps the ref (warren-8cbf)", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const { planRun } = await h.repos.planRuns.create({
			planId: "pl-ref-gate",
			projectId: h.projectId,
			agentName: "claude-code",
			parentRunId,
			ref: "feature/parent",
			children: [{ seq: 1, seedId: "warren-c" }],
			now: NOW,
		});
		let seenRef: string | null | undefined;
		const innerSpawn = h.spawnStub(() => "run_child");
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			// The merged check polls the PR itself; with reap threading the run's
			// ref as the PR base, "merged" here means merged-into-ref — the gate
			// needs no extra base input.
			checkPrMerged: async (url) => {
				expect(url).toBe("https://github.com/x/y/pull/99");
				return { kind: "merged", mergedAt: NOW.toISOString() };
			},
			spawn: (args) => {
				seenRef = args.planRun.ref;
				return innerSpawn(args);
			},
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
		expect(seenRef).toBe("feature/parent");
	});

	test("parentRunId set, parent PR open → waiting_for_parent_merge", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const pr = await createPlanRunWithParent(parentRunId);
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "open" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("waiting_for_parent_merge");
		const reloaded = await h.repos.planRuns.require(pr.id);
		expect(reloaded.state).toBe("running");
	});

	test("parentRunId set, parent PR open past merge budget → plan_failed (warren-3937)", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const pr = await createPlanRunWithParent(parentRunId);
		const later = new Date(NOW.getTime() + 60 * 60 * 1000); // +1h, past 30m default
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "open" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => later,
		});
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("parent_pr_merge_timeout");
		}
		const reloaded = await h.repos.planRuns.require(pr.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("parent_pr_merge_timeout");
		// Surfaced on the parent run's event stream so the operator sees why.
		const failedEvent = h.events.find(
			(e) => e.runId === parentRunId && e.kind === "plan_run.failed",
		);
		expect(failedEvent?.payload.reason).toBe("parent_pr_merge_timeout");
		expect(failedEvent?.payload.prUrl).toBe("https://github.com/x/y/pull/99");
	});

	test("parentRunId set, parent PR open within budget → still waiting (warren-3937)", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const pr = await createPlanRunWithParent(parentRunId);
		const soon = new Date(NOW.getTime() + 5 * 60 * 1000); // +5m, under 30m default
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "open" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => soon,
		});
		expect(result.kind).toBe("waiting_for_parent_merge");
	});

	test("mergeTimeoutMs=0 disables the parent merge timeout (warren-3937)", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const pr = await createPlanRunWithParent(parentRunId);
		const muchLater = new Date(NOW.getTime() + 24 * 60 * 60 * 1000); // +1d
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "open" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			mergeTimeoutMs: 0,
			now: () => muchLater,
		});
		expect(result.kind).toBe("waiting_for_parent_merge");
	});

	test("parentRunId set, parent PR closed unmerged → plan_failed", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const pr = await createPlanRunWithParent(parentRunId);
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "closed_unmerged" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("parent_pr_not_merged");
		}
		const reloaded = await h.repos.planRuns.require(pr.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("parent_pr_not_merged");
	});

	test.each([
		"Not Found",
		"Gone",
	])("parent PR not_found poll (%s) → plan_failed parent_pr_not_merged (warren-eccd)", async (detail) => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const pr = await createPlanRunWithParent(parentRunId);
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "forge_error", errorKind: "not_found", detail }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		// not_found means the parent PR is genuinely gone → fail the gate.
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("parent_pr_not_merged");
		}
		const reloaded = await h.repos.planRuns.require(pr.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("parent_pr_not_merged");
		// Surfaced on the parent run's event stream so the operator sees why.
		const failedEvent = h.events.find(
			(e) => e.runId === parentRunId && e.kind === "plan_run.failed",
		);
		expect(failedEvent?.payload.reason).toBe("parent_pr_not_merged");
	});

	test.each([
		"unauthorized",
		"forbidden",
		"rate_limited",
	] as const)("parent PR %s poll keeps waiting, not parent_pr_not_merged (warren-eccd)", async (errorKind) => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const pr = await createPlanRunWithParent(parentRunId);
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "forge_error", errorKind, detail: errorKind }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		// unauthorized/forbidden/rate_limited are "cannot verify right now"
		// (auth blip / rate limit) — keep waiting for the parent merge, bounded by the
		// merge-wait budget (warren-3937). Do NOT fail the gate; no
		// plan_run.failed event.
		expect(result.kind).toBe("waiting_for_parent_merge");
		const reloaded = await h.repos.planRuns.require(pr.id);
		expect(reloaded.state).toBe("running");
		expect(reloaded.failureReason).toBeNull();
		expect(h.events.some((e) => e.kind === "plan_run.failed")).toBe(false);
	});

	test("parentRunId set, parent has no PR + empty_push → trivial merge, gate passes", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		const seq = ((await h.repos.events.maxSeqForRun(parentRunId)) ?? 0) + 1;
		await h.repos.events.append({
			runId: parentRunId,
			sandboxEventSeq: seq,
			ts: NOW.toISOString(),
			kind: "reap.empty_push",
			stream: "system",
			payload: { commitsAhead: 0 },
		});
		const pr = await createPlanRunWithParent(parentRunId);
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "run_child"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
	});

	test("parentRunId set, parent run deleted → gate passes (best-effort)", async () => {
		const pr = await createPlanRunWithParent("run_nonexistent_zzz");
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "run_child"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
	});

	test("parentRunId set, parent still running → waiting_for_parent_merge", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		const pr = await createPlanRunWithParent(parentRunId);
		const result = await advancePlanRun({
			planRun: pr,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("waiting_for_parent_merge");
	});
});
