import { describe, expect, it } from "bun:test";
import { buildRunMetrics, type RunMetricsRow } from "./run-metrics.ts";

// Cost-economics tests (warren-ea4e), split from run-metrics.test.ts to
// keep each file under the 500-line budget.

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

describe("buildRunMetrics cost economics", () => {
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

	it("summarizes the per-run cost distribution over priced rows only (warren-ea4e)", () => {
		const m = buildRunMetrics([
			row({ runId: "a", costUsd: 1 }),
			row({ runId: "b", costUsd: 2 }),
			row({ runId: "c", costUsd: 4 }),
			row({ runId: "d", costUsd: 8 }),
			row({ runId: "e" }), // unpriced — excluded from the sample
		]);
		// nearest-rank percentiles, same convention as durationMs
		expect(m.totals.costUsd).toEqual({ avg: 3.75, median: 2, p95: 8, count: 4 });
	});
});
