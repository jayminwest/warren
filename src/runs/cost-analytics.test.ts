import { describe, expect, it } from "bun:test";
import { buildCostAnalytics, type CostAnalyticsRow, NONE_KEY } from "./cost-analytics.ts";

function row(o: Partial<CostAnalyticsRow> & { runId: string }): CostAnalyticsRow {
	return {
		runId: o.runId,
		projectId: o.projectId ?? null,
		agentName: o.agentName ?? "claude-code",
		plotId: o.plotId ?? null,
		planId: o.planId ?? null,
		planRunId: o.planRunId ?? null,
		provider: o.provider ?? null,
		model: o.model ?? null,
		costUsd: o.costUsd ?? null,
		startedAt: o.startedAt ?? null,
	};
}

describe("buildCostAnalytics", () => {
	it("returns zeroed totals + empty buckets for no rows", () => {
		const a = buildCostAnalytics([]);
		expect(a.totals).toEqual({ runs: 0, priced: 0, costUsd: 0 });
		expect(a.breakdowns.date).toEqual([]);
		expect(a.breakdowns.project).toEqual([]);
		expect(a.breakdowns.provider).toEqual([]);
	});

	it("sums totals and counts priced rows", () => {
		const a = buildCostAnalytics([
			row({ runId: "r1", costUsd: 0.5 }),
			row({ runId: "r2", costUsd: 1.5 }),
			row({ runId: "r3", costUsd: null }),
		]);
		expect(a.totals.runs).toBe(3);
		expect(a.totals.priced).toBe(2);
		expect(a.totals.costUsd).toBeCloseTo(2.0);
	});

	it("groups by date using the YYYY-MM-DD prefix of startedAt", () => {
		const a = buildCostAnalytics([
			row({ runId: "a", startedAt: "2026-01-01T10:00:00Z", costUsd: 1 }),
			row({ runId: "b", startedAt: "2026-01-01T20:00:00Z", costUsd: 2 }),
			row({ runId: "c", startedAt: "2026-01-03T00:00:00Z", costUsd: 4 }),
			row({ runId: "d", startedAt: null, costUsd: 0.1 }),
		]);
		expect(a.breakdowns.date.map((b) => b.key)).toEqual(["2026-01-01", "2026-01-03", NONE_KEY]);
		expect(a.breakdowns.date[0]?.costUsd).toBeCloseTo(3);
		expect(a.breakdowns.date[0]?.runs).toBe(2);
	});

	it("sorts non-date breakdowns by cost desc with key tiebreaker", () => {
		const a = buildCostAnalytics([
			row({ runId: "x", projectId: "alpha", costUsd: 1 }),
			row({ runId: "y", projectId: "beta", costUsd: 3 }),
			row({ runId: "z", projectId: "alpha", costUsd: 1 }),
		]);
		expect(a.breakdowns.project.map((b) => b.key)).toEqual(["beta", "alpha"]);
		expect(a.breakdowns.project[0]?.costUsd).toBeCloseTo(3);
		expect(a.breakdowns.project[0]?.runs).toBe(1);
		expect(a.breakdowns.project[1]?.costUsd).toBeCloseTo(2);
		expect(a.breakdowns.project[1]?.runs).toBe(2);
	});

	it("folds null keys into the NONE_KEY bucket per dimension", () => {
		const a = buildCostAnalytics([
			row({ runId: "a", plotId: "plot-1", costUsd: 1 }),
			row({ runId: "b", plotId: null, costUsd: 2 }),
			row({ runId: "c", plotId: null, costUsd: 4 }),
		]);
		const noneBucket = a.breakdowns.plot.find((b) => b.key === NONE_KEY);
		expect(noneBucket).toBeDefined();
		expect(noneBucket?.costUsd).toBeCloseTo(6);
		expect(noneBucket?.runs).toBe(2);
	});

	it("exposes all eight dimensions", () => {
		const a = buildCostAnalytics([
			row({
				runId: "r",
				projectId: "p",
				planId: "pl",
				plotId: "plot",
				agentName: "claude-code",
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				startedAt: "2026-01-01T00:00:00Z",
				costUsd: 1,
			}),
		]);
		expect(a.breakdowns.date[0]?.key).toBe("2026-01-01");
		expect(a.breakdowns.project[0]?.key).toBe("p");
		expect(a.breakdowns.plan[0]?.key).toBe("pl");
		expect(a.breakdowns.plot[0]?.key).toBe("plot");
		expect(a.breakdowns.run[0]?.key).toBe("r");
		expect(a.breakdowns.agent[0]?.key).toBe("claude-code");
		expect(a.breakdowns.model[0]?.key).toBe("claude-sonnet-4-6");
		expect(a.breakdowns.provider[0]?.key).toBe("anthropic");
	});
});
