import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StateTransitionError } from "../core/errors.ts";
import { type Harness, NOW, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun } from "./coordinator.ts";
import { resumePlanRun } from "./resume.ts";

const RESUME_AT = new Date(NOW.getTime() + 2 * 60 * 60 * 1000); // NOW + 2h

describe("resumePlanRun (warren-1eff)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	/** Drive child seq=1 to a merge-timeout failure against a succeeded run with a PR. */
	async function failChildWithMergeTimeout(): Promise<string> {
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(runId, "https://github.com/x/y/pull/361");
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "dispatched", startedAt: NOW.toISOString() },
		});
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: {
				state: "failed",
				failureReason: "child_pr_merge_timeout",
				endedAt: NOW.toISOString(),
			},
		});
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		await h.repos.planRuns.transitionTo(h.planRun.id, "failed", {
			failureReason: "child_pr_merge_timeout",
			endedAt: NOW.toISOString(),
		});
		return runId;
	}

	test("child_pr_merge_timeout: resets the child to pr_open and re-arms the clock", async () => {
		const runId = await failChildWithMergeTimeout();
		const result = await resumePlanRun({
			planRunId: h.planRun.id,
			repos: h.repos,
			emit: h.emit,
			now: () => RESUME_AT,
		});
		expect(result.reason).toBe("child_pr_merge_timeout");
		expect(result.resumedChild).toEqual({ seq: 1, runId });
		expect(result.planRun.state).toBe("running");
		expect(result.planRun.resumedAt).toBe(RESUME_AT.toISOString());
		expect(result.planRun.endedAt).toBeNull();
		expect(result.planRun.failureReason).toBeNull();

		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		const child = children.find((c) => c.seq === 1);
		expect(child?.state).toBe("pr_open");
		expect(child?.runId).toBe(runId);
		expect(child?.failureReason).toBeNull();
		expect(child?.endedAt).toBeNull();

		const resumedEvent = h.events.find((e) => e.kind === "plan_run.resumed");
		expect(resumedEvent?.runId).toBe(runId);
		expect(resumedEvent?.payload.reason).toBe("child_pr_merge_timeout");
	});

	test("resumed child whose PR has since merged advances to the next child", async () => {
		await failChildWithMergeTimeout();
		await resumePlanRun({ planRunId: h.planRun.id, repos: h.repos, now: () => RESUME_AT });
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "merged", mergedAt: RESUME_AT.toISOString() }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => new Date(RESUME_AT.getTime() + 60 * 1000),
		});
		expect(result.kind).toBe("advanced");
		if (result.kind === "advanced") {
			expect(result.mergedChildSeq).toBe(1);
			expect(result.dispatchedChildSeq).toBe(2);
		}
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		// No fresh run for the completed child; the next child dispatched.
		expect(children.find((c) => c.seq === 1)?.state).toBe("merged");
		expect(children.find((c) => c.seq === 2)?.state).toBe("dispatched");
	});

	test("resumed child whose PR is still open waits on a fresh budget (no instant re-timeout)", async () => {
		const runId = await failChildWithMergeTimeout();
		await resumePlanRun({ planRunId: h.planRun.id, repos: h.repos, now: () => RESUME_AT });
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		// A tiny 10m budget would instantly re-fail against the stale
		// run.endedAt (NOW, 2h ago); the rebaselined clock must not.
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "open" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			mergeTimeoutMs: 10 * 60 * 1000,
			now: () => new Date(RESUME_AT.getTime() + 60 * 1000),
		});
		expect(result.kind).toBe("waiting_for_merge");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.runId).toBe(runId);
	});

	test("parent_pr_merge_timeout: re-arms the parent gate and re-polls", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const { planRun } = await h.repos.planRuns.create({
			planId: "pl-parent-resume",
			projectId: h.projectId,
			agentName: "claude-code",
			parentRunId,
			children: [{ seq: 1, seedId: "warren-c" }],
			now: NOW,
		});
		await h.repos.planRuns.transitionTo(planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		await h.repos.planRuns.transitionTo(planRun.id, "failed", {
			failureReason: "parent_pr_merge_timeout",
			endedAt: NOW.toISOString(),
		});

		const result = await resumePlanRun({
			planRunId: planRun.id,
			repos: h.repos,
			emit: h.emit,
			now: () => RESUME_AT,
		});
		expect(result.reason).toBe("parent_pr_merge_timeout");
		expect(result.resumedChild).toBeNull();
		expect(result.planRun.state).toBe("running");
		expect(h.events.find((e) => e.kind === "plan_run.resumed")?.runId).toBe(parentRunId);

		// Parent PR merged in the meantime → gate passes → first child dispatches.
		const reloaded = await h.repos.planRuns.require(planRun.id);
		const advanced = await advancePlanRun({
			planRun: reloaded,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "merged", mergedAt: RESUME_AT.toISOString() }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => new Date(RESUME_AT.getTime() + 60 * 1000),
		});
		expect(advanced.kind).toBe("dispatched");
	});

	test("parent gate still open after resume waits instead of re-failing on the stale clock", async () => {
		const parentRunId = await h.makeRun("warren-parent");
		await h.repos.runs.markRunning(parentRunId, NOW);
		await h.repos.runs.finalize(parentRunId, "succeeded", NOW);
		await h.repos.runs.setPrUrl(parentRunId, "https://github.com/x/y/pull/99");
		const { planRun } = await h.repos.planRuns.create({
			planId: "pl-parent-resume-open",
			projectId: h.projectId,
			agentName: "claude-code",
			parentRunId,
			children: [{ seq: 1, seedId: "warren-c" }],
			now: NOW,
		});
		await h.repos.planRuns.transitionTo(planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		await h.repos.planRuns.transitionTo(planRun.id, "failed", {
			failureReason: "parent_pr_merge_timeout",
			endedAt: NOW.toISOString(),
		});
		await resumePlanRun({ planRunId: planRun.id, repos: h.repos, now: () => RESUME_AT });
		const reloaded = await h.repos.planRuns.require(planRun.id);
		const advanced = await advancePlanRun({
			planRun: reloaded,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "open" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			mergeTimeoutMs: 10 * 60 * 1000,
			now: () => new Date(RESUME_AT.getTime() + 60 * 1000),
		});
		expect(advanced.kind).toBe("waiting_for_parent_merge");
	});

	test("rejects a plan-run that is not failed, with no state change", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		await expect(
			resumePlanRun({ planRunId: h.planRun.id, repos: h.repos, now: () => RESUME_AT }),
		).rejects.toBeInstanceOf(StateTransitionError);
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
	});

	test("rejects a non-merge-timeout failure reason, with no state change", async () => {
		const runId = await h.makeRun("warren-a");
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "dispatched", startedAt: NOW.toISOString() },
		});
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: {
				state: "failed",
				failureReason: "pr_closed_without_merge",
				endedAt: NOW.toISOString(),
			},
		});
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
			startedAt: NOW.toISOString(),
		});
		await h.repos.planRuns.transitionTo(h.planRun.id, "failed", {
			failureReason: "pr_closed_without_merge",
			endedAt: NOW.toISOString(),
		});
		await expect(
			resumePlanRun({ planRunId: h.planRun.id, repos: h.repos, now: () => RESUME_AT }),
		).rejects.toThrow(/not a merge timeout/);
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("failed");
	});
});
