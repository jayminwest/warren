import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun, type CoordinatorCloseChildSeedFn } from "./coordinator.ts";

/**
 * warren-3806: the coordinator must fire the host-side child-seed close the
 * instant a plan-run child transitions to `merged` — on both the PR-poll
 * merge path and the trivial-merge (empty-push) path — so seed closure never
 * depends on agent initiative.
 */
describe("advancePlanRun — host-side child seed close (warren-3806)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	function recordingCloseSeed(): {
		fn: CoordinatorCloseChildSeedFn;
		calls: { planRunId: string; seq: number; seedId: string }[];
	} {
		const calls: { planRunId: string; seq: number; seedId: string }[] = [];
		const fn: CoordinatorCloseChildSeedFn = async ({ planRun, child }) => {
			calls.push({ planRunId: planRun.id, seq: child.seq, seedId: child.seedId });
		};
		return { fn, calls };
	}

	test("pr_open + merged poll fires closeChildSeed for the merged child", async () => {
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
		const { fn, calls } = recordingCloseSeed();
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "merged", mergedAt: "2026-05-17T01:00:00.000Z" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			closeChildSeed: fn,
			now: () => NOW,
		});
		expect(result.kind).toBe("advanced");
		expect(calls).toEqual([{ planRunId: h.planRun.id, seq: 1, seedId: "warren-a" }]);
	});

	test("trivial merge (empty push) fires closeChildSeed for the merged child", async () => {
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
		const { fn, calls } = recordingCloseSeed();
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			closeChildSeed: fn,
			now: () => NOW,
		});
		expect(result.kind).toBe("advanced");
		expect(calls).toEqual([{ planRunId: h.planRun.id, seq: 1, seedId: "warren-a" }]);
	});

	test("a non-merge decision (waiting_for_merge) does not fire closeChildSeed", async () => {
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
		const { fn, calls } = recordingCloseSeed();
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: async () => ({ kind: "open" }),
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			closeChildSeed: fn,
			now: () => NOW,
		});
		expect(result.kind).toBe("waiting_for_merge");
		expect(calls).toEqual([]);
	});
});
