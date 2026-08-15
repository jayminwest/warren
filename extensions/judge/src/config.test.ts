import { describe, expect, test } from "bun:test";
import {
	ConfigError,
	DEFAULT_JUDGE_MODEL,
	DEFAULT_JUDGE_PROVIDER,
	resolveConfig,
} from "./config.ts";

const BASE_ENV = {
	WARREN_BASE_URL: "https://warren.example.com",
	WARREN_API_TOKEN: "token-abc",
};

describe("resolveConfig", () => {
	test("resolves the minimal contract with provider-agnostic defaults", () => {
		const config = resolveConfig({ ...BASE_ENV });
		expect(config.provider).toBe(DEFAULT_JUDGE_PROVIDER);
		expect(config.model).toBe(DEFAULT_JUDGE_MODEL);
		expect(config.warrenBaseUrl).toBe("https://warren.example.com");
		expect(config.dbPath).toBe("./data/judge.db");
		expect(config.pollIntervalMs).toBe(30_000);
		expect(config.maxCostUsdPerJudgment).toBe(0.25);
		expect(config.dailyBudgetUsd).toBe(5);
		expect(config.maxRetries).toBe(2);
		expect(config.maxPages).toBe(40);
		expect(config.eventsPageSize).toBe(200);
		expect(config.exportPort).toBe(8080);
		expect(config.exportToken).toBeNull();
	});

	test("resolves the export surface knobs; an empty token disables the surface", () => {
		const config = resolveConfig({
			...BASE_ENV,
			JUDGE_EXPORT_PORT: "9471",
			JUDGE_EXPORT_TOKEN: "static-token",
		});
		expect(config.exportPort).toBe(9471);
		expect(config.exportToken).toBe("static-token");
		expect(resolveConfig({ ...BASE_ENV, JUDGE_EXPORT_TOKEN: "" }).exportToken).toBeNull();
	});

	test("honors an explicit judge provider and model pair", () => {
		const config = resolveConfig({
			...BASE_ENV,
			JUDGE_PROVIDER: "openai",
			JUDGE_MODEL: "gpt-5-mini",
		});
		expect(config.provider).toBe("openai");
		expect(config.model).toBe("gpt-5-mini");
	});

	test("honors every JUDGE_* knob", () => {
		const config = resolveConfig({
			...BASE_ENV,
			JUDGE_DB_PATH: "/tmp/judge.db",
			JUDGE_POLL_INTERVAL_MS: "1000",
			JUDGE_MAX_COST_USD: "0.05",
			JUDGE_DAILY_BUDGET_USD: "1.5",
		});
		expect(config.dbPath).toBe("/tmp/judge.db");
		expect(config.pollIntervalMs).toBe(1000);
		expect(config.maxCostUsdPerJudgment).toBe(0.05);
		expect(config.dailyBudgetUsd).toBe(1.5);
	});

	test("strips a trailing slash from the base URL", () => {
		expect(resolveConfig({ ...BASE_ENV, WARREN_BASE_URL: "https://w.example.com/" }).warrenBaseUrl)
			.toBe("https://w.example.com");
	});

	test("fails fast without WARREN_BASE_URL or WARREN_API_TOKEN", () => {
		expect(() => resolveConfig({ WARREN_API_TOKEN: "t" })).toThrow(ConfigError);
		expect(() => resolveConfig({ WARREN_BASE_URL: "https://w.example.com" })).toThrow(
			/WARREN_API_TOKEN/,
		);
	});

	test("resolves the legacy per-judgment cap spelling as a fallback alias", () => {
		const config = resolveConfig({ ...BASE_ENV, JUDGE_MAX_COST_USD_PER_JUDGMENT: "0.07" });
		expect(config.maxCostUsdPerJudgment).toBe(0.07);
		const both = resolveConfig({
			...BASE_ENV,
			JUDGE_MAX_COST_USD: "0.09",
			JUDGE_MAX_COST_USD_PER_JUDGMENT: "0.07",
		});
		expect(both.maxCostUsdPerJudgment).toBe(0.09);
	});

	test("rejects a malformed numeric knob", () => {
		expect(() => resolveConfig({ ...BASE_ENV, JUDGE_DAILY_BUDGET_USD: "lots" })).toThrow(
			/JUDGE_DAILY_BUDGET_USD/,
		);
		expect(() =>
			resolveConfig({ ...BASE_ENV, JUDGE_MAX_COST_USD_PER_JUDGMENT: "-1" }),
		).toThrow(ConfigError);
	});
});

describe("resolveConfig calibration", () => {
	test("disables calibration unless JUDGE_CALIBRATION_MODEL is set", () => {
		expect(resolveConfig({ ...BASE_ENV }).calibration).toBeNull();
	});

	test("resolves the strong-model pair with sample and cadence defaults", () => {
		const config = resolveConfig({ ...BASE_ENV, JUDGE_CALIBRATION_MODEL: "claude-opus-4-1" });
		expect(config.calibration).toEqual({
			provider: DEFAULT_JUDGE_PROVIDER,
			model: "claude-opus-4-1",
			sampleSize: 20,
			intervalMs: 6 * 60 * 60 * 1000,
		});
	});

	test("resolves a cross-provider pair and the JUDGE_CALIBRATION_* knobs", () => {
		const config = resolveConfig({
			...BASE_ENV,
			JUDGE_PROVIDER: "anthropic",
			JUDGE_CALIBRATION_PROVIDER: "openai",
			JUDGE_CALIBRATION_MODEL: "gpt-5",
			JUDGE_CALIBRATION_SAMPLE_SIZE: "7",
			JUDGE_CALIBRATION_INTERVAL_MS: "60000",
		});
		expect(config.calibration).toEqual({
			provider: "openai",
			model: "gpt-5",
			sampleSize: 7,
			intervalMs: 60_000,
		});
	});

	test("falls back to JUDGE_PROVIDER when JUDGE_CALIBRATION_PROVIDER is unset", () => {
		const config = resolveConfig({
			...BASE_ENV,
			JUDGE_PROVIDER: "openai",
			JUDGE_CALIBRATION_MODEL: "gpt-5",
		});
		expect(config.calibration?.provider).toBe("openai");
	});

	test("rejects a malformed calibration sample size", () => {
		expect(() =>
			resolveConfig({
				...BASE_ENV,
				JUDGE_CALIBRATION_MODEL: "gpt-5",
				JUDGE_CALIBRATION_SAMPLE_SIZE: "abc",
			}),
		).toThrow(ConfigError);
	});
});
