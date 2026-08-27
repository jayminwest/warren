import { describe, expect, test } from "bun:test";
import { resolveRunCostBasis } from "./providers.ts";

describe("resolveRunCostBasis", () => {
	test("returns api when the anthropic API key is present", () => {
		expect(
			resolveRunCostBasis("anthropic", {
				ANTHROPIC_API_KEY: "sk-ant",
				CLAUDE_CODE_OAUTH_TOKEN: "oauth",
			}),
		).toBe("api");
	});

	test("returns subscription_estimate when only CLAUDE_CODE_OAUTH_TOKEN authenticates", () => {
		expect(resolveRunCostBasis("anthropic", { CLAUDE_CODE_OAUTH_TOKEN: "oauth" })).toBe(
			"subscription_estimate",
		);
	});

	test("returns subscription_estimate for an undeclared provider (anthropic-shaped default)", () => {
		expect(resolveRunCostBasis(undefined, { CLAUDE_CODE_OAUTH_TOKEN: "oauth" })).toBe(
			"subscription_estimate",
		);
	});

	test("returns api when no credential is present", () => {
		expect(resolveRunCostBasis("anthropic", {})).toBe("api");
	});

	test("blank oauth token counts as absent", () => {
		expect(resolveRunCostBasis("anthropic", { CLAUDE_CODE_OAUTH_TOKEN: "" })).toBe("api");
	});

	test("returns api for non-anthropic providers even with the oauth token set", () => {
		expect(resolveRunCostBasis("openrouter", { CLAUDE_CODE_OAUTH_TOKEN: "oauth" })).toBe("api");
	});

	test("provider names are normalized before the anthropic check", () => {
		expect(resolveRunCostBasis("Anthropic", { CLAUDE_CODE_OAUTH_TOKEN: "oauth" })).toBe(
			"subscription_estimate",
		);
	});
});
