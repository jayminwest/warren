import { describe, expect, test } from "bun:test";
import { MODEL_TIERS, resolveModelTiers } from "./model-tiers.ts";

describe("resolveModelTiers", () => {
	test("falls back to anthropic defaults when env is empty", () => {
		const tiers = resolveModelTiers({});
		expect(tiers.opus).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
		expect(tiers.sonnet).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
	});

	test("overrides model and provider per tier from env", () => {
		const tiers = resolveModelTiers({
			WARREN_MODEL_OPUS: "claude-opus-4-9",
			WARREN_MODEL_OPUS_PROVIDER: "bedrock",
			WARREN_MODEL_SONNET: "claude-sonnet-5",
		});
		expect(tiers.opus).toEqual({ provider: "bedrock", model: "claude-opus-4-9" });
		expect(tiers.sonnet).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
	});

	test("treats empty or whitespace env values as unset", () => {
		const tiers = resolveModelTiers({ WARREN_MODEL_OPUS: "   ", WARREN_MODEL_SONNET: "" });
		expect(tiers.opus.model).toBe("claude-opus-4-8");
		expect(tiers.sonnet.model).toBe("claude-sonnet-4-6");
	});
});

describe("MODEL_TIERS", () => {
	test("exposes resolved, non-empty opus and sonnet tiers", () => {
		expect(MODEL_TIERS.opus.provider.length).toBeGreaterThan(0);
		expect(MODEL_TIERS.opus.model.length).toBeGreaterThan(0);
		expect(MODEL_TIERS.sonnet.provider.length).toBeGreaterThan(0);
		expect(MODEL_TIERS.sonnet.model.length).toBeGreaterThan(0);
	});
});
