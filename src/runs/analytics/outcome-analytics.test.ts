import { describe, expect, test } from "bun:test";
import {
	buildCostPerMergedPr,
	buildRunOutcomes,
	buildSteeringOutcomeComparison,
	confidenceForSample,
	type SteeringOutcomeEventRow,
} from "./outcome-analytics.ts";
import { buildRunMetrics, type RunMetricsRow } from "./run-metrics.ts";

function row(overrides: Partial<RunMetricsRow> & { runId: string }): RunMetricsRow {
	return {
		projectId: "proj",
		agentName: "claude-code",
		provider: "anthropic",
		model: "claude-opus-4",
		seedId: null,
		state: "succeeded",
		failureReason: null,
		costUsd: null,
		tokensInput: null,
		tokensCacheRead: null,
		tokensOutput: null,
		tokensCacheWrite: null,
		startedAt: "2026-05-01T00:00:00.000Z",
		endedAt: "2026-05-01T00:10:00.000Z",
		createdAt: null,
		prState: null,
		parentRunId: null,
		retryOf: null,
		prMergedAt: null,
		branchPushedAt: null,
		prOpenedAt: null,
		...overrides,
	};
}

function steer(runId: string, kind = "steer.sent"): SteeringOutcomeEventRow {
	return { runId, kind };
}

describe("confidenceForSample", () => {
	test("low below the medium threshold, medium below high, high past it", () => {
		expect(confidenceForSample(0)).toBe("low");
		expect(confidenceForSample(9)).toBe("low");
		expect(confidenceForSample(10)).toBe("medium");
		expect(confidenceForSample(29)).toBe("medium");
		expect(confidenceForSample(30)).toBe("high");
	});
});

describe("buildSteeringOutcomeComparison", () => {
	test("splits cohorts by steer.sent and tallies outcomes per cohort", () => {
		const rows = [
			row({ runId: "a", prState: "merged" }),
			row({ runId: "b", prState: "closed_unmerged" }),
			row({ runId: "c", prState: "merged" }),
			row({ runId: "d", prState: "open" }),
		];
		const c = buildSteeringOutcomeComparison(rows, [steer("a"), steer("c")]);
		expect(c.steered.runs).toBe(2);
		expect(c.steered.prStateKnown).toBe(2);
		expect(c.steered.prsMerged).toBe(2);
		expect(c.steered.mergedPrRate).toBe(1);
		expect(c.unsteered.runs).toBe(2);
		expect(c.unsteered.prStateKnown).toBe(2);
		expect(c.unsteered.prsMerged).toBe(0);
		expect(c.unsteered.mergedPrRate).toBe(0);
		expect(c.mergedPrRateDelta).toBe(1);
	});

	test("excludes NULL prState rows from merge denominators, never as failures", () => {
		const rows = [
			row({ runId: "a", prState: null }),
			row({ runId: "b", prState: "merged" }),
			row({ runId: "c", prState: null }),
		];
		const c = buildSteeringOutcomeComparison(rows, [steer("a")]);
		// The steered cohort's only row is unresolved: known = 0, not a 0% rate.
		expect(c.steered.prStateKnown).toBe(0);
		expect(c.steered.mergedPrRate).toBeNull();
		expect(c.unsteered.prStateKnown).toBe(1);
		expect(c.unsteered.mergedPrRate).toBe(1);
		// One side has no denominator → no delta at all.
		expect(c.mergedPrRateDelta).toBeNull();
	});

	test("counts success over terminal runs per cohort", () => {
		const rows = [
			row({ runId: "a", state: "succeeded" }),
			row({ runId: "b", state: "failed" }),
			row({ runId: "c", state: "cancelled" }),
			row({ runId: "d", state: "running" }),
		];
		const c = buildSteeringOutcomeComparison(rows, [steer("a"), steer("b")]);
		expect(c.steered.terminal).toBe(2);
		expect(c.steered.successRate).toBe(0.5);
		expect(c.unsteered.terminal).toBe(1);
		expect(c.unsteered.succeeded).toBe(0);
	});

	test("ignores non-steering event kinds", () => {
		const rows = [row({ runId: "a" }), row({ runId: "b" })];
		const c = buildSteeringOutcomeComparison(rows, [
			steer("a", "tool_use"),
			steer("a", "state_change"),
		]);
		expect(c.steered.runs).toBe(0);
		expect(c.unsteered.runs).toBe(2);
	});

	test("derives confidence from the smaller cohort denominator", () => {
		const steeredRows = Array.from({ length: 12 }, (_, i) =>
			row({ runId: `s-${i}`, prState: "merged" }),
		);
		const unsteeredRows = Array.from({ length: 4 }, (_, i) =>
			row({ runId: `u-${i}`, prState: "open" }),
		);
		const c = buildSteeringOutcomeComparison(
			[...steeredRows, ...unsteeredRows],
			steeredRows.map((r) => steer(r.runId)),
		);
		expect(c.confidence).toBe("low");
	});
});

describe("buildCostPerMergedPr", () => {
	test("divides total priced cost by merged PRs, overall and per bucket", () => {
		const rows = [
			row({ runId: "a", agentName: "pi", costUsd: 4, prState: "merged" }),
			row({ runId: "b", agentName: "pi", costUsd: 2, prState: "merged" }),
			row({ runId: "c", agentName: "claude-code", costUsd: 9, prState: "closed_unmerged" }),
		];
		const c = buildCostPerMergedPr(buildRunMetrics(rows));
		expect(c.overall.costUsd).toBe(15);
		expect(c.overall.priced).toBe(3);
		expect(c.overall.prStateKnown).toBe(3);
		expect(c.overall.prsMerged).toBe(2);
		expect(c.overall.costPerMergedPrUsd).toBe(7.5);
		const pi = c.byAgent.find((b) => b.key === "pi");
		expect(pi?.costPerMergedPrUsd).toBe(3);
		const cc = c.byAgent.find((b) => b.key === "claude-code");
		expect(cc?.prsMerged).toBe(0);
		expect(cc?.costPerMergedPrUsd).toBeNull();
	});

	test("nulls the ratio when nothing merged and treats NULL prState as unknown", () => {
		const rows = [
			row({ runId: "a", costUsd: 5, prState: null }),
			row({ runId: "b", costUsd: 5, prState: "open" }),
		];
		const c = buildCostPerMergedPr(buildRunMetrics(rows));
		expect(c.overall.prsMerged).toBe(0);
		expect(c.overall.prStateKnown).toBe(1);
		expect(c.overall.costPerMergedPrUsd).toBeNull();
	});

	test("sorts buckets by ratio descending with unresolved buckets last", () => {
		const rows = [
			row({ runId: "a", model: "opus", costUsd: 10, prState: "merged" }),
			row({ runId: "b", model: "sonnet", costUsd: 2, prState: "merged" }),
			row({ runId: "c", model: "haiku", costUsd: 1, prState: "open" }),
		];
		const c = buildCostPerMergedPr(buildRunMetrics(rows));
		expect(c.byModel.map((b) => b.key)).toEqual(["opus", "sonnet", "haiku"]);
	});
});

describe("buildRunOutcomes", () => {
	test("composes steering comparison and cost rollup from the same inputs", () => {
		const rows = [
			row({ runId: "a", costUsd: 3, prState: "merged" }),
			row({ runId: "b", costUsd: 1, prState: "open" }),
		];
		const metrics = buildRunMetrics(rows);
		const o = buildRunOutcomes(rows, [steer("a")], metrics);
		expect(o.steering.steered.runs).toBe(1);
		// Total priced cost (3 + 1) over the single merged PR.
		expect(o.costPerMergedPr.overall.costPerMergedPrUsd).toBe(4);
	});
});

describe("outcomes.autonomy (warren-bc9c)", () => {
	test("counts merged runs that were unsteered and first attempts", () => {
		const rows = [
			row({ runId: "a", prState: "merged" }),
			// steered: merged but not autonomous
			row({ runId: "b", prState: "merged" }),
			// retry: merged but not autonomous
			row({ runId: "c", prState: "merged", retryOf: "x" }),
			// continuation: merged but not autonomous
			row({ runId: "d", prState: "merged", parentRunId: "p" }),
			// unmerged: outside the denominator
			row({ runId: "e", prState: "open" }),
			row({ runId: "f", prState: null }),
		];
		const steering = [{ runId: "b", kind: "steer.sent" }];
		const outcomes = buildRunOutcomes(rows, steering, buildRunMetrics(rows));
		expect(outcomes.autonomy.merged).toBe(4);
		expect(outcomes.autonomy.autonomous).toBe(1);
		expect(outcomes.autonomy.rate).toBe(0.25);
	});

	test("rate is null when nothing merged", () => {
		const outcomes = buildRunOutcomes(
			[row({ runId: "a" })],
			[],
			buildRunMetrics([row({ runId: "a" })]),
		);
		expect(outcomes.autonomy.merged).toBe(0);
		expect(outcomes.autonomy.rate).toBeNull();
	});
});
