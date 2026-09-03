import { describe, expect, test } from "bun:test";
import type { CommandMining } from "./command-mining.ts";
import { buildInsights, type Insight, type InsightKind } from "./insights.ts";
import type { OutcomeTally, RunOutcomes } from "./outcome-analytics.ts";
import type { RunMetrics } from "./run-metrics.ts";

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export function emptyMetrics(): RunMetrics {
	return {
		totals: {
			runs: 0,
			succeeded: 0,
			failed: 0,
			cancelled: 0,
			active: 0,
			successRate: null,
			prStateKnown: 0,
			prsMerged: 0,
			mergedPrRate: null,
			durationMs: { avg: null, median: null, p95: null, count: 0 },
			queueWaitMs: { avg: null, median: null, p95: null, count: 0 },
			contextTokens: { avg: null, median: null, p95: null, count: 0 },
			tokens: ZERO_TOKENS,
			cost: { total: 0, avg: null, priced: 0 },
		},
		delivery: {
			branchPushToPrOpenMs: { avg: null, median: null, p95: null, count: 0 },
			prOpenToMergeMs: { avg: null, median: null, p95: null, count: 0 },
			dispatchToMergeMs: { avg: null, median: null, p95: null, count: 0 },
			endToMergeMs: { avg: null, median: null, p95: null, count: 0 },
		},
		timeSeries: [],
		byAgent: [],
		byModel: [],
		byProvider: [],
		byFailureReason: [],
		topSeedsByContext: [],
		tokenTimeSeries: [],
		tokenByModelSeries: [],
		tokenByProviderSeries: [],
	};
}

export function emptyMining(): CommandMining {
	return {
		totals: {
			toolUses: 0,
			commands: 0,
			distinctCommands: 0,
			failures: 0,
			retries: 0,
			byRuntime: [],
		},
		byFrequency: [],
		byFailures: [],
		byStuckScore: [],
		osEcoCommands: [],
		byCategory: [],
	};
}

function kinds(insights: readonly Insight[]): InsightKind[] {
	return insights.map((i) => i.kind);
}

function find(insights: readonly Insight[], kind: InsightKind): Insight {
	const found = insights.find((i) => i.kind === kind);
	if (found === undefined) throw new Error(`no insight ${kind}`);
	return found;
}

describe("buildInsights (outcome-joined kinds, warren-be04)", () => {
	function tally(overrides: Partial<OutcomeTally>): OutcomeTally {
		return {
			runs: 0,
			terminal: 0,
			succeeded: 0,
			successRate: null,
			prStateKnown: 0,
			prsMerged: 0,
			mergedPrRate: null,
			...overrides,
		};
	}

	function outcomes(overrides: Partial<RunOutcomes>): RunOutcomes {
		return {
			steering: {
				steered: tally({}),
				unsteered: tally({}),
				mergedPrRateDelta: null,
				confidence: "low",
			},
			autonomy: { merged: 0, autonomous: 0, rate: null },
			costPerMergedPr: {
				overall: { costUsd: 0, priced: 0, prStateKnown: 0, prsMerged: 0, costPerMergedPrUsd: null },
				byAgent: [],
				byModel: [],
				byProvider: [],
				confidence: "low",
			},
			...overrides,
		};
	}

	test("omits both outcome kinds when outcomes are not supplied", () => {
		const insights = buildInsights({ metrics: emptyMetrics(), mining: emptyMining() });
		expect(kinds(insights)).not.toContain("steering-outcome-delta");
		expect(kinds(insights)).not.toContain("cost-per-merged-pr");
	});

	test("reports the steered/unsteered delta with denominators and confidence", () => {
		const o = outcomes({
			steering: {
				steered: tally({ runs: 6, prStateKnown: 6, prsMerged: 5, mergedPrRate: 5 / 6 }),
				unsteered: tally({ runs: 10, prStateKnown: 9, prsMerged: 3, mergedPrRate: 1 / 3 }),
				mergedPrRateDelta: 5 / 6 - 1 / 3,
				confidence: "low",
			},
		});
		const i = find(
			buildInsights({ metrics: emptyMetrics(), mining: emptyMining(), outcomes: o }),
			"steering-outcome-delta",
		);
		expect(i.severity).toBe("info");
		expect(i.value).toBeCloseTo(0.5, 5);
		expect(i.denominator).toBe(15);
		expect(i.confidence).toBe("low");
		expect(i.detail).toContain("5 of 6");
		expect(i.detail).toContain("3 of 9");
	});

	test("flags a negative steering delta as a warning", () => {
		const o = outcomes({
			steering: {
				steered: tally({ runs: 4, prStateKnown: 4, prsMerged: 1, mergedPrRate: 0.25 }),
				unsteered: tally({ runs: 8, prStateKnown: 8, prsMerged: 6, mergedPrRate: 0.75 }),
				mergedPrRateDelta: -0.5,
				confidence: "medium",
			},
		});
		const i = find(
			buildInsights({ metrics: emptyMetrics(), mining: emptyMining(), outcomes: o }),
			"steering-outcome-delta",
		);
		expect(i.severity).toBe("warning");
	});

	test("skips the delta when either cohort lacks the minimum resolved sample", () => {
		const o = outcomes({
			steering: {
				steered: tally({ runs: 2, prStateKnown: 2, prsMerged: 2, mergedPrRate: 1 }),
				unsteered: tally({ runs: 10, prStateKnown: 9, prsMerged: 3, mergedPrRate: 1 / 3 }),
				mergedPrRateDelta: 2 / 3,
				confidence: "low",
			},
		});
		expect(
			kinds(buildInsights({ metrics: emptyMetrics(), mining: emptyMining(), outcomes: o })),
		).not.toContain("steering-outcome-delta");
	});

	test("skips the delta when a cohort has no resolved PRs at all (null rate)", () => {
		const o = outcomes({
			steering: {
				steered: tally({ runs: 5, prStateKnown: 0, prsMerged: 0, mergedPrRate: null }),
				unsteered: tally({ runs: 9, prStateKnown: 9, prsMerged: 9, mergedPrRate: 1 }),
				mergedPrRateDelta: null,
				confidence: "low",
			},
		});
		expect(
			kinds(buildInsights({ metrics: emptyMetrics(), mining: emptyMining(), outcomes: o })),
		).not.toContain("steering-outcome-delta");
	});

	test("reports cost per merged PR with the priciest bucket as subject", () => {
		const o = outcomes({
			costPerMergedPr: {
				overall: {
					costUsd: 30,
					priced: 8,
					prStateKnown: 7,
					prsMerged: 3,
					costPerMergedPrUsd: 10,
				},
				byAgent: [
					{
						key: "opus-agent",
						costUsd: 22,
						priced: 3,
						prStateKnown: 2,
						prsMerged: 1,
						costPerMergedPrUsd: 22,
					},
				],
				byModel: [],
				byProvider: [],
				confidence: "low",
			},
		});
		const i = find(
			buildInsights({ metrics: emptyMetrics(), mining: emptyMining(), outcomes: o }),
			"cost-per-merged-pr",
		);
		expect(i.severity).toBe("info");
		expect(i.value).toBe(10);
		expect(i.subject).toBe("opus-agent");
		expect(i.denominator).toBe(3);
		expect(i.confidence).toBe("low");
		expect(i.detail).toContain("$30.00");
		expect(i.detail).toContain("3 merged PR(s) of 7 resolved");
	});

	test("skips cost-per-merged-pr when nothing merged or nothing priced", () => {
		const noMerges = outcomes({});
		expect(
			kinds(buildInsights({ metrics: emptyMetrics(), mining: emptyMining(), outcomes: noMerges })),
		).not.toContain("cost-per-merged-pr");
		const unpriced = outcomes({
			costPerMergedPr: {
				overall: {
					costUsd: 0,
					priced: 0,
					prStateKnown: 2,
					prsMerged: 2,
					costPerMergedPrUsd: 0,
				},
				byAgent: [],
				byModel: [],
				byProvider: [],
				confidence: "low",
			},
		});
		expect(
			kinds(buildInsights({ metrics: emptyMetrics(), mining: emptyMining(), outcomes: unpriced })),
		).not.toContain("cost-per-merged-pr");
	});
});
