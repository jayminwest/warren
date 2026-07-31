import { describe, expect, test } from "bun:test";
import { buildPlanRunInput, computeSubmittable } from "./dispatch-plan-dialog.helpers.ts";

describe("computeSubmittable", () => {
	const base = {
		isPending: false,
		hasSeeds: true,
		agent: "claude-code",
		planId: "pl-1234",
		promptTemplate: "work on sd {seed_id}",
	};

	test("enabled when every field is present", () => {
		expect(computeSubmittable(base)).toBe(true);
	});

	test("disabled while a dispatch is in flight", () => {
		expect(computeSubmittable({ ...base, isPending: true })).toBe(false);
	});

	test("disabled when the project has no .seeds/", () => {
		expect(computeSubmittable({ ...base, hasSeeds: false })).toBe(false);
	});

	test("disabled without an agent", () => {
		expect(computeSubmittable({ ...base, agent: "" })).toBe(false);
	});

	test("disabled when the plan id is blank or whitespace", () => {
		expect(computeSubmittable({ ...base, planId: "   " })).toBe(false);
	});

	test("disabled when the prompt template is blank", () => {
		expect(computeSubmittable({ ...base, promptTemplate: "  " })).toBe(false);
	});
});

describe("buildPlanRunInput", () => {
	const base = {
		projectId: "proj-1",
		planId: "  pl-1234 ",
		agent: "claude-code",
		promptTemplate: "  work on sd {seed_id}  ",
		providerOverride: "",
		modelOverride: "",
	};

	test("trims plan id and prompt and omits optional fields when unset", () => {
		expect(buildPlanRunInput(base)).toEqual({
			project: "proj-1",
			planId: "pl-1234",
			agent: "claude-code",
			promptTemplate: "work on sd {seed_id}",
		});
	});

	test("includes provider and model overrides when present", () => {
		expect(
			buildPlanRunInput({
				...base,
				providerOverride: " anthropic ",
				modelOverride: " claude-sonnet-4-6 ",
			}),
		).toMatchObject({ providerOverride: "anthropic", modelOverride: "claude-sonnet-4-6" });
	});
});
