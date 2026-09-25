import { describe, expect, test } from "bun:test";
import type { RunDayBucket } from "../../api/run-analytics-types.ts";
import {
	collapseToWeeks,
	dayKeys,
	outcomeBuckets,
	padDailySeries,
	segmentPercent,
} from "./loop-tab.buckets.ts";
import { telemetryWindowBounds } from "./telemetry-window.helpers.ts";

function bucket(key: string, succeeded: number, failed = 0): RunDayBucket {
	return {
		key,
		runs: succeeded + failed,
		succeeded,
		failed,
		cancelled: 0,
		active: 0,
		contextTokensTotal: 0,
	};
}

const NOW = Date.parse("2026-09-25T15:30:00Z");

describe("telemetryWindowBounds", () => {
	test("opens the window at UTC midnight N-1 days back", () => {
		const { from, to } = telemetryWindowBounds(14, NOW);
		expect(from).toBe("2026-09-12T00:00:00.000Z");
		expect(to).toBe("2026-09-25T15:30:00.000Z");
	});
});

describe("dayKeys", () => {
	test("lists every UTC day in the window inclusive", () => {
		const { from, to } = telemetryWindowBounds(7, NOW);
		const keys = dayKeys(from, to);
		expect(keys).toHaveLength(7);
		expect(keys[0]).toBe("2026-09-19");
		expect(keys[6]).toBe("2026-09-25");
	});
	test("returns nothing for an inverted or unparseable window", () => {
		expect(dayKeys("2026-09-25T00:00:00Z", "2026-09-20T00:00:00Z")).toEqual([]);
		expect(dayKeys("nope", "2026-09-20T00:00:00Z")).toEqual([]);
	});
});

describe("padDailySeries", () => {
	test("renders one bucket per day, zero-filling days without runs", () => {
		const { from, to } = telemetryWindowBounds(14, NOW);
		const padded = padDailySeries(
			[bucket("2026-09-15", 3), bucket("2026-09-22", 5, 1), bucket("(none)", 2)],
			from,
			to,
		);
		expect(padded).toHaveLength(14);
		expect(padded[0]?.key).toBe("2026-09-12");
		expect(padded[13]?.key).toBe("2026-09-25");
		expect(padded.find((b) => b.key === "2026-09-22")?.failed).toBe(1);
		expect(padded.filter((b) => b.runs === 0)).toHaveLength(12);
	});
});

describe("collapseToWeeks", () => {
	test("folds days into Monday-keyed weeks", () => {
		const weeks = collapseToWeeks([
			bucket("2026-09-21", 1),
			bucket("2026-09-23", 2, 1),
			bucket("2026-09-28", 4),
		]);
		expect(weeks.map((w) => w.key)).toEqual(["2026-09-21", "2026-09-28"]);
		expect(weeks[0]?.runs).toBe(4);
		expect(weeks[0]?.failed).toBe(1);
	});
});

describe("outcomeBuckets", () => {
	test("keeps days for short windows and weeks for 90 days", () => {
		const short = telemetryWindowBounds(30, NOW);
		expect(outcomeBuckets([], 30, short.from, short.to)).toHaveLength(30);
		const long = telemetryWindowBounds(90, NOW);
		const weeks = outcomeBuckets([], 90, long.from, long.to);
		expect(weeks.length).toBeGreaterThanOrEqual(13);
		expect(weeks.length).toBeLessThanOrEqual(14);
	});
});

describe("segmentPercent", () => {
	test("scales against the tallest column and never exceeds it", () => {
		expect(segmentPercent(5, 10)).toBe(50);
		expect(segmentPercent(10, 10)).toBe(100);
		expect(segmentPercent(0, 10)).toBe(0);
		expect(segmentPercent(3, 0)).toBe(0);
	});
});
