import { describe, expect, test } from "bun:test";
import {
	NotFoundError as BurrowNotFoundError,
	ValidationError as BurrowValidationError,
} from "@os-eco/burrow-cli";
import { BurrowUnreachableError } from "../burrow-client/errors.ts";
import { NotFoundError, StateTransitionError, ValidationError } from "../core/errors.ts";
import { ProjectUnavailableError } from "../projects/errors.ts";
import { AgentSchemaError, CanopyUnavailableError } from "../registry/errors.ts";
import { RunSpawnError } from "../runs/errors.ts";
import { RuntimeAdmissionError } from "../runtime/errors.ts";
import { WarrenConfigUnavailableError } from "../warren-config/errors.ts";
import { methodNotAllowed, notFound, notImplemented, renderError } from "./errors.ts";

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

	test("BurrowUnreachableError → 503", () => {
		expect(renderError(new BurrowUnreachableError("burrow gone")).status).toBe(503);
	});

	test("CanopyUnavailableError → 503", () => {
		expect(renderError(new CanopyUnavailableError("cn missing")).status).toBe(503);
	});

	test("ProjectUnavailableError → 503", () => {
		expect(renderError(new ProjectUnavailableError("rm failed")).status).toBe(503);
	});

	test("WarrenConfigUnavailableError → 503 with code passthrough", () => {
		const r = renderError(new WarrenConfigUnavailableError("clone vanished"));
		expect(r.status).toBe(503);
		expect(r.envelope.error.code).toBe("warren_config_unavailable");
	});

	test("AgentSchemaError → 422", () => {
		expect(renderError(new AgentSchemaError("missing system")).status).toBe(422);
	});

	test("RunSpawnError → 500", () => {
		expect(renderError(new RunSpawnError("rolled back")).status).toBe(500);
	});
});

describe("renderError — BurrowError pass-through", () => {
	test("burrow NotFoundError → 404 with code passthrough", () => {
		const r = renderError(new BurrowNotFoundError("burrow not found: bur_x"));
		expect(r.status).toBe(404);
		expect(r.envelope.error.code).toBe("not_found");
	});

	test("burrow ValidationError → 400", () => {
		expect(renderError(new BurrowValidationError("bad input")).status).toBe(400);
	});
});

describe("renderError — fallthrough", () => {
	test("plain Error → 500 internal_error", () => {
		const r = renderError(new Error("kaboom"));
		expect(r.status).toBe(500);
		expect(r.envelope.error.code).toBe("internal_error");
		expect(r.envelope.error.message).toBe("kaboom");
	});

	test("non-Error thrown value → 500 with String(value) message", () => {
		const r = renderError("oops");
		expect(r.status).toBe(500);
		expect(r.envelope.error.message).toBe("oops");
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

	test("notImplemented", () => {
		const r = notImplemented("GET /todo");
		expect(r.status).toBe(501);
		expect(r.envelope.error.code).toBe("not_implemented");
	});
});
