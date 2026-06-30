import { describe, expect, test } from "bun:test";
import {
	formatError,
	NotFoundError,
	StateTransitionError,
	ValidationError,
	WarrenError,
} from "./errors.ts";

describe("formatError", () => {
	test("returns the message for Error instances", () => {
		expect(formatError(new Error("boom"))).toBe("boom");
	});

	test("returns just the message for WarrenError, without code or hint", () => {
		const err = new ValidationError("bad input", { recoveryHint: "fix it" });
		expect(formatError(err)).toBe("bad input");
	});

	test("coerces non-Error values via String()", () => {
		expect(formatError("plain string")).toBe("plain string");
		expect(formatError(42)).toBe("42");
		expect(formatError({ a: 1 })).toBe("[object Object]");
		expect(formatError(null)).toBe("null");
		expect(formatError(undefined)).toBe("undefined");
	});
});

describe("WarrenError", () => {
	test("exposes a stable code and class name on each subclass", () => {
		const notFound = new NotFoundError("missing");
		expect(notFound).toBeInstanceOf(WarrenError);
		expect(notFound.code).toBe("not_found");
		expect(notFound.name).toBe("NotFoundError");
		expect(notFound.message).toBe("missing");
		expect(notFound.recoveryHint).toBeUndefined();
	});

	test("carries an optional recovery hint when provided", () => {
		const err = new ValidationError("bad input", { recoveryHint: "fix the field" });
		expect(err.code).toBe("validation_error");
		expect(err.recoveryHint).toBe("fix the field");
	});

	test("threads the cause through to the Error options", () => {
		const cause = new Error("root");
		const err = new StateTransitionError("cannot transition", { cause });
		expect(err.code).toBe("state_transition_error");
		expect(err.cause).toBe(cause);
	});

	test("leaves cause undefined when not supplied", () => {
		const err = new NotFoundError("x");
		expect(err.cause).toBeUndefined();
	});
});
