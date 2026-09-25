import { describe, expect, test } from "bun:test";
import { InvalidArgumentError } from "commander";
import { parseMaxDurationMinutes } from "./flags.ts";

describe("parseMaxDurationMinutes", () => {
	test("accepts a positive whole number of minutes", () => {
		expect(parseMaxDurationMinutes("45")).toBe(45);
		expect(parseMaxDurationMinutes(" 90 ")).toBe(90);
	});

	test("rejects zero, negatives, fractions, and junk", () => {
		for (const bad of ["0", "-5", "1.5", "", "abc", "30m"]) {
			expect(() => parseMaxDurationMinutes(bad)).toThrow(InvalidArgumentError);
		}
	});
});
