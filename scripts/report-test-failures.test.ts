import { describe, expect, test } from "bun:test";
import { formatAnnotations, formatSummary, parseFailures } from "./report-test-failures.ts";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="5" failures="1" skipped="0" time="1.2">
  <testsuite name="a.test.ts" file="a.test.ts" tests="2" assertions="3" failures="1" skipped="0" time="0.5" hostname="h">
    <testcase name="passing case" classname="group A" time="0.001" file="a.test.ts" line="2" assertions="1" />
    <testcase name="failing case" classname="group A" time="0.4" file="a.test.ts" line="5" assertions="2">
      <failure message="expect(received).toBe(expected)" type="AssertionError">stack trace here</failure>
    </testcase>
  </testsuite>
  <testsuite name="b.test.ts" file="b.test.ts" tests="1" assertions="2" failures="0" skipped="0" time="0.7" hostname="h">
    <testcase name="b case" classname="group B" time="0.7" file="b.test.ts" line="2" assertions="2" />
  </testsuite>
</testsuites>`;

describe("parseFailures", () => {
	test("extracts only testcases with a <failure> child", () => {
		const failures = parseFailures(SAMPLE_XML);
		expect(failures).toHaveLength(1);
		const f = failures[0];
		expect(f?.name).toBe("failing case");
		expect(f?.classname).toBe("group A");
		expect(f?.file).toBe("a.test.ts");
		expect(f?.line).toBe(5);
		expect(f?.message).toBe("expect(received).toBe(expected)");
	});

	test("returns an empty list when nothing failed", () => {
		const xml = SAMPLE_XML.replace(
			/<testcase name="failing case"[\s\S]*?<\/testcase>/,
			'<testcase name="failing case" classname="group A" time="0.4" file="a.test.ts" line="5" assertions="2" />',
		);
		expect(parseFailures(xml)).toEqual([]);
	});
});

describe("formatAnnotations", () => {
	test("emits one ::error command per failure with file and line", () => {
		const out = formatAnnotations(parseFailures(SAMPLE_XML));
		expect(out).toContain("::error file=a.test.ts,line=5::");
		expect(out).toContain("group A › failing case");
		expect(out).toContain("expect(received).toBe(expected)");
	});

	test("escapes workflow-command delimiters in messages", () => {
		const out = formatAnnotations([
			{
				name: "n",
				classname: "c",
				file: "f.ts",
				line: undefined,
				message: "100% wrong\nsecond line",
			},
		]);
		expect(out).toContain("::error::");
		expect(out).toContain("100%25 wrong");
		expect(out).not.toContain("\nsecond");
	});
});

describe("formatSummary", () => {
	test("renders a markdown table of failing tests", () => {
		const md = formatSummary(parseFailures(SAMPLE_XML));
		expect(md).toContain("## Failing tests");
		expect(md).toContain("**1** test(s) failed");
		expect(md).toContain("group A › failing case");
		expect(md).toContain("`a.test.ts:5`");
	});
});
