/**
 * Unit tests for the small env/db helpers in `./utils.ts`
 * (warren-8d3d / pl-9088 step 10). Companion to `./index.test.ts`,
 * which only exercises `resolvePgPoolMax`. These cover the rest of
 * the module so the split doesn't sink line coverage relative to the
 * pre-split `main.ts`.
 */

import { describe, expect, test } from "bun:test";
import { closeDatabase, parseIntEnv, parseTrueEnv, redactDbUrl } from "./utils.ts";

describe("parseTrueEnv", () => {
	test("returns false for undefined / empty / explicit false", () => {
		expect(parseTrueEnv(undefined)).toBe(false);
		expect(parseTrueEnv("")).toBe(false);
		expect(parseTrueEnv("0")).toBe(false);
		expect(parseTrueEnv("false")).toBe(false);
		expect(parseTrueEnv("no")).toBe(false);
		expect(parseTrueEnv("off")).toBe(false);
	});

	test("accepts the canonical truthy set (case- and whitespace-insensitive)", () => {
		expect(parseTrueEnv("1")).toBe(true);
		expect(parseTrueEnv("true")).toBe(true);
		expect(parseTrueEnv("TRUE")).toBe(true);
		expect(parseTrueEnv("yes")).toBe(true);
		expect(parseTrueEnv("YES")).toBe(true);
		expect(parseTrueEnv("  Yes  ")).toBe(true);
		expect(parseTrueEnv("  true  ")).toBe(true);
		expect(parseTrueEnv("on")).toBe(true);
		expect(parseTrueEnv("On")).toBe(true);
	});
});

describe("parseIntEnv", () => {
	test("returns fallback when env var is missing / blank", () => {
		expect(parseIntEnv({}, "X", 100)).toBe(100);
		expect(parseIntEnv({ X: "" }, "X", 100)).toBe(100);
		expect(parseIntEnv({}, "X", undefined)).toBeUndefined();
	});

	test("parses a strict positive integer", () => {
		expect(parseIntEnv({ X: "42" }, "X", 1)).toBe(42);
	});

	test("rejects non-positive, junk-suffix, and decimal values", () => {
		expect(() => parseIntEnv({ X: "0" }, "X", 1)).toThrow(/must be a positive integer/);
		expect(() => parseIntEnv({ X: "-3" }, "X", 1)).toThrow(/must be a positive integer/);
		expect(() => parseIntEnv({ X: "10x" }, "X", 1)).toThrow(/must be a positive integer/);
		expect(() => parseIntEnv({ X: "1.5" }, "X", 1)).toThrow(/must be a positive integer/);
	});
});

describe("redactDbUrl", () => {
	test("sqlite URLs pass through untouched", () => {
		expect(redactDbUrl("sqlite:///var/data/warren.db")).toBe("sqlite:///var/data/warren.db");
		expect(redactDbUrl(":memory:")).toBe(":memory:");
	});

	test("strips userinfo from postgres URLs", () => {
		const redacted = redactDbUrl("postgres://alice:secret@db.example/warren");
		expect(redacted).not.toContain("alice");
		expect(redacted).not.toContain("secret");
		expect(redacted).toContain("db.example");
	});

	test("postgres URL without userinfo round-trips unchanged", () => {
		const url = "postgres://db.example:5432/warren";
		expect(redactDbUrl(url)).toBe(url);
	});
});

describe("closeDatabase", () => {
	test("swallows errors from a double-close", async () => {
		let calls = 0;
		const db = {
			async close() {
				calls++;
				throw new Error("already closed");
			},
		} as unknown as Parameters<typeof closeDatabase>[0];
		await closeDatabase(db);
		expect(calls).toBe(1);
	});

	test("awaits the underlying close exactly once", async () => {
		let calls = 0;
		const db = {
			async close() {
				calls++;
			},
		} as unknown as Parameters<typeof closeDatabase>[0];
		await closeDatabase(db);
		expect(calls).toBe(1);
	});
});
