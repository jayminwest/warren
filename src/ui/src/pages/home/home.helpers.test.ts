import { describe, expect, test } from "bun:test";
import type { PlanRunRow, RunRow } from "../../api/types.ts";
import {
	buildFeed,
	dayLabel,
	fillDays,
	greeting,
	headline,
	isLongRun,
	promptTitle,
	runElapsedMs,
	shortDuration,
	windowStartIso,
} from "./home.helpers.ts";

const NOW = new Date("2026-09-25T15:30:00").getTime();

function run(over: Partial<RunRow>): RunRow {
	return {
		id: "run_1",
		state: "succeeded",
		createdAt: NOW - 60_000,
		startedAt: null,
		endedAt: null,
		prState: null,
		...over,
	} as RunRow;
}

describe("shortDuration", () => {
	test("formats each magnitude compactly", () => {
		expect(shortDuration(42_000)).toBe("42s");
		expect(shortDuration(12 * 60_000)).toBe("12m");
		expect(shortDuration(64 * 60_000)).toBe("1h 04m");
		expect(shortDuration(51 * 3_600_000)).toBe("2d 3h");
		expect(shortDuration(null)).toBe("—");
	});
});

describe("greeting", () => {
	test("follows the hour of day", () => {
		expect(greeting(3)).toBe("Working late");
		expect(greeting(9)).toBe("Good morning");
		expect(greeting(14)).toBe("Good afternoon");
		expect(greeting(20)).toBe("Good evening");
	});
});

describe("windowStartIso", () => {
	test("floors to the hour so the query key is stable within the hour", () => {
		expect(windowStartIso("1", NOW)).toBe(windowStartIso("1", NOW + 20 * 60_000));
	});
});

describe("runElapsedMs", () => {
	test("measures from start to end, or to now while live", () => {
		const startedAt = new Date(NOW - 90_000).toISOString();
		expect(runElapsedMs(run({ startedAt }), NOW)).toBe(90_000);
		expect(
			runElapsedMs(run({ startedAt, endedAt: new Date(NOW - 30_000).toISOString() }), NOW),
		).toBe(60_000);
	});
});

describe("isLongRun", () => {
	test("flags a running run past the p95, and nothing without a p95", () => {
		const r = run({ state: "running", startedAt: new Date(NOW - 10 * 60_000).toISOString() });
		expect(isLongRun(r, NOW, 5 * 60_000)).toBe(true);
		expect(isLongRun(r, NOW, 20 * 60_000)).toBe(false);
		expect(isLongRun(r, NOW, null)).toBe(false);
	});
});

describe("dayLabel", () => {
	test("names today and yesterday", () => {
		expect(dayLabel(NOW - 60_000, NOW)).toBe("Today");
		expect(dayLabel(NOW - 86_400_000, NOW)).toBe("Yesterday");
	});
});

describe("buildFeed", () => {
	const runs = [
		run({ id: "run_a", state: "failed", createdAt: NOW - 1000 }),
		run({ id: "run_b", state: "succeeded", prState: "merged", createdAt: NOW - 2000 }),
		run({ id: "run_c", state: "running", createdAt: NOW - 86_400_000 }),
	];
	const planRuns = [
		{ id: "plnr_1", state: "running", createdAt: new Date(NOW - 500).toISOString() },
	] as PlanRunRow[];

	test("groups newest first by day and folds in plan runs", () => {
		const groups = buildFeed({ runs, planRuns, filter: "all", now: NOW, isLong: () => false });
		expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
		expect(groups[0]?.items.map((i) => (i.kind === "run" ? i.run.id : i.plan.id))).toEqual([
			"plnr_1",
			"run_a",
			"run_b",
		]);
	});

	test("filters to attention and shipped", () => {
		const ids = (filter: "attention" | "shipped") =>
			buildFeed({ runs, planRuns, filter, now: NOW, isLong: () => false })
				.flatMap((g) => g.items)
				.map((i) => (i.kind === "run" ? i.run.id : i.plan.id));
		expect(ids("attention")).toEqual(["run_a"]);
		expect(ids("shipped")).toEqual(["run_b"]);
	});
});

describe("headline", () => {
	test("counts live agents and handles idle and loading", () => {
		expect(headline(1, false)).toBe("1 agent is working right now");
		expect(headline(3, false)).toBe("3 agents are working right now");
		expect(headline(0, true)).toBe("Loading your agents' work");
		expect(headline(0, false)).toBe("No agents are running right now");
	});
});

describe("fillDays", () => {
	test("spans the full window and zero-fills missing days", () => {
		const today = new Date(NOW).toISOString().slice(0, 10);
		const days = fillDays(
			[
				{
					key: today,
					runs: 3,
					succeeded: 2,
					failed: 1,
					cancelled: 0,
					active: 0,
					contextTokensTotal: 0,
				},
			],
			30,
			NOW,
		);
		expect(days).toHaveLength(30);
		expect(days[29]?.runs).toBe(3);
		expect(days[0]?.runs).toBe(0);
	});
});

describe("promptTitle", () => {
	test("collapses the tracker prompt shape and passes others through", () => {
		expect(promptTitle('Work GitHub issue #1230 in jayminwest/warren: "version bump drift"')).toBe(
			"#1230 version bump drift",
		);
		expect(promptTitle("Fix the flaky test")).toBe("Fix the flaky test");
	});
});
