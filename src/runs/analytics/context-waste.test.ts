import { describe, expect, test } from "bun:test";
import type { ToolCallMiningRow } from "./command-mining.ts";
import { buildContextWaste } from "./context-waste.ts";
import type { RunMetricsRow } from "./run-metrics.ts";

function run(
	runId: string,
	tokens: { input: number | null; cacheRead: number | null },
): RunMetricsRow {
	return {
		runId,
		projectId: "p1",
		agentName: "claude-code",
		provider: "anthropic",
		model: "sonnet",
		seedId: null,
		state: "succeeded",
		failureReason: null,
		costUsd: null,
		tokensInput: tokens.input,
		tokensCacheRead: tokens.cacheRead,
		tokensOutput: null,
		tokensCacheWrite: null,
		startedAt: "2026-05-20T10:00:00.000Z",
		endedAt: "2026-05-20T10:05:00.000Z",
		parentRunId: null,
		retryOf: null,
		prMergedAt: null,
		branchPushedAt: null,
		prOpenedAt: null,
		createdAt: Date.parse("2026-05-20T10:00:00.000Z"),
		prState: null,
	};
}

let seqCounter = 0;
function call(
	runId: string,
	toolName: string | null,
	opts: { command?: string | null; resultBytes?: number | null } = {},
): ToolCallMiningRow {
	seqCounter += 1;
	return {
		runId,
		seq: seqCounter,
		toolName,
		command: opts.command ?? null,
		toolUseId: `u${seqCounter}`,
		isError: false,
		resultBytes: opts.resultBytes ?? null,
		runtime: "claude-code",
	};
}

describe("buildContextWaste (warren-6d41)", () => {
	test("a fresh window yields zeroed denominators, null share, low confidence", () => {
		const waste = buildContextWaste([], []);
		expect(waste.runsInWindow).toBe(0);
		expect(waste.runsWithRollup).toBe(0);
		expect(waste.runsMeasured).toBe(0);
		expect(waste.contextTokensTotal).toBe(0);
		expect(waste.resultBytesTotal).toBe(0);
		expect(waste.share).toBeNull();
		expect(waste.byTool).toEqual([]);
		expect(waste.byCommand).toEqual([]);
		expect(waste.confidence).toBe("low");
	});

	test("runs without rollup rows are unknown — excluded from denominators, never zero", () => {
		// run-old predates the rollup: tokens known, no tool_calls rows.
		const metrics = [
			run("run-old", { input: 10_000, cacheRead: 0 }),
			run("run-new", { input: 600, cacheRead: 400 }),
		];
		const rows = [call("run-new", "Bash", { command: "ls", resultBytes: 500 })];
		const waste = buildContextWaste(rows, metrics);
		expect(waste.runsInWindow).toBe(2);
		expect(waste.runsWithRollup).toBe(1);
		expect(waste.runsMeasured).toBe(1);
		// The pre-rollup run's 10k tokens sit in NO denominator.
		expect(waste.contextTokensTotal).toBe(1000);
		expect(waste.resultBytesTotal).toBe(500);
		expect(waste.share).toBeCloseTo(0.5);
	});

	test("rollup runs with null context tokens drop out of the measured cohort", () => {
		const metrics = [
			run("run-a", { input: 1000, cacheRead: null }),
			run("run-b", { input: null, cacheRead: null }),
		];
		const rows = [
			call("run-a", "Read", { resultBytes: 250 }),
			call("run-b", "Read", { resultBytes: 750 }),
		];
		const waste = buildContextWaste(rows, metrics);
		expect(waste.runsWithRollup).toBe(2);
		expect(waste.runsMeasured).toBe(1);
		// run-b's bytes still count toward the numerator totals, but its
		// unknown tokens keep it out of the share denominator.
		expect(waste.resultBytesTotal).toBe(1000);
		expect(waste.contextTokensTotal).toBe(1000);
		expect(waste.share).toBeCloseTo(1);
	});

	test("per-tool and per-command shares divide by their own measured runs' tokens", () => {
		const metrics = [
			run("run-a", { input: 800, cacheRead: 200 }),
			run("run-b", { input: 500, cacheRead: 500 }),
		];
		const rows = [
			call("run-a", "Bash", { command: "bun test", resultBytes: 800 }),
			call("run-a", "Bash", { command: "bun test --coverage", resultBytes: 200 }),
			call("run-b", "Read", { resultBytes: 100 }),
		];
		const waste = buildContextWaste(rows, metrics);
		const bash = waste.byTool.find((t) => t.key === "Bash");
		const read = waste.byTool.find((t) => t.key === "Read");
		// Bash: 1000 bytes over run-a's 1000 tokens.
		expect(bash).toMatchObject({
			invocations: 2,
			resultBytesKnown: 2,
			resultBytesTotal: 1000,
			runs: 1,
			runsMeasured: 1,
			contextTokensTotal: 1000,
		});
		expect(bash?.share).toBeCloseTo(1);
		// Read: 100 bytes over run-b's 1000 tokens.
		expect(read?.share).toBeCloseTo(0.1);
		// Both Bash invocations generalize to one command signature.
		expect(waste.byCommand).toHaveLength(1);
		expect(waste.byCommand[0]).toMatchObject({ key: "bun test", invocations: 2 });
	});

	test("null tool names group under NONE_KEY; null result bytes count invocations only", () => {
		const metrics = [run("run-a", { input: 100, cacheRead: 0 })];
		const rows = [call("run-a", null, { resultBytes: null })];
		const waste = buildContextWaste(rows, metrics);
		expect(waste.byTool[0]).toMatchObject({
			key: "__none__",
			invocations: 1,
			resultBytesKnown: 0,
			resultBytesTotal: 0,
			share: 0,
		});
	});

	test("a subject invoked only in token-unknown runs has a null share, never zero", () => {
		const metrics = [run("run-a", { input: null, cacheRead: null })];
		const rows = [call("run-a", "Bash", { command: "ls", resultBytes: 999 })];
		const waste = buildContextWaste(rows, metrics);
		expect(waste.runsMeasured).toBe(0);
		expect(waste.share).toBeNull();
		expect(waste.byTool[0]?.share).toBeNull();
		expect(waste.byTool[0]?.resultBytesTotal).toBe(999);
	});

	test("confidence follows the measured cohort size", () => {
		const metrics = Array.from({ length: 10 }, (_, i) =>
			run(`run-${i}`, { input: 100, cacheRead: 0 }),
		);
		const rows = metrics.map((r) => call(r.runId, "Read", { resultBytes: 10 }));
		expect(buildContextWaste(rows, metrics).confidence).toBe("medium");
	});

	test("breakdowns sort by resultBytesTotal desc with key-asc ties", () => {
		const metrics = [run("run-a", { input: 1000, cacheRead: 0 })];
		const rows = [
			call("run-a", "Read", { resultBytes: 100 }),
			call("run-a", "Bash", { command: "ls", resultBytes: 300 }),
			call("run-a", "Edit", { resultBytes: 100 }),
		];
		const waste = buildContextWaste(rows, metrics);
		expect(waste.byTool.map((t) => t.key)).toEqual(["Bash", "Edit", "Read"]);
	});
});
