import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CheckRun, PullRequestRef, RepoRef } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { createPrMergeChecker } from "../runs/pr-merge.ts";
import { type Harness, NOW, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun } from "./coordinator.ts";
import { createMergeStallProbe } from "./merge-stall.ts";
import { buildDefaultPlanRunEmit } from "./tick.ts";

/**
 * End-to-end stall-warning coverage through `advancePlanRun` against a real
 * FakeForge: the merge poll and the stall probe both cross the Forge seam,
 * so the coordinator's wiring (probe + grace knob + one-shot scan) is
 * exercised exactly as boot wires it (pl-92a3 step 7).
 */

const GREEN_RUN: CheckRun = {
	name: "ci",
	status: "completed",
	conclusion: "success",
	jobId: "job-1",
	detailsUrl: null,
};

const GRACE_MS = 5 * 60 * 1000;

interface StallHarness extends Harness {
	forge: FakeForge;
	ref: RepoRef;
	pr: PullRequestRef;
	/** Advance with the fake-forge merge poll + stall probe wired. */
	advance: (now: Date, overrides?: Record<string, unknown>) => ReturnType<typeof advancePlanRun>;
}

async function setupStall(): Promise<StallHarness> {
	const h = await setup();
	const forge = new FakeForge();
	const ref = forge.parseRepoRef("fake://x/y");
	if (ref === null) throw new Error("fake forge must own the test repo url");
	const opened = await forge.openPullRequest(ref, {
		headBranch: "warren/run-1",
		baseBranch: "main",
		title: "child pr",
		body: "child pr body",
	});
	if (!opened.ok) throw new Error(`openPullRequest failed: ${opened.error.detail}`);

	await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
	const planRunRow = await h.repos.planRuns.require(h.planRun.id);
	const runId = await h.makeRun("warren-a");
	await h.repos.runs.markRunning(runId, NOW);
	await h.repos.runs.finalize(runId, "succeeded", NOW);
	await h.repos.runs.setPrUrl(runId, opened.value.webUrl);
	await h.seedChildState({
		planRunId: h.planRun.id,
		seq: 1,
		runId,
		state: "pr_open",
		startedAt: NOW.toISOString(),
	});

	const advance = (now: Date, overrides: Partial<Parameters<typeof advancePlanRun>[0]> = {}) =>
		advancePlanRun({
			planRun: planRunRow,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: createPrMergeChecker({ forge }),
			probeMergeStall: createMergeStallProbe({ forge }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => now,
			...overrides,
		});
	return { ...h, forge, ref, pr: opened.value, advance };
}

/** Stamp the child PR green: passing checks + unarmed auto-merge. */
function seedGreenPr(h: StallHarness): void {
	h.forge.setChecks(h.ref, "fake-head-warren/run-1", [GREEN_RUN]);
}

/** The child run's id, as the persisted-event scans need it. */
async function childRunId(h: StallHarness): Promise<string> {
	const children = await h.repos.planRuns.listChildren(h.planRun.id);
	const runId = children.find((c) => c.seq === 1)?.runId;
	if (runId === undefined || runId === null) throw new Error("child run missing");
	return runId;
}

describe("advancePlanRun — merge-stall warning (pl-92a3 step 7)", () => {
	let h: StallHarness;

	beforeEach(async () => {
		h = await setupStall();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("emits plan_run.merge_stalled once a green unarmed PR passes the grace period", async () => {
		seedGreenPr(h);
		const result = await h.advance(new Date(NOW.getTime() + GRACE_MS + 1000));
		expect(result.kind).toBe("waiting_for_merge");
		const event = h.events.find((e) => e.kind === "plan_run.merge_stalled");
		expect(event?.runId).toBe(await childRunId(h));
		expect(event?.payload.planRunId).toBe(h.planRun.id);
		expect(event?.payload.seq).toBe(1);
		expect(event?.payload.seedId).toBe("warren-a");
		expect(event?.payload.prUrl).toBe(h.pr.webUrl);
		expect(event?.payload.checksPassing).toBe(true);
		expect(event?.payload.autoMerge).toBe("unarmed");
		expect(event?.payload.waitedMs).toBe(GRACE_MS + 1000);
		expect(typeof event?.payload.hint).toBe("string");
	});

	test("does not emit before the grace period has elapsed", async () => {
		seedGreenPr(h);
		const result = await h.advance(new Date(NOW.getTime() + GRACE_MS - 1000));
		expect(result.kind).toBe("waiting_for_merge");
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("does not emit while checks are pending", async () => {
		h.forge.setChecks(h.ref, "fake-head-warren/run-1", [
			{ ...GREEN_RUN, status: "in_progress", conclusion: null },
		]);
		const result = await h.advance(new Date(NOW.getTime() + GRACE_MS + 1000));
		expect(result.kind).toBe("waiting_for_merge");
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("does not emit while checks are failing", async () => {
		h.forge.setChecks(h.ref, "fake-head-warren/run-1", [{ ...GREEN_RUN, conclusion: "failure" }]);
		const result = await h.advance(new Date(NOW.getTime() + GRACE_MS + 1000));
		expect(result.kind).toBe("waiting_for_merge");
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("does not emit when the rollup is unavailable (no check runs)", async () => {
		const result = await h.advance(new Date(NOW.getTime() + GRACE_MS + 1000));
		expect(result.kind).toBe("waiting_for_merge");
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("does not emit when auto-merge reads unknown", async () => {
		seedGreenPr(h);
		h.forge.setAutoMergeState(h.ref, h.pr, "unknown");
		const result = await h.advance(new Date(NOW.getTime() + GRACE_MS + 1000));
		expect(result.kind).toBe("waiting_for_merge");
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("does not emit when auto-merge is armed", async () => {
		seedGreenPr(h);
		h.forge.setAutoMergeState(h.ref, h.pr, "armed");
		const result = await h.advance(new Date(NOW.getTime() + GRACE_MS + 1000));
		expect(result.kind).toBe("waiting_for_merge");
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("mergeStallWarningMs=0 disables the warning", async () => {
		seedGreenPr(h);
		const result = await h.advance(new Date(NOW.getTime() + GRACE_MS + 60_000), {
			mergeStallWarningMs: 0,
		});
		expect(result.kind).toBe("waiting_for_merge");
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("fires exactly once across ticks when the emit persists (restart-safe one-shot)", async () => {
		seedGreenPr(h);
		const persistingEmit = buildDefaultPlanRunEmit(h.repos, () => NOW);
		const later = new Date(NOW.getTime() + GRACE_MS + 1000);
		const first = await h.advance(later, { emit: persistingEmit });
		expect(first.kind).toBe("waiting_for_merge");
		const second = await h.advance(new Date(later.getTime() + 30_000), {
			emit: persistingEmit,
		});
		expect(second.kind).toBe("waiting_for_merge");
		const events = await h.repos.events.listByRun(await childRunId(h));
		const stalled = events.filter((e) => e.kind === "plan_run.merge_stalled");
		expect(stalled.length).toBe(1);
	});

	test("does not re-emit when a prior warning already sits on the persisted stream", async () => {
		seedGreenPr(h);
		const runId = await childRunId(h);
		const seq = ((await h.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await h.repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: NOW.toISOString(),
			kind: "plan_run.merge_stalled",
			stream: "system",
			payload: { planRunId: h.planRun.id },
		});
		const result = await h.advance(new Date(NOW.getTime() + GRACE_MS + 1000));
		expect(result.kind).toBe("waiting_for_merge");
		expect(h.events.some((e) => e.kind === "plan_run.merge_stalled")).toBe(false);
	});

	test("child_pr_merge_timeout payload carries the checks/auto-merge diagnosis", async () => {
		seedGreenPr(h);
		const result = await h.advance(new Date(NOW.getTime() + 60 * 60 * 1000));
		expect(result.kind).toBe("plan_failed");
		const failedEvent = h.events.find((e) => e.kind === "plan_run.failed");
		expect(failedEvent?.payload.reason).toBe("child_pr_merge_timeout");
		expect(failedEvent?.payload.prUrl).toBe(h.pr.webUrl);
		expect(failedEvent?.payload.checksPassing).toBe(true);
		expect(failedEvent?.payload.autoMerge).toBe("unarmed");
	});

	test("child_pr_merge_timeout payload carries nulls when the rollup is unavailable", async () => {
		const result = await h.advance(new Date(NOW.getTime() + 60 * 60 * 1000));
		expect(result.kind).toBe("plan_failed");
		const failedEvent = h.events.find((e) => e.kind === "plan_run.failed");
		expect(failedEvent?.payload.checksPassing).toBeNull();
		expect(failedEvent?.payload.autoMerge).toBe("unarmed");
	});

	test("child_pr_merge_timeout payload stays byte-identical without a probe", async () => {
		seedGreenPr(h);
		const result = await h.advance(new Date(NOW.getTime() + 60 * 60 * 1000), {
			probeMergeStall: undefined,
		});
		expect(result.kind).toBe("plan_failed");
		const failedEvent = h.events.find((e) => e.kind === "plan_run.failed");
		expect(failedEvent?.payload.reason).toBe("child_pr_merge_timeout");
		expect(failedEvent?.payload.prUrl).toBe(h.pr.webUrl);
		expect(failedEvent?.payload.checksPassing).toBeUndefined();
		expect(failedEvent?.payload.autoMerge).toBeUndefined();
	});
});
