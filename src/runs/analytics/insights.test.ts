import { describe, expect, test } from "bun:test";
import type { CommandMining, CommandStat } from "./command-mining.ts";
import { buildInsights, type Insight, type InsightKind, type SteeringSignals } from "./insights.ts";
import type { RunGroupBucket, RunMetrics, SeedContextBucket } from "./run-metrics.ts";

function emptyMetrics(): RunMetrics {
	return {
		totals: {
			runs: 0,
			succeeded: 0,
			failed: 0,
			cancelled: 0,
			active: 0,
			successRate: null,
			durationMs: { avg: null, median: null, p95: null, count: 0 },
			contextTokens: { avg: null, median: null, p95: null, count: 0 },
			cost: { total: 0, avg: null, priced: 0 },
		},
		timeSeries: [],
		byAgent: [],
		byModel: [],
		byProvider: [],
		byFailureReason: [],
		topSeedsByContext: [],
	};
}

function emptyMining(): CommandMining {
	return {
		totals: { toolUses: 0, commands: 0, distinctCommands: 0, failures: 0, retries: 0 },
		byFrequency: [],
		byFailures: [],
		byStuckScore: [],
		osEcoCommands: [],
		byCategory: [],
	};
}

function seed(seedId: string, contextTokensTotal: number, runs = 1): SeedContextBucket {
	return {
		seedId,
		runs,
		contextTokensTotal,
		avgContextTokens: runs === 0 ? null : contextTokensTotal / runs,
	};
}

function agent(key: string, succeeded: number, failed: number, cancelled = 0): RunGroupBucket {
	const terminal = succeeded + failed + cancelled;
	return {
		key,
		runs: terminal,
		succeeded,
		failed,
		successRate: terminal === 0 ? null : succeeded / terminal,
		contextTokensTotal: 0,
		avgContextTokens: null,
		costUsd: 0,
		priced: 0,
		avgDurationMs: null,
	};
}

function model(key: string, costUsd: number, priced: number): RunGroupBucket {
	return {
		key,
		runs: priced,
		succeeded: priced,
		failed: 0,
		successRate: priced === 0 ? null : 1,
		contextTokensTotal: 0,
		avgContextTokens: null,
		costUsd,
		priced,
		avgDurationMs: null,
	};
}

function cmd(overrides: Partial<CommandStat> & { command: string }): CommandStat {
	return {
		category: "other",
		osEco: false,
		runs: 1,
		invocations: 1,
		failures: 0,
		failureRate: 0,
		retries: 0,
		stuckScore: 0,
		...overrides,
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

describe("buildInsights", () => {
	test("returns empty list for a clean, low-signal window", () => {
		const insights = buildInsights({ metrics: emptyMetrics(), mining: emptyMining() });
		expect(insights).toEqual([]);
	});

	test("flags the highest-context seed as info when not dominant", () => {
		const metrics = {
			...emptyMetrics(),
			topSeedsByContext: [seed("warren-1", 1200), seed("warren-2", 1000)],
		};
		const insights = buildInsights({ metrics, mining: emptyMining() });
		const i = find(insights, "highest-context-seed");
		expect(i.severity).toBe("info");
		expect(i.subject).toBe("warren-1");
		expect(i.value).toBe(1200);
	});

	test("escalates highest-context seed to warning when it dominates 2x", () => {
		const metrics = {
			...emptyMetrics(),
			topSeedsByContext: [seed("warren-1", 5000), seed("warren-2", 1000)],
		};
		const i = find(buildInsights({ metrics, mining: emptyMining() }), "highest-context-seed");
		expect(i.severity).toBe("warning");
	});

	test("skips highest-context seed when no tokens recorded", () => {
		const metrics = { ...emptyMetrics(), topSeedsByContext: [seed("warren-1", 0)] };
		expect(kinds(buildInsights({ metrics, mining: emptyMining() }))).not.toContain(
			"highest-context-seed",
		);
	});

	test("flags worst-success agent as critical below 50%", () => {
		const metrics = {
			...emptyMetrics(),
			byAgent: [agent("flaky", 1, 4), agent("solid", 9, 1)],
		};
		const i = find(buildInsights({ metrics, mining: emptyMining() }), "worst-success-agent");
		expect(i.severity).toBe("critical");
		expect(i.subject).toBe("flaky");
	});

	test("reports the rate and count over the same cancelled-inclusive terminal denominator", () => {
		// 1 succeeded, 4 failed, 5 cancelled -> 10 terminal runs, successRate 0.1.
		const metrics = { ...emptyMetrics(), byAgent: [agent("flaky", 1, 4, 5)] };
		const i = find(buildInsights({ metrics, mining: emptyMining() }), "worst-success-agent");
		expect(i.value).toBe(0.1);
		// Count must match the denominator behind the rate, not succeeded + failed (5).
		expect(i.detail).toContain("10% of 10 terminal run(s)");
	});

	test("ignores agents below the minimum terminal-run sample", () => {
		const metrics = { ...emptyMetrics(), byAgent: [agent("tiny", 0, 1)] };
		expect(kinds(buildInsights({ metrics, mining: emptyMining() }))).not.toContain(
			"worst-success-agent",
		);
	});

	test("does not flag agents above the warning success threshold", () => {
		const metrics = { ...emptyMetrics(), byAgent: [agent("good", 9, 1)] };
		expect(kinds(buildInsights({ metrics, mining: emptyMining() }))).not.toContain(
			"worst-success-agent",
		);
	});

	test("flags the most-failed command and highlights os-eco tooling", () => {
		const mining = {
			...emptyMining(),
			byFailures: [cmd({ command: "bun run check:all", osEco: true, invocations: 7, failures: 6 })],
		};
		const i = find(buildInsights({ metrics: emptyMetrics(), mining }), "most-failed-command");
		expect(i.severity).toBe("critical");
		expect(i.detail).toContain("os-eco");
	});

	test("skips most-failed command below the warning failure floor", () => {
		const mining = {
			...emptyMining(),
			byFailures: [cmd({ command: "ls", invocations: 3, failures: 1 })],
		};
		expect(kinds(buildInsights({ metrics: emptyMetrics(), mining }))).not.toContain(
			"most-failed-command",
		);
	});

	test("flags a stuck-command loop from the stuck-score ranking", () => {
		const mining = {
			...emptyMining(),
			byStuckScore: [
				cmd({ command: "git push", invocations: 6, failures: 4, retries: 3, stuckScore: 3 }),
			],
		};
		const i = find(buildInsights({ metrics: emptyMetrics(), mining }), "most-retried-command");
		expect(i.severity).toBe("critical");
		expect(i.value).toBe(3);
		expect(i.detail).toContain("3 retr");
	});

	test("flags a model cost outlier at 2x the peer median", () => {
		const metrics = {
			...emptyMetrics(),
			byModel: [model("opus", 1.0, 2), model("sonnet", 0.2, 2), model("haiku", 0.1, 2)],
		};
		const i = find(buildInsights({ metrics, mining: emptyMining() }), "model-cost-outlier");
		expect(i.subject).toBe("opus");
		expect(i.severity).toBe("warning");
	});

	test("does not flag a cost outlier when models are comparable", () => {
		const metrics = {
			...emptyMetrics(),
			byModel: [model("a", 0.2, 2), model("b", 0.22, 2)],
		};
		expect(kinds(buildInsights({ metrics, mining: emptyMining() }))).not.toContain(
			"model-cost-outlier",
		);
	});

	test("needs at least two priced models for the outlier check", () => {
		const metrics = { ...emptyMetrics(), byModel: [model("only", 5.0, 1)] };
		expect(kinds(buildInsights({ metrics, mining: emptyMining() }))).not.toContain(
			"model-cost-outlier",
		);
	});

	test("flags heavy steering as critical past the 50% share", () => {
		const steering: SteeringSignals = {
			totalRuns: 4,
			runsSteered: 3,
			steeringMessages: 9,
			runsPaused: 0,
			pauseTimeouts: 0,
		};
		const i = find(
			buildInsights({ metrics: emptyMetrics(), mining: emptyMining(), steering }),
			"steering-anomaly",
		);
		expect(i.severity).toBe("critical");
	});

	test("omits steering insight below the warning share", () => {
		const steering: SteeringSignals = {
			totalRuns: 10,
			runsSteered: 1,
			steeringMessages: 1,
			runsPaused: 0,
			pauseTimeouts: 0,
		};
		expect(
			kinds(buildInsights({ metrics: emptyMetrics(), mining: emptyMining(), steering })),
		).not.toContain("steering-anomaly");
	});

	test("flags pause-timeout stalls as critical", () => {
		const steering: SteeringSignals = {
			totalRuns: 5,
			runsSteered: 0,
			steeringMessages: 0,
			runsPaused: 2,
			pauseTimeouts: 2,
		};
		const i = find(
			buildInsights({ metrics: emptyMetrics(), mining: emptyMining(), steering }),
			"pause-anomaly",
		);
		expect(i.severity).toBe("critical");
		expect(i.value).toBe(2);
	});

	test("skips steering/pause insights entirely when signals are absent", () => {
		const insights = buildInsights({ metrics: emptyMetrics(), mining: emptyMining() });
		expect(kinds(insights)).not.toContain("steering-anomaly");
		expect(kinds(insights)).not.toContain("pause-anomaly");
	});

	test("sorts critical insights ahead of warning and info", () => {
		const metrics = {
			...emptyMetrics(),
			byAgent: [agent("flaky", 1, 4)],
			topSeedsByContext: [seed("warren-1", 1000)],
		};
		const mining = {
			...emptyMining(),
			byFailures: [cmd({ command: "ls", invocations: 5, failures: 3 })],
		};
		const insights = buildInsights({ metrics, mining });
		const ranks = insights.map((i) => i.severity);
		const order = { critical: 0, warning: 1, info: 2 } as const;
		for (let n = 1; n < ranks.length; n += 1) {
			expect(order[ranks[n - 1] ?? "info"]).toBeLessThanOrEqual(order[ranks[n] ?? "info"]);
		}
	});
});
