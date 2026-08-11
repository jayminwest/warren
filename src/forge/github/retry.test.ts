import { describe, expect, test } from "bun:test";
import type { GitHubHttpError } from "./errors.ts";
import {
	isTransientGitHubError,
	MAX_RETRY_AFTER_MS,
	retryDelayFor,
	withGitHubRetry,
} from "./retry.ts";

function err(overrides: Partial<GitHubHttpError>): GitHubHttpError {
	return { kind: "http_error", status: 500, retryAfterMs: null, message: "m", ...overrides };
}

describe("isTransientGitHubError", () => {
	test("retries network, 5xx, and rate_limited (the pr-merge direction)", () => {
		expect(isTransientGitHubError(err({ kind: "network", status: 0 }))).toBe(true);
		expect(isTransientGitHubError(err({ status: 500 }))).toBe(true);
		expect(isTransientGitHubError(err({ status: 503 }))).toBe(true);
		expect(isTransientGitHubError(err({ kind: "rate_limited", status: 429 }))).toBe(true);
	});

	test("treats other 4xx as fatal", () => {
		expect(isTransientGitHubError(err({ kind: "unauthorized", status: 401 }))).toBe(false);
		expect(isTransientGitHubError(err({ kind: "forbidden", status: 403 }))).toBe(false);
		expect(isTransientGitHubError(err({ kind: "not_found", status: 404 }))).toBe(false);
		expect(isTransientGitHubError(err({ kind: "conflict", status: 422 }))).toBe(false);
		expect(isTransientGitHubError(err({ status: 400 }))).toBe(false);
	});
});

describe("retryDelayFor", () => {
	test("honors Retry-After on rate_limited, capped at the max", () => {
		expect(retryDelayFor(err({ kind: "rate_limited", retryAfterMs: 2_000 }), 500)).toBe(2_000);
		expect(retryDelayFor(err({ kind: "rate_limited", retryAfterMs: 999_000 }), 500)).toBe(
			MAX_RETRY_AFTER_MS,
		);
	});

	test("falls back without a hint or for other kinds", () => {
		expect(retryDelayFor(err({ kind: "rate_limited" }), 500)).toBe(500);
		expect(retryDelayFor(err({}), 500)).toBe(500);
	});
});

describe("withGitHubRetry", () => {
	const noSleep = () => Promise.resolve();

	test("returns the first success without retrying", async () => {
		let calls = 0;
		const result = await withGitHubRetry(
			async () => {
				calls += 1;
				return { ok: true as const, value: 42 };
			},
			{ sleep: noSleep },
		);
		expect(result).toEqual({ ok: true, value: 42 });
		expect(calls).toBe(1);
	});

	test("retries a transient failure up to maxRetries, then surfaces the last error", async () => {
		let calls = 0;
		const result = await withGitHubRetry(
			async () => {
				calls += 1;
				return { ok: false as const, error: err({ kind: "network", status: 0 }) };
			},
			{ maxRetries: 2, sleep: noSleep },
		);
		expect(result.ok).toBe(false);
		expect(calls).toBe(3);
	});

	test("returns a fatal 4xx immediately with no retry", async () => {
		let calls = 0;
		const result = await withGitHubRetry(
			async () => {
				calls += 1;
				return { ok: false as const, error: err({ kind: "not_found", status: 404 }) };
			},
			{ sleep: noSleep },
		);
		expect(result).toEqual({
			ok: false,
			error: err({ kind: "not_found", status: 404 }),
		});
		expect(calls).toBe(1);
	});

	test("recovers when a later attempt succeeds", async () => {
		let calls = 0;
		const result = await withGitHubRetry(
			async () => {
				calls += 1;
				if (calls < 2) return { ok: false as const, error: err({ status: 502 }) };
				return { ok: true as const, value: "fine" };
			},
			{ sleep: noSleep },
		);
		expect(result).toEqual({ ok: true, value: "fine" });
		expect(calls).toBe(2);
	});

	test("waits the Retry-After hint on rate_limited attempts", async () => {
		const waits: number[] = [];
		const result = await withGitHubRetry(
			async () => ({
				ok: false as const,
				error: err({ kind: "rate_limited", status: 429, retryAfterMs: 1_500 }),
			}),
			{
				maxRetries: 1,
				delayMs: 500,
				sleep: (ms) => {
					waits.push(ms);
					return Promise.resolve();
				},
			},
		);
		expect(result.ok).toBe(false);
		expect(waits).toEqual([1_500]);
	});

	test("maxRetries: 0 disables retrying", async () => {
		let calls = 0;
		await withGitHubRetry(
			async () => {
				calls += 1;
				return { ok: false as const, error: err({ status: 500 }) };
			},
			{ maxRetries: 0, sleep: noSleep },
		);
		expect(calls).toBe(1);
	});
});
