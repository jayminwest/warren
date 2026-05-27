/**
 * Unit tests for report-quality-metrics.ts (warren-5b95 / pl-7b06 step 18).
 *
 * Each helper is pure (string in, struct/string out), so we exercise the
 * parsers and the report formatter directly without touching the
 * filesystem. End-to-end coverage of the CLI entrypoint is provided by
 * the CI workflow itself; here we focus on the data-shape contracts.
 */

import { describe, expect, test } from "bun:test";
import {
	countComplexityOverrides,
	formatReport,
	parseLcov,
	summariseDebt,
	summariseFileSizes,
} from "./report-quality-metrics.ts";

describe("parseLcov", () => {
	test("aggregates FNF/FNH/LF/LH across multiple SF blocks", () => {
		const lcov = [
			"TN:",
			"SF:src/a.ts",
			"FNF:4",
			"FNH:3",
			"LF:10",
			"LH:9",
			"end_of_record",
			"SF:src/b.ts",
			"FNF:6",
			"FNH:3",
			"LF:30",
			"LH:21",
			"end_of_record",
		].join("\n");
		const totals = parseLcov(lcov);
		expect(totals).toBeDefined();
		expect(totals?.functions).toEqual({ hit: 6, found: 10, pct: 60 });
		expect(totals?.lines).toEqual({ hit: 30, found: 40, pct: 75 });
	});

	test("returns undefined for empty input", () => {
		expect(parseLcov("")).toBeUndefined();
		expect(parseLcov("# nothing useful here\n")).toBeUndefined();
	});

	test("treats zero-found counters as 100% to avoid NaN", () => {
		const totals = parseLcov("FNF:0\nFNH:0\nLF:0\nLH:0\n");
		expect(totals?.functions.pct).toBe(100);
		expect(totals?.lines.pct).toBe(100);
	});
});

describe("countComplexityOverrides", () => {
	test("counts files exempt from each rule independently", () => {
		const biome = JSON.stringify({
			overrides: [
				{
					includes: ["a.ts", "b.ts"],
					linter: { rules: { complexity: { noExcessiveLinesPerFunction: "off" } } },
				},
				{
					includes: ["c.ts", "d.ts", "e.ts"],
					linter: { rules: { complexity: { noExcessiveCognitiveComplexity: "off" } } },
				},
				{
					// Non-complexity override should be ignored.
					includes: ["f.ts"],
					linter: { rules: { style: { useFilenamingConvention: "off" } } },
				},
			],
		});
		const counts = countComplexityOverrides(biome);
		expect(counts).toEqual({ cognitive: 3, linesPerFunction: 2 });
	});

	test("returns zeros when no overrides block is present", () => {
		expect(countComplexityOverrides("{}")).toEqual({ cognitive: 0, linesPerFunction: 0 });
	});
});

describe("summariseFileSizes", () => {
	test("reports grandfather count and largest entry", () => {
		const json = JSON.stringify({
			threshold: 500,
			budgets: { "a.ts": 600, "b.ts": 1200, "c.ts": 750 },
		});
		expect(summariseFileSizes(json)).toEqual({
			threshold: 500,
			grandfathered: 3,
			largest: 1200,
		});
	});

	test("handles empty budgets", () => {
		expect(summariseFileSizes(JSON.stringify({ threshold: 500, budgets: {} }))).toEqual({
			threshold: 500,
			grandfathered: 0,
			largest: 0,
		});
	});
});

describe("summariseDebt", () => {
	test("counts allowlist entries", () => {
		expect(summariseDebt(JSON.stringify({ allowlist: ["a:1", "b:2"] }))).toEqual({
			grandfathered: 2,
		});
		expect(summariseDebt(JSON.stringify({ allowlist: [] }))).toEqual({ grandfathered: 0 });
	});
});

describe("formatReport", () => {
	test("emits coverage delta vs floor and complexity counts", () => {
		const lcov = "FNF:10\nFNH:9\nLF:100\nLH:95\n";
		const coverageBudgets = JSON.stringify({ functions: 85, lines: 90 });
		const biomeJson = JSON.stringify({
			overrides: [
				{
					includes: ["a.ts"],
					linter: { rules: { complexity: { noExcessiveCognitiveComplexity: "off" } } },
				},
			],
		});
		const report = formatReport({
			summaryJson: undefined,
			lcov,
			coverageBudgets,
			biomeJson,
			fileSizeBudgets: JSON.stringify({ threshold: 500, budgets: { "x.ts": 700 } }),
			debtAllowlist: JSON.stringify({ allowlist: [] }),
			bundleSizes: undefined,
		});
		expect(report).toContain("## Code-quality metrics");
		expect(report).toContain("Coverage — functions | 90.00% (floor 85.00%, +5.00pt)");
		expect(report).toContain("Coverage — lines | 95.00% (floor 90.00%, +5.00pt)");
		expect(report).toContain("cognitive-complexity ≤ 15 | 1");
		expect(report).toContain("lines-per-function ≤ 500 | 0");
		expect(report).toContain("grandfathered files | 1 (largest 700 lines vs 500 threshold)");
		expect(report).toContain("Untracked debt markers — grandfathered | 0");
		expect(report).toContain("Bundle sizes | — (src/ui/dist/assets/ missing");
	});

	test("renders a placeholder row when coverage inputs are missing", () => {
		const report = formatReport({
			summaryJson: undefined,
			lcov: undefined,
			coverageBudgets: undefined,
			biomeJson: undefined,
			fileSizeBudgets: undefined,
			debtAllowlist: undefined,
			bundleSizes: undefined,
		});
		expect(report).toContain("| Coverage | — (summary.json/lcov.info or budgets missing) |");
	});

	test("prefers summary.json over lcov for coverage numbers", () => {
		const report = formatReport({
			summaryJson: JSON.stringify({ functions: 87.5, lines: 92.34 }),
			lcov: "FNF:10\nFNH:1\nLF:100\nLH:1\n",
			coverageBudgets: JSON.stringify({ functions: 85, lines: 90 }),
			biomeJson: undefined,
			fileSizeBudgets: undefined,
			debtAllowlist: undefined,
			bundleSizes: undefined,
		});
		expect(report).toContain("Coverage — functions | 87.50% (floor 85.00%, +2.50pt)");
		expect(report).toContain("Coverage — lines | 92.34% (floor 90.00%, +2.34pt)");
	});

	test("renders bundle-size rows with budget percentages", () => {
		const report = formatReport({
			summaryJson: undefined,
			lcov: undefined,
			coverageBudgets: undefined,
			biomeJson: undefined,
			fileSizeBudgets: undefined,
			debtAllowlist: undefined,
			bundleSizes: {
				rawJs: 200_000,
				rawCss: 10_000,
				gzipJs: 60_000,
				gzipCss: 3_000,
				budgetRawJs: 400_000,
				budgetRawCss: 20_000,
				budgetGzipJs: 120_000,
				budgetGzipCss: 6_000,
			},
		});
		expect(report).toContain("Bundle — JS gzip");
		expect(report).toMatch(/Bundle — JS gzip \| [\d.]+ KiB \/ [\d.]+ KiB \(50\.0%\)/);
		expect(report).toMatch(/Bundle — CSS gzip \| [\d.]+ KiB \/ [\d.]+ KiB \(50\.0%\)/);
	});
});
