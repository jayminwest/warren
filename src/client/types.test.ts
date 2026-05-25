import { describe, expect, test } from "bun:test";
import { isTerminalRunState, RUN_TERMINAL_STATES, type RunState } from "./types.ts";

describe("isTerminalRunState", () => {
	test("flags succeeded/failed/cancelled as terminal", () => {
		for (const s of ["succeeded", "failed", "cancelled"] as RunState[]) {
			expect(isTerminalRunState(s)).toBe(true);
		}
	});

	test("flags queued/running/paused as non-terminal", () => {
		for (const s of ["queued", "running", "paused"] as RunState[]) {
			expect(isTerminalRunState(s)).toBe(false);
		}
	});

	test("RUN_TERMINAL_STATES is the same canonical set", () => {
		expect(RUN_TERMINAL_STATES.size).toBe(3);
		expect(RUN_TERMINAL_STATES.has("succeeded")).toBe(true);
		expect(RUN_TERMINAL_STATES.has("failed")).toBe(true);
		expect(RUN_TERMINAL_STATES.has("cancelled")).toBe(true);
	});
});
