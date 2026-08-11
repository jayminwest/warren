import { describe, expect, test } from "bun:test";
import {
	classifyGitHubHttpError,
	isRateLimitedForbidden,
	networkError,
	parseRetryAfterMs,
} from "./errors.ts";

function headers(init: Record<string, string>): Headers {
	return new Headers(init);
}

describe("parseRetryAfterMs", () => {
	test("parses the delta-seconds form", () => {
		expect(parseRetryAfterMs("7")).toBe(7_000);
		expect(parseRetryAfterMs(" 3 ")).toBe(3_000);
	});

	test("rejects absent, fractional, negative, and date forms", () => {
		expect(parseRetryAfterMs(null)).toBeNull();
		expect(parseRetryAfterMs("")).toBeNull();
		expect(parseRetryAfterMs("1.5")).toBeNull();
		expect(parseRetryAfterMs("-2")).toBeNull();
		expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT")).toBeNull();
	});
});

describe("isRateLimitedForbidden", () => {
	test("true with a Retry-After header (secondary limit)", () => {
		expect(isRateLimitedForbidden(headers({ "retry-after": "30" }))).toBe(true);
	});

	test("true with x-ratelimit-remaining: 0 (primary limit)", () => {
		expect(isRateLimitedForbidden(headers({ "x-ratelimit-remaining": "0" }))).toBe(true);
	});

	test("false for a plain 403", () => {
		expect(isRateLimitedForbidden(headers({ "x-ratelimit-remaining": "59" }))).toBe(false);
		expect(isRateLimitedForbidden(headers({}))).toBe(false);
	});
});

describe("classifyGitHubHttpError", () => {
	test("429 is rate_limited and parses Retry-After", () => {
		const err = classifyGitHubHttpError(
			429,
			headers({ "retry-after": "12" }),
			"slow down",
			"GET /pulls/7",
		);
		expect(err).toEqual({
			kind: "rate_limited",
			status: 429,
			retryAfterMs: 12_000,
			message: "GET /pulls/7 returned 429: slow down",
		});
	});

	test("403 with rate-limit headers is rate_limited; plain 403 is forbidden", () => {
		expect(
			classifyGitHubHttpError(403, headers({ "x-ratelimit-remaining": "0" }), "x", "c").kind,
		).toBe("rate_limited");
		expect(classifyGitHubHttpError(403, headers({}), "x", "c").kind).toBe("forbidden");
	});

	test("401 is unauthorized; 404/410 are not_found; 409/422 are conflict", () => {
		expect(classifyGitHubHttpError(401, headers({}), "x", "c").kind).toBe("unauthorized");
		expect(classifyGitHubHttpError(404, headers({}), "x", "c").kind).toBe("not_found");
		expect(classifyGitHubHttpError(410, headers({}), "x", "c").kind).toBe("not_found");
		expect(classifyGitHubHttpError(409, headers({}), "x", "c").kind).toBe("conflict");
		expect(classifyGitHubHttpError(422, headers({}), "x", "c").kind).toBe("conflict");
	});

	test("anything else is http_error with a null hint", () => {
		const err = classifyGitHubHttpError(500, headers({}), "boom", "GET /check-runs");
		expect(err).toEqual({
			kind: "http_error",
			status: 500,
			retryAfterMs: null,
			message: "GET /check-runs returned 500: boom",
		});
	});
});

describe("networkError", () => {
	test("wraps an Error message", () => {
		const err = networkError(new Error("socket hangup"), "GET /pulls/7");
		expect(err).toEqual({
			kind: "network",
			status: 0,
			retryAfterMs: null,
			message: "GET /pulls/7 failed: socket hangup",
		});
	});

	test("stringifies non-Error throws", () => {
		expect(networkError("nope", "c").message).toBe("c failed: nope");
	});
});
