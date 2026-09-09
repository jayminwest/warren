import { describe, expect, test } from "bun:test";
import { assertTrackerEndpointAllowed } from "./endpoint-policy.ts";

describe("tracker endpoint policy", () => {
	test("refuses arbitrary endpoints and unrelated environment credentials", () => {
		expect(() =>
			assertTrackerEndpointAllowed({ url: "http://169.254.169.254/latest" }, {}),
		).toThrow("allowlist");
		const env = { WARREN_TRACKER_ALLOWED_URLS: '["http://tracker:8080"]' };
		expect(() =>
			assertTrackerEndpointAllowed(
				{ url: "http://tracker:8080", tokenEnv: "AWS_SECRET_ACCESS_KEY" },
				env,
			),
		).toThrow("credential name");
		expect(() =>
			assertTrackerEndpointAllowed(
				{ url: "http://tracker:8080", tokenEnv: "WARREN_TRACKER_BEARER" },
				env,
			),
		).not.toThrow();
	});
});
