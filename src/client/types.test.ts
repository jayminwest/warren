import { describe, expect, test } from "bun:test";
import {
	isTerminalPlanRunState,
	isTerminalRunState,
	PLAN_RUN_TERMINAL_STATES,
	type PlanRunState,
	RUN_TERMINAL_STATES,
	type RunState,
} from "./types.ts";

describe("isTerminalRunState", () => {
	test("flags succeeded/failed/cancelled as terminal", () => {
		for (const s of ["succeeded", "failed", "cancelled"] as RunState[]) {
			expect(isTerminalRunState(s)).toBe(true);
		}
	});

	test("flags queued/running as non-terminal", () => {
		for (const s of ["queued", "running"] as RunState[]) {
			expect(isTerminalRunState(s)).toBe(false);
		}
	});

	test("RUN_TERMINAL_STATES re-exports the canonical tuple", () => {
		expect([...RUN_TERMINAL_STATES]).toEqual(["succeeded", "failed", "cancelled"]);
	});
});

describe("isTerminalPlanRunState", () => {
	test("flags succeeded/failed/cancelled as terminal", () => {
		for (const s of ["succeeded", "failed", "cancelled"] as PlanRunState[]) {
			expect(isTerminalPlanRunState(s)).toBe(true);
		}
	});

	test("flags queued/running as non-terminal", () => {
		for (const s of ["queued", "running"] as PlanRunState[]) {
			expect(isTerminalPlanRunState(s)).toBe(false);
		}
	});

	test("PLAN_RUN_TERMINAL_STATES re-exports the canonical tuple", () => {
		expect([...PLAN_RUN_TERMINAL_STATES]).toEqual(["succeeded", "failed", "cancelled"]);
	});
});
