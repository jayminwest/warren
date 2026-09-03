import { describe, expect, test } from "bun:test";
import { parseArgs } from "./dump.ts";

describe("pg-migrate dump", () => {
	describe("parseArgs", () => {
		test("accepts --source and --out in flag-value and = forms", () => {
			expect(parseArgs(["--source", "postgres://a", "--out", "/tmp"])).toEqual({
				source: "postgres://a",
				out: "/tmp",
				help: false,
			});
			expect(parseArgs(["--source=postgres://b", "--out=/var"])).toEqual({
				source: "postgres://b",
				out: "/var",
				help: false,
			});
		});

		test("flags --help and defaults to env-resolved source", () => {
			expect(parseArgs([])).toEqual({ source: undefined, out: undefined, help: false });
			expect(parseArgs(["--help"]).help).toBe(true);
			expect(parseArgs(["-h"]).help).toBe(true);
		});

		test("rejects unknown arguments", () => {
			expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
		});
	});
});
