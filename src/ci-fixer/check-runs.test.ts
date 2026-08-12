import { describe, expect, test } from "bun:test";
import { type CheckRun, classifyCheckRuns, tailLogLines } from "./check-runs.ts";

function checkRun(over: Partial<CheckRun>): CheckRun {
	return {
		name: "ci",
		status: "completed",
		conclusion: "success",
		jobId: null,
		detailsUrl: null,
		...over,
	};
}

describe("classifyCheckRuns", () => {
	test("returns no_checks for an empty list", () => {
		expect(classifyCheckRuns([]).verdict).toBe("no_checks");
	});

	test("returns pending when any check-run is not completed", () => {
		const result = classifyCheckRuns([
			checkRun({ status: "completed", conclusion: "success" }),
			checkRun({ status: "in_progress", conclusion: null }),
		]);
		expect(result.verdict).toBe("pending");
		expect(result.failures).toEqual([]);
	});

	test("returns passing when all completed with success-ish conclusions", () => {
		const result = classifyCheckRuns([
			checkRun({ conclusion: "success" }),
			checkRun({ conclusion: "neutral" }),
			checkRun({ conclusion: "skipped" }),
		]);
		expect(result.verdict).toBe("passing");
	});

	test("returns failing with the failing check-runs when any failure-ish conclusion present", () => {
		const failing = checkRun({ name: "test", conclusion: "failure", jobId: "2" });
		const result = classifyCheckRuns([checkRun({ conclusion: "success" }), failing]);
		expect(result.verdict).toBe("failing");
		expect(result.failures).toEqual([failing]);
	});

	test("treats timed_out / action_required / cancelled / startup_failure as failures", () => {
		for (const conclusion of ["timed_out", "action_required", "cancelled", "startup_failure"]) {
			const result = classifyCheckRuns([checkRun({ conclusion })]);
			expect(result.verdict).toBe("failing");
		}
	});
});

describe("tailLogLines", () => {
	test("returns the last N lines of the log", () => {
		expect(tailLogLines("l1\nl2\nl3\nl4\n", 2)).toBe("l3\nl4");
	});

	test("returns the whole (trimmed) log when it has fewer lines than the tail", () => {
		expect(tailLogLines("only\n", 200)).toBe("only");
	});

	test("returns null for an effectively empty log", () => {
		expect(tailLogLines("  \n ", 10)).toBeNull();
	});
});
