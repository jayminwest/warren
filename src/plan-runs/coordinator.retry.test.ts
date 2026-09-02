import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun } from "./coordinator.ts";
import { MAX_CHILD_RETRIES } from "./retry.ts";

/**
 * warren-6de9: a child run that terminalizes failed with a retryable
 * failure cause (`provider_error`) gets ONE automatic re-dispatch — fresh
 * run, same seed, same prompt — before the coordinator declares the
 * plan-run failed with `child_provider_error`. The retry budget persists
 * on the child row (`retryCount`), so a re-driven tick never grants a
 * second retry. Non-retryable child failures keep the old behavior.
 */
describe("advancePlanRun — automatic child retry (warren-6de9)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	/** Drive child seq=1 to a terminal-failed run with the given cause. */
	const failChildRun = async (
		failureReason: "provider_error" | "crashed" | "timed_out" | "sandbox_run_lost" | "preempted",
	): Promise<string> => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "failed", NOW, failureReason);
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			runId,
			state: "running",
			startedAt: NOW.toISOString(),
		});
		return runId;
	};

	const advance = async () =>
		advancePlanRun({
			planRun: await h.repos.planRuns.require(h.planRun.id),
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});

	test("child provider error → one retry dispatched, plan stays running", async () => {
		const failedRunId = await failChildRun("provider_error");
		const result = await advance();
		expect(result.kind).toBe("dispatched");
		if (result.kind !== "dispatched") return;
		expect(result.childRunId).not.toBe(failedRunId);

		const child = (await h.repos.planRuns.listChildren(h.planRun.id)).find((c) => c.seq === 1);
		expect(child?.state).toBe("dispatched");
		expect(child?.runId).toBe(result.childRunId);
		expect(child?.retryCount).toBe(1);

		// The plan-run itself is untouched — still running, no failure.
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		expect(reloaded.failureReason).toBeNull();

		// The retry is recorded as a plan-run event on the NEW run id so the
		// event tail (current child run ids) keeps it visible.
		const retryEvent = h.events.find((e) => e.kind === "plan_run.child_retried");
		expect(retryEvent?.runId).toBe(result.childRunId);
		expect(retryEvent?.payload.previousRunId).toBe(failedRunId);
		expect(retryEvent?.payload.failureReason).toBe("provider_error");
		expect(retryEvent?.payload.retryCount).toBe(1);
		expect(h.events.some((e) => e.kind === "plan_run.failed")).toBe(false);
	});

	test("retry run carries the same seed and rendered prompt", async () => {
		await failChildRun("provider_error");
		const result = await advance();
		if (result.kind !== "dispatched") throw new Error("expected dispatched");
		const retryRun = await h.repos.runs.get(result.childRunId);
		expect(retryRun?.seedId).toBe("warren-a");
		expect(retryRun?.prompt).toBe("work on sd warren-a");
	});

	test("retry succeeds → plan continues (child advances to pr_open)", async () => {
		await failChildRun("provider_error");
		const first = await advance();
		if (first.kind !== "dispatched") throw new Error("expected dispatched");

		// The retried run succeeds and opens a PR.
		await h.repos.runs.markRunning(first.childRunId, NOW);
		await h.repos.runs.finalize(first.childRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(first.childRunId, "https://github.com/x/y/pull/42");
		const second = await advancePlanRun({
			planRun: await h.repos.planRuns.require(h.planRun.id),
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "open" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(second.kind).toBe("waiting_for_merge");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
	});

	test("second consecutive provider error on the same child → plan_failed child_provider_error", async () => {
		await failChildRun("provider_error");
		const first = await advance();
		if (first.kind !== "dispatched") throw new Error("expected dispatched");

		// The retry run fails with provider_error too — budget is spent.
		await h.repos.runs.markRunning(first.childRunId, NOW);
		await h.repos.runs.finalize(first.childRunId, "failed", NOW, "provider_error");
		const second = await advancePlanRun({
			planRun: await h.repos.planRuns.require(h.planRun.id),
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(second.kind).toBe("plan_failed");
		if (second.kind !== "plan_failed") return;
		expect(second.reason).toBe("child_provider_error");
		expect(second.failedSeq).toBe(1);

		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("child_provider_error");
		const child = (await h.repos.planRuns.listChildren(h.planRun.id)).find((c) => c.seq === 1);
		expect(child?.state).toBe("failed");
		expect(child?.retryCount).toBe(MAX_CHILD_RETRIES);
	});

	test("child infra-lost (sandbox_run_lost) → one retry via the same shape (warren-4af7)", async () => {
		const failedRunId = await failChildRun("sandbox_run_lost");
		const result = await advance();
		expect(result.kind).toBe("dispatched");
		if (result.kind !== "dispatched") return;
		expect(result.childRunId).not.toBe(failedRunId);

		const child = (await h.repos.planRuns.listChildren(h.planRun.id)).find((c) => c.seq === 1);
		expect(child?.state).toBe("dispatched");
		expect(child?.runId).toBe(result.childRunId);
		expect(child?.retryCount).toBe(1);

		const retryEvent = h.events.find((e) => e.kind === "plan_run.child_retried");
		expect(retryEvent?.payload.previousRunId).toBe(failedRunId);
		expect(retryEvent?.payload.failureReason).toBe("sandbox_run_lost");
		expect(h.events.some((e) => e.kind === "plan_run.failed")).toBe(false);
	});

	// warren-ea4b: a Spot-preempted child earns the same single automatic
	// re-dispatch as an infra-lost child — same shape, distinct cause.
	test("child preempted (spot) → one retry via the same shape (warren-ea4b)", async () => {
		const failedRunId = await failChildRun("preempted");
		const result = await advance();
		expect(result.kind).toBe("dispatched");
		if (result.kind !== "dispatched") return;
		expect(result.childRunId).not.toBe(failedRunId);

		const child = (await h.repos.planRuns.listChildren(h.planRun.id)).find((c) => c.seq === 1);
		expect(child?.state).toBe("dispatched");
		expect(child?.retryCount).toBe(1);
		const retryEvent = h.events.find((e) => e.kind === "plan_run.child_retried");
		expect(retryEvent?.payload.failureReason).toBe("preempted");
	});

	test("non-provider child failure → no retry, plan_failed as before", async () => {
		const failedRunId = await failChildRun("crashed");
		const result = await advance();
		expect(result.kind).toBe("plan_failed");
		if (result.kind !== "plan_failed") return;
		expect(result.reason).toBe("child_crashed");

		const child = (await h.repos.planRuns.listChildren(h.planRun.id)).find((c) => c.seq === 1);
		expect(child?.state).toBe("failed");
		expect(child?.runId).toBe(failedRunId);
		expect(child?.retryCount).toBe(0);
		expect(h.events.some((e) => e.kind === "plan_run.child_retried")).toBe(false);
	});

	test("persisted retry budget survives a re-driven tick (no fresh retry)", async () => {
		const failedRunId = await failChildRun("provider_error");
		// Simulate a coordinator that already burned the retry (e.g. the
		// process restarted between re-dispatch and the retry's failure).
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { retryCount: MAX_CHILD_RETRIES },
		});
		const result = await advance();
		expect(result.kind).toBe("plan_failed");
		if (result.kind !== "plan_failed") return;
		expect(result.reason).toBe("child_provider_error");
		const child = (await h.repos.planRuns.listChildren(h.planRun.id)).find((c) => c.seq === 1);
		expect(child?.runId).toBe(failedRunId);
	});
});
