import { describe, expect, test } from "bun:test";
import { formatReport, parseJUnit } from "./report-test-timing.ts";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="5" failures="0" skipped="0" time="1.234567">
  <testsuite name="a.test.ts" file="a.test.ts" tests="2" assertions="3" failures="0" skipped="0" time="0.5" hostname="h">
    <testsuite name="group A" file="a.test.ts" line="1" tests="2" assertions="3" failures="0" skipped="0" time="0.5" hostname="h">
      <testcase name="fast case" classname="group A" time="0.001" file="a.test.ts" line="2" assertions="1" />
      <testcase name="slow case" classname="group A" time="0.4" file="a.test.ts" line="5" assertions="2" />
    </testsuite>
  </testsuite>
  <testsuite name="b.test.ts" file="b.test.ts" tests="1" assertions="2" failures="0" skipped="0" time="0.734567" hostname="h">
    <testcase name="b case" classname="group B" time="0.7" file="b.test.ts" line="2" assertions="2" />
  </testsuite>
</testsuites>`;

describe("parseJUnit", () => {
	test("extracts root totals, file suites, and individual test cases", () => {
		const report = parseJUnit(SAMPLE_XML);
		expect(report.totalTests).toBe(3);
		expect(report.totalSeconds).toBeCloseTo(1.234567, 5);
		expect(report.suites).toHaveLength(2);
		expect(report.suites.map((s) => s.file).sort()).toEqual(["a.test.ts", "b.test.ts"]);
		expect(report.cases).toHaveLength(3);
		const slow = report.cases.find((c) => c.name === "slow case");
		expect(slow?.timeSeconds).toBeCloseTo(0.4, 5);
		expect(slow?.file).toBe("a.test.ts");
	});

	test("falls back to suite sums when root time/tests are missing", () => {
		const xml = SAMPLE_XML.replace(/tests="3"[^>]*time="1.234567"/, 'tests="0" time="0"');
		const report = parseJUnit(xml);
		expect(report.totalTests).toBe(3);
		// File totals are derived from per-case sums (suite.time is unreliable
		// when bun nests describe() blocks), so fallback total = sum of cases.
		expect(report.totalSeconds).toBeCloseTo(0.001 + 0.4 + 0.7, 5);
	});
});

describe("formatReport", () => {
	test("renders a markdown summary with slowest cases first", () => {
		const report = parseJUnit(SAMPLE_XML);
		const md = formatReport(report, 2);
		expect(md).toContain("## Test timing");
		expect(md).toContain("Slowest 2 test files");
		expect(md).toContain("Slowest 2 individual tests");
		// Slowest individual case ("b case", 0.7s) should appear before "slow case" (0.4s).
		const bIdx = md.indexOf("b case");
		const sIdx = md.indexOf("slow case");
		expect(bIdx).toBeGreaterThan(-1);
		expect(sIdx).toBeGreaterThan(-1);
		expect(bIdx).toBeLessThan(sIdx);
	});
});
