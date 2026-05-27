import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import {
	DEFAULT_IDLE_TTL_MS,
	DEFAULT_MAX_LIFETIME_MS,
	DEFAULT_MAX_LIVE,
	loadPreviewEvictionConfigFromEnv,
	WARREN_PREVIEW_EVICTION_DISABLED_ENV,
	WARREN_PREVIEW_EVICTION_TICK_MS_ENV,
	WARREN_PREVIEW_IDLE_TTL_ENV,
	WARREN_PREVIEW_MAX_LIFETIME_ENV,
	WARREN_PREVIEW_MAX_LIVE_ENV,
} from "./config.ts";

describe("loadPreviewEvictionConfigFromEnv", () => {
	test("defaults match SPEC §11.L", () => {
		expect(loadPreviewEvictionConfigFromEnv({})).toEqual({
			idleTtlMs: DEFAULT_IDLE_TTL_MS,
			maxLifetimeMs: DEFAULT_MAX_LIFETIME_MS,
			maxLive: DEFAULT_MAX_LIVE,
			tickMs: 10_000,
			disabled: false,
		});
	});

	test("parses idle TTL + max-lifetime durations", () => {
		const cfg = loadPreviewEvictionConfigFromEnv({
			[WARREN_PREVIEW_IDLE_TTL_ENV]: "5m",
			[WARREN_PREVIEW_MAX_LIFETIME_ENV]: "2h",
			[WARREN_PREVIEW_MAX_LIVE_ENV]: "5",
			[WARREN_PREVIEW_EVICTION_TICK_MS_ENV]: "1500",
		});
		expect(cfg.idleTtlMs).toBe(5 * 60_000);
		expect(cfg.maxLifetimeMs).toBe(2 * 3_600_000);
		expect(cfg.maxLive).toBe(5);
		expect(cfg.tickMs).toBe(1500);
	});

	test("WARREN_PREVIEW_EVICTION_DISABLED toggles", () => {
		expect(
			loadPreviewEvictionConfigFromEnv({ [WARREN_PREVIEW_EVICTION_DISABLED_ENV]: "1" }).disabled,
		).toBe(true);
		expect(
			loadPreviewEvictionConfigFromEnv({ [WARREN_PREVIEW_EVICTION_DISABLED_ENV]: "true" }).disabled,
		).toBe(true);
		expect(
			loadPreviewEvictionConfigFromEnv({ [WARREN_PREVIEW_EVICTION_DISABLED_ENV]: "0" }).disabled,
		).toBe(false);
	});

	test("malformed env values fail loudly (incl. junk-suffix warren-da37)", () => {
		const cases: Array<[string, string]> = [
			[WARREN_PREVIEW_IDLE_TTL_ENV, "garbage"],
			[WARREN_PREVIEW_MAX_LIVE_ENV, "0"],
			[WARREN_PREVIEW_MAX_LIVE_ENV, "-1"],
			[WARREN_PREVIEW_MAX_LIVE_ENV, "5abc"], // warren-da37: junk suffix
			[WARREN_PREVIEW_EVICTION_TICK_MS_ENV, "1500x"], // warren-da37
		];
		for (const [n, v] of cases)
			expect(() => loadPreviewEvictionConfigFromEnv({ [n]: v })).toThrow(ValidationError);
	});
});
