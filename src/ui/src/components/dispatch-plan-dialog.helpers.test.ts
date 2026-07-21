import { describe, expect, test } from "bun:test";
import {
	buildPlanRunInput,
	computeBindablePlot,
	computeSubmittable,
	readFrontmatter,
} from "./dispatch-plan-dialog.helpers.ts";

describe("computeBindablePlot", () => {
	test("binds a well-formed plot id when the project has .plot/", () => {
		expect(computeBindablePlot(true, "plot-abc123")).toBe(true);
	});

	test("does not bind when the project lacks .plot/", () => {
		expect(computeBindablePlot(false, "plot-abc123")).toBe(false);
	});

	test("does not bind a null plot id", () => {
		expect(computeBindablePlot(true, null)).toBe(false);
	});

	test("does not bind a malformed plot id", () => {
		expect(computeBindablePlot(true, "PLOT-Bad")).toBe(false);
	});
});

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
		plotId: null,
		bindablePlot: false,
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

	test("includes the plot back-link only when bindable", () => {
		expect(buildPlanRunInput({ ...base, plotId: "plot-abc", bindablePlot: true })).toMatchObject({
			plotId: "plot-abc",
		});
		expect(
			buildPlanRunInput({ ...base, plotId: "plot-abc", bindablePlot: false }),
		).not.toHaveProperty("plotId");
	});
});

describe("readFrontmatter", () => {
	test("returns the frontmatter object when present", () => {
		expect(readFrontmatter({ frontmatter: { provider: "anthropic" } })).toEqual({
			provider: "anthropic",
		});
	});

	test("returns an empty object for non-objects, null, or array frontmatter", () => {
		expect(readFrontmatter(null)).toEqual({});
		expect(readFrontmatter("nope")).toEqual({});
		expect(readFrontmatter({ frontmatter: [1, 2] })).toEqual({});
		expect(readFrontmatter({})).toEqual({});
	});
});
