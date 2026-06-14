import { describe, expect, test } from "bun:test";
import { coerceCostCap, isOverBudget, readMaxCostUsd, resolveCostCapUsd } from "./cost-cap.ts";

describe("coerceCostCap", () => {
	test("accepts a positive number", () => {
		expect(coerceCostCap(5)).toBe(5);
		expect(coerceCostCap(0.25)).toBe(0.25);
	});

	test("accepts a positive numeric string (cn --fm stringification trap)", () => {
		expect(coerceCostCap("5")).toBe(5);
		expect(coerceCostCap("  2.5 ")).toBe(2.5);
	});

	test("treats non-positive, NaN, and unparseable values as no cap", () => {
		expect(coerceCostCap(0)).toBeNull();
		expect(coerceCostCap(-1)).toBeNull();
		expect(coerceCostCap(Number.NaN)).toBeNull();
		expect(coerceCostCap(Number.POSITIVE_INFINITY)).toBeNull();
		expect(coerceCostCap("")).toBeNull();
		expect(coerceCostCap("abc")).toBeNull();
		expect(coerceCostCap("-3")).toBeNull();
	});

	test("rejects non-number / non-string values", () => {
		expect(coerceCostCap(undefined)).toBeNull();
		expect(coerceCostCap(null)).toBeNull();
		expect(coerceCostCap(true)).toBeNull();
		expect(coerceCostCap({})).toBeNull();
	});
});

describe("readMaxCostUsd", () => {
	test("reads a numeric maxCostUsd from frontmatter", () => {
		expect(readMaxCostUsd({ maxCostUsd: 3 })).toBe(3);
	});

	test("reads a stringified maxCostUsd from frontmatter", () => {
		expect(readMaxCostUsd({ maxCostUsd: "3" })).toBe(3);
	});

	test("returns null when absent", () => {
		expect(readMaxCostUsd({})).toBeNull();
		expect(readMaxCostUsd({ other: 1 })).toBeNull();
	});
});

describe("resolveCostCapUsd", () => {
	test("reads the cap from rendered_agent_json frontmatter", () => {
		expect(resolveCostCapUsd({ name: "x", frontmatter: { maxCostUsd: 4 } })).toBe(4);
	});

	test("returns null for missing / malformed shapes", () => {
		expect(resolveCostCapUsd(null)).toBeNull();
		expect(resolveCostCapUsd("nope")).toBeNull();
		expect(resolveCostCapUsd({})).toBeNull();
		expect(resolveCostCapUsd({ frontmatter: null })).toBeNull();
		expect(resolveCostCapUsd({ frontmatter: [] })).toBeNull();
		expect(resolveCostCapUsd({ frontmatter: { maxCostUsd: "bad" } })).toBeNull();
	});
});

describe("isOverBudget", () => {
	test("null cap is never over budget", () => {
		expect(isOverBudget(9999, null)).toBe(false);
	});

	test("strictly-greater cost is over budget; equal is allowed", () => {
		expect(isOverBudget(5.01, 5)).toBe(true);
		expect(isOverBudget(5, 5)).toBe(false);
		expect(isOverBudget(4.99, 5)).toBe(false);
	});
});
