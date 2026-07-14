import { describe, expect, test } from "bun:test";
import { CronRetryTracker, MAX_CRON_TRANSIENT_RETRIES } from "./cron-retry.ts";

describe("CronRetryTracker", () => {
	test("returns a fresh zeroed state on first observation of a slot", () => {
		const t = new CronRetryTracker();
		const s = t.forSlot("prj", "nightly", "2026-05-11T00:00:00.000Z");
		expect(s.consecutiveFailures).toBe(0);
		expect(s.lastFailedRunId).toBeNull();
		expect(s.slotKey).toBe("2026-05-11T00:00:00.000Z");
	});

	test("returns the same live object across observations of the same slot", () => {
		const t = new CronRetryTracker();
		const a = t.forSlot("prj", "nightly", "slot-1");
		a.consecutiveFailures = 3;
		a.lastFailedRunId = "run_x";
		const b = t.forSlot("prj", "nightly", "slot-1");
		expect(b).toBe(a);
		expect(b.consecutiveFailures).toBe(3);
		expect(b.lastFailedRunId).toBe("run_x");
	});

	test("resets the counter when the slot advances", () => {
		const t = new CronRetryTracker();
		const a = t.forSlot("prj", "nightly", "slot-1");
		a.consecutiveFailures = MAX_CRON_TRANSIENT_RETRIES;
		a.lastFailedRunId = "run_x";
		const b = t.forSlot("prj", "nightly", "slot-2");
		expect(b.consecutiveFailures).toBe(0);
		expect(b.lastFailedRunId).toBeNull();
	});

	test("keeps distinct state per trigger and per project", () => {
		const t = new CronRetryTracker();
		t.forSlot("prj", "a", "slot-1").consecutiveFailures = 2;
		t.forSlot("prj", "b", "slot-1").consecutiveFailures = 4;
		t.forSlot("other", "a", "slot-1").consecutiveFailures = 1;
		expect(t.forSlot("prj", "a", "slot-1").consecutiveFailures).toBe(2);
		expect(t.forSlot("prj", "b", "slot-1").consecutiveFailures).toBe(4);
		expect(t.forSlot("other", "a", "slot-1").consecutiveFailures).toBe(1);
	});

	test("clear() drops the slot memory so the next observation is fresh", () => {
		const t = new CronRetryTracker();
		t.forSlot("prj", "nightly", "slot-1").consecutiveFailures = 3;
		t.clear("prj", "nightly");
		expect(t.forSlot("prj", "nightly", "slot-1").consecutiveFailures).toBe(0);
	});
});
