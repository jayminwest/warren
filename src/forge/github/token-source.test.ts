import { describe, expect, test } from "bun:test";
import { StaticGitHubTokenSource } from "./token-source.ts";

describe("StaticGitHubTokenSource", () => {
	test("returns the configured secret with no known expiry (static lifetime, §4)", async () => {
		const result = await new StaticGitHubTokenSource("pat-secret").mint();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({ secret: "pat-secret", expiresAt: null });
	});

	test("an empty token reports no_credential", async () => {
		const result = await new StaticGitHubTokenSource("").mint();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("no_credential");
	});
});
