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
			getIssue: h.getIssueStub("open"),
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
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "pr_open",
			startedAt: NOW.toISOString(),
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const later = new Date(NOW.getTime() + 60 * 60 * 1000); // +1h, past 30m default
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
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
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "pr_open",
			startedAt: NOW.toISOString(),
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
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
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "pr_open",
			startedAt: NOW.toISOString(),
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
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

	test.each([
		"Not Found",
		"Gone",
	])("pr_open + not_found poll (%s) → plan_failed pr_closed_without_merge (warren-eccd)", async (detail) => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(runId, "https://github.com/x/y/pull/42");
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "pr_open",
			startedAt: NOW.toISOString(),
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "forge_error", errorKind: "not_found", detail }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		// not_found means the PR is genuinely gone → fail the plan.
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("pr_closed_without_merge");
			expect(result.failedSeq).toBe(1);
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("pr_closed_without_merge");
		const failedEvent = h.events.find((e) => e.kind === "plan_run.failed");
		expect(failedEvent?.payload.reason).toBe("pr_closed_without_merge");
	});

	test.each([
		"unauthorized",
		"forbidden",
		"rate_limited",
	] as const)("pr_open + %s poll keeps waiting, not pr_closed_without_merge (warren-eccd)", async (errorKind) => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(runId, "https://github.com/x/y/pull/42");
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "pr_open",
			startedAt: NOW.toISOString(),
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "forge_error", errorKind, detail: errorKind }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		// unauthorized/forbidden/rate_limited are "cannot verify right now"
		// (auth blip / rate limit) — keep waiting, bounded by the merge-wait budget
		// (warren-3937). Do NOT fail the plan; no plan_run.failed event.
		expect(result.kind).toBe("waiting_for_merge");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		expect(reloaded.failureReason).toBeNull();
		expect(h.events.some((e) => e.kind === "plan_run.failed")).toBe(false);
	});

	test("child run failed → plan_failed with child_<reason>", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "failed", NOW, "crashed");
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "running",
			startedAt: NOW.toISOString(),
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
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "running",
			startedAt: NOW.toISOString(),
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
			sandboxEventSeq: 1,
			ts: NOW.toISOString(),
			kind: "reap.empty_push",
			stream: "system",
			payload: { branch: "burrow/run", baseBranch: "main", message: "no commits" },
		});
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "running",
			startedAt: NOW.toISOString(),
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
		expect(result.kind).toBe("advanced");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("merged");
		expect(children.find((c) => c.seq === 2)?.state).toBe("dispatched");
		expect(h.events.some((e) => e.kind === "plan_run.merged")).toBe(true);
	});

	// warren-2a8c: an empty push is only a trivial merge when the child's
	// seed actually resolved. When it doesn't, the agent could not find its
	// work item and pushed nothing — that must fail with a typed reason, not
	// be scored a phantom success that masks the real first failure.
	async function setupEmptyPushChild(): Promise<string> {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW);
		await h.repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: NOW.toISOString(),
			kind: "reap.empty_push",
			stream: "system",
			payload: { branch: "burrow/run", baseBranch: "main", message: "no commits" },
		});
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "running",
			startedAt: NOW.toISOString(),
		});
		return runId;
	}

	test("empty push + unresolved seed fails child_seed_not_resolved, not trivial merge (warren-2a8c)", async () => {
		const runId = await setupEmptyPushChild();
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueNotFound,
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("child_seed_not_resolved:warren-a");
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("child_seed_not_resolved:warren-a");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("failed");
		// seq 2 must NOT have advanced — the plan died at the true first failure.
		expect(children.find((c) => c.seq === 2)?.state).toBe("pending");
		// The emitted event distinguishes this from a trivial merge.
		expect(h.events.some((e) => e.kind === "plan_run.merged")).toBe(false);
		expect(
			h.events.some(
				(e) =>
					e.kind === "plan_run.failed" && e.payload.reason === "child_seed_not_resolved:warren-a",
			),
		).toBe(true);
		void runId;
	});

	test("empty push + resolved seed still merges trivially (no regression) (warren-2a8c)", async () => {
		await setupEmptyPushChild();
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
		expect(result.kind).toBe("advanced");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("merged");
		expect(children.find((c) => c.seq === 2)?.state).toBe("dispatched");
		expect(h.events.some((e) => e.kind === "plan_run.merged" && e.payload.trivial === true)).toBe(
			true,
		);
	});

	test("empty push + transient seed-store failure retries next tick, no terminal decision (warren-2a8c)", async () => {
		const runId = await setupEmptyPushChild();
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueTransient,
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("noop");
		if (result.kind === "noop") {
			expect(result.reason).toBe(`seed_check_failed:${runId}`);
		}
		// Plan still running — neither merged nor failed.
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("running");
		expect(h.events.some((e) => e.kind === "plan_run.merged")).toBe(false);
	});
});
