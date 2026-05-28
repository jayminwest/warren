import { describe, expect, test } from "bun:test";
import { formatError } from "./format-error.ts";

describe("formatError", () => {
	test("returns empty string for null/undefined", () => {
		expect(formatError(null)).toBe("");
		expect(formatError(undefined)).toBe("");
	});

	test("returns string input unchanged", () => {
		expect(formatError("boom")).toBe("boom");
	});

	test("formats {code, message} envelope as 'code: message'", () => {
		expect(formatError({ code: "http_404", message: "not found" })).toBe(
			"http_404: not found",
		);
	});

	test("falls back to .message for plain Error", () => {
		expect(formatError(new Error("kaboom"))).toBe("kaboom");
	});

	test("falls back to .message for object with only message", () => {
		expect(formatError({ message: "hi" })).toBe("hi");
	});

	test("stringifies arbitrary values", () => {
		expect(formatError(42)).toBe("42");
		expect(formatError({ foo: "bar" })).toBe("[object Object]");
	});

	test("ignores non-string code on envelope-shaped object", () => {
		expect(formatError({ code: 500, message: "err" })).toBe("err");
	});
});
