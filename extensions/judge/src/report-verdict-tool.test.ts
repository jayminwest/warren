import { describe, expect, test } from "bun:test";
import {
	type ReportVerdictArgs,
	REPORT_VERDICT_PARAMETERS,
	REPORT_VERDICT_PROMPT_GUIDELINES,
	REPORT_VERDICT_TOOL,
	validateReportVerdictArgs,
} from "./report-verdict-tool.ts";
import { VERDICT_CLASSES, VerdictValidationError } from "./wire.ts";

const VALID_ARGS: ReportVerdictArgs = {
	runId: "run_01J8Z7XYZDEF",
	assignments: [
		{
			class: "spin_loop",
			confidence: "high",
			evidence: [{ fromSeq: 340, toSeq: 612 }],
			note: "same failing command retried verbatim",
		},
		{ class: "env_fumble", confidence: "medium", evidence: [{ fromSeq: 12, toSeq: 40 }] },
	],
};

describe("REPORT_VERDICT_PARAMETERS", () => {
	test("encodes every wire.ts class as a literal in the schema", () => {
		const schema = JSON.stringify(REPORT_VERDICT_PARAMETERS);
		for (const cls of VERDICT_CLASSES) {
			expect(schema).toContain(`"const":"${cls}"`);
		}
	});

	test("encodes the banded confidence vocabulary and the note cap", () => {
		const schema = JSON.stringify(REPORT_VERDICT_PARAMETERS);
		for (const band of ["low", "medium", "high"]) {
			expect(schema).toContain(`"const":"${band}"`);
		}
		expect(schema).toContain('"maxLength":200');
	});
});

describe("validateReportVerdictArgs", () => {
	test("accepts a valid multi-label verdict", () => {
		expect(validateReportVerdictArgs(VALID_ARGS)).toEqual(VALID_ARGS);
	});

	test("accepts an exclusive clean verdict with no evidence", () => {
		const args: ReportVerdictArgs = {
			runId: "run_clean",
			assignments: [{ class: "clean", confidence: "high", evidence: [] }],
		};
		expect(validateReportVerdictArgs(args)).toEqual(args);
	});

	test("rejects a class outside the taxonomy", () => {
		const args = {
			runId: "run_x",
			assignments: [{ class: "laziness", confidence: "high", evidence: [] }],
		};
		expect(() => validateReportVerdictArgs(args)).toThrow(VerdictValidationError);
	});

	test("rejects a float confidence — bands only", () => {
		const args = {
			runId: "run_x",
			assignments: [
				{ class: "spin_loop", confidence: 0.9, evidence: [{ fromSeq: 1, toSeq: 2 }] },
			],
		};
		expect(() => validateReportVerdictArgs(args)).toThrow(VerdictValidationError);
	});

	test("rejects a note over the 200-character cap", () => {
		const args = {
			runId: "run_x",
			assignments: [
				{
					class: "spin_loop",
					confidence: "low",
					evidence: [{ fromSeq: 1, toSeq: 2 }],
					note: "x".repeat(201),
				},
			],
		};
		expect(() => validateReportVerdictArgs(args)).toThrow(VerdictValidationError);
	});

	test("rejects a non-clean class with no evidence range", () => {
		const args = {
			runId: "run_x",
			assignments: [{ class: "gate_flunk", confidence: "high", evidence: [] }],
		};
		expect(() => validateReportVerdictArgs(args)).toThrow(/requires at least one evidence/u);
	});

	test("rejects clean carrying evidence", () => {
		const args = {
			runId: "run_x",
			assignments: [
				{ class: "clean", confidence: "high", evidence: [{ fromSeq: 1, toSeq: 2 }] },
			],
		};
		expect(() => validateReportVerdictArgs(args)).toThrow(/carries no evidence/u);
	});

	test("rejects clean alongside another class", () => {
		const args = {
			runId: "run_x",
			assignments: [
				{ class: "clean", confidence: "high", evidence: [] },
				{ class: "spin_loop", confidence: "low", evidence: [{ fromSeq: 1, toSeq: 2 }] },
			],
		};
		expect(() => validateReportVerdictArgs(args)).toThrow(/exclusive/u);
	});

	test("rejects a duplicate class assignment", () => {
		const args = {
			runId: "run_x",
			assignments: [
				{ class: "spin_loop", confidence: "low", evidence: [{ fromSeq: 1, toSeq: 2 }] },
				{ class: "spin_loop", confidence: "high", evidence: [{ fromSeq: 3, toSeq: 4 }] },
			],
		};
		expect(() => validateReportVerdictArgs(args)).toThrow(/more than once/u);
	});

	test("rejects an inverted evidence range", () => {
		const args = {
			runId: "run_x",
			assignments: [
				{ class: "spin_loop", confidence: "low", evidence: [{ fromSeq: 10, toSeq: 2 }] },
			],
		};
		expect(() => validateReportVerdictArgs(args)).toThrow(/toSeq must be >= fromSeq/u);
	});

	test("rejects extra properties and empty assignments", () => {
		expect(() =>
			validateReportVerdictArgs({ ...VALID_ARGS, provenance: {} }),
		).toThrow(VerdictValidationError);
		expect(() => validateReportVerdictArgs({ runId: "run_x", assignments: [] })).toThrow(
			VerdictValidationError,
		);
	});
});

describe("REPORT_VERDICT_TOOL", () => {
	test("promptGuidelines makes report_verdict the mandatory final action", () => {
		expect(REPORT_VERDICT_PROMPT_GUIDELINES).toContain("MANDATORY final action");
		expect(REPORT_VERDICT_PROMPT_GUIDELINES).toContain("no provider-level tool forcing");
		expect(REPORT_VERDICT_TOOL.promptGuidelines).toBe(REPORT_VERDICT_PROMPT_GUIDELINES);
		expect(REPORT_VERDICT_TOOL.parameters).toBe(REPORT_VERDICT_PARAMETERS);
	});
});
