import { describe, expect, test } from "bun:test";
import { parseArgs, requireDbUrl } from "./repair-tool-calls.ts";

describe("repair-tool-calls parseArgs", () => {
	test("reads --dry-run", () => {
		expect(parseArgs([])).toEqual({ dryRun: false });
		expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true });
	});
});

describe("repair-tool-calls requireDbUrl", () => {
	test("returns the trimmed url when set", () => {
		expect(requireDbUrl({ WARREN_DB_URL: " postgres://x " })).toBe("postgres://x");
	});

	test("refuses to run without an explicit target — no default database", () => {
		expect(() => requireDbUrl({})).toThrow("WARREN_DB_URL is required");
		expect(() => requireDbUrl({ WARREN_DB_URL: "" })).toThrow("WARREN_DB_URL is required");
		expect(() => requireDbUrl({ WARREN_DB_URL: "   " })).toThrow("WARREN_DB_URL is required");
	});
});
