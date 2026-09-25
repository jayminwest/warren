import { describe, expect, test } from "bun:test";
import type { PlanRunRow, RunRow } from "@/api/types.ts";
import { childSummary, formatElapsedMs, planRunElapsed, summarizeCost } from "./walk-state.ts";

describe("childSummary", () => {
	test("counts merged children and names the running one", () => {
		expect(childSummary("running", ["merged", "merged", "running", "pending"])).toBe(
			"2 of 4 merged · child 3 running",
		);
	});

	test("says the walk waits on a merge while a PR is open", () => {
		expect(childSummary("running", ["merged", "pr_open", "pending"])).toBe(
			"1 of 3 merged · waiting on PR merge",
		);
	});

	test("drops the clause once the walk succeeded", () => {
		expect(childSummary("succeeded", ["merged", "merged"])).toBe("2 of 2 merged");
	});

	test("reads a queued or childless walk plainly", () => {
		expect(childSummary("queued", ["pending"])).toBe("0 of 1 merged · waiting to start");
		expect(childSummary("running", [])).toBe("No children");
		expect(childSummary("running", undefined)).toBe("—");
	});
});

describe("formatElapsedMs", () => {
	test("steps from seconds to m:ss to h:mm:ss", () => {
		expect(formatElapsedMs(42_000)).toBe("42s");
		expect(formatElapsedMs(125_000)).toBe("2:05");
		expect(formatElapsedMs(3_725_000)).toBe("1:02:05");
	});
});

describe("childSummary clauses", () => {
	test("names queued, failed, cancelled and in-flight walks", () => {
		expect(childSummary("queued", ["pending"])).toBe("0 of 1 merged · waiting to start");
		expect(childSummary("failed", ["failed"])).toBe("0 of 1 merged · stopped on a failure");
		expect(childSummary("cancelled", ["merged"])).toBe("1 of 1 merged · cancelled");
		expect(childSummary("running", ["merged", "pending"])).toBe("1 of 2 merged · in flight");
		expect(childSummary("running", [])).toBe("No children");
		expect(childSummary("running", undefined)).toBe("—");
	});
});

describe("planRunElapsed", () => {
	const base = { startedAt: null, endedAt: null } as unknown as PlanRunRow;
	test("dashes an unstarted walk and ticks a live one against now", () => {
		expect(planRunElapsed(base, 0)).toBe("—");
		expect(planRunElapsed({ ...base, startedAt: "bad" }, 0)).toBe("—");
		const started = { ...base, startedAt: "2026-09-25T10:00:00Z" };
		expect(planRunElapsed(started, Date.parse("2026-09-25T10:01:05Z"))).toBe("1:05");
		expect(planRunElapsed({ ...started, endedAt: "2026-09-25T11:00:00Z" }, 0)).toBe("1:00:00");
		expect(planRunElapsed({ ...started, endedAt: "bad" }, 0)).toBe("—");
	});

	test("formats negative spans as a dash", () => {
		expect(formatElapsedMs(-1)).toBe("—");
	});
});

describe("summarizeCost", () => {
	test("sums priced child runs and counts the unpriced ones", () => {
		const runs = [{ costUsd: 1.5 }, { costUsd: null }, { costUsd: 0.25 }] as unknown as RunRow[];
		expect(summarizeCost(runs)).toEqual({ sum: 1.75, priced: 2, total: 3 });
	});
});
