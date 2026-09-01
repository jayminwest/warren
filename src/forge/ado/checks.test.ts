import { describe, expect, test } from "bun:test";
import type { CheckRun } from "../contract.ts";
import { buildMatches, parseBuild, pickTimelineLogId, rollUp } from "./checks.ts";

function run(overrides: Partial<CheckRun> = {}): CheckRun {
	return {
		name: "ci",
		status: "completed",
		conclusion: "success",
		jobId: "1",
		detailsUrl: null,
		...overrides,
	};
}

describe("parseBuild", () => {
	test("maps a build row onto a check run with the build id as jobId", () => {
		expect(
			parseBuild({
				id: 42,
				status: "completed",
				result: "failed",
				definition: { name: "CI" },
				_links: { web: { href: "https://dev.azure.com/acme/_build/results?buildId=42" } },
			}),
		).toEqual({
			name: "CI",
			status: "completed",
			conclusion: "failure",
			jobId: "42",
			detailsUrl: "https://dev.azure.com/acme/_build/results?buildId=42",
		});
	});

	test("maps the build status vocabulary", () => {
		expect(parseBuild({ id: 1, status: "notStarted" })?.status).toBe("queued");
		expect(parseBuild({ id: 1, status: "postponed" })?.status).toBe("queued");
		expect(parseBuild({ id: 1, status: "inProgress" })?.status).toBe("in_progress");
		expect(parseBuild({ id: 1, status: "cancelling" })?.status).toBe("in_progress");
		expect(parseBuild({ id: 1, status: "completed" })?.conclusion).toBeNull();
	});

	test("folds build results to the classifier's conclusion vocabulary", () => {
		expect(parseBuild({ id: 1, result: "succeeded" })?.conclusion).toBe("success");
		expect(parseBuild({ id: 1, result: "failed" })?.conclusion).toBe("failure");
		expect(parseBuild({ id: 1, result: "partiallySucceeded" })?.conclusion).toBe("failure");
		expect(parseBuild({ id: 1, result: "canceled" })?.conclusion).toBe("cancelled");
		expect(parseBuild({ id: 1, result: "somethingElse" })?.conclusion).toBe("somethingElse");
	});

	test("returns null for a row without a numeric id", () => {
		expect(parseBuild({ status: "completed" })).toBeNull();
		expect(parseBuild(null)).toBeNull();
	});
});

describe("buildMatches", () => {
	const SHA = "a".repeat(40);

	test("matches a commit sha on sourceVersion and, when named, the repository", () => {
		expect(
			buildMatches({ sourceVersion: SHA, repository: { name: "widget" } }, "widget", SHA),
		).toBe(true);
		expect(buildMatches({ sourceVersion: SHA, repository: { name: "other" } }, "widget", SHA)).toBe(
			false,
		);
		expect(buildMatches({ sourceVersion: SHA }, "widget", SHA)).toBe(true);
		expect(buildMatches({ sourceVersion: "b".repeat(40) }, "widget", SHA)).toBe(false);
		expect(buildMatches(null, "widget", SHA)).toBe(false);
	});

	test("matches a branch ref on sourceBranch — the shape the ci-fixer polls with", () => {
		const row = { sourceVersion: SHA, sourceBranch: "refs/heads/warren/run_1" };
		expect(buildMatches(row, "widget", "warren/run_1")).toBe(true);
		expect(buildMatches(row, "widget", "warren/run_2")).toBe(false);
		expect(buildMatches({ sourceVersion: SHA }, "widget", "warren/run_1")).toBe(false);
	});
});

describe("rollUp", () => {
	test("no builds is unknown, an incomplete one is pending", () => {
		expect(rollUp([])).toBe("unknown");
		expect(rollUp([run(), run({ status: "in_progress", conclusion: null })])).toBe("pending");
	});

	test("failure and cancelled count as failing", () => {
		expect(rollUp([run(), run({ conclusion: "failure" })])).toBe("failing");
		expect(rollUp([run({ conclusion: "cancelled" })])).toBe("failing");
		expect(rollUp([run(), run()])).toBe("passing");
	});
});

describe("pickTimelineLogId", () => {
	test("prefers the first failed task's log", () => {
		expect(
			pickTimelineLogId({
				records: [
					{ type: "Job", result: "failed", log: { id: 1 } },
					{ type: "Task", result: "succeeded", log: { id: 2 } },
					{ type: "Task", result: "failed", log: { id: 3 } },
					{ type: "Task", result: "failed", log: { id: 4 } },
				],
			}),
		).toBe(3);
	});

	test("falls back to the last record with a log", () => {
		expect(
			pickTimelineLogId({
				records: [
					{ type: "Task", log: { id: 5 } },
					{ type: "Task", log: { id: 6 } },
					{ type: "Task" },
				],
			}),
		).toBe(6);
	});

	test("returns null when nothing carries a log", () => {
		expect(pickTimelineLogId({ records: [{ type: "Task" }] })).toBeNull();
		expect(pickTimelineLogId(null)).toBeNull();
		expect(pickTimelineLogId({})).toBeNull();
	});
});
