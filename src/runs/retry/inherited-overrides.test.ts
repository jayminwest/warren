import { describe, expect, test } from "bun:test";
import { inheritedDispatchOverrides } from "./inherited-overrides.ts";

describe("inheritedDispatchOverrides", () => {
	test("reads the three override slots off the frozen frontmatter", () => {
		expect(
			inheritedDispatchOverrides({
				frontmatter: { provider: "openrouter", model: "deepseek/deepseek-v4-pro", maxCostUsd: 4 },
			}),
		).toEqual({
			providerOverride: "openrouter",
			modelOverride: "deepseek/deepseek-v4-pro",
			maxCostUsdOverride: 4,
		});
	});

	test("fills only the slots the parent actually carried", () => {
		expect(inheritedDispatchOverrides({ frontmatter: { model: "kimi-k3" } })).toEqual({
			modelOverride: "kimi-k3",
		});
	});

	test("yields nothing for a run whose frontmatter declared none of them", () => {
		// A spread of `{}` leaves the retry resolving exactly as the original
		// did, off the agent and the project defaults.
		expect(inheritedDispatchOverrides({ frontmatter: {} })).toEqual({});
		expect(inheritedDispatchOverrides({})).toEqual({});
	});

	test("narrows a rendered agent that is not the shape it should be", () => {
		// The column is `unknown`, and a hand-built fixture or an older row
		// can carry anything.
		for (const rendered of [
			null,
			undefined,
			"",
			7,
			[],
			{ frontmatter: null },
			{ frontmatter: 3 },
		]) {
			expect(inheritedDispatchOverrides(rendered), JSON.stringify(rendered)).toEqual({});
		}
	});

	test("ignores an empty or non-string provider and model", () => {
		expect(inheritedDispatchOverrides({ frontmatter: { provider: "", model: 42 } })).toEqual({});
	});

	test("defers to readMaxCostUsd on a cap that is not a plain number", () => {
		// Measured, not assumed: the reader coerces a numeric string on purpose
		// (the `cn --fm` trap its own module doc describes), and drops a
		// negative, a zero and an unparseable one. The retry inherits whatever
		// the original run's cap resolved to, including that coercion.
		expect(inheritedDispatchOverrides({ frontmatter: { maxCostUsd: "4" } })).toEqual({
			maxCostUsdOverride: 4,
		});
		for (const cap of [-1, 0, "abc", null]) {
			expect(inheritedDispatchOverrides({ frontmatter: { maxCostUsd: cap } }), `${cap}`).toEqual(
				{},
			);
		}
	});
});
