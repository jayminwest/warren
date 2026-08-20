import { describe, expect, test } from "bun:test";
import { DefaultsConfigSchema, TrackerConfigSchema } from "./schema.ts";

/**
 * Per-project external tracker container config (warren-d3a9, plan
 * pl-a37b Track B): `tracker: { url, tokenEnv }` names a
 * warren-tracker/v1 endpoint plus the environment variable holding the
 * optional bearer. The credential is never persisted by warren — only
 * its NAME crosses the config boundary.
 */
describe("DefaultsConfigSchema tracker block", () => {
	test("leaves tracker undefined when the block is omitted (SeedsTracker default)", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.tracker).toBeUndefined();
	});

	test("accepts a url-only block (unauthenticated container)", () => {
		const parsed = DefaultsConfigSchema.safeParse({
			tracker: { url: "http://tracker.internal:8080" },
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.tracker).toEqual({ url: "http://tracker.internal:8080" });
		}
	});

	test("accepts url + tokenEnv", () => {
		const parsed = TrackerConfigSchema.safeParse({
			url: "http://tracker:8080",
			tokenEnv: "PROJ_TRACKER_TOKEN",
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects a non-URL url", () => {
		expect(TrackerConfigSchema.safeParse({ url: "not a url" }).success).toBe(false);
	});

	test("rejects a tokenEnv that is not an env variable name", () => {
		expect(
			TrackerConfigSchema.safeParse({ url: "http://tracker:8080", tokenEnv: "tracker token" })
				.success,
		).toBe(false);
	});

	test("rejects unknown keys (strict)", () => {
		expect(
			TrackerConfigSchema.safeParse({ url: "http://tracker:8080", token: "hunter2" }).success,
		).toBe(false);
	});

	test("rejects a token value in the config file itself", () => {
		// The whole point of tokenEnv: the credential never lands in the
		// repo. A literal `token` key must fail, not silently load.
		expect(
			DefaultsConfigSchema.safeParse({
				tracker: { url: "http://tracker:8080", token: "hunter2" },
			}).success,
		).toBe(false);
	});
});
