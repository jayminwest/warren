import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import { optionalEnum, optionalObject, optionalPositiveNumber } from "./body-fields.ts";

describe("optionalPositiveNumber", () => {
	test("returns undefined for an absent or null field", () => {
		expect(optionalPositiveNumber({}, "maxCostUsd")).toBeUndefined();
		expect(optionalPositiveNumber({ maxCostUsd: null }, "maxCostUsd")).toBeUndefined();
	});

	test("returns a positive finite number verbatim", () => {
		expect(optionalPositiveNumber({ maxCostUsd: 2.5 }, "maxCostUsd")).toBe(2.5);
	});

	test("rejects zero, negatives, and non-finite values", () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => optionalPositiveNumber({ maxCostUsd: bad }, "maxCostUsd")).toThrow(
				ValidationError,
			);
		}
	});

	test("rejects numeric strings instead of coercing them", () => {
		// A string cap would coerce downstream into "no cap" (fail-open) —
		// the boundary rejects it loudly instead (warren-a63d).
		expect(() => optionalPositiveNumber({ maxCostUsd: "2.5" }, "maxCostUsd")).toThrow(
			ValidationError,
		);
	});
});

describe("optionalEnum", () => {
	test("returns undefined for an absent field and the value when allowed", () => {
		expect(optionalEnum({}, "priority", ["low", "high"])).toBeUndefined();
		expect(optionalEnum({ priority: "low" }, "priority", ["low", "high"])).toBe("low");
	});

	test("rejects a value outside the allowed tuple", () => {
		expect(() => optionalEnum({ priority: "urgent" }, "priority", ["low", "high"])).toThrow(
			ValidationError,
		);
	});
});

describe("optionalObject", () => {
	test("returns undefined for an absent field and the record when an object", () => {
		expect(optionalObject({}, "metadata")).toBeUndefined();
		expect(optionalObject({ metadata: { a: 1 } }, "metadata")).toEqual({ a: 1 });
	});

	test("rejects arrays and scalars", () => {
		expect(() => optionalObject({ metadata: [1] }, "metadata")).toThrow(ValidationError);
		expect(() => optionalObject({ metadata: "x" }, "metadata")).toThrow(ValidationError);
	});
});
