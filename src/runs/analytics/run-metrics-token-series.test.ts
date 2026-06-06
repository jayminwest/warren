import { describe, expect, it } from "bun:test";
import { NONE_KEY, OTHER_KEY, type RunMetricsRow } from "./run-metrics.ts";
import { buildTokenDimSeries, buildTokenTimeSeries } from "./run-metrics-token-series.ts";

function row(o: Partial<RunMetricsRow> & { runId: string }): RunMetricsRow {
	return {
		runId: o.runId,
		projectId: o.projectId ?? null,
		agentName: o.agentName ?? "claude-code",
		provider: o.provider ?? null,
		model: o.model ?? null,
		seedId: o.seedId ?? null,
		state: o.state ?? "succeeded",
		failureReason: o.failureReason ?? null,
		costUsd: o.costUsd ?? null,
		tokensInput: o.tokensInput ?? null,
		tokensCacheRead: o.tokensCacheRead ?? null,
		tokensOutput: o.tokensOutput ?? null,
		tokensCacheWrite: o.tokensCacheWrite ?? null,
		startedAt: o.startedAt ?? null,
		endedAt: o.endedAt ?? null,
	};
}

describe("buildTokenTimeSeries", () => {
	it("returns empty array for no rows", () => {
		expect(buildTokenTimeSeries([])).toEqual([]);
	});

	it("buckets by startedAt date, NONE_KEY for null startedAt", () => {
		const series = buildTokenTimeSeries([
			row({ runId: "a", startedAt: "2026-01-02T10:00:00Z", tokensInput: 100 }),
			row({ runId: "b", startedAt: "2026-01-01T08:00:00Z", tokensInput: 200, tokensOutput: 50 }),
			row({ runId: "c", startedAt: null, tokensInput: 10 }),
		]);
		expect(series.map((b) => b.date)).toEqual(["2026-01-01", "2026-01-02", NONE_KEY]);
		const jan1 = series.find((b) => b.date === "2026-01-01");
		expect(jan1?.input).toBe(200);
		expect(jan1?.output).toBe(50);
		expect(jan1?.total).toBe(250);
	});

	it("sums all four token kinds per day, null columns count as zero", () => {
		const series = buildTokenTimeSeries([
			row({
				runId: "a",
				startedAt: "2026-01-01T00:00:00Z",
				tokensInput: 100,
				tokensOutput: 40,
				tokensCacheRead: 20,
				tokensCacheWrite: 10,
			}),
			row({
				runId: "b",
				startedAt: "2026-01-01T12:00:00Z",
				tokensInput: null,
				tokensOutput: null,
				tokensCacheRead: 5,
				tokensCacheWrite: null,
			}),
		]);
		expect(series.length).toBe(1);
		const day = series[0];
		expect(day?.input).toBe(100);
		expect(day?.output).toBe(40);
		expect(day?.cacheRead).toBe(25);
		expect(day?.cacheWrite).toBe(10);
		expect(day?.total).toBe(175);
	});

	it("day total equals sum of four kinds", () => {
		const series = buildTokenTimeSeries([
			row({
				runId: "a",
				startedAt: "2026-01-01T00:00:00Z",
				tokensInput: 111,
				tokensOutput: 222,
				tokensCacheRead: 333,
				tokensCacheWrite: 444,
			}),
		]);
		const b = series[0];
		expect(b?.total).toBe(
			(b?.input ?? 0) + (b?.output ?? 0) + (b?.cacheRead ?? 0) + (b?.cacheWrite ?? 0),
		);
	});

	it("in-flight rows with all-null tokens do not produce NaN", () => {
		const series = buildTokenTimeSeries([
			row({ runId: "a", startedAt: "2026-01-01T00:00:00Z", state: "running" }),
		]);
		const b = series[0];
		expect(Number.isNaN(b?.total)).toBe(false);
		expect(b?.total).toBe(0);
	});
});

describe("buildTokenDimSeries", () => {
	it("returns empty array for no rows", () => {
		expect(buildTokenDimSeries([], "model")).toEqual([]);
		expect(buildTokenDimSeries([], "provider")).toEqual([]);
	});

	it("day-bucket alignment: token series dates match runs time-series dates", () => {
		const rows = [
			row({ runId: "a", startedAt: "2026-01-01T10:00:00Z", model: "gpt-4", tokensInput: 100 }),
			row({ runId: "b", startedAt: "2026-01-02T08:00:00Z", model: "gpt-4", tokensInput: 50 }),
		];
		const series = buildTokenDimSeries(rows, "model");
		expect(series.length).toBe(1);
		const gpt4 = series[0];
		expect(gpt4?.key).toBe("gpt-4");
		expect(gpt4?.series.map((b) => b.date)).toEqual(["2026-01-01", "2026-01-02"]);
		expect(gpt4?.series[0]?.input).toBe(100);
		expect(gpt4?.series[1]?.input).toBe(50);
	});

	it("top-5 + other folding: 6+ models, the 6th folds into OTHER_KEY", () => {
		const rows = Array.from({ length: 6 }, (_, i) =>
			row({
				runId: `r${i}`,
				startedAt: "2026-01-01T00:00:00Z",
				model: `model-${i}`,
				tokensInput: (6 - i) * 100,
			}),
		);
		// model-0 has 600 (top), model-5 has 100 (6th — folded)
		const series = buildTokenDimSeries(rows, "model");
		const keys = series.map((s) => s.key);
		expect(keys).toContain("model-0");
		expect(keys).toContain(OTHER_KEY);
		expect(keys).not.toContain("model-5");
		// OTHER_KEY bucket's day sum should equal model-5's contribution
		const other = series.find((s) => s.key === OTHER_KEY);
		expect(other?.series[0]?.input).toBe(100);
	});

	it("unknown vs other separation: NONE_KEY is kept distinct from OTHER_KEY", () => {
		const rows = [
			...Array.from({ length: 6 }, (_, i) =>
				row({
					runId: `r${i}`,
					startedAt: "2026-01-01T00:00:00Z",
					model: `model-${i}`,
					tokensInput: (6 - i) * 100,
				}),
			),
			row({
				runId: "null-model",
				startedAt: "2026-01-01T00:00:00Z",
				model: null,
				tokensInput: 9999,
			}),
		];
		const series = buildTokenDimSeries(rows, "model");
		const keys = series.map((s) => s.key);
		expect(keys).toContain(OTHER_KEY);
		expect(keys).toContain(NONE_KEY);
		// NONE_KEY bucket should have 9999 input, not lumped with OTHER_KEY
		const none = series.find((s) => s.key === NONE_KEY);
		expect(none?.series[0]?.input).toBe(9999);
	});

	it("sum of series per day equals overall daily total", () => {
		const rows = [
			row({
				runId: "a",
				startedAt: "2026-01-01T00:00:00Z",
				model: "alpha",
				tokensInput: 100,
				tokensOutput: 20,
			}),
			row({
				runId: "b",
				startedAt: "2026-01-01T12:00:00Z",
				model: "beta",
				tokensInput: 200,
				tokensOutput: 30,
			}),
			row({ runId: "c", startedAt: "2026-01-01T18:00:00Z", model: null, tokensInput: 50 }),
		];
		const overallSeries = buildTokenTimeSeries(rows);
		const dimSeries = buildTokenDimSeries(rows, "model");
		const overallDay = overallSeries.find((b) => b.date === "2026-01-01");
		const dimDayTotal = dimSeries.reduce((sum, s) => {
			const dayBucket = s.series.find((b) => b.date === "2026-01-01");
			return sum + (dayBucket?.total ?? 0);
		}, 0);
		expect(dimDayTotal).toBe(overallDay?.total ?? 0);
	});

	it("sort order: top-5 by total desc, then OTHER_KEY, then NONE_KEY", () => {
		const rows = [
			...Array.from({ length: 6 }, (_, i) =>
				row({
					runId: `r${i}`,
					startedAt: "2026-01-01T00:00:00Z",
					model: `model-${i}`,
					tokensInput: (i + 1) * 100,
				}),
			),
			row({ runId: "n", startedAt: "2026-01-01T00:00:00Z", model: null, tokensInput: 50 }),
		];
		const series = buildTokenDimSeries(rows, "model");
		const keys = series.map((s) => s.key);
		const otherIdx = keys.indexOf(OTHER_KEY);
		const noneIdx = keys.indexOf(NONE_KEY);
		// OTHER_KEY must come before NONE_KEY
		expect(otherIdx).toBeGreaterThan(-1);
		expect(noneIdx).toBeGreaterThan(otherIdx);
		// top key (model-5 with 600 tokens) must be first
		expect(keys[0]).toBe("model-5");
	});

	it("works for provider dimension too", () => {
		const rows = [
			row({
				runId: "a",
				startedAt: "2026-01-01T00:00:00Z",
				provider: "anthropic",
				tokensInput: 500,
			}),
			row({
				runId: "b",
				startedAt: "2026-01-01T00:00:00Z",
				provider: "openai",
				tokensInput: 200,
			}),
		];
		const series = buildTokenDimSeries(rows, "provider");
		expect(series.map((s) => s.key)).toEqual(["anthropic", "openai"]);
	});
});
