import { describe, expect, test } from "bun:test";
import {
	buildGitHubHeaders,
	DEFAULT_GITHUB_USER_AGENT,
	GITHUB_API_BASE,
	GITHUB_API_VERSION,
} from "./headers.ts";

describe("buildGitHubHeaders", () => {
	test("includes the full canonical header set, including content-type", () => {
		const headers = buildGitHubHeaders("tok");
		expect(headers).toEqual({
			accept: "application/vnd.github+json",
			authorization: "Bearer tok",
			"content-type": "application/json",
			"user-agent": DEFAULT_GITHUB_USER_AGENT,
			"x-github-api-version": GITHUB_API_VERSION,
		});
	});

	test("honors a subsystem user-agent override", () => {
		const headers = buildGitHubHeaders("tok", { userAgent: "warren-ci-fixer" });
		expect(headers["user-agent"]).toBe("warren-ci-fixer");
	});

	test("interpolates any token verbatim with no length assumption (§6.9)", () => {
		// Live installation tokens are a stateless ghs_ format observed at
		// 383 chars — the builder must not care.
		const long = `ghs_${"a".repeat(377)}`;
		expect(buildGitHubHeaders(long).authorization).toBe(`Bearer ${long}`);
		expect(buildGitHubHeaders("").authorization).toBe("Bearer ");
	});

	test("pins the documented API base and version", () => {
		expect(GITHUB_API_BASE).toBe("https://api.github.com");
		expect(GITHUB_API_VERSION).toBe("2022-11-28");
	});
});
