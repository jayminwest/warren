import { describe, expect, test } from "bun:test";
import {
	buildCreateRunInput,
	initialDraft,
	initialTouched,
	parseCostCap,
	parseErrorOf,
	parseTimeLimit,
	parseValueOf,
	readDispatchRouteState,
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

describe("readDispatchRouteState", () => {
	test("keeps string fields and drops everything else", () => {
		expect(readDispatchRouteState(null)).toEqual({});
		expect(
			readDispatchRouteState({
				project: "p1",
				agent: "pi",
				prompt: "fix it",
				seedId: "warren-1",
				continueFromRunId: "run_a",
				cloneFromRunId: "run_b",
				rescueFromRunId: "run_c",
				extra: 3,
				planId: 7,
			}),
		).toEqual({
			project: "p1",
			agent: "pi",
			prompt: "fix it",
			seedId: "warren-1",
			continueFromRunId: "run_a",
			cloneFromRunId: "run_b",
			rescueFromRunId: "run_c",
		});
	});
});

describe("initialDraft and initialTouched", () => {
	test("seed the form from route state and mark supplied fields touched", () => {
		const state = { project: "p1", agent: "pi", prompt: "go", seedId: "warren-1" };
		expect(initialDraft(state)).toMatchObject({
			project: "p1",
			agent: "pi",
			prompt: "go",
			seedId: "warren-1",
		});
		expect(initialTouched(state)).toMatchObject({ agent: true, prompt: true, costCap: false });
		expect(initialTouched({})).toMatchObject({ agent: false, prompt: false });
	});
});

describe("parseErrorOf and parseValueOf", () => {
	test("split a parse result into its error or its value", () => {
		expect(parseErrorOf(null)).toBeNull();
		expect(parseErrorOf({ error: "bad" })).toBe("bad");
		expect(parseValueOf({ value: 3 })).toBe(3);
		expect(parseValueOf({ error: "bad" })).toBeUndefined();
		expect(parseValueOf(null)).toBeUndefined();
	});
});
