import { describe, expect, test } from "bun:test";
import { NotFoundError, StateTransitionError, ValidationError } from "../core/errors.ts";
import { ProjectUnavailableError } from "../projects/errors.ts";
import { AgentSchemaError } from "../registry/errors.ts";
import { RunSpawnError } from "../runs/errors.ts";
import {
	RuntimeAdmissionError,
	RuntimeConflictError,
	RuntimeRunNotFoundError,
	RuntimeUnreachableError,
} from "../runtime/errors.ts";
import { WarrenConfigInvalidError, WarrenConfigUnavailableError } from "../warren-config/errors.ts";
import {
	collectedErrorMessage,
	errorLogFields,
	forbidden,
	INTERNAL_ERROR_MESSAGE,
	methodNotAllowed,
	notFound,
	notImplemented,
	renderError,
} from "./errors.ts";

describe("renderError — WarrenError mapping", () => {
	test("NotFoundError → 404", () => {
		const r = renderError(new NotFoundError("nope"));
		expect(r.status).toBe(404);
		expect(r.envelope.error.code).toBe("not_found");
	});

	test("ValidationError → 400 with hint passthrough", () => {
		const r = renderError(new ValidationError("bad", { recoveryHint: "fix it" }));
		expect(r.status).toBe(400);
		expect(r.envelope.error.code).toBe("validation_error");
		expect(r.envelope.error.hint).toBe("fix it");
	});

	test("StateTransitionError → 409", () => {
		expect(renderError(new StateTransitionError("nope")).status).toBe(409);
	});

	test("RuntimeAdmissionError → 429 with Retry-After header + reason hint (warren-b6f2)", () => {
		const r = renderError(
			new RuntimeAdmissionError("run rejected: cluster busy", {
				reason: "cluster_pending_saturated",
				retryAfterSeconds: 30,
				recoveryHint: "retry after 30s",
			}),
		);
		expect(r.status).toBe(429);
		expect(r.envelope.error.code).toBe("runtime_admission_rejected");
		expect(r.envelope.error.message).toContain("cluster busy");
		expect(r.envelope.error.hint).toBe("retry after 30s");
		expect(r.headers).toEqual({ "Retry-After": "30" });
	});

	test("RuntimeUnreachableError → 503 (neutral K8s transport failure)", () => {
		const r = renderError(new RuntimeUnreachableError("pod endpoint gone"));
		expect(r.status).toBe(503);
		expect(r.envelope.error.code).toBe("runtime_unreachable");
	});

	test("RuntimeRunNotFoundError → 404", () => {
		const r = renderError(new RuntimeRunNotFoundError("run gone"));
		expect(r.status).toBe(404);
		expect(r.envelope.error.code).toBe("runtime_run_not_found");
	});

	test("RuntimeConflictError → 409", () => {
		const r = renderError(new RuntimeConflictError("toolchain clash"));
		expect(r.status).toBe(409);
		expect(r.envelope.error.code).toBe("runtime_conflict");
	});

	test("ProjectUnavailableError → 503", () => {
		expect(renderError(new ProjectUnavailableError("rm failed")).status).toBe(503);
	});

	test("WarrenConfigUnavailableError → 503 with code passthrough", () => {
		const r = renderError(new WarrenConfigUnavailableError("clone vanished"));
		expect(r.status).toBe(503);
		expect(r.envelope.error.code).toBe("warren_config_unavailable");
	});

	test("WarrenConfigInvalidError → 422 with code passthrough (warren-02aa)", () => {
		const r = renderError(new WarrenConfigInvalidError("unknown key in .warren/config.yaml"));
		expect(r.status).toBe(422);
		expect(r.envelope.error.code).toBe("warren_config_invalid");
	});

	test("AgentSchemaError → 422", () => {
		expect(renderError(new AgentSchemaError("missing system")).status).toBe(422);
	});

	test("RunSpawnError → 500", () => {
		expect(renderError(new RunSpawnError("rolled back")).status).toBe(500);
	});
});

describe("renderError — fallthrough (warren-4385)", () => {
	test("plain Error → 500 internal_error with the generic message, not err.message", () => {
		const r = renderError(new Error("kaboom"));
		expect(r.status).toBe(500);
		expect(r.envelope.error.code).toBe("internal_error");
		expect(r.envelope.error.message).toBe(INTERNAL_ERROR_MESSAGE);
		expect(r.envelope.error.message).not.toContain("kaboom");
	});

	test("non-Error thrown value → 500 with the same generic message", () => {
		const r = renderError("oops");
		expect(r.status).toBe(500);
		expect(r.envelope.error.message).toBe(INTERNAL_ERROR_MESSAGE);
		expect(JSON.stringify(r.envelope)).not.toContain("oops");
	});

	test("the correlation id rides in the hint when supplied", () => {
		const r = renderError(new Error("kaboom"), "trace-abc-123");
		expect(r.envelope.error.hint).toContain("trace-abc-123");
	});

	test("no correlation id → a hint that still points at the logs", () => {
		const r = renderError(new Error("kaboom"));
		expect(r.envelope.error.hint).toBe("check the warren server logs for the underlying error");
	});

	test("a subprocess/filesystem message never reaches the envelope", () => {
		// The disclosure this guard exists for: `sd` stderr, a /data clone path,
		// and a driver string all arrive as untyped Errors from deep layers.
		const leaky = new Error(
			`sd show failed: ENOENT /data/warren/projects/acme/.seeds at ${process.cwd()}`,
		);
		const body = JSON.stringify(renderError(leaky, "req-1").envelope);
		expect(body).not.toContain("/data/warren");
		expect(body).not.toContain(process.cwd());
		expect(body).not.toContain("ENOENT");
	});
});

describe("collectedErrorMessage (warren-bf4c)", () => {
	test("is the generic message plus the correlation id, whatever was caught", () => {
		expect(collectedErrorMessage("req-1")).toContain(INTERNAL_ERROR_MESSAGE);
		expect(collectedErrorMessage("req-1")).toContain("req-1");
	});

	test("without a correlation id it still points at the logs", () => {
		expect(collectedErrorMessage()).toContain("check the warren server logs");
	});
});

describe("errorLogFields (warren-4385)", () => {
	test("carries the full message and stack for an Error", () => {
		const err = new Error("kaboom");
		const fields = errorLogFields(err);
		expect(fields.err).toBe(err);
		expect(fields.err_message).toBe("kaboom");
		expect(typeof fields.err_stack).toBe("string");
	});

	test("stringifies a non-Error thrown value", () => {
		const fields = errorLogFields("oops");
		expect(fields.err_message).toBe("oops");
		expect(fields.err_stack).toBeUndefined();
	});
});

describe("canned envelopes", () => {
	test("notFound", () => {
		const r = notFound("/nope");
		expect(r.status).toBe(404);
		expect(r.envelope.error.code).toBe("not_found");
		expect(r.envelope.error.message).toContain("/nope");
	});

	test("methodNotAllowed", () => {
		const r = methodNotAllowed("PUT", "/agents");
		expect(r.status).toBe(405);
		expect(r.envelope.error.code).toBe("method_not_allowed");
	});

	test("forbidden names the demanded capability and nothing else (warren-b875)", () => {
		const r = forbidden("readOperator");
		expect(r.status).toBe(403);
		expect(r.envelope.error.code).toBe("forbidden");
		expect(r.envelope.error.message).toContain("readOperator");
		expect(r.envelope.error.hint).toContain("bearer token");
	});

	test("notImplemented", () => {
		const r = notImplemented("GET /todo");
		expect(r.status).toBe(501);
		expect(r.envelope.error.code).toBe("not_implemented");
	});
});
