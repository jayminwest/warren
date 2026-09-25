import { describe, expect, test } from "bun:test";
import { childSummary, formatElapsedMs } from "./walk-state.ts";

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
	});
});

describe("formatElapsedMs", () => {
	test("steps from seconds to m:ss to h:mm:ss", () => {
		expect(formatElapsedMs(42_000)).toBe("42s");
		expect(formatElapsedMs(125_000)).toBe("2:05");
		expect(formatElapsedMs(3_725_000)).toBe("1:02:05");
	});
});
