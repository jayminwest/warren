import { describe, expect, test } from "bun:test";
import { requestGitHub } from "./http.ts";
import { jsonResponse, recordingFetch } from "./test-helpers.ts";

const NO_RETRY = { maxRetries: 0 };

describe("requestGitHub", () => {
	test("GETs with the canonical headers and returns the raw response", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, { ok: true })]);
		const result = await requestGitHub({
			url: "https://api.github.com/repos/o/r/pulls/7",
			token: "tok",
			context: "GET /pulls/7",
			fetch,
			retry: NO_RETRY,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(await result.response.json()).toEqual({ ok: true });
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.headers.authorization).toBe("Bearer tok");
		expect(calls[0]?.headers["x-github-api-version"]).toBe("2022-11-28");
	});

	test("serializes a JSON body for write methods", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, {})]);
		await requestGitHub({
			url: "https://api.github.com/repos/o/r/pulls/7",
			method: "PATCH",
			token: "tok",
			body: { body: "next" },
			userAgent: "warren-reap-pr-annotate",
			context: "PATCH /pulls/7",
			fetch,
			retry: NO_RETRY,
		});
		expect(calls[0]?.method).toBe("PATCH");
		expect(calls[0]?.body).toBe(JSON.stringify({ body: "next" }));
		expect(calls[0]?.headers["user-agent"]).toBe("warren-reap-pr-annotate");
		expect(calls[0]?.headers["content-type"]).toBe("application/json");
	});

	test("classifies a non-2xx response with the truncated body", async () => {
		const { fetch } = recordingFetch([new Response("x".repeat(600), { status: 404 })]);
		const result = await requestGitHub({
			url: "https://api.github.com/repos/o/r/pulls/9",
			token: "tok",
			context: "GET /pulls/9",
			fetch,
			retry: NO_RETRY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("not_found");
			expect(result.error.status).toBe(404);
			expect(result.error.message).toContain("GET /pulls/9 returned 404:");
			expect(result.error.message.length).toBeLessThan(540);
		}
	});

	test("a thrown fetch surfaces as a network error", async () => {
		const throwing = (() => Promise.reject(new Error("dns"))) as unknown as typeof fetch;
		const result = await requestGitHub({
			url: "https://api.github.com/x",
			token: "tok",
			context: "GET /x",
			fetch: throwing,
			retry: NO_RETRY,
		});
		expect(result).toEqual({
			ok: false,
			error: {
				kind: "network",
				status: 0,
				retryAfterMs: null,
				message: "GET /x failed: dns",
			},
		});
	});

	test("retries a transient 5xx and recovers", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(500, { message: "boom" }),
			jsonResponse(200, { ok: true }),
		]);
		const result = await requestGitHub({
			url: "https://api.github.com/x",
			token: "tok",
			context: "GET /x",
			fetch,
			retry: { sleep: () => Promise.resolve() },
		});
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(2);
	});

	test("does not retry a fatal 4xx", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(422, { message: "bad" })]);
		const result = await requestGitHub({
			url: "https://api.github.com/x",
			token: "tok",
			context: "POST /pulls",
			fetch,
			retry: { sleep: () => Promise.resolve() },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("conflict");
		expect(calls).toHaveLength(1);
	});
});
