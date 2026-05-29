import { describe, expect, test } from "bun:test";
import { WarrenError } from "../core/errors.ts";
import { RunSpawnError } from "./errors.ts";

describe("RunSpawnError", () => {
	test("is a WarrenError with the run_spawn_error code", () => {
		const err = new RunSpawnError("seed write failed");
		expect(err).toBeInstanceOf(WarrenError);
		expect(err.code).toBe("run_spawn_error");
		expect(err.name).toBe("RunSpawnError");
		expect(err.message).toBe("seed write failed");
	});

	test("preserves the cause when wrapping a lower-level failure", () => {
		const cause = new Error("ENOSPC");
		const err = new RunSpawnError("cannot seed workspace", { cause });
		expect(err.cause).toBe(cause);
	});
});
