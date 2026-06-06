import { describe, expect, test } from "bun:test";
import {
	buildPrContent,
	checkPullRequestMerged,
	loadAutoOpenPrConfigFromEnv,
	mergePullRequest,
	openPullRequest,
	type PrFetcher,
	parsePullRequestRef,
	parsePullRequestUrl,
} from "./pr.ts";

interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
}

function recordingFetch(responses: ReadonlyArray<Response | (() => Response)>): {
	fetch: typeof fetch;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	let i = 0;
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headersInit = init?.headers as Record<string, string> | undefined;
		calls.push({
			url,
			method: (init?.method ?? "GET").toUpperCase(),
			headers: headersInit ?? {},
			body: typeof init?.body === "string" ? init.body : null,
		});
		const next = responses[i++];
		if (next === undefined) throw new Error("recordingFetch: ran out of canned responses");
		return typeof next === "function" ? next() : next;
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const baseInput = {
	owner: "jayminwest",
	repo: "warren",
	head: "agent/refactor-bot/run-1",
	base: "main",
	title: "Test PR",
	body: "body",
	token: "ghp_xyz",
};

describe("openPullRequest", () => {
	test("returns ok with html_url on 201 created", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(201, { html_url: "https://github.com/jayminwest/warren/pull/42" }),
		]);
		const result = await openPullRequest(baseInput, { fetch });
		expect(result).toEqual({
			ok: true,
			url: "https://github.com/jayminwest/warren/pull/42",
			mode: "created",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe("https://api.github.com/repos/jayminwest/warren/pulls");
		expect(calls[0]?.headers.authorization).toBe("Bearer ghp_xyz");
		expect(calls[0]?.headers.accept).toBe("application/vnd.github+json");
		const body = JSON.parse(calls[0]?.body as string);
		expect(body).toEqual({
			title: "Test PR",
			body: "body",
			head: "agent/refactor-bot/run-1",
			base: "main",
		});
	});

	test("treats 422 'already exists' as success and returns the existing PR url", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(422, {
				message: "Validation Failed",
				errors: [{ message: "A pull request already exists for warren:foo." }],
			}),
			jsonResponse(200, [{ html_url: "https://github.com/jayminwest/warren/pull/9" }]),
		]);
		const result = await openPullRequest(baseInput, { fetch });
		expect(result).toEqual({
			ok: true,
			url: "https://github.com/jayminwest/warren/pull/9",
			mode: "exists",
		});
		expect(calls).toHaveLength(2);
		expect(calls[1]?.method).toBe("GET");
		expect(calls[1]?.url).toContain("head=jayminwest%3Aagent");
		expect(calls[1]?.url).toContain("base=main");
	});

	test("returns http_error for unrecognized 422 and embeds errors[] in message (warren-70c6)", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(422, {
				message: "Validation Failed",
				errors: [{ message: "No commits between main and feature." }],
			}),
		]);
		const result = await openPullRequest(baseInput, { fetch });
		expect((result as { reason: string }).reason).toBe("http_error");
		expect((result as { message: string }).message).toContain("errors="); // warren-70c6
		expect(calls).toHaveLength(1);
	});

	test("returns missing_token when token is empty", async () => {
		const { fetch, calls } = recordingFetch([]);
		const result = await openPullRequest({ ...baseInput, token: "" }, { fetch });
		expect(result).toEqual({
			ok: false,
			reason: "missing_token",
			message: "GITHUB_TOKEN unset; cannot open pull request",
		});
		expect(calls).toHaveLength(0);
	});

	test("returns network on fetch throw", async () => {
		const failingFetch: PrFetcher = {
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		};
		const result = await openPullRequest(baseInput, failingFetch);
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("network");
		expect((result as { message: string }).message).toContain("ECONNREFUSED");
	});

	test("returns http_error on a 500 response", async () => {
		const { fetch } = recordingFetch([
			new Response("oops", { status: 500, headers: { "content-type": "text/plain" } }),
		]);
		const result = await openPullRequest(baseInput, { fetch });
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toBe("http_error");
		expect((result as { message: string }).message).toContain("500");
	});
});

describe("buildPrContent", () => {
	test("first non-empty prompt line becomes the title", () => {
		const c = buildPrContent({
			prompt: "\n\nFix the auth bug in login flow\n\nMore detail follows.",
			runId: "run_abc",
			agentName: "refactor-bot",
		});
		expect(c.title).toBe("Fix the auth bug in login flow");
		expect(c.body).toContain("run_abc");
		expect(c.body).toContain("refactor-bot");
		expect(c.body).toContain("Fix the auth bug in login flow");
	});

	test("title truncates at 72 chars with ellipsis", () => {
		const long = "a".repeat(120);
		const c = buildPrContent({ prompt: long, runId: "run_x", agentName: "agt" });
		expect(c.title.length).toBeLessThanOrEqual(72);
		expect(c.title.endsWith("…")).toBe(true);
	});

	test("includes warren UI link when warrenBaseUrl is set", () => {
		const c = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "refactor-bot",
			warrenBaseUrl: "https://warren.example.com/",
		});
		expect(c.body).toContain("https://warren.example.com/#/runs/run_abc");
	});

	test("falls back to a synthetic title when prompt is whitespace", () => {
		const c = buildPrContent({ prompt: "   \n\n  ", runId: "run_abc", agentName: "refactor-bot" });
		expect(c.title).toContain("run_abc");
		expect(c.title).toContain("refactor-bot");
	});

	test("uses the resolved seed title when one is supplied", () => {
		const c = buildPrContent({
			prompt: "work on sd warren-17a4. use ml. commit when done.",
			runId: "run_abc",
			agentName: "pi",
			seed: {
				id: "warren-17a4",
				title: "Scenario 16: assert non-null cost/token columns after a pi run",
			},
		});
		expect(c.title).toBe("Scenario 16: assert non-null cost/token columns after a pi run");
		expect(c.body).toContain("## Seeds");
		expect(c.body).toContain("warren-17a4 — Scenario 16");
	});

	test("falls back to the first commit subject when no seed is supplied", () => {
		const c = buildPrContent({
			prompt: "work on sd nothing-here-or-not",
			runId: "run_abc",
			agentName: "pi",
			commits: [
				{
					sha: "abc1234abcdef",
					subject: "fix(stream): accumulate pi turn_end usage across the run",
				},
				{ sha: "deadbeefcafe1", subject: "test(stream): cover terminalDetected flush path" },
			],
		});
		expect(c.title).toBe("fix(stream): accumulate pi turn_end usage across the run");
		expect(c.body).toContain("## Summary");
		expect(c.body).toContain("## Commits (2)");
		expect(c.body).toContain("abc1234 fix(stream): accumulate pi turn_end usage across the run");
		expect(c.body).toContain("deadbee test(stream): cover terminalDetected flush path");
	});

	test("body has a zero-commits summary when no commits and no seed", () => {
		const c = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "pi",
			startedAt: "2026-05-14T05:00:00.000Z",
			endedAt: "2026-05-14T05:04:17.000Z",
		});
		expect(c.body).toContain("Agent `pi` ran for 4m 17s; no commits.");
		expect(c.body).not.toContain("## Commits");
		expect(c.body).not.toContain("## Files changed");
		expect(c.body).not.toContain("## Seeds");
	});

	test("includes a Files-changed fenced block when diffStat is non-empty", () => {
		const c = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "pi",
			diffStat: " src/runs/pr.ts             | 42 +++++++++\n 1 file changed, 42 insertions(+)\n",
		});
		expect(c.body).toContain("## Files changed");
		expect(c.body).toContain("```\nsrc/runs/pr.ts             | 42 +++++++++");
		expect(c.body).toContain("1 file changed, 42 insertions(+)");
	});

	test("omits Files-changed and Commits sections when their data is empty", () => {
		const c = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "pi",
			commits: [],
			diffStat: "",
		});
		expect(c.body).not.toContain("## Files changed");
		expect(c.body).not.toContain("## Commits");
	});

	test("formats the cost line with cost + tokens when set", () => {
		const c = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "pi",
			costUsd: 0.13,
			tokensInput: 24_600,
			tokensOutput: 5_200,
			tokensCacheRead: 21_900,
		});
		expect(c.body).toContain("**Cost:**");
		expect(c.body).toContain("$0.130");
		expect(c.body).toContain("24.6k in");
		expect(c.body).toContain("5.2k out");
		expect(c.body).toContain("21.9k cache-r");
	});

	test("collapses the prompt in a <details> block", () => {
		const c = buildPrContent({
			prompt: "do x\ndo y",
			runId: "run_abc",
			agentName: "pi",
		});
		expect(c.body).toContain("<details><summary>Show prompt</summary>");
		expect(c.body).toContain("```\ndo x\ndo y\n```");
		expect(c.body).toContain("</details>");
	});

	test("renders the run id as a code span when no warrenBaseUrl is set", () => {
		const c = buildPrContent({ prompt: "do x", runId: "run_abc", agentName: "pi" });
		expect(c.body).toContain("**Warren run:** `run_abc`");
	});

	test("emits the preview_url_or_placeholder fragment when previewOptedIn is true", () => {
		const c = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "pi",
			previewOptedIn: true,
		});
		expect(c.body).toContain("## Preview");
		expect(c.body).toContain("<!-- warren:preview-start -->");
		expect(c.body).toContain("Preview launching…");
		expect(c.body).toContain("<!-- warren:preview-end -->");
	});

	test("omits the preview fragment when previewOptedIn is absent or false", () => {
		const a = buildPrContent({ prompt: "do x", runId: "run_abc", agentName: "pi" });
		const b = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "pi",
			previewOptedIn: false,
		});
		expect(a.body).not.toContain("warren:preview-start");
		expect(b.body).not.toContain("warren:preview-start");
	});

	test("templateOverrides replaces individual fragments (warren-bd49)", () => {
		const c = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "pi",
			templateOverrides: {
				trailer: "Reviewed-by: @team",
			},
		});
		expect(c.body).toContain("Reviewed-by: @team");
		expect(c.body).not.toContain("🤖 Opened by warren run");
		expect(c.body).toContain("## Summary"); // default still applies
	});

	test("templateOverrides.title beats the seed-title precedence (warren-bd49)", () => {
		const c = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "pi",
			seed: { id: "warren-1234", title: "Seed title" },
			templateOverrides: { title: "Custom Title" },
		});
		expect(c.title).toBe("Custom Title");
	});

	test("whitespace-only override removes the fragment entirely (warren-bd49)", () => {
		const c = buildPrContent({
			prompt: "do x",
			runId: "run_abc",
			agentName: "pi",
			templateOverrides: { prompt: "" },
		});
		expect(c.body).not.toContain("## Prompt");
		expect(c.body).toContain("## Summary"); // other defaults survive
	});
});

describe("loadAutoOpenPrConfigFromEnv", () => {
	test("defaults to enabled with empty token when env is empty", () => {
		const cfg = loadAutoOpenPrConfigFromEnv({});
		expect(cfg.enabled).toBe(true);
		expect(cfg.token).toBe("");
		expect(cfg.warrenBaseUrl).toBeNull();
	});

	test("disables on falsy WARREN_AUTO_OPEN_PR values", () => {
		for (const v of ["0", "false", "FALSE", "no", "off", " "]) {
			expect(loadAutoOpenPrConfigFromEnv({ WARREN_AUTO_OPEN_PR: v }).enabled).toBe(false);
		}
	});

	test("stays enabled for any other value", () => {
		for (const v of ["1", "true", "yes", "on", "always"]) {
			expect(loadAutoOpenPrConfigFromEnv({ WARREN_AUTO_OPEN_PR: v }).enabled).toBe(true);
		}
	});

	test("forwards GITHUB_TOKEN and WARREN_BASE_URL", () => {
		const cfg = loadAutoOpenPrConfigFromEnv({
			GITHUB_TOKEN: "ghp_x",
			WARREN_BASE_URL: "https://warren.example.com",
		});
		expect(cfg.token).toBe("ghp_x");
		expect(cfg.warrenBaseUrl).toBe("https://warren.example.com");
	});
});

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

describe("parsePullRequestRef", () => {
	test("accepts canonical URL", () => {
		expect(parsePullRequestRef("https://github.com/o/r/pull/3")).toEqual({
			owner: "o",
			repo: "r",
			number: 3,
		});
	});

	test("accepts owner/repo#N shorthand", () => {
		expect(parsePullRequestRef("jayminwest/warren#42")).toEqual({
			owner: "jayminwest",
			repo: "warren",
			number: 42,
		});
		expect(parsePullRequestRef("  jayminwest/warren#1 ")).toEqual({
			owner: "jayminwest",
			repo: "warren",
			number: 1,
		});
	});

	test("rejects unrecognized shapes", () => {
		expect(parsePullRequestRef("jayminwest/warren")).toBeNull();
		expect(parsePullRequestRef("warren#42")).toBeNull();
		expect(parsePullRequestRef("o/r/issues/1")).toBeNull();
		expect(parsePullRequestRef("")).toBeNull();
	});
});

describe("mergePullRequest", () => {
	const baseMerge = {
		owner: "o",
		repo: "r",
		number: 7,
		token: "ghp_x",
	};

	test("returns merged on 200 with merged=true", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, { merged: true, sha: "abc123" })]);
		const result = await mergePullRequest({ ...baseMerge, fetch });
		expect(result.kind).toBe("merged");
		expect((result as { sha: string }).sha).toBe("abc123");
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/pulls/7/merge");
		expect(calls[0]?.headers.authorization).toBe("Bearer ghp_x");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ merge_method: "merge" });
	});

	test("forwards merge_method and commit_message", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, { merged: true, sha: "def" })]);
		await mergePullRequest({
			...baseMerge,
			mergeMethod: "squash",
			commitMessage: "chore: merge",
			fetch,
		});
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			merge_method: "squash",
			commit_message: "chore: merge",
		});
	});

	test("detects already_merged via 405 body", async () => {
		const { fetch } = recordingFetch([
			jsonResponse(405, { message: "Pull Request is already merged" }),
		]);
		const result = await mergePullRequest({ ...baseMerge, fetch });
		expect(result.kind).toBe("already_merged");
	});

	test("returns not_mergeable on 405 with non-merged message", async () => {
		const { fetch } = recordingFetch([
			jsonResponse(405, { message: "Pull Request is not mergeable" }),
		]);
		const result = await mergePullRequest({ ...baseMerge, fetch });
		expect(result.kind).toBe("not_mergeable");
		expect((result as { message: string }).message).toContain("not mergeable");
	});

	test("returns rate_limited on 403 with x-ratelimit-remaining=0", async () => {
		const resetEpoch = 1_700_000_000;
		const response = new Response(JSON.stringify({ message: "rate limit exceeded" }), {
			status: 403,
			headers: {
				"content-type": "application/json",
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": String(resetEpoch),
			},
		});
		const { fetch } = recordingFetch([response]);
		const result = await mergePullRequest({ ...baseMerge, fetch });
		expect(result.kind).toBe("rate_limited");
		expect((result as { resetAt: string | null }).resetAt).toBe(
			new Date(resetEpoch * 1000).toISOString(),
		);
	});

	test("returns rate_limited on 429", async () => {
		const { fetch } = recordingFetch([jsonResponse(429, { message: "slow down" })]);
		const result = await mergePullRequest({ ...baseMerge, fetch });
		expect(result.kind).toBe("rate_limited");
	});

	test("returns not_found on 404", async () => {
		const { fetch } = recordingFetch([jsonResponse(404, { message: "Not Found" })]);
		const result = await mergePullRequest({ ...baseMerge, fetch });
		expect(result.kind).toBe("not_found");
	});

	test("missing token short-circuits", async () => {
		const result = await mergePullRequest({ ...baseMerge, token: "" });
		expect(result.kind).toBe("missing_token");
	});

	test("network failure surfaces", async () => {
		const failing = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const result = await mergePullRequest({ ...baseMerge, fetch: failing });
		expect(result.kind).toBe("network");
		expect((result as { message: string }).message).toContain("ECONNREFUSED");
	});
});
