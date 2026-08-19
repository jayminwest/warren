import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun, type CoordinatorReopenPrFn } from "./coordinator.ts";

// ---------------------------------------------------------------------------
// warren-22de: child_succeeded_without_pr recovery — separate describe so the
// describe-callback line count stays under the 500-line biome threshold.
// ---------------------------------------------------------------------------

async function setupSucceededChildNoPr(harness: Harness, endedAt: Date): Promise<string> {
	await harness.repos.planRuns.transitionTo(harness.planRun.id, "running", {
		startedAt: NOW.toISOString(),
	});
	const runId = await harness.makeRun("warren-a");
	await harness.repos.runs.markRunning(runId, NOW);
	await harness.repos.runs.finalize(runId, "succeeded", endedAt);
	// No prUrl set, no empty_push event.
	await harness.seedChildState({
		planRunId: harness.planRun.id,
		seq: 1,
		runId,
		state: "running",
		startedAt: NOW.toISOString(),
	});
	return runId;
}

describe("advancePlanRun — PR recovery and plan completion", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});
	afterEach(async () => {
		await h.db.close();
	});

	test("within budget, no reopenPr → noop + waiting_for_pr_reopen event", async () => {
		const runId = await setupSucceededChildNoPr(h, NOW);
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		// now = NOW, endedAt = NOW, mergeTimeoutMs = 1ms would be expired, but 60_000 is not
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			mergeTimeoutMs: 60_000,
			now: () => NOW, // same as endedAt → 0ms elapsed → within budget
		});
		expect(result.kind).toBe("noop");
		if (result.kind === "noop") {
			expect(result.reason).toContain("pr_reopen_pending:");
			expect(result.reason).toContain(runId);
		}
		// Plan must still be running — not failed terminally.
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		// Diagnostic event emitted so the operator can see the delay.
		expect(h.events.some((e) => e.kind === "plan_run.waiting_for_pr_reopen")).toBe(true);
	});

	test("succeeded/no-prUrl/no-empty-push: past budget → child_succeeded_without_pr terminal fail", async () => {
		// endedAt = NOW, nowFn returns NOW + 2h → well past 1h budget
		const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
		const runId = await setupSucceededChildNoPr(h, NOW);
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			mergeTimeoutMs: 60_000,
			now: () => new Date(NOW.getTime() + TWO_HOURS_MS),
		});
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("child_succeeded_without_pr");
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("child_succeeded_without_pr");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("failed");
		void runId;
	});

	test("succeeded/no-prUrl/no-empty-push: within budget, reopenPr succeeds → pr_open, polls merged, advances", async () => {
		const MERGED_AT = "2026-05-17T01:00:00.000Z";
		const runId = await setupSucceededChildNoPr(h, NOW);
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const reopenPr: CoordinatorReopenPrFn = async () => "https://github.com/x/y/pull/55";
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "merged", mergedAt: MERGED_AT }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			reopenPr,
			mergeTimeoutMs: 60_000,
			now: () => NOW,
		});
		// Should dispatch child 2 immediately after merging child 1.
		expect(result.kind).toBe("advanced");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("merged");
		expect(children.find((c) => c.seq === 2)?.state).toBe("dispatched");
		// Plan is still running (not failed).
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		// prUrl should be persisted on the run row.
		const updatedRun = await h.repos.runs.get(runId);
		expect(updatedRun?.prUrl).toBe("https://github.com/x/y/pull/55");
		void runId;
	});

	test("succeeded/no-prUrl/no-empty-push: within budget, reopenPr fails → noop + waiting_for_pr_reopen event", async () => {
		const runId = await setupSucceededChildNoPr(h, NOW);
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const reopenPr: CoordinatorReopenPrFn = async () => null;
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			reopenPr,
			mergeTimeoutMs: 60_000,
			now: () => NOW,
		});
		expect(result.kind).toBe("noop");
		if (result.kind === "noop") {
			expect(result.reason).toContain("pr_reopen_pending:");
		}
		// Plan still running.
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		expect(h.events.some((e) => e.kind === "plan_run.waiting_for_pr_reopen")).toBe(true);
		void runId;
	});

	test("plan_succeeded: every child terminal, no pending left", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "merged",
			startedAt: NOW.toISOString(),
			prMergedAt: NOW.toISOString(),
			endedAt: NOW.toISOString(),
		});
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 2,
			patch: { state: "skipped", endedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("plan_succeeded");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("succeeded");
		expect(reloaded.endedAt).toBe(NOW.toISOString());
		expect(h.events.some((e) => e.kind === "plan_run.succeeded")).toBe(true);
	});
});
