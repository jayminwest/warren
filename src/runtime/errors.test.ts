import { describe, expect, test } from "bun:test";
import { WarrenError } from "../core/errors.ts";
import {
	RUNTIME_BACKEND_STATUS_BY_CODE,
	RuntimeAdmissionError,
	RuntimeConflictError,
	RuntimeProviderError,
	RuntimeRunNotFoundError,
	RuntimeUnreachableError,
	runtimeBackendStatusFor,
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

describe("runtimeBackendStatusFor (warren-36cb)", () => {
	test("maps the mirrored burrow server-envelope codes to their HTTP status", () => {
		expect(runtimeBackendStatusFor({ code: "not_found" })).toBe(404);
		expect(runtimeBackendStatusFor({ code: "validation_error" })).toBe(400);
		expect(runtimeBackendStatusFor({ code: "credential_error" })).toBe(401);
		expect(runtimeBackendStatusFor({ code: "agent_not_installed" })).toBe(424);
		expect(runtimeBackendStatusFor({ code: "agent_runtime_failed" })).toBe(502);
		expect(runtimeBackendStatusFor({ code: "sandbox_error" })).toBe(502);
		expect(runtimeBackendStatusFor({ code: "bwrap_or_sb_missing" })).toBe(502);
		expect(runtimeBackendStatusFor({ code: "workspace_materialization_failed" })).toBe(500);
		expect(runtimeBackendStatusFor({ code: "toolchain_mismatch" })).toBe(409);
		expect(runtimeBackendStatusFor({ code: "secret_resolution_failed" })).toBe(502);
	});

	test("returns undefined for an unknown or absent code", () => {
		expect(runtimeBackendStatusFor({ code: "worker_draining" })).toBeUndefined();
		expect(runtimeBackendStatusFor({ code: 42 })).toBeUndefined();
		expect(runtimeBackendStatusFor(new Error("plain"))).toBeUndefined();
		expect(runtimeBackendStatusFor(null)).toBeUndefined();
		expect(runtimeBackendStatusFor("string")).toBeUndefined();
	});

	test("the table statuses match the neutral-class statuses for the shared codes", () => {
		// The instanceof table in src/server/errors.ts maps RuntimeConflictError →
		// 409; the code table must agree so a seam-mapped conflict and a raw
		// leaking `toolchain_mismatch` render the same status.
		expect(RUNTIME_BACKEND_STATUS_BY_CODE.toolchain_mismatch).toBe(409);
		expect(RUNTIME_BACKEND_STATUS_BY_CODE.not_found).toBe(404);
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
