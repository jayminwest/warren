import { describe, expect, test } from "bun:test";
import {
	NotFoundError as BurrowNotFoundError,
	SandboxError,
	ToolchainMismatch,
} from "@os-eco/burrow-cli";
import { BurrowUnreachableError } from "../../burrow-client/errors.ts";
import {
	RuntimeConflictError,
	RuntimeRunNotFoundError,
	RuntimeUnreachableError,
} from "../errors.ts";
import { mapBurrowError } from "./error-map.ts";

describe("mapBurrowError (warren-36cb)", () => {
	test("burrow NotFoundError → RuntimeRunNotFoundError, preserving message + custom hint", () => {
		const mapped = mapBurrowError(new BurrowNotFoundError("burrow gone: bur_x"), {
			runNotFoundHint: "terminalize the row",
		});
		expect(mapped).toBeInstanceOf(RuntimeRunNotFoundError);
		const err = mapped as RuntimeRunNotFoundError;
		expect(err.message).toBe("burrow gone: bur_x");
		expect(err.recoveryHint).toBe("terminalize the row");
		expect(err.cause).toBeInstanceOf(BurrowNotFoundError);
	});

	test("burrow ToolchainMismatch → RuntimeConflictError", () => {
		const mapped = mapBurrowError(new ToolchainMismatch("node 18 vs 20"));
		expect(mapped).toBeInstanceOf(RuntimeConflictError);
		expect((mapped as RuntimeConflictError).message).toBe("node 18 vs 20");
	});

	test("a burrow class with no neutral analogue propagates unchanged", () => {
		const raw = new SandboxError("bwrap failed");
		expect(mapBurrowError(raw)).toBe(raw);
	});

	test("a non-burrow error propagates unchanged", () => {
		const plain = new Error("boom");
		expect(mapBurrowError(plain)).toBe(plain);
	});

	test("BurrowUnreachableError is already neutral (extends RuntimeUnreachableError) and passes through", () => {
		const transport = new BurrowUnreachableError("socket refused");
		expect(transport).toBeInstanceOf(RuntimeUnreachableError);
		// mapBurrowError leaves it unchanged — it is already neutral.
		expect(mapBurrowError(transport)).toBe(transport);
	});
});
