import { describe, expect, test } from "bun:test";
import {
	collectProviderEnv,
	isKnownProviderName,
	KNOWN_PROVIDER_NAMES,
	normalizeProviderName,
	PROVIDER_ENV_REGISTRY,
	primaryProviderEnvKey,
	providerEnvRegistration,
} from "./providers.ts";

describe("PROVIDER_ENV_REGISTRY (warren-fb8d)", () => {
	test("covers the union of both topologies' provider sets", () => {
		// The disjoint sets that motivated the registry: burrow's
		// PI_PROVIDER_ENV_KEYS (local) + the two hand-written k8s blocks.
		for (const name of [
			"anthropic",
			"openrouter",
			"openai",
			"google",
			"groq",
			"mistral",
			"deepseek",
			"zai",
		]) {
			expect(isKnownProviderName(name)).toBe(true);
		}
		expect(KNOWN_PROVIDER_NAMES).toHaveLength(8);
	});

	test("every entry declares at least one canonical env key shaped like an env var", () => {
		for (const name of KNOWN_PROVIDER_NAMES) {
			const registration = PROVIDER_ENV_REGISTRY[name];
			expect(registration.envKeys.length).toBeGreaterThan(0);
			for (const key of [...registration.envKeys, ...registration.optionalEnvKeys]) {
				expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
			}
			// canonical key never duplicated in the optional list
			expect(registration.optionalEnvKeys).not.toContain(registration.envKeys[0]);
		}
	});

	test("name lists are frozen against mutation", () => {
		expect(Object.isFrozen(KNOWN_PROVIDER_NAMES)).toBe(true);
	});
});

describe("normalizeProviderName", () => {
	test("resolves casing variants and whitespace to the canonical name", () => {
		expect(normalizeProviderName("OpenRouter")).toBe("openrouter");
		expect(normalizeProviderName("  ANTHROPIC ")).toBe("anthropic");
	});

	test("returns undefined for unknown providers (open-ended vocabulary)", () => {
		expect(normalizeProviderName("acme-custom")).toBeUndefined();
		expect(normalizeProviderName("")).toBeUndefined();
	});
});

describe("providerEnvRegistration / primaryProviderEnvKey", () => {
	test("returns the registry entry for known providers, case-insensitively", () => {
		expect(providerEnvRegistration("openrouter")?.envKeys).toEqual(["OPENROUTER_API_KEY"]);
		expect(primaryProviderEnvKey("Groq")).toBe("GROQ_API_KEY");
	});

	test("returns undefined for unknown providers", () => {
		expect(providerEnvRegistration("acme-custom")).toBeUndefined();
		expect(primaryProviderEnvKey("acme-custom")).toBeUndefined();
	});
});

describe("collectProviderEnv", () => {
	test("collects every registry key present in the env, required and optional", () => {
		const collected = collectProviderEnv({
			ANTHROPIC_API_KEY: "sk-ant",
			ANTHROPIC_BASE_URL: "https://proxy.example.com",
			OPENROUTER_API_KEY: "sk-or",
			GROQ_API_KEY: "gsk_",
			UNRELATED_VAR: "nope",
		});
		expect(collected).toEqual({
			ANTHROPIC_API_KEY: "sk-ant",
			ANTHROPIC_BASE_URL: "https://proxy.example.com",
			OPENROUTER_API_KEY: "sk-or",
			GROQ_API_KEY: "gsk_",
		});
	});

	test("skips blank and absent keys; unknown env vars never leak in", () => {
		expect(collectProviderEnv({ OPENAI_API_KEY: "" })).toEqual({});
		expect(collectProviderEnv({})).toEqual({});
	});
});
