import { describe, expect, test } from "bun:test";
import { WarrenError } from "../core/errors.ts";
import { ProjectUnavailableError } from "./errors.ts";

describe("ProjectUnavailableError", () => {
	test("is a WarrenError with the project_unavailable code", () => {
		const err = new ProjectUnavailableError("git clone failed");
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.code).toBe("project_unavailable");
		expect(err.name).toBe("ProjectUnavailableError");
		expect(err.message).toBe("git clone failed");
	});

	test("carries a recovery hint pointing at the host", () => {
		const err = new ProjectUnavailableError("network down", {
			recoveryHint: "check connectivity",
		});
		expect(err.recoveryHint).toBe("check connectivity");
	});
});
