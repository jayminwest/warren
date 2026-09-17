import { describe, expect, test } from "bun:test";
import {
	healthAction,
	healthReport,
	latestRelevantRun,
	type NightlyRun,
	parseOutcomes,
	readState,
} from "./acceptance-health.ts";

const run: NightlyRun = {
	id: 100,
	run_number: 50,
	run_attempt: 1,
	conclusion: "failure",
	head_sha: "a".repeat(40),
	html_url: "https://github.com/owner/repo/actions/runs/100",
};
const outcomes = parseOutcomes({
	outcomes: [
		{ id: "22", title: "Seeds roundtrip", status: "passed" },
		{ id: "42", title: "Self host", status: "failed" },
		{ id: "35", title: "Live flow", status: "skipped" },
	],
});
const failed = healthReport(run, outcomes, ["acceptance: Run scenarios"]);
const issue = { number: 1, state: "open", body: failed.body };

describe("nightly acceptance health", () => {
	test("opens on the first observed failure even after a long red history", () => {
		expect(healthAction(undefined, failed.state)).toBe("create");
		expect(failed.body).toContain("1 passed, 1 failed, 1 skipped");
		expect(failed.body).toContain("42: Self host");
		expect(readState(failed.body)).toEqual(failed.state);
	});
	test("updates quietly on repeated failures and duplicate deliveries", () => {
		expect(healthAction(issue, failed.state)).toBe("update");
		const next = healthReport({ ...run, run_number: 51 }, outcomes, ["acceptance: Run scenarios"]);
		expect(healthAction(issue, next.state)).toBe("update");
	});
	test("announces changed failed scenarios while the suite stays red", () => {
		const next = healthReport(run, [{ id: "22", title: "Seeds", status: "failed" }], []);
		expect(healthAction(issue, next.state)).toBe("transition");
	});
	test("closes on recovery and reopens on a later failure", () => {
		const recovered = healthReport({ ...run, run_number: 51, conclusion: "success" }, [], []);
		expect(healthAction(issue, recovered.state)).toBe("transition");
		expect(healthAction(undefined, recovered.state)).toBe("ignore");
		const closed = { ...issue, state: "closed", body: recovered.body };
		expect(healthAction(closed, recovered.state)).toBe("update");
		expect(healthAction(closed, { ...failed.state, run: 52 })).toBe("transition");
	});
	test("repairs a manually closed failing issue without creating another", () => {
		expect(healthAction({ ...issue, state: "closed" }, failed.state)).toBe("transition");
	});
	test("ignores old runs and old attempts after newer evidence", () => {
		expect(healthAction(issue, { ...failed.state, run: 49, failed: false })).toBe("ignore");
		const rerun = healthReport({ ...run, run_attempt: 2 }, outcomes, []);
		expect(healthAction({ ...issue, body: rerun.body }, failed.state)).toBe("ignore");
	});
	test("ignores cancellations and selects by run number before attempt", () => {
		expect(
			latestRelevantRun([
				{ ...run, run_number: 51, conclusion: "cancelled" },
				{ ...run, run_number: 49, run_attempt: 4, conclusion: "success" },
				run,
			]),
		).toEqual(run);
		expect(latestRelevantRun([{ ...run, conclusion: "skipped" }])).toBeUndefined();
	});
	test("reports setup failures and timeouts without a scoreboard", () => {
		const timeout = healthReport({ ...run, conclusion: "timed_out" }, undefined, [
			"acceptance: timed_out",
		]);
		expect(timeout.body).toContain("No scenario scoreboard");
		expect(timeout.body).toContain("acceptance: timed_out");
		expect(healthAction(undefined, timeout.state)).toBe("create");
	});
	test("rejects malformed artifacts and neutralizes mentions in titles", () => {
		expect(() => parseOutcomes({ outcomes: [{ status: "green" }] })).toThrow();
		expect(() => parseOutcomes(null)).toThrow();
		const data = parseOutcomes({
			outcomes: [{ id: "42", title: "@owner <tag> `code`", status: "failed" }],
		});
		expect(healthReport(run, data, []).body).not.toContain("@owner");
		expect(readState("<!-- acceptance-state:invalid -->")).toBeUndefined();
	});
});
