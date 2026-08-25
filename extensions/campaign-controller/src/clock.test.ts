import { describe, expect, test } from "bun:test";
import { FixedClock, SequentialIdGenerator, SystemClock, UuidIdGenerator } from "./clock.ts";

describe("clock and id primitives", () => {
	test("SystemClock returns wall time as epoch milliseconds", () => {
		const before = Date.now();
		const now = new SystemClock().nowMs();
		const after = Date.now();
		expect(now).toBeGreaterThanOrEqual(before);
		expect(now).toBeLessThanOrEqual(after);
	});

	test("FixedClock pins time and advances deterministically", () => {
		const clock = new FixedClock(1_000);
		expect(clock.nowMs()).toBe(1_000);
		clock.advance(250);
		expect(clock.nowMs()).toBe(1_250);
	});

	test("UuidIdGenerator emits unique cc-prefixed ids", () => {
		const ids = new UuidIdGenerator();
		const seen = new Set<string>();
		for (let i = 0; i < 100; i += 1) {
			const id = ids.newId();
			expect(id.startsWith("cc-")).toBe(true);
			expect(seen.has(id)).toBe(false);
			seen.add(id);
		}
	});

	test("SequentialIdGenerator emits a deterministic sequence", () => {
		const ids = new SequentialIdGenerator();
		expect([ids.newId(), ids.newId(), ids.newId()]).toEqual(["seq-1", "seq-2", "seq-3"]);
	});
});
