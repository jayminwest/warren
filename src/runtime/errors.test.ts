import { describe, expect, test } from "bun:test";
import { WarrenError } from "../core/errors.ts";
import {
	RuntimeAdmissionError,
	RuntimeConflictError,
	RuntimeProviderError,
	RuntimeRunNotFoundError,
	RuntimeUnreachableError,
} from "./errors.ts";

describe("neutral runtime error taxonomy (warren-36cb)", () => {
	test("RuntimeUnreachableError is a WarrenError with code runtime_unreachable", () => {
		const err = new RuntimeUnreachableError("socket gone");
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.code).toBe("runtime_unreachable");
		expect(err.message).toBe("socket gone");
	});

	test("RuntimeConflictError carries code runtime_conflict + hint", () => {
		const err = new RuntimeConflictError("toolchain clash", { recoveryHint: "align versions" });
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.code).toBe("runtime_conflict");
		expect(err.recoveryHint).toBe("align versions");
	});

	test("RuntimeRunNotFoundError carries code runtime_run_not_found", () => {
		expect(new RuntimeRunNotFoundError("gone").code).toBe("runtime_run_not_found");
	});

	test("RuntimeProviderError carries code runtime_provider_error", () => {
		expect(new RuntimeProviderError("no worker").code).toBe("runtime_provider_error");
	});
});

describe("RuntimeAdmissionError (unchanged, warren-b6f2)", () => {
	test("carries reason + retryAfterSeconds", () => {
		const err = new RuntimeAdmissionError("at cap", {
			reason: "project_concurrency_exceeded",
			retryAfterSeconds: 15,
		});
		expect(err.code).toBe("runtime_admission_rejected");
		expect(err.reason).toBe("project_concurrency_exceeded");
		expect(err.retryAfterSeconds).toBe(15);
	});
});
