import { describe, expect, test } from "bun:test";
import {
	buildCreateRunInput,
	initialDraft,
	parseCostCap,
	parseErrorOf,
	parseTimeLimit,
	parseValueOf,
} from "./dispatch-draft.ts";

describe("parseTimeLimit", () => {
	test("returns null for empty or blank text", () => {
		expect(parseTimeLimit("")).toBeNull();
		expect(parseTimeLimit("   ")).toBeNull();
	});

	test("accepts a positive whole number of minutes", () => {
		expect(parseTimeLimit("60")).toEqual({ value: 60 });
		expect(parseTimeLimit(" 5 ")).toEqual({ value: 5 });
	});

	test("rejects zero, negatives, fractions, and non-numbers", () => {
		for (const bad of ["0", "-5", "1.5", "abc", "1e3", "0x10", "Infinity"]) {
			expect(parseTimeLimit(bad)).toHaveProperty("error");
		}
	});
});

describe("parse result helpers", () => {
	test("parseErrorOf and parseValueOf read each result shape", () => {
		expect(parseErrorOf(null)).toBeNull();
		expect(parseValueOf(null)).toBeUndefined();
		expect(parseValueOf(parseCostCap("2.5"))).toBe(2.5);
		expect(parseErrorOf(parseTimeLimit("0"))).toContain("whole number");
		expect(parseValueOf(parseTimeLimit("0"))).toBeUndefined();
	});
});

describe("buildCreateRunInput", () => {
	const draft = { ...initialDraft({}), agent: "claude-code", project: "p1", prompt: "do it" };

	test("passes maxDurationMinutes through when set", () => {
		const input = buildCreateRunInput({
			draft,
			routeState: {},
			maxCostUsd: 5,
			maxDurationMinutes: 90,
		});
		expect(input.maxDurationMinutes).toBe(90);
		expect(input.maxCostUsd).toBe(5);
	});

	test("omits maxDurationMinutes when unset", () => {
		const input = buildCreateRunInput({ draft, routeState: {}, maxCostUsd: undefined });
		expect("maxDurationMinutes" in input).toBe(false);
		expect("maxCostUsd" in input).toBe(false);
	});
});
