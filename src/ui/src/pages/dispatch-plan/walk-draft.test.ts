import { describe, expect, test } from "bun:test";
import { buildCreatePlanRunInput, initialWalkDraft, timeLimitErrorOf } from "./walk-draft.ts";
import { isSubmittable } from "./walk-state.ts";

const draft = { ...initialWalkDraft({}), project: "p1", agent: "claude-code", planId: "pl-1" };

describe("timeLimitErrorOf", () => {
	test("returns null when unset or valid, and an error otherwise", () => {
		expect(timeLimitErrorOf("")).toBeNull();
		expect(timeLimitErrorOf("45")).toBeNull();
		expect(timeLimitErrorOf("2.5")).not.toBeNull();
		expect(timeLimitErrorOf("0")).not.toBeNull();
	});
});

describe("buildCreatePlanRunInput", () => {
	test("passes maxDurationMinutes through when set", () => {
		const input = buildCreatePlanRunInput({ draft, maxCostUsd: undefined, maxDurationMinutes: 30 });
		expect(input.maxDurationMinutes).toBe(30);
		expect(input.planId).toBe("pl-1");
	});

	test("omits maxDurationMinutes when unset", () => {
		const input = buildCreatePlanRunInput({ draft, maxCostUsd: undefined });
		expect("maxDurationMinutes" in input).toBe(false);
	});
});

describe("isSubmittable", () => {
	test("blocks submit on a time limit parse error", () => {
		const base = { draft, hasSeeds: true, costCapError: null };
		expect(isSubmittable(base)).toBe(true);
		expect(isSubmittable({ ...base, timeLimitError: null })).toBe(true);
		expect(isSubmittable({ ...base, timeLimitError: "bad" })).toBe(false);
	});
});
