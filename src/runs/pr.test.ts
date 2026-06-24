import { describe, expect, test } from "bun:test";
import { jsonResponse, recordingFetch } from "./pr.test-helpers.ts";
import {
	buildPrContent,
	loadAutoOpenPrConfigFromEnv,
	openPullRequest,
	type PrFetcher,
} from "./pr.ts";

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
