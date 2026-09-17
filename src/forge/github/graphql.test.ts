/**
 * Unit tests for the GitHub GraphQL transport (plan pl-92a3, step 3) against
 * the canned-response `recordingFetch` — the same double the REST core's
 * tests use, so the shared pieces (headers, retry, classifier) are pinned
 * once here rather than per call site.
 */

import { describe, expect, test } from "bun:test";
import { GITHUB_GRAPHQL_URL, requestGitHubGraphQL } from "./graphql.ts";
import { jsonResponse, recordingFetch } from "./test-helpers.ts";

const QUERY = "mutation($input: EnablePullRequestAutoMergeInput!) { stub }";

function baseInput(overrides: Partial<Parameters<typeof requestGitHubGraphQL>[0]> = {}) {
	return { query: QUERY, token: "pat-token", context: "mutation stub", ...overrides };
}

describe("requestGitHubGraphQL", () => {
	test("POSTs the document and variables to the GraphQL endpoint with the canonical headers", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, { data: { stub: true } })]);
		const result = await requestGitHubGraphQL({
			...baseInput(),
			variables: { input: { pullRequestId: "PR_1", mergeMethod: "SQUASH" } },
			fetch,
		});
		expect(result).toEqual({ ok: true, data: { stub: true } });
		expect(calls[0]?.url).toBe(GITHUB_GRAPHQL_URL);
		expect(GITHUB_GRAPHQL_URL).toBe("https://api.github.com/graphql");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.headers.authorization).toBe("Bearer pat-token");
		expect(calls[0]?.headers["content-type"]).toBe("application/json");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			query: QUERY,
			variables: { input: { pullRequestId: "PR_1", mergeMethod: "SQUASH" } },
		});
	});

	test("omits the variables key when no variables are passed", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, { data: null })]);
		const result = await requestGitHubGraphQL({ ...baseInput(), fetch });
		expect(result).toEqual({ ok: true, data: null });
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ query: QUERY });
	});

	test("treats a 200 with a non-empty errors array as a failure carrying the parsed errors", async () => {
		const { fetch } = recordingFetch([
			jsonResponse(200, {
				data: null,
				errors: [{ message: "Auto merge is not allowed", type: "FORBIDDEN" }],
			}),
		]);
		const result = await requestGitHubGraphQL({ ...baseInput(), fetch });
		expect(result).toEqual({
			ok: false,
			error: {
				kind: "graphql",
				errors: [{ message: "Auto merge is not allowed", type: "FORBIDDEN" }],
			},
		});
	});

	test("keeps a 200-with-errors response a failure even when no row carries a message", async () => {
		const { fetch } = recordingFetch([
			jsonResponse(200, { data: null, errors: [{ type: "WEIRD" }] }),
		]);
		const result = await requestGitHubGraphQL({ ...baseInput(), fetch });
		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "graphql") {
			expect(result.error.errors).toHaveLength(0);
		} else {
			throw new Error("expected a graphql-kind failure");
		}
	});

	test("classifies a non-2xx response through the shared classifier", async () => {
		const { fetch } = recordingFetch([
			jsonResponse(403, { message: "Resource not accessible by integration" }),
		]);
		const result = await requestGitHubGraphQL({ ...baseInput(), fetch });
		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "http") {
			expect(result.error.error.kind).toBe("forbidden");
			expect(result.error.error.status).toBe(403);
		} else {
			throw new Error("expected an http-kind failure");
		}
	});

	test("retries transient 5xx in-band and surfaces the exhausted classification", async () => {
		const { fetch, calls } = recordingFetch(
			Array.from({ length: 3 }, () => jsonResponse(500, { message: "boom" })),
		);
		const result = await requestGitHubGraphQL({
			...baseInput(),
			fetch,
			retry: { sleep: async () => {} },
		});
		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "http") {
			expect(result.error.error.kind).toBe("http_error");
		}
		expect(calls).toHaveLength(3);
	});

	test("wraps a thrown fetch as a network error", async () => {
		const throwing = (async () => {
			throw new Error("connection reset");
		}) as unknown as typeof fetch;
		const result = await requestGitHubGraphQL({
			...baseInput(),
			fetch: throwing,
			retry: { maxRetries: 0 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "http") {
			expect(result.error.error.kind).toBe("network");
			expect(result.error.error.message).toContain("connection reset");
		}
	});

	test("maps an unreadable 200 body to an http failure", async () => {
		const { fetch } = recordingFetch([new Response("not json", { status: 200 })]);
		const result = await requestGitHubGraphQL({ ...baseInput(), fetch });
		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "http") {
			expect(result.error.error.kind).toBe("http_error");
			expect(result.error.error.message).toContain("unreadable body");
		}
	});
});
