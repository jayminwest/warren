/**
 * Unit tests for the env-var integer parsers exported from
 * `src/server/main.ts` (warren-da37 / pl-60a6 step 1). The HTTP-query
 * variants live in `server.test.ts`; this file covers the env-only
 * `resolvePgPoolMax` so the strict round-trip check (`String(n) ===
 * raw`) is regression-locked: junk-suffix inputs (`"10x"`,
 * `"5 abc"`) must throw rather than silently coercing to the leading
 * integer.
 */

import { describe, expect, test } from "bun:test";
import { WARREN_DB_POOL_MAX_ENV } from "../../db/client.ts";
import { resolvePgPoolMax } from "./index.ts";

describe("resolvePgPoolMax", () => {
	test("undefined / blank env returns undefined (let openDatabase default win)", () => {
		expect(resolvePgPoolMax({})).toBeUndefined();
		expect(resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "" })).toBeUndefined();
	});

	test("valid positive integer parses through unchanged", () => {
		expect(resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "10" })).toBe(10);
		expect(resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "1" })).toBe(1);
	});

	test("non-positive integers throw", () => {
		expect(() => resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "0" })).toThrow(
			/must be a positive integer/,
		);
		expect(() => resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "-5" })).toThrow(
			/must be a positive integer/,
		);
	});

	// warren-da37: the strict round-trip check is the regression target.
	// Reverting `String(n) !== raw` in `parseIntEnv` makes these pass with
	// the leading integer instead of throwing.
	test("junk-suffix inputs reject instead of silently truncating", () => {
		expect(() => resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "10x" })).toThrow(
			/must be a positive integer/,
		);
		expect(() => resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "5abc" })).toThrow(
			/must be a positive integer/,
		);
		expect(() => resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "1.5" })).toThrow(
			/must be a positive integer/,
		);
	});
});
