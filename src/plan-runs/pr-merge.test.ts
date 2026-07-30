import { describe, expect, test } from "bun:test";
import type { CheckPrMergedResult } from "../runs/pr.ts";
import { createPrMergeChecker } from "./pr-merge.ts";

describe("createPrMergeChecker", () => {
	test("returns http_error status 0 for an unparseable URL without calling check", async () => {
		let called = false;
		const checker = createPrMergeChecker({
			token: "x",
			check: async () => {
				called = true;
				return { kind: "open" };
			},
			retryDelayMs: 0,
		});
		const result = await checker("https://example.com/not-a-pr");
		expect(result.kind).toBe("http_error");
		if (result.kind === "http_error") {
			expect(result.status).toBe(0);
			expect(result.message).toContain("unparseable");
		}
		expect(called).toBe(false);
	});

	test("returns merged on the happy path", async () => {
		const checker = createPrMergeChecker({
			token: "tok",
			check: async () => ({ kind: "merged", mergedAt: "2026-05-17T00:00:00.000Z" }),
			retryDelayMs: 0,
		});
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result.kind).toBe("merged");
	});

	test("does not retry on 4xx http errors", async () => {
		let calls = 0;
		const checker = createPrMergeChecker({
			token: "tok",
			check: async () => {
				calls += 1;
				return { kind: "http_error", status: 404, message: "Not Found" };
			},
			retryDelayMs: 0,
		});
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result.kind).toBe("http_error");
		expect(calls).toBe(1);
	});

	test("retries on transient http_error (status 0) and surfaces the eventual response", async () => {
		const responses: CheckPrMergedResult[] = [
			{ kind: "http_error", status: 0, message: "ETIMEDOUT" },
			{ kind: "http_error", status: 503, message: "Service Unavailable" },
			{ kind: "merged", mergedAt: "2026-05-17T01:00:00.000Z" },
		];
		let calls = 0;
		const checker = createPrMergeChecker({
			token: "tok",
			check: async () => {
				const next = responses[calls];
				if (next === undefined) throw new Error("ran out of stubbed responses");
				calls += 1;
				return next;
			},
			maxRetries: 2,
			retryDelayMs: 0,
		});
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result.kind).toBe("merged");
		expect(calls).toBe(3);
	});

	test("retries on rate_limited and surfaces the eventual response", async () => {
		const responses: CheckPrMergedResult[] = [
			{ kind: "rate_limited", retryAfterMs: null, message: "429" },
			{ kind: "open" },
		];
		let calls = 0;
		const checker = createPrMergeChecker({
			token: "tok",
			check: async () => {
				const next = responses[calls];
				if (next === undefined) throw new Error("ran out of stubbed responses");
				calls += 1;
				return next;
			},
			maxRetries: 2,
			retryDelayMs: 0,
		});
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result.kind).toBe("open");
		expect(calls).toBe(2);
	});

	test("honors the Retry-After hint (capped) when sleeping between rate-limited retries", async () => {
		const sleeps: number[] = [];
		let calls = 0;
		const checker = createPrMergeChecker({
			token: "tok",
			check: async () => {
				calls += 1;
				return { kind: "rate_limited", retryAfterMs: 120_000, message: "429" };
			},
			maxRetries: 1,
			retryDelayMs: 0,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result.kind).toBe("rate_limited");
		expect(calls).toBe(2);
		// 120s hint capped at MAX_RETRY_AFTER_MS (60s).
		expect(sleeps).toEqual([60_000]);
	});

	test("returns the last transient response after exhausting retries", async () => {
		let calls = 0;
		const checker = createPrMergeChecker({
			token: "tok",
			check: async () => {
				calls += 1;
				return { kind: "http_error", status: 502, message: "Bad Gateway" };
			},
			maxRetries: 1,
			retryDelayMs: 0,
		});
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result.kind).toBe("http_error");
		expect(calls).toBe(2);
	});
});
