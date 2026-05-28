import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun, type CoordinatorShowSeedFn } from "./coordinator.ts";

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
		const showSeed: CoordinatorShowSeedFn = async (_p, seedId) => {
			calls += 1;
			// First call (seq=1) reports closed; second (seq=2) reports open.
			if (seedId === "warren-a") return { id: seedId, status: "closed" };
			return { id: seedId, status: "open" };
		};
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed,
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
});
