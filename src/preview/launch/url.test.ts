import { describe, expect, test } from "bun:test";
import { formatPreviewUrl, loadPreviewLaunchConfigFromEnv } from "./url.ts";

describe("loadPreviewLaunchConfigFromEnv", () => {
	test("returns host=null when WARREN_PREVIEW_HOST is unset", () => {
		expect(loadPreviewLaunchConfigFromEnv({})).toEqual({ host: null, mode: "path" });
	});

	test("returns host=null on whitespace-only value", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_HOST: "   " })).toEqual({
			host: null,
			mode: "path",
		});
	});

	test("returns the trimmed host suffix", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_HOST: " warren.example.com " })).toEqual(
			{ host: "warren.example.com", mode: "path" },
		);
	});

	test("defaults mode to 'path' when WARREN_PREVIEW_MODE is unset (warren-fcb7)", () => {
		expect(loadPreviewLaunchConfigFromEnv({}).mode).toBe("path");
	});

	test("accepts WARREN_PREVIEW_MODE=subdomain (case-insensitive, trimmed)", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "subdomain" }).mode).toBe(
			"subdomain",
		);
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: " SUBDOMAIN " }).mode).toBe(
			"subdomain",
		);
	});

	test("accepts WARREN_PREVIEW_MODE=path (explicit opt-in matches default)", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "path" }).mode).toBe("path");
	});

	test("invalid WARREN_PREVIEW_MODE silently falls back to 'path' default", () => {
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "wildcard" }).mode).toBe("path");
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "" }).mode).toBe("path");
		expect(loadPreviewLaunchConfigFromEnv({ WARREN_PREVIEW_MODE: "   " }).mode).toBe("path");
	});
});

describe("formatPreviewUrl", () => {
	test("subdomain mode renders https URL with run id sub-host (no trailing slash)", () => {
		expect(formatPreviewUrl("run_abc123", "warren.example.com", "subdomain")).toBe(
			"https://run-run_abc123.warren.example.com",
		);
	});

	test("path mode renders https URL under /p/<id>/ with trailing slash (warren-c3c4)", () => {
		expect(formatPreviewUrl("run_abc123", "warren.example.com", "path")).toBe(
			"https://warren.example.com/p/run_abc123/",
		);
	});
});
