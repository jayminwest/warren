import { describe, expect, test } from "bun:test";
import { jsonResponse } from "../github/test-helpers.ts";
import { buildGitLabHeaders, requestGitLab } from "./http.ts";

const URL_UNDER_TEST = "https://gitlab.com/api/v4/projects/acme%2Fwidget/merge_requests";

function answering(response: () => Response): typeof fetch {
	return (async () => response()) as unknown as typeof fetch;
}

describe("buildGitLabHeaders", () => {
	test("sends the token as PRIVATE-TOKEN and honours an Accept override", () => {
		expect(buildGitLabHeaders("glpat-x")).toMatchObject({
			accept: "application/json",
			"private-token": "glpat-x",
		});
		expect(buildGitLabHeaders("glpat-x", "text/plain").accept).toBe("text/plain");
	});
});

describe("requestGitLab", () => {
	test("maps GitLab's status line onto the seam kinds", async () => {
		const cases: [number, string][] = [
			[401, "unauthorized"],
			[403, "forbidden"],
			[404, "not_found"],
			[409, "conflict"],
			[422, "conflict"],
			[400, "http_error"],
		];
		for (const [status, kind] of cases) {
			const result = await requestGitLab({
				url: URL_UNDER_TEST,
				token: "t",
				context: "GET /merge_requests",
				fetch: answering(() => jsonResponse(status, { message: `${status}` })),
				retry: { maxRetries: 0 },
			});
			expect(result.ok ? "ok" : result.error.kind).toBe(kind);
		}
	});

	test("carries Retry-After on a 429", async () => {
		const result = await requestGitLab({
			url: URL_UNDER_TEST,
			token: "t",
			context: "GET /merge_requests",
			fetch: answering(
				() => new Response("Retry later", { status: 429, headers: { "retry-after": "7" } }),
			),
			retry: { maxRetries: 0 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("rate_limited");
			expect(result.error.retryAfterMs).toBe(7000);
		}
	});

	test("refuses a 2xx HTML page as not the GitLab API", async () => {
		const result = await requestGitLab({
			url: URL_UNDER_TEST,
			token: "t",
			context: "GET /merge_requests",
			fetch: answering(
				() =>
					new Response("<html>Sign in</html>", {
						status: 200,
						headers: { "content-type": "text/html; charset=utf-8" },
					}),
			),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("http_error");
			expect(result.error.message).toContain("WARREN_GITLAB_URL");
		}
	});

	test("cuts a stalled call at the deadline as a network error", async () => {
		const stalled = ((_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as unknown as typeof fetch;
		const result = await requestGitLab({
			url: URL_UNDER_TEST,
			token: "t",
			context: "GET /merge_requests",
			fetch: stalled,
			timeoutMs: 20,
			retry: { maxRetries: 0 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("network");
			expect(result.error.message).toMatch(/timed out|TimeoutError|timeout/i);
		}
	});
});
