import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IssueNotFoundError, TrackerError } from "../core/wire.ts";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun, type CoordinatorGetIssueFn } from "./coordinator.ts";

describe("advancePlanRun — resume phase", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("resume semantics: closed seed flips to skipped without dispatch", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		let calls = 0;
		const getIssue: CoordinatorGetIssueFn = async (_p, seedId) => {
			calls += 1;
			// First call (seq=1) reports closed; second (seq=2) reports open.
			if (seedId === "warren-a") return { id: seedId, status: "closed" };
			return { id: seedId, status: "open" };
		};
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue,
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
		expect(calls).toBe(2);
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("skipped");
		expect(children.find((c) => c.seq === 2)?.state).toBe("dispatched");
	});

	test("warren-0fed: a definitive IssueNotFoundError fails the child and the plan-run", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const getIssue: CoordinatorGetIssueFn = async (_p, seedId) => {
			throw new IssueNotFoundError(`sd show ${seedId} exited 1: Issue not found`);
		};
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue,
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.failedSeq).toBe(1);
			expect(result.reason).toBe("child_seed_not_found:warren-a");
		}
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("failed");
		expect(children.find((c) => c.seq === 1)?.failureReason).toBe("child_seed_not_found:warren-a");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("child_seed_not_found:warren-a");
	});

	test("warren-0fed: a transient sd failure stays a retryable noop, not terminal", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const getIssue: CoordinatorGetIssueFn = async (_p, seedId) => {
			throw new TrackerError(`sd show ${seedId} exited 1: database is locked`);
		};
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			getIssue,
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("noop");
		if (result.kind === "noop") {
			expect(result.reason).toContain("show_seed_failed");
		}
		// Plan-run stays running so the next tick retries.
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("pending");
	});
});
