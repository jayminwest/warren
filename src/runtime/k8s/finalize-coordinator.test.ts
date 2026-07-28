import { describe, expect, test } from "bun:test";
import type { FinalizeResult } from "../contract.ts";
import { FinalizeCoordinator } from "./finalize-coordinator.ts";
import { IN_POD_FINALIZE_WIRE_VERSION, type InPodFinalizeIntent } from "./finalize-wire.ts";

function intent(): Omit<InPodFinalizeIntent, "attemptId"> {
	return {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		branch: "warren/run_x",
		push: true,
		artifacts: ["mulch", "seeds"],
		commit: ["seeds"],
	};
}

function result(pushed: boolean): FinalizeResult {
	return {
		pushed,
		commitsAhead: pushed ? 2 : null,
		emptyPush: false,
		dirty: false,
		workspacePlansBody: null,
		events: [],
		artifacts: {},
		prBranch: pushed ? "warren/run_x" : null,
		stages: [],
	};
}

describe("FinalizeCoordinator", () => {
	test("register parks an intent that peekIntent serves with a fresh attemptId", () => {
		const c = new FinalizeCoordinator();
		const pending = c.register("run_a", intent());
		expect(pending.attemptId).toMatch(/^fin_/);
		const served = c.peekIntent("run_a");
		expect(served).toBeDefined();
		expect(served?.attemptId).toBe(pending.attemptId);
		expect(served?.branch).toBe("warren/run_x");
		expect(c.pendingCount).toBe(1);
	});

	test("submit resolves the awaiting result promise on an attemptId match", async () => {
		const c = new FinalizeCoordinator();
		const pending = c.register("run_a", intent());
		const outcome = c.submit("run_a", pending.attemptId, result(true));
		expect(outcome).toBe("accepted");
		await expect(pending.result).resolves.toMatchObject({ pushed: true, commitsAhead: 2 });
	});

	test("a duplicate submit is an idempotent no-op", async () => {
		const c = new FinalizeCoordinator();
		const pending = c.register("run_a", intent());
		expect(c.submit("run_a", pending.attemptId, result(true))).toBe("accepted");
		// A redelivery of the same attempt does not re-resolve / change anything.
		expect(c.submit("run_a", pending.attemptId, result(false))).toBe("duplicate");
		await expect(pending.result).resolves.toMatchObject({ pushed: true });
	});

	test("a stale attemptId is rejected without resolving", () => {
		const c = new FinalizeCoordinator();
		const pending = c.register("run_a", intent());
		expect(c.submit("run_a", "fin_wrongwrongwr", result(true))).toBe("stale");
		let settled = false;
		void pending.result.then(() => {
			settled = true;
		});
		expect(settled).toBe(false);
	});

	test("submit for an unknown run is 'unknown'", () => {
		const c = new FinalizeCoordinator();
		expect(c.submit("run_missing", "fin_x", result(true))).toBe("unknown");
	});

	test("peekIntent returns undefined after the attempt settles", () => {
		const c = new FinalizeCoordinator();
		const pending = c.register("run_a", intent());
		c.submit("run_a", pending.attemptId, result(true));
		expect(c.peekIntent("run_a")).toBeUndefined();
	});

	test("abort drops the entry so a late submit is 'unknown'", () => {
		const c = new FinalizeCoordinator();
		const pending = c.register("run_a", intent());
		c.abort("run_a", pending.attemptId);
		expect(c.pendingCount).toBe(0);
		expect(c.submit("run_a", pending.attemptId, result(true))).toBe("unknown");
	});

	test("abort with a mismatched attemptId does not evict a newer entry", () => {
		const c = new FinalizeCoordinator();
		const first = c.register("run_a", intent());
		// A second register for the same run supersedes the first.
		const second = c.register("run_a", intent());
		expect(second.attemptId).not.toBe(first.attemptId);
		// The stale first attempt aborting must not evict the live second.
		c.abort("run_a", first.attemptId);
		expect(c.peekIntent("run_a")?.attemptId).toBe(second.attemptId);
	});

	test("re-register for the same run supersedes the old intent", () => {
		const c = new FinalizeCoordinator();
		c.register("run_a", { ...intent(), branch: "old" });
		c.register("run_a", { ...intent(), branch: "new" });
		expect(c.peekIntent("run_a")?.branch).toBe("new");
		expect(c.pendingCount).toBe(1);
	});
});
