import { describe, expect, test } from "bun:test";
import { WarrenError } from "../core/errors.ts";
import { NoDispatchableSeedsError, SdPlanSynthesisError } from "./errors.ts";

describe("NoDispatchableSeedsError", () => {
	test("is a WarrenError with the no_dispatchable_seeds code", () => {
		const err = new NoDispatchableSeedsError("plot has no open seeds");
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.code).toBe("no_dispatchable_seeds");
		expect(err.name).toBe("NoDispatchableSeedsError");
	});
});

describe("SdPlanSynthesisError", () => {
	test("is a WarrenError with the sd_plan_synthesis_error code", () => {
		const cause = new Error("sd create exited 1");
		const err = new SdPlanSynthesisError("synthesis failed", { cause });
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.code).toBe("sd_plan_synthesis_error");
		expect(err.name).toBe("SdPlanSynthesisError");
		expect(err.cause).toBe(cause);
	});
});
