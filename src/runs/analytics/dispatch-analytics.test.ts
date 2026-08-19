import { describe, expect, test } from "bun:test";
import type { DispatchAnalyticsRow } from "./dispatch-analytics.ts";
import { buildDispatchAnalytics, NONE_KEY } from "./dispatch-analytics.ts";

function row(partial: Partial<DispatchAnalyticsRow> & { runId: string }): DispatchAnalyticsRow {
	return {
		createdAt: "2026-05-20T10:00:00.000Z",
		agentName: "claude-code",
		provider: "anthropic",
		model: "sonnet",
		dispatchOrigin: "api",
		retryKind: "none",
		queueQueuedRuns: 0,
		queueRunningRuns: 1,
		queueProjectNonTerminal: 1,
		projectId: "proj-1",
		state: "succeeded",
		failureReason: null,
		costUsd: 0.5,
		prState: null,
		...partial,
	};
}

describe("buildDispatchAnalytics", () => {
	test("empty input yields zero totals and empty buckets", () => {
		const a = buildDispatchAnalytics([]);
		expect(a.totals.dispatches).toBe(0);
		expect(a.byDispatchOrigin).toEqual([]);
		expect(a.byRetryKind).toEqual([]);
		expect(a.byProviderModel).toEqual([]);
		expect(a.byQueueDepth).toEqual([]);
		expect(a.rows).toEqual([]);
	});

	test("groups counts by origin, retry kind, provider/model, queue depth", () => {
		const rows = [
			row({
				runId: "r1",
				dispatchOrigin: "api",
				retryKind: "none",
				queueQueuedRuns: 0,
				queueRunningRuns: 1,
			}),
			row({
				runId: "r2",
				dispatchOrigin: "api",
				retryKind: "infra_lost",
				queueQueuedRuns: 2,
				queueRunningRuns: 1,
				provider: "anthropic",
				model: "opus",
				state: "failed",
				failureReason: "sandbox_run_lost",
			}),
			row({
				runId: "r3",
				dispatchOrigin: "cron",
				retryKind: "none",
				queueQueuedRuns: 0,
				queueRunningRuns: 1,
				provider: null,
				model: null,
			}),
			row({
				runId: "r4",
				dispatchOrigin: null,
				retryKind: null,
				queueQueuedRuns: null,
				queueRunningRuns: null,
			}),
		];
		const a = buildDispatchAnalytics(rows);
		expect(a.totals.dispatches).toBe(4);
		// Equal counts break ties by key ascending ("__none__" < "cron").
		expect(a.byDispatchOrigin).toEqual([
			{ key: "api", count: 2 },
			{ key: NONE_KEY, count: 1 },
			{ key: "cron", count: 1 },
		]);
		expect(a.byRetryKind).toEqual([
			{ key: "none", count: 2 },
			{ key: NONE_KEY, count: 1 },
			{ key: "infra_lost", count: 1 },
		]);
		// provider/model: two anthropic/sonnet (r1,r4), one anthropic/opus, one none
		expect(a.byProviderModel).toEqual([
			{ key: "anthropic/sonnet", count: 2 },
			{ key: NONE_KEY, count: 1 },
			{ key: "anthropic/opus", count: 1 },
		]);
		// queue depth 0+1 = "1" for r1+r3; "3" for r2; none for r4
		expect(a.byQueueDepth).toEqual([
			{ key: "1", count: 2 },
			{ key: "3", count: 1 },
			{ key: NONE_KEY, count: 1 },
		]);
		expect(a.rows).toEqual(rows);
	});

	test("sorts buckets by count desc then key asc", () => {
		const rows = [
			row({ runId: "a", dispatchOrigin: "cli" }),
			row({ runId: "b", dispatchOrigin: "api" }),
			row({ runId: "c", dispatchOrigin: "api" }),
			row({ runId: "d", dispatchOrigin: "cron" }),
			row({ runId: "e", dispatchOrigin: "cli" }),
			row({ runId: "f", dispatchOrigin: "api" }),
		];
		const a = buildDispatchAnalytics(rows);
		expect(a.byDispatchOrigin.map((b) => b.key)).toEqual(["api", "cli", "cron"]);
		expect(a.byDispatchOrigin.map((b) => b.count)).toEqual([3, 2, 1]);
	});
});
