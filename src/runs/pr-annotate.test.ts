import { describe, expect, test } from "bun:test";
import { PREVIEW_FRAGMENT_END, PREVIEW_FRAGMENT_START } from "./pr.ts";
import { composePreviewBody, replaceFragment } from "./pr-annotate.ts";
import { MAX_PR_BODY_LENGTH } from "./pr-template.ts";

// warren-45e6: the URL grammar and the GET/PATCH transport left this module
// for the Forge seam (`forge.parseRepoRef` / `forge.setPullRequestBody`).
// What remains under test here is the pure domain composition.

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

describe("composePreviewBody", () => {
	test("patches a live URL fragment into the placeholder body", () => {
		const body = `## Preview\n\n${PREVIEW_FRAGMENT_START}\nPreview launching…\n${PREVIEW_FRAGMENT_END}\n`;
		const edit = composePreviewBody(body, {
			state: "live",
			url: "https://run-abc.warren.example.com",
		});
		expect(edit.changed).toBe(true);
		expect(edit.body).toContain(
			"[https://run-abc.warren.example.com](https://run-abc.warren.example.com)",
		);
		expect(edit.body).not.toContain("Preview launching");
	});

	test("patches a formatted failure tail when the launch failed", () => {
		const edit = composePreviewBody("body text", {
			state: "failed",
			failureTail: "TypeError: boom",
		});
		expect(edit.changed).toBe(true);
		expect(edit.body).toContain("❌ Preview failed:");
		expect(edit.body).toContain("TypeError: boom");
	});

	test("renders a fallback line when the failure tail is empty", () => {
		const edit = composePreviewBody("body text", { state: "failed", failureTail: "  " });
		expect(edit.body).toContain("❌ Preview failed (no stderr captured).");
	});

	test("reports changed=false when the body already carries the fragment", () => {
		const once = composePreviewBody("body text", {
			state: "live",
			url: "https://run-abc.warren.example.com",
		});
		const twice = composePreviewBody(once.body, {
			state: "live",
			url: "https://run-abc.warren.example.com",
		});
		expect(twice.changed).toBe(false);
		expect(twice.body).toBe(once.body);
	});

	test("re-clamps a near-limit body plus failure tail under the domain limit (§3)", () => {
		const body = "x".repeat(MAX_PR_BODY_LENGTH - 100);
		const edit = composePreviewBody(body, {
			state: "failed",
			failureTail: "y".repeat(500),
		});
		expect(edit.body.length).toBeLessThanOrEqual(MAX_PR_BODY_LENGTH);
	});
});
