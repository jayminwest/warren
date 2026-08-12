import { describe, expect, test } from "bun:test";
import { parsePullRequestUrl } from "./pr.ts";

// warren-63e7: the `checkPullRequestMerged` and `parseRetryAfterMs`
// describes died with the helper itself — the merge gate polls through the
// Forge seam now (see src/plan-runs/pr-merge.test.ts), and the Retry-After
// parser is covered at its home in src/forge/github/errors.test.ts.

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
