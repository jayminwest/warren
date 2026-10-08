/**
 * Durable source-event identity tests (warren-323d, warren-b990).
 *
 * A review bot that edits one comment in place must surface every edit as
 * a new source fact, and a re-poll of the same edit must not. The key
 * format is also pinned: `github_events.node_id` and every
 * `review_feedback` id derive from it, so a format change would re-emit
 * every historical event as new on upgrade.
 */

import { describe, expect, test } from "bun:test";
import type { GithubIssueCommentSnapshot, GithubReviewSnapshot } from "../github/types.ts";
import { dedupeEvents, normalizeIssueComment, normalizeReview } from "./events.ts";

const REPO = "openclaw/openclaw";

/** The key `comment()` produced when the format shipped (warren-323d). */
const PINNED_COMMENT_KEY = "openclaw/openclaw|issue_comment|IC_kwDO_review|77b597263943b9bb";

function comment(overrides: Partial<GithubIssueCommentSnapshot> = {}): GithubIssueCommentSnapshot {
	return {
		nodeId: "IC_kwDO_review",
		id: 5457556862,
		authorLogin: "clawsweeper[bot]",
		authorAssociation: "NONE",
		body: "ClawSweeper picked this up.",
		createdAt: "2026-08-28T20:42:57Z",
		updatedAt: "2026-08-28T20:42:57Z",
		htmlUrl: "https://github.com/openclaw/openclaw/pull/132081#issuecomment-5457556862",
		...overrides,
	};
}

function review(overrides: Partial<GithubReviewSnapshot> = {}): GithubReviewSnapshot {
	return {
		nodeId: "PRR_review",
		id: 77,
		authorLogin: "clawsweeper[bot]",
		authorAssociation: "NONE",
		state: "COMMENTED",
		body: "first verdict",
		submittedAt: "2026-08-28T20:42:57Z",
		commitId: "abc123",
		htmlUrl: "https://github.com/openclaw/openclaw/pull/132081#pullrequestreview-77",
		...overrides,
	};
}

describe("normalizeIssueComment", () => {
	test("keeps the event key format byte-stable across releases", () => {
		// A changed format re-emits the whole durable history on upgrade.
		expect(normalizeIssueComment(REPO, comment()).key).toBe(PINNED_COMMENT_KEY);
	});

	test("a re-poll of the same comment state normalizes to the same key", () => {
		const first = normalizeIssueComment(REPO, comment());
		const again = normalizeIssueComment(REPO, comment());
		expect(again.key).toBe(first.key);
		expect(dedupeEvents([first, again]).duplicateCount).toBe(1);
	});

	test("an in-place edit of the same node is a new source fact", () => {
		const placeholder = normalizeIssueComment(REPO, comment());
		const verdict = normalizeIssueComment(
			REPO,
			comment({ body: "## Findings\n- [P1] x", updatedAt: "2026-08-29T05:41:00Z" }),
		);
		expect(verdict.nodeId).toBe(placeholder.nodeId);
		expect(verdict.key).not.toBe(placeholder.key);
		expect(verdict.key.startsWith(`${REPO}|issue_comment|IC_kwDO_review|`)).toBe(true);
	});

	test("an updated_at move alone is a new source fact", () => {
		const before = normalizeIssueComment(REPO, comment());
		const after = normalizeIssueComment(REPO, comment({ updatedAt: "2026-08-29T05:41:00Z" }));
		expect(after.key).not.toBe(before.key);
	});
});

describe("normalizeReview", () => {
	test("a review body edit is a new source fact", () => {
		// GitHub reviews carry no updated_at, so the body digest is the signal.
		const before = normalizeReview(REPO, review());
		const after = normalizeReview(REPO, review({ body: "second verdict" }));
		expect(after.nodeId).toBe(before.nodeId);
		expect(after.key).not.toBe(before.key);
	});
});
