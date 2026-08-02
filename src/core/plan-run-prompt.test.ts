import { describe, expect, test } from "bun:test";
import { ValidationError } from "./errors.ts";
import {
	assertPlanRunPromptTemplate,
	DEFAULT_PLAN_RUN_PROMPT_TEMPLATE,
	hasSeedIdPlaceholder,
	renderPlanRunPrompt,
	SEED_ID_PLACEHOLDER,
} from "./plan-run-prompt.ts";

describe("hasSeedIdPlaceholder", () => {
	test("accepts the default template", () => {
		expect(hasSeedIdPlaceholder(DEFAULT_PLAN_RUN_PROMPT_TEMPLATE)).toBe(true);
	});

	test("rejects a template without the placeholder", () => {
		expect(hasSeedIdPlaceholder("work on the next issue")).toBe(false);
	});
});

describe("assertPlanRunPromptTemplate", () => {
	test("passes a template carrying the placeholder", () => {
		expect(() => assertPlanRunPromptTemplate(`fix ${SEED_ID_PLACEHOLDER} now`)).not.toThrow();
	});

	test("throws ValidationError naming the placeholder requirement", () => {
		let caught: unknown;
		try {
			assertPlanRunPromptTemplate("fix the bug");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ValidationError);
		const err = caught as ValidationError;
		expect(err.code).toBe("validation_error");
		expect(err.message).toContain(SEED_ID_PLACEHOLDER);
		expect(err.recoveryHint).toContain(SEED_ID_PLACEHOLDER);
	});
});

describe("renderPlanRunPrompt", () => {
	test("substitutes a single occurrence", () => {
		expect(renderPlanRunPrompt("work on sd {seed_id}", "wa-1")).toBe("work on sd wa-1");
	});

	test("substitutes every occurrence, not just the first", () => {
		expect(renderPlanRunPrompt("read {seed_id}; then close {seed_id}", "wa-9")).toBe(
			"read wa-9; then close wa-9",
		);
	});

	test("leaves a template without the placeholder untouched", () => {
		expect(renderPlanRunPrompt("no placeholder", "wa-1")).toBe("no placeholder");
	});
});
