import { describe, expect, test } from "bun:test";
import type { ContextWasteProxy, ContextWasteShare } from "./context-waste.ts";
import { buildInsights } from "./insights.ts";
import { emptyMetrics, emptyMining } from "./insights-outcomes.test.ts";

function share(partial: Partial<ContextWasteShare> & { key: string }): ContextWasteShare {
	return {
		invocations: 1,
		resultBytesKnown: 1,
		resultBytesTotal: 0,
		runs: 1,
		runsMeasured: 3,
		contextTokensTotal: 1000,
		share: null,
		...partial,
	};
}

function waste(partial: Partial<ContextWasteProxy>): ContextWasteProxy {
	return {
		runsInWindow: 5,
		runsWithRollup: 4,
		runsMeasured: 3,
		contextTokensTotal: 1000,
		resultBytesTotal: 600,
		share: 0.6,
		byTool: [],
		byCommand: [],
		confidence: "low",
		...partial,
	};
}

describe("buildInsights: context-waste-proxy (warren-6d41)", () => {
	test("fires on a dominant tool with denominator, confidence, and the proxy limitation named", () => {
		const insights = buildInsights({
			metrics: emptyMetrics(),
			mining: emptyMining(),
			contextWaste: waste({
				byTool: [share({ key: "Bash", resultBytesTotal: 600, share: 0.6 })],
			}),
		});
		const hit = insights.find((i) => i.kind === "context-waste-proxy");
		expect(hit).toBeDefined();
		expect(hit?.severity).toBe("warning");
		expect(hit?.subject).toBe("Bash");
		expect(hit?.value).toBeCloseTo(0.6);
		expect(hit?.denominator).toBe(3);
		expect(hit?.confidence).toBe("low");
		expect(hit?.detail).toContain("proxy");
		expect(hit?.detail).toContain("not per-turn");
	});

	test("escalates to critical at the 0.75 share threshold", () => {
		const insights = buildInsights({
			metrics: emptyMetrics(),
			mining: emptyMining(),
			contextWaste: waste({
				byTool: [share({ key: "Read", resultBytesTotal: 800, share: 0.8 })],
			}),
		});
		expect(insights.find((i) => i.kind === "context-waste-proxy")?.severity).toBe("critical");
	});

	test("stays silent below the warning share, below the minimum cohort, and unmeasured", () => {
		const base = { metrics: emptyMetrics(), mining: emptyMining() };
		const lowShare = waste({ byTool: [share({ key: "Bash", share: 0.4 })] });
		expect(
			buildInsights({ ...base, contextWaste: lowShare }).some(
				(i) => i.kind === "context-waste-proxy",
			),
		).toBe(false);
		const tinyCohort = waste({
			runsMeasured: 2,
			byTool: [share({ key: "Bash", share: 0.9, runsMeasured: 2 })],
		});
		expect(
			buildInsights({ ...base, contextWaste: tinyCohort }).some(
				(i) => i.kind === "context-waste-proxy",
			),
		).toBe(false);
		const unmeasured = waste({ byTool: [share({ key: "Bash", share: null })] });
		expect(
			buildInsights({ ...base, contextWaste: unmeasured }).some(
				(i) => i.kind === "context-waste-proxy",
			),
		).toBe(false);
	});

	test("is omitted when no contextWaste bundle is passed", () => {
		const insights = buildInsights({ metrics: emptyMetrics(), mining: emptyMining() });
		expect(insights.some((i) => i.kind === "context-waste-proxy")).toBe(false);
	});
});
