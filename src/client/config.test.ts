import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { DEFAULT_WARREN_BASE_URL, loadWarrenClientConfigFromEnv } from "./config.ts";

describe("loadWarrenClientConfigFromEnv", () => {
	test("defaults to the canonical base URL when nothing is set", () => {
		const cfg = loadWarrenClientConfigFromEnv({});
		expect(cfg.baseUrl).toBe(DEFAULT_WARREN_BASE_URL);
		expect(cfg.token).toBeUndefined();
	});

	test("uses WARREN_BASE_URL when present", () => {
		const cfg = loadWarrenClientConfigFromEnv({ WARREN_BASE_URL: "https://warren.example.com" });
		expect(cfg.baseUrl).toBe("https://warren.example.com");
	});

	test("rejects an empty WARREN_BASE_URL", () => {
		expect(() => loadWarrenClientConfigFromEnv({ WARREN_BASE_URL: "" })).toThrow(ValidationError);
	});

	test("captures WARREN_API_TOKEN when set", () => {
		const cfg = loadWarrenClientConfigFromEnv({ WARREN_API_TOKEN: "secret" });
		expect(cfg.token).toBe("secret");
	});

	test("treats an empty WARREN_API_TOKEN as absent", () => {
		const cfg = loadWarrenClientConfigFromEnv({ WARREN_API_TOKEN: "" });
		expect(cfg.token).toBeUndefined();
	});
});
