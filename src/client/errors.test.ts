import { describe, expect, test } from "bun:test";
import { WarrenError } from "../core/errors.ts";
import { WarrenClientError, WarrenUnreachableError } from "./errors.ts";

describe("WarrenUnreachableError", () => {
	test("is a WarrenError with the warren_unreachable code", () => {
		const err = new WarrenUnreachableError("connection refused");
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.code).toBe("warren_unreachable");
	});
});

describe("WarrenClientError", () => {
	test("captures the HTTP status, server code, and hint", () => {
		const err = new WarrenClientError(404, "not_found", "no such run", "check the id");
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.status).toBe(404);
		expect(err.code).toBe("not_found");
		expect(err.message).toBe("no such run");
		expect(err.hint).toBe("check the id");
		expect(err.recoveryHint).toBe("check the id");
		expect(err.name).toBe("WarrenClientError");
	});

	test("leaves the hint undefined when not supplied", () => {
		const err = new WarrenClientError(500, "internal", "boom");
		expect(err.hint).toBeUndefined();
		expect(err.recoveryHint).toBeUndefined();
	});
});
