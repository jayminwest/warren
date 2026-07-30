import { describe, expect, test } from "bun:test";
import { jsonResponse, recordingFetch } from "./pr.test-helpers.ts";
import { checkPullRequestMerged, parsePullRequestUrl, parseRetryAfterMs } from "./pr.ts";

describe("checkPullRequestMerged", () => {
	const baseArgs = { owner: "jayminwest", repo: "warren", number: 42, token: "ghp_xyz" };

	test("returns missing_token when token is empty", async () => {
		const { fetch, calls } = recordingFetch([]);
		const result = await checkPullRequestMerged({ ...baseArgs, token: "", fetch });
		expect(result.kind).toBe("missing_token");
		expect((result as { message: string }).message).toContain("GITHUB_TOKEN unset");
		expect(calls).toHaveLength(0);
	});

	test("200 with merged_at non-null → merged", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(200, { merged_at: "2026-05-17T12:00:00Z", state: "closed" }),
		]);
		const result = await checkPullRequestMerged({ ...baseArgs, fetch });
		expect(result).toEqual({ kind: "merged", mergedAt: "2026-05-17T12:00:00Z" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe("https://api.github.com/repos/jayminwest/warren/pulls/42");
		expect(calls[0]?.headers.authorization).toBe("Bearer ghp_xyz");
		expect(calls[0]?.headers.accept).toBe("application/vnd.github+json");
	});

	test("200 with merged_at null + state:'open' → open", async () => {
		const { fetch } = recordingFetch([jsonResponse(200, { merged_at: null, state: "open" })]);
		const result = await checkPullRequestMerged({ ...baseArgs, fetch });
		expect(result).toEqual({ kind: "open" });
	});

	test("200 with state:'closed' + merged_at null → closed_unmerged", async () => {
		const { fetch } = recordingFetch([jsonResponse(200, { merged_at: null, state: "closed" })]);
		const result = await checkPullRequestMerged({ ...baseArgs, fetch });
		expect(result).toEqual({ kind: "closed_unmerged" });
	});

	test("404 → http_error", async () => {
		const { fetch } = recordingFetch([jsonResponse(404, { message: "Not Found" })]);
		const result = await checkPullRequestMerged({ ...baseArgs, fetch });
		expect(result.kind).toBe("http_error");
		expect((result as { status: number }).status).toBe(404);
		expect((result as { message: string }).message).toContain("404");
	});

	test("429 → rate_limited with the Retry-After hint parsed", async () => {
		const res = jsonResponse(429, { message: "API rate limit exceeded" });
		res.headers.set("retry-after", "30");
		const { fetch } = recordingFetch([res]);
		const result = await checkPullRequestMerged({ ...baseArgs, fetch });
		expect(result.kind).toBe("rate_limited");
		expect((result as { retryAfterMs: number | null }).retryAfterMs).toBe(30_000);
		expect((result as { message: string }).message).toContain("429");
	});

	test("429 without a Retry-After header → rate_limited with null hint", async () => {
		const { fetch } = recordingFetch([jsonResponse(429, { message: "secondary rate limit" })]);
		const result = await checkPullRequestMerged({ ...baseArgs, fetch });
		expect(result).toMatchObject({ kind: "rate_limited", retryAfterMs: null });
	});

	test("fetch throw → http_error with status 0", async () => {
		const failingFetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const result = await checkPullRequestMerged({ ...baseArgs, fetch: failingFetch });
		expect(result.kind).toBe("http_error");
		expect((result as { status: number }).status).toBe(0);
		expect((result as { message: string }).message).toContain("ECONNREFUSED");
	});
});

describe("parseRetryAfterMs", () => {
	test("parses the delta-seconds form", () => {
		expect(parseRetryAfterMs("30")).toBe(30_000);
		expect(parseRetryAfterMs(" 2 ")).toBe(2_000);
	});

	test("returns null for absent, malformed, or negative values", () => {
		expect(parseRetryAfterMs(null)).toBeNull();
		expect(parseRetryAfterMs("")).toBeNull();
		expect(parseRetryAfterMs("soon")).toBeNull();
		expect(parseRetryAfterMs("-5")).toBeNull();
		expect(parseRetryAfterMs("1.5")).toBeNull();
		// The HTTP-date form is deliberately not honored.
		expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
	});
});

describe("parsePullRequestUrl", () => {
	test("parses a canonical github.com PR URL", () => {
		expect(parsePullRequestUrl("https://github.com/jayminwest/warren/pull/42")).toEqual({
			owner: "jayminwest",
			repo: "warren",
			number: 42,
		});
	});

	test("tolerates trailing slash, query, and fragment", () => {
		expect(parsePullRequestUrl("https://github.com/o/r/pull/7/")).toEqual({
			owner: "o",
			repo: "r",
			number: 7,
		});
		expect(parsePullRequestUrl("https://github.com/o/r/pull/7?diff=split")).toEqual({
			owner: "o",
			repo: "r",
			number: 7,
		});
		expect(parsePullRequestUrl("https://github.com/o/r/pull/7#discussion_r1")).toEqual({
			owner: "o",
			repo: "r",
			number: 7,
		});
	});

	test("returns null for GHE-hosted shapes", () => {
		expect(parsePullRequestUrl("https://ghe.example.com/o/r/pull/42")).toBeNull();
	});

	test("returns null on mismatched inputs", () => {
		expect(parsePullRequestUrl("")).toBeNull();
		expect(parsePullRequestUrl("not a url")).toBeNull();
		expect(parsePullRequestUrl("https://github.com/o/r/issues/42")).toBeNull();
		expect(parsePullRequestUrl("http://github.com/o/r/pull/42")).toBeNull();
		expect(parsePullRequestUrl("https://github.com/o/r/pull/abc")).toBeNull();
		expect(parsePullRequestUrl("https://github.com/o/r/pull/0")).toBeNull();
	});
});
