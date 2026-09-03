import { describe, expect, it } from "bun:test";
import {
	buildRunMetrics,
	contextTokensOf,
	durationMsOf,
	NONE_KEY,
	queueWaitMsOf,
	type RunMetricsRow,
	type TokenBreakdown,
} from "./run-metrics.ts";

// Token-series unit tests live in run-metrics-token-series.test.ts
// (split to keep each file under the 500-line budget).

/** All-null baseline row; `row()` spreads the caller's overrides over it. */
const ROW_DEFAULTS: Omit<RunMetricsRow, "runId"> = {
	projectId: null,
	agentName: "claude-code",
	provider: null,
	model: null,
	seedId: null,
	state: "succeeded",
	failureReason: null,
	costUsd: null,
	tokensInput: null,
	tokensCacheRead: null,
	tokensOutput: null,
	tokensCacheWrite: null,
	startedAt: null,
	endedAt: null,
	createdAt: null,
	prState: null,
	parentRunId: null,
	retryOf: null,
	prMergedAt: null,
	branchPushedAt: null,
	prOpenedAt: null,
};

function row(o: Partial<RunMetricsRow> & { runId: string }): RunMetricsRow {
	return { ...ROW_DEFAULTS, ...o };
}

describe("contextTokensOf", () => {
	it("returns null when both input and cache-read are null", () => {
		expect(contextTokensOf(row({ runId: "r" }))).toBeNull();
	});

	it("sums input and cache-read, treating a missing half as zero", () => {
		expect(contextTokensOf(row({ runId: "r", tokensInput: 100 }))).toBe(100);
		expect(contextTokensOf(row({ runId: "r", tokensCacheRead: 40 }))).toBe(40);
		expect(contextTokensOf(row({ runId: "r", tokensInput: 100, tokensCacheRead: 40 }))).toBe(140);
	});
});

describe("durationMsOf", () => {
	it("returns null unless both timestamps are present and valid", () => {
		expect(durationMsOf(row({ runId: "r", startedAt: "2026-01-01T00:00:00Z" }))).toBeNull();
		expect(durationMsOf(row({ runId: "r", endedAt: "2026-01-01T00:00:00Z" }))).toBeNull();
		expect(
			durationMsOf(row({ runId: "r", startedAt: "nonsense", endedAt: "2026-01-01T00:00:00Z" })),
		).toBeNull();
	});

	it("computes positive deltas and rejects negative ones", () => {
		expect(
			durationMsOf(
				row({ runId: "r", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:05Z" }),
			),
		).toBe(5000);
		expect(
			durationMsOf(
				row({ runId: "r", startedAt: "2026-01-01T00:00:05Z", endedAt: "2026-01-01T00:00:00Z" }),
			),
		).toBeNull();
	});
});

describe("queueWaitMsOf", () => {
	it("returns null unless both the queued instant and startedAt are known", () => {
		// Pre-migration row: createdAt is null — the wait is unknown, not zero.
		expect(queueWaitMsOf(row({ runId: "r", startedAt: "2026-01-01T00:00:00Z" }))).toBeNull();
		// Still queued: no startedAt yet.
		expect(queueWaitMsOf(row({ runId: "r", createdAt: 1_767_225_600_000 }))).toBeNull();
		expect(queueWaitMsOf(row({ runId: "r", createdAt: 100, startedAt: "nonsense" }))).toBeNull();
	});

	it("computes startedAt minus createdAt and rejects negative waits", () => {
		const createdAt = Date.parse("2026-01-01T00:00:00Z");
		expect(queueWaitMsOf(row({ runId: "r", createdAt, startedAt: "2026-01-01T00:00:05Z" }))).toBe(
			5000,
		);
		expect(
			queueWaitMsOf(
				row({ runId: "r", createdAt: createdAt + 5000, startedAt: "2026-01-01T00:00:00Z" }),
			),
		).toBeNull();
	});
});

describe("buildRunMetrics", () => {
	it("returns zeroed totals and empty breakdowns for no rows", () => {
		const m = buildRunMetrics([]);
		expect(m.totals.runs).toBe(0);
		expect(m.totals.successRate).toBeNull();
		expect(m.totals.durationMs).toEqual({ avg: null, median: null, p95: null, count: 0 });
		expect(m.totals.queueWaitMs).toEqual({ avg: null, median: null, p95: null, count: 0 });
		expect(m.totals.contextTokens.count).toBe(0);
		expect(m.totals.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(m.totals.cost).toEqual({ total: 0, avg: null, priced: 0 });
		expect(m.timeSeries).toEqual([]);
		expect(m.byAgent).toEqual([]);
		expect(m.byModel).toEqual([]);
		expect(m.byProvider).toEqual([]);
		expect(m.byFailureReason).toEqual([]);
		expect(m.topSeedsByContext).toEqual([]);
		// token series fields exist and are empty for zero rows
		expect(m.tokenTimeSeries).toEqual([]);
		expect(m.tokenByModelSeries).toEqual([]);
		expect(m.tokenByProviderSeries).toEqual([]);
	});

	it("counts states and computes success rate over terminal runs only", () => {
		const m = buildRunMetrics([
			row({ runId: "a", state: "succeeded" }),
			row({ runId: "b", state: "succeeded" }),
			row({ runId: "c", state: "failed" }),
			row({ runId: "d", state: "cancelled" }),
			row({ runId: "e", state: "running" }),
			row({ runId: "f", state: "queued" }),
		]);
		expect(m.totals.runs).toBe(6);
		expect(m.totals.succeeded).toBe(2);
		expect(m.totals.failed).toBe(1);
		expect(m.totals.cancelled).toBe(1);
		expect(m.totals.active).toBe(2);
		// 2 succeeded / 4 terminal
		expect(m.totals.successRate).toBeCloseTo(0.5);
	});

	it("excludes null token/cost rows from averages rather than counting them as zero", () => {
		const m = buildRunMetrics([
			row({ runId: "a", tokensInput: 1000, costUsd: 2 }),
			row({ runId: "b", tokensInput: 3000, costUsd: 4 }),
			row({ runId: "c" }), // null tokens + null cost — should not drag averages down
		]);
		// context avg over the two priced rows = 2000, not 4000/3
		expect(m.totals.contextTokens.avg).toBeCloseTo(2000);
		expect(m.totals.contextTokens.count).toBe(2);
		expect(m.totals.cost.total).toBeCloseTo(6);
		expect(m.totals.cost.avg).toBeCloseTo(3);
		expect(m.totals.cost.priced).toBe(2);
	});

	it("excludes pre-migration rows from queue-wait denominators rather than counting zero", () => {
		const createdAt = Date.parse("2026-01-01T00:00:00Z");
		const m = buildRunMetrics([
			row({ runId: "a", createdAt, startedAt: "2026-01-01T00:00:10Z" }), // 10s wait
			row({ runId: "b", createdAt, startedAt: "2026-01-01T00:00:20Z" }), // 20s wait
			row({ runId: "c", startedAt: "2026-01-01T00:00:30Z" }), // pre-migration: unknown
			row({ runId: "d", createdAt }), // never started: unknown
		]);
		// avg over the two known waits = 15s, not 30s/4.
		expect(m.totals.queueWaitMs.avg).toBeCloseTo(15_000);
		// nearest-rank percentile over [10s, 20s]: p50 -> 10s, p95 -> 20s.
		expect(m.totals.queueWaitMs.median).toBeCloseTo(10_000);
		expect(m.totals.queueWaitMs.p95).toBeCloseTo(20_000);
		expect(m.totals.queueWaitMs.count).toBe(2);
	});

	it("computes duration median and p95 over the non-null sample", () => {
		const base = "2026-01-01T00:00:00Z";
		const at = (sec: number) => new Date(Date.parse(base) + sec * 1000).toISOString();
		const m = buildRunMetrics([
			row({ runId: "a", startedAt: base, endedAt: at(1) }),
			row({ runId: "b", startedAt: base, endedAt: at(2) }),
			row({ runId: "c", startedAt: base, endedAt: at(3) }),
			row({ runId: "d", startedAt: base, endedAt: at(4) }),
			row({ runId: "e" }), // no timestamps — excluded
		]);
		expect(m.totals.durationMs.count).toBe(4);
		expect(m.totals.durationMs.avg).toBeCloseTo(2500);
		// nearest-rank median over [1000,2000,3000,4000] → rank ceil(0.5*4)=2 → 2000
		expect(m.totals.durationMs.median).toBe(2000);
		expect(m.totals.durationMs.p95).toBe(4000);
	});

	it("builds a chronological time series with NONE_KEY last and per-state counts", () => {
		const m = buildRunMetrics([
			row({ runId: "a", startedAt: "2026-01-02T10:00:00Z", state: "succeeded", tokensInput: 100 }),
			row({ runId: "b", startedAt: "2026-01-01T20:00:00Z", state: "failed" }),
			row({
				runId: "c",
				startedAt: "2026-01-01T08:00:00Z",
				state: "succeeded",
				tokensCacheRead: 50,
			}),
			row({ runId: "d", startedAt: null, state: "running" }),
		]);
		expect(m.timeSeries.map((b) => b.key)).toEqual(["2026-01-01", "2026-01-02", NONE_KEY]);
		const day1 = m.timeSeries[0];
		expect(day1?.runs).toBe(2);
		expect(day1?.succeeded).toBe(1);
		expect(day1?.failed).toBe(1);
		expect(day1?.contextTokensTotal).toBe(50);
		expect(m.timeSeries[2]?.active).toBe(1);
	});

	it("groups by agent ranked by total context tokens with null keys folded to NONE_KEY", () => {
		const m = buildRunMetrics([
			row({ runId: "a", agentName: "alpha", tokensInput: 500, state: "succeeded", costUsd: 1 }),
			row({ runId: "b", agentName: "beta", tokensInput: 2000, state: "failed" }),
			row({ runId: "c", agentName: "alpha", tokensInput: 100, state: "succeeded" }),
		]);
		expect(m.byAgent.map((g) => g.key)).toEqual(["beta", "alpha"]);
		const alpha = m.byAgent.find((g) => g.key === "alpha");
		expect(alpha?.runs).toBe(2);
		expect(alpha?.contextTokensTotal).toBe(600);
		expect(alpha?.avgContextTokens).toBe(300);
		expect(alpha?.successRate).toBeCloseTo(1);
		expect(alpha?.priced).toBe(1);
		const beta = m.byAgent.find((g) => g.key === "beta");
		expect(beta?.successRate).toBeCloseTo(0);
	});

	it("populates cancelled on RunGroupBucket and includes it in the terminal denominator", () => {
		const m = buildRunMetrics([
			row({ runId: "a", agentName: "agent-x", state: "cancelled" }),
			row({ runId: "b", agentName: "agent-x", state: "cancelled" }),
			row({ runId: "c", agentName: "agent-x", state: "failed" }),
		]);
		const g = m.byAgent.find((g) => g.key === "agent-x");
		expect(g?.cancelled).toBe(2);
		expect(g?.failed).toBe(1);
		expect(g?.succeeded).toBe(0);
		// terminal = 3; successRate = 0/3 = 0
		expect(g?.successRate).toBe(0);
	});

	it("folds null model/provider into NONE_KEY", () => {
		const m = buildRunMetrics([
			row({ runId: "a", model: "sonnet", provider: "anthropic", tokensInput: 10 }),
			row({ runId: "b", tokensInput: 5 }),
		]);
		expect(m.byModel.map((g) => g.key)).toEqual(["sonnet", NONE_KEY]);
		expect(m.byProvider.map((g) => g.key)).toEqual(["anthropic", NONE_KEY]);
	});

	it("counts failure reasons over failed runs only, null reason as NONE_KEY", () => {
		const m = buildRunMetrics([
			row({ runId: "a", state: "failed", failureReason: "crashed" }),
			row({ runId: "b", state: "failed", failureReason: "crashed" }),
			row({ runId: "c", state: "failed", failureReason: "never_started" }),
			row({ runId: "d", state: "failed", failureReason: null }),
			row({ runId: "e", state: "succeeded", failureReason: null }),
		]);
		expect(m.byFailureReason).toEqual([
			{ key: "crashed", runs: 2 },
			{ key: NONE_KEY, runs: 1 },
			{ key: "never_started", runs: 1 },
		]);
	});

	it("null token columns treated as 0 in token breakdown", () => {
		// Row with all nulls → each kind counts as 0
		const m = buildRunMetrics([row({ runId: "a" })]);
		expect(m.totals.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(m.byAgent[0]?.tokens).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		});
	});

	it("sums all four token kinds across multiple runs", () => {
		const m = buildRunMetrics([
			row({
				runId: "a",
				tokensInput: 100,
				tokensOutput: 50,
				tokensCacheRead: 20,
				tokensCacheWrite: 10,
			}),
			row({
				runId: "b",
				tokensInput: 200,
				tokensOutput: null,
				tokensCacheRead: null,
				tokensCacheWrite: 5,
			}),
		]);
		const tb = m.totals.tokens;
		expect(tb.input).toBe(300);
		expect(tb.output).toBe(50);
		expect(tb.cacheRead).toBe(20);
		expect(tb.cacheWrite).toBe(15);
		expect(tb.total).toBe(385);
	});

	it("totals.tokens equals sum of byAgent bucket tokens", () => {
		const m = buildRunMetrics([
			row({
				runId: "a",
				agentName: "alpha",
				tokensInput: 100,
				tokensOutput: 40,
				tokensCacheRead: 10,
				tokensCacheWrite: 5,
			}),
			row({
				runId: "b",
				agentName: "beta",
				tokensInput: 200,
				tokensOutput: 80,
				tokensCacheRead: 30,
				tokensCacheWrite: 15,
			}),
			row({ runId: "c", agentName: "alpha", tokensInput: 50, tokensOutput: 20 }),
		]);
		const sumInput = m.byAgent.reduce((s, g) => s + g.tokens.input, 0);
		const sumTotal = m.byAgent.reduce((s, g) => s + g.tokens.total, 0);
		expect(sumInput).toBe(m.totals.tokens.input);
		expect(sumTotal).toBe(m.totals.tokens.total);
	});

	it("unknown model/provider buckets reconcile with totals for token breakdown", () => {
		const m = buildRunMetrics([
			row({
				runId: "a",
				model: "sonnet",
				provider: "anthropic",
				tokensInput: 300,
				tokensOutput: 100,
				tokensCacheWrite: 20,
			}),
			// null model/provider → NONE_KEY bucket
			row({ runId: "b", tokensInput: 50, tokensOutput: 25 }),
		]);
		const modelSum = m.byModel.reduce((s, g) => s + g.tokens.input, 0);
		const providerSum = m.byProvider.reduce((s, g) => s + g.tokens.total, 0);
		expect(modelSum).toBe(m.totals.tokens.input);
		expect(providerSum).toBe(m.totals.tokens.total);
		// NONE_KEY bucket must exist
		const noneModel = m.byModel.find((g) => g.key === NONE_KEY);
		expect(noneModel?.tokens.input).toBe(50);
	});

	it("token total field equals sum of the four kinds", () => {
		const check = (tb: TokenBreakdown) => {
			expect(tb.total).toBe(tb.input + tb.output + tb.cacheRead + tb.cacheWrite);
		};
		const m = buildRunMetrics([
			row({
				runId: "a",
				tokensInput: 111,
				tokensOutput: 222,
				tokensCacheRead: 333,
				tokensCacheWrite: 444,
			}),
			row({ runId: "b", tokensInput: 10, model: "gpt-4", provider: "openai" }),
		]);
		check(m.totals.tokens);
		for (const g of m.byAgent) check(g.tokens);
		for (const g of m.byModel) check(g.tokens);
		for (const g of m.byProvider) check(g.tokens);
	});

	it("ranks top seeds by total context, excluding null-seed runs", () => {
		const m = buildRunMetrics([
			row({ runId: "a", seedId: "warren-1", tokensInput: 300 }),
			row({ runId: "b", seedId: "warren-1", tokensInput: 100 }),
			row({ runId: "c", seedId: "warren-2", tokensInput: 1000 }),
			row({ runId: "d", seedId: null, tokensInput: 9999 }), // ad-hoc run excluded
			row({ runId: "e", seedId: "warren-3" }), // no token data
		]);
		expect(m.topSeedsByContext.map((s) => s.seedId)).toEqual(["warren-2", "warren-1", "warren-3"]);
		const w1 = m.topSeedsByContext.find((s) => s.seedId === "warren-1");
		expect(w1?.contextTokensTotal).toBe(400);
		expect(w1?.avgContextTokens).toBe(200);
		const w3 = m.topSeedsByContext.find((s) => s.seedId === "warren-3");
		expect(w3?.avgContextTokens).toBeNull();
	});

	it("exposes tokenTimeSeries / tokenByModelSeries / tokenByProviderSeries on RunMetrics", () => {
		const m = buildRunMetrics([
			row({
				runId: "a",
				startedAt: "2026-01-01T10:00:00Z",
				model: "sonnet",
				provider: "anthropic",
				tokensInput: 100,
				tokensOutput: 50,
			}),
			row({
				runId: "b",
				startedAt: "2026-01-01T20:00:00Z",
				model: "sonnet",
				provider: "anthropic",
				tokensInput: 200,
			}),
		]);
		expect(m.tokenTimeSeries.length).toBe(1);
		expect(m.tokenTimeSeries[0]?.date).toBe("2026-01-01");
		expect(m.tokenTimeSeries[0]?.input).toBe(300);
		expect(m.tokenTimeSeries[0]?.output).toBe(50);
		expect(m.tokenByModelSeries.length).toBe(1);
		expect(m.tokenByModelSeries[0]?.key).toBe("sonnet");
		expect(m.tokenByProviderSeries.length).toBe(1);
		expect(m.tokenByProviderSeries[0]?.key).toBe("anthropic");
	});

	it("rolls merged-PR counts and rates into totals and every bucket (warren-bd57)", () => {
		const m = buildRunMetrics([
			row({
				runId: "a",
				agentName: "sapling",
				model: "opus",
				provider: "anthropic",
				prState: "merged",
			}),
			row({
				runId: "b",
				agentName: "sapling",
				model: "opus",
				provider: "anthropic",
				prState: "open",
			}),
			row({
				runId: "c",
				agentName: "claude-code",
				model: "sonnet",
				provider: "anthropic",
				prState: "closed_unmerged",
			}),
			// NULL pr_state: unknown — excluded from every denominator, never a failure.
			row({ runId: "d", agentName: "sapling", model: "opus", provider: "anthropic" }),
		]);
		expect(m.totals.prStateKnown).toBe(3);
		expect(m.totals.prsMerged).toBe(1);
		expect(m.totals.mergedPrRate).toBeCloseTo(1 / 3);
		const sapling = m.byAgent.find((b) => b.key === "sapling");
		expect(sapling?.prStateKnown).toBe(2);
		expect(sapling?.prsMerged).toBe(1);
		expect(sapling?.mergedPrRate).toBeCloseTo(1 / 2);
		const opus = m.byModel.find((b) => b.key === "opus");
		expect(opus?.mergedPrRate).toBeCloseTo(1 / 2);
		const anthropic = m.byProvider.find((b) => b.key === "anthropic");
		expect(anthropic?.prStateKnown).toBe(3);
		expect(anthropic?.mergedPrRate).toBeCloseTo(1 / 3);
	});

	it("reports a null merged-PR rate when no row carries a resolved PR state", () => {
		const m = buildRunMetrics([row({ runId: "a" }), row({ runId: "b" })]);
		expect(m.totals.prStateKnown).toBe(0);
		expect(m.totals.prsMerged).toBe(0);
		expect(m.totals.mergedPrRate).toBeNull();
		for (const bucket of [...m.byAgent, ...m.byModel, ...m.byProvider]) {
			expect(bucket.prStateKnown).toBe(0);
			expect(bucket.mergedPrRate).toBeNull();
		}
	});
});

describe("buildRunMetrics delivery block (warren-bc9c)", () => {
	it("summarizes the four delivery gaps over rows with known endpoints", () => {
		const m = buildRunMetrics([
			row({
				runId: "a",
				startedAt: "2026-05-01T00:00:10.000Z",
				endedAt: "2026-05-01T00:20:00.000Z",
				createdAt: 1_775_000_000_000, // well before the delivery timestamps
				branchPushedAt: "2026-05-01T00:20:10.000Z",
				prOpenedAt: "2026-05-01T00:21:10.000Z",
				prMergedAt: "2026-05-01T00:31:10.000Z",
				prState: "merged",
			}),
			row({ runId: "b" }),
		]);
		expect(m.delivery.branchPushToPrOpenMs.median).toBe(60_000);
		expect(m.delivery.prOpenToMergeMs.median).toBe(600_000);
		expect(m.delivery.endToMergeMs.median).toBe(670_000);
		expect(m.delivery.dispatchToMergeMs.count).toBe(1);
	});

	it("excludes unknown endpoints from each sample instead of counting zero", () => {
		const m = buildRunMetrics([
			row({ runId: "a", prMergedAt: "2026-05-01T00:31:10.000Z", prState: "merged" }),
			row({ runId: "b", branchPushedAt: "2026-05-01T00:20:10.000Z" }),
		]);
		expect(m.delivery.prOpenToMergeMs.count).toBe(0);
		expect(m.delivery.prOpenToMergeMs.median).toBeNull();
		expect(m.delivery.branchPushToPrOpenMs.count).toBe(0);
		expect(m.delivery.dispatchToMergeMs.count).toBe(0);
		expect(m.delivery.endToMergeMs.count).toBe(0);
	});
});
