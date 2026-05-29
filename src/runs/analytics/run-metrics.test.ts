import { describe, expect, it } from "bun:test";
import {
	buildRunMetrics,
	contextTokensOf,
	durationMsOf,
	NONE_KEY,
	type RunMetricsRow,
} from "./run-metrics.ts";

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
		startedAt: o.startedAt ?? null,
		endedAt: o.endedAt ?? null,
	};
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

describe("buildRunMetrics", () => {
	it("returns zeroed totals and empty breakdowns for no rows", () => {
		const m = buildRunMetrics([]);
		expect(m.totals.runs).toBe(0);
		expect(m.totals.successRate).toBeNull();
		expect(m.totals.durationMs).toEqual({ avg: null, median: null, p95: null, count: 0 });
		expect(m.totals.contextTokens.count).toBe(0);
		expect(m.totals.cost).toEqual({ total: 0, avg: null, priced: 0 });
		expect(m.timeSeries).toEqual([]);
		expect(m.byAgent).toEqual([]);
		expect(m.byModel).toEqual([]);
		expect(m.byProvider).toEqual([]);
		expect(m.byFailureReason).toEqual([]);
		expect(m.topSeedsByContext).toEqual([]);
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
});
