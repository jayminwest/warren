import { describe, expect, test } from "bun:test";
import { jsonResponse, recordingFetch } from "../forge/github/test-helpers.ts";
import { PREVIEW_FRAGMENT_END, PREVIEW_FRAGMENT_START } from "./pr.ts";
import {
	type AnnotatePrPreviewInput,
	annotatePrPreview,
	parsePrUrl,
	replaceFragment,
} from "./pr-annotate.ts";
import { MAX_PR_BODY_LENGTH } from "./pr-template.ts";

const baseInput: AnnotatePrPreviewInput = {
	prUrl: "https://github.com/x/y/pull/77",
	token: "ghp_xyz",
	preview: { state: "live", url: "https://run-abc.warren.example.com" },
};

describe("parsePrUrl", () => {
	test("parses the GitHub web URL shape", () => {
		expect(parsePrUrl("https://github.com/owner/repo/pull/42")).toEqual({
			owner: "owner",
			repo: "repo",
			number: 42,
		});
	});

	test("parses the GitHub REST API URL shape", () => {
		expect(parsePrUrl("https://api.github.com/repos/owner/repo/pulls/99")).toEqual({
			owner: "owner",
			repo: "repo",
			number: 99,
		});
	});

	test("rejects non-PR URLs and malformed shapes", () => {
		expect(parsePrUrl("")).toBeNull();
		expect(parsePrUrl("https://github.com/owner/repo")).toBeNull();
		expect(parsePrUrl("https://github.com/owner/repo/pull/abc")).toBeNull();
		expect(parsePrUrl("ftp://github.com/o/r/pull/1")).toBeNull();
	});
});

describe("replaceFragment", () => {
	test("replaces content between markers", () => {
		const body = `## Preview\n\n${PREVIEW_FRAGMENT_START}\nPreview launching…\n${PREVIEW_FRAGMENT_END}\n\n## Other`;
		const next = replaceFragment(body, `${PREVIEW_FRAGMENT_START}\nLIVE\n${PREVIEW_FRAGMENT_END}`);
		expect(next).toContain(`${PREVIEW_FRAGMENT_START}\nLIVE\n${PREVIEW_FRAGMENT_END}`);
		expect(next).not.toContain("Preview launching");
	});

	test("appends a fresh section when markers are absent", () => {
		const body = "Random body text";
		const fragment = `${PREVIEW_FRAGMENT_START}\nfoo\n${PREVIEW_FRAGMENT_END}`;
		const next = replaceFragment(body, fragment);
		expect(next).toContain("Random body text");
		expect(next).toContain("## Preview");
		expect(next).toContain(fragment);
	});

	test("is idempotent on re-run", () => {
		const body = `${PREVIEW_FRAGMENT_START}\nold\n${PREVIEW_FRAGMENT_END}`;
		const fragment = `${PREVIEW_FRAGMENT_START}\nnew\n${PREVIEW_FRAGMENT_END}`;
		const once = replaceFragment(body, fragment);
		const twice = replaceFragment(once, fragment);
		expect(twice).toBe(once);
	});
});

describe("annotatePrPreview", () => {
	test("GETs the PR, PATCHes the body with a live URL fragment", async () => {
		const body = `## Summary\n\nfoo\n\n## Preview\n\n${PREVIEW_FRAGMENT_START}\nPreview launching…\n${PREVIEW_FRAGMENT_END}\n`;
		const { fetch, calls } = recordingFetch([jsonResponse(200, { body }), jsonResponse(200, {})]);
		const result = await annotatePrPreview(baseInput, { fetch });
		expect(result).toEqual({ ok: true, mode: "patched" });
		expect(calls).toHaveLength(2);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe("https://api.github.com/repos/x/y/pulls/77");
		expect(calls[1]?.method).toBe("PATCH");
		const patchBody = JSON.parse(calls[1]?.body as string) as { body: string };
		expect(patchBody.body).toContain(
			"[https://run-abc.warren.example.com](https://run-abc.warren.example.com)",
		);
		expect(patchBody.body).not.toContain("Preview launching");
	});

	test("PATCHes a failure tail when preview state is failed", async () => {
		const body = `## Preview\n\n${PREVIEW_FRAGMENT_START}\nPreview launching…\n${PREVIEW_FRAGMENT_END}\n`;
		const { fetch, calls } = recordingFetch([jsonResponse(200, { body }), jsonResponse(200, {})]);
		const result = await annotatePrPreview(
			{
				prUrl: baseInput.prUrl,
				token: baseInput.token,
				preview: { state: "failed", failureTail: "TypeError: nope" },
			},
			{ fetch },
		);
		expect(result.ok).toBe(true);
		const patchBody = JSON.parse(calls[1]?.body as string) as { body: string };
		expect(patchBody.body).toContain("❌ Preview failed");
		expect(patchBody.body).toContain("TypeError: nope");
	});

	test("returns missing_token when token is empty", async () => {
		const { fetch, calls } = recordingFetch([]);
		const result = await annotatePrPreview({ ...baseInput, token: "" }, { fetch });
		expect(result).toMatchObject({ ok: false, reason: "missing_token" });
		expect(calls).toHaveLength(0);
	});

	test("returns bad_url for an unrecognized prUrl", async () => {
		const { fetch, calls } = recordingFetch([]);
		const result = await annotatePrPreview({ ...baseInput, prUrl: "not a url" }, { fetch });
		expect(result).toMatchObject({ ok: false, reason: "bad_url" });
		expect(calls).toHaveLength(0);
	});

	test("returns http_error when GET /pulls/N fails after the retry budget", async () => {
		// The transport core's retry policy retries 5xx twice (3 attempts).
		const { fetch, calls } = recordingFetch([
			new Response("nope", { status: 500 }),
			new Response("nope", { status: 500 }),
			new Response("nope", { status: 500 }),
		]);
		const result = await annotatePrPreview(baseInput, { fetch });
		expect(result).toMatchObject({ ok: false, reason: "http_error" });
		expect(calls).toHaveLength(3);
	});

	test("retries a transient GET failure once, then succeeds", async () => {
		// New behavior from adopting the transport core: this call site had
		// no retry at all before the migration (forge-contract.md §6.5).
		const body = `${PREVIEW_FRAGMENT_START}\nx\n${PREVIEW_FRAGMENT_END}`;
		const { fetch, calls } = recordingFetch([
			new Response("boom", { status: 503 }),
			jsonResponse(200, { body }),
			jsonResponse(200, {}),
		]);
		const result = await annotatePrPreview(baseInput, { fetch });
		expect(result).toMatchObject({ ok: true, mode: "patched" });
		expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
	});

	test("returns http_error when PATCH /pulls/N fails", async () => {
		const body = `${PREVIEW_FRAGMENT_START}\nold\n${PREVIEW_FRAGMENT_END}`;
		const { fetch } = recordingFetch([
			jsonResponse(200, { body }),
			new Response("nope", { status: 422 }),
		]);
		const result = await annotatePrPreview(baseInput, { fetch });
		expect(result).toMatchObject({ ok: false, reason: "http_error" });
	});

	test("returns unchanged when GET body already matches the new fragment", async () => {
		const existing = `${PREVIEW_FRAGMENT_START}\n[https://run-abc.warren.example.com](https://run-abc.warren.example.com)\n${PREVIEW_FRAGMENT_END}`;
		const body = `## Preview\n\n${existing}\n`;
		const { fetch, calls } = recordingFetch([jsonResponse(200, { body })]);
		const result = await annotatePrPreview(baseInput, { fetch });
		expect(result).toEqual({ ok: true, mode: "unchanged" });
		expect(calls).toHaveLength(1);
	});

	test("returns network when fetch keeps throwing through the retry budget", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts += 1;
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const result = await annotatePrPreview(baseInput, { fetch: fetchImpl });
		expect(result).toMatchObject({ ok: false, reason: "network" });
		expect(attempts).toBe(3);
	});

	test("re-clamps a near-limit body plus failure tail so the PATCH stays under the limit", async () => {
		// Regression for forge-contract.md §3: the annotate path used to
		// PATCH a body it never re-clamped, so a near-limit PR body plus an
		// appended failure tail exceeded GitHub's 64KB limit and 422d.
		const body = "x".repeat(MAX_PR_BODY_LENGTH - 10);
		const hugeTail = "E".repeat(4096);
		const { fetch, calls } = recordingFetch([jsonResponse(200, { body }), jsonResponse(200, {})]);
		const result = await annotatePrPreview(
			{
				prUrl: baseInput.prUrl,
				token: baseInput.token,
				preview: { state: "failed", failureTail: hugeTail },
			},
			{ fetch },
		);
		expect(result).toMatchObject({ ok: true, mode: "patched" });
		expect(calls).toHaveLength(2);
		const patchBody = JSON.parse(calls[1]?.body as string) as { body: string };
		expect(patchBody.body.length).toBeLessThanOrEqual(MAX_PR_BODY_LENGTH);
	});
});
