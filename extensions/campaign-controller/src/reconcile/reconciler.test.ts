/**
 * Fake-infrastructure tests for read-only upstream PR reconciliation
 * (plan pl-91b6 step 9, warren-323d).
 *
 * Every scenario runs against the deterministic fake GitHub server through
 * the same `GithubTransport` seam as production, and every test asserts (or
 * relies on the final test asserting) that only GET/HEAD requests were
 * issued. The store is a real SQLite file, so restart recovery is exercised
 * by reopening the database, not by resetting memory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { ReadOnlyGithubClient } from "../github/client.ts";
import { FakeGithubServer } from "../github/fake-server.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import { UpstreamPrReconciler, type UpstreamPrTarget } from "./reconciler.ts";

const OWNER = "openclaw";
const REPO = "openclaw";
const REPO_FULL = `${OWNER}/${REPO}`;
const BOT = "warren-run-bot";
const PR_NUMBER = 7;
const HEAD_SHA = "abc123";
const NOW = Date.parse("2026-08-25T00:00:00Z");

function prBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 900,
		node_id: "PR_1",
		number: PR_NUMBER,
		state: "open",
		draft: false,
		title: "Fix the thing",
		user: { login: BOT },
		head: { ref: "warren/issue-42", sha: HEAD_SHA, repo: { full_name: `${BOT}/${REPO}` } },
		base: { ref: "main", sha: "def456", repo: { full_name: REPO_FULL } },
		merged_at: null,
		closed_at: null,
		created_at: "2026-08-01T00:00:00Z",
		updated_at: "2026-08-02T00:00:00Z",
		html_url: `https://github.com/${REPO_FULL}/pull/${PR_NUMBER}`,
		...overrides,
	};
}

function reviewBody(
	nodeId: string,
	login: string,
	state: string,
	submittedAt: string,
): Record<string, unknown> {
	return {
		id: nodeId.length,
		node_id: nodeId,
		user: { login },
		author_association: "MEMBER",
		state,
		body: "review body text",
		submitted_at: submittedAt,
		commit_id: HEAD_SHA,
		html_url: `https://github.com/${REPO_FULL}/pull/${PR_NUMBER}#review-${nodeId}`,
	};
}

function issueCommentBody(
	nodeId: string,
	login: string,
	updatedAt: string,
	body: string,
): Record<string, unknown> {
	return {
		id: nodeId.length,
		node_id: nodeId,
		user: { login },
		author_association: "MEMBER",
		body,
		created_at: "2026-08-02T00:00:00Z",
		updated_at: updatedAt,
		html_url: `https://github.com/${REPO_FULL}/issues/${PR_NUMBER}#issuecomment-${nodeId}`,
	};
}

function reviewCommentBody(
	nodeId: string,
	login: string,
	updatedAt: string,
): Record<string, unknown> {
	return {
		id: nodeId.length,
		node_id: nodeId,
		user: { login },
		author_association: "CONTRIBUTOR",
		body: "code comment text",
		created_at: "2026-08-02T00:00:00Z",
		updated_at: updatedAt,
		html_url: `https://github.com/${REPO_FULL}/pull/${PR_NUMBER}#discussion-${nodeId}`,
	};
}

function checkRunBody(
	nodeId: string,
	name: string,
	status: string,
	conclusion: string | null,
): Record<string, unknown> {
	return {
		id: nodeId.length,
		node_id: nodeId,
		name,
		status,
		conclusion,
		started_at: "2026-08-02T00:00:00Z",
		completed_at: status === "completed" ? "2026-08-02T00:01:00Z" : null,
		details_url: null,
		html_url: `https://github.com/${REPO_FULL}/runs/${nodeId}`,
	};
}

function notificationBody(nodeId: string, title: string): Record<string, unknown> {
	return {
		id: nodeId,
		reason: "review_requested",
		updated_at: "2026-08-03T00:00:00Z",
		subject: { type: "PullRequest", title, url: `https://github.com/${REPO_FULL}` },
		repository: { full_name: REPO_FULL },
	};
}

interface Harness {
	server: FakeGithubServer;
	client: ReadOnlyGithubClient;
	store: CampaignStateStore;
	reconciler: UpstreamPrReconciler;
	dir: string;
	campaignId: string;
	workItemId: string;
	target: (overrides?: Partial<UpstreamPrTarget>) => UpstreamPrTarget;
}

function newHarness(options: { perPage?: number; maxPages?: number } = {}): Harness {
	const clock = new FixedClock(NOW);
	const server = new FakeGithubServer({ clock });
	const client = new ReadOnlyGithubClient(server, {
		perPage: options.perPage ?? 2,
		maxPages: options.maxPages ?? 10,
	});
	const dir = mkdtempSync(join(tmpdir(), "campaign-reconcile-"));
	const store = new CampaignStateStore(join(dir, "state.db"), {
		clock,
		ids: new SequentialIdGenerator(),
	});
	const campaign = store.campaigns.createCampaign({
		manifestDigest: `digest-${Math.random().toString(36).slice(2)}`,
		manifestJson: "{}",
	});
	const workItem = store.campaigns.addWorkItem({
		campaignId: campaign.id,
		position: 1,
		issueRef: "issue://42",
	});
	const reconciler = new UpstreamPrReconciler({ client, store, clock });
	return {
		server,
		client,
		store,
		reconciler,
		dir,
		campaignId: campaign.id,
		workItemId: workItem.id,
		target: (overrides = {}) => ({
			campaignId: campaign.id,
			workItemId: workItem.id,
			upstreamOwner: OWNER,
			upstreamRepo: REPO,
			prNumber: PR_NUMBER,
			botLogin: BOT,
			...overrides,
		}),
	};
}

/** Seed the default upstream world: one open bot PR, quiet everywhere. */
function seedQuietUpstream(h: Harness): void {
	h.server.setPaginatedCollection("/notifications", []);
	h.server.setResource(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}`, prBody());
	h.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`, []);
	h.server.setPaginatedCollection(`/repos/${REPO_FULL}/issues/${PR_NUMBER}/comments`, []);
	h.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/comments`, []);
	h.server.setResource(`/repos/${REPO_FULL}/commits/${HEAD_SHA}/check-runs`, {
		total_count: 0,
		check_runs: [],
	});
	h.server.setResource(`/repos/${REPO_FULL}/commits/${HEAD_SHA}/status`, {
		state: "success",
		total_count: 0,
		sha: HEAD_SHA,
		statuses: [],
	});
}

function openReasons(h: Harness): string[] {
	return h.store.events.listOpenAttention(h.campaignId).map((item) => item.reason);
}

function eventCount(h: Harness): number {
	return h.store.events.listGithubEvents(h.campaignId).length;
}

let harness: Harness;

beforeEach(() => {
	harness = newHarness();
});

afterEach(() => {
	harness.store.close();
	rmSync(harness.dir, { recursive: true, force: true });
});

describe("UpstreamPrReconciler", () => {
	test("reconciles paginated upstream state and dedupes reordered re-polls", async () => {
		seedQuietUpstream(harness);
		const reviews = [
			reviewBody("RV_1", "maintainer", "COMMENTED", "2026-08-03T00:00:00Z"),
			reviewBody("RV_2", "maintainer", "CHANGES_REQUESTED", "2026-08-04T00:00:00Z"),
			reviewBody("RV_3", "maintainer", "APPROVED", "2026-08-05T00:00:00Z"),
		];
		harness.server.setPaginatedCollection(
			`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`,
			reviews,
		);
		const first = await harness.reconciler.reconcile(harness.target());
		// pr + 3 reviews + combined status = 5 durable events (perPage 2 → 2 pages).
		expect(first.newEvents).toBe(5);
		expect(first.prMissing).toBe(false);
		expect(first.truncated).toBe(false);

		// Reordered pages plus a re-delivered duplicate node id.
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`, [
			reviews[2],
			reviews[1],
			reviews[0],
			reviews[1],
		]);
		const second = await harness.reconciler.reconcile(harness.target());
		expect(second.newEvents).toBe(0);
		expect(second.duplicateEvents).toBeGreaterThan(0);
		expect(eventCount(harness)).toBe(5);
		// Requested changes raised once and stays exactly once.
		const requested = openReasons(harness).filter((r) => r === "requested_changes");
		expect(requested).toHaveLength(1);
	});

	test("an edit produces a new durable fact and a new attention item", async () => {
		seedQuietUpstream(harness);
		const path = `/repos/${REPO_FULL}/issues/${PR_NUMBER}/comments`;
		harness.server.setPaginatedCollection(path, [
			issueCommentBody("IC_1", "maintainer", "2026-08-03T00:00:00Z", "please rebase"),
		]);
		await harness.reconciler.reconcile(harness.target());
		expect(eventCount(harness)).toBe(3); // pr + comment + status
		harness.server.mutateResource(path, [
			issueCommentBody("IC_1", "maintainer", "2026-08-06T00:00:00Z", "please rebase, again"),
		]);
		const second = await harness.reconciler.reconcile(harness.target());
		expect(second.newEvents).toBe(1);
		expect(eventCount(harness)).toBe(4);
		const maintainerItems = openReasons(harness);
		expect(maintainerItems.filter((r) => r === "maintainer_comment")).toHaveLength(2);
	});

	test("a deleted or missing PR raises unresolved ambiguity and skips sub-reads", async () => {
		harness.server.setPaginatedCollection("/notifications", []);
		// PR resource never registered → 404.
		const result = await harness.reconciler.reconcile(harness.target());
		expect(result.prMissing).toBe(true);
		expect(result.newEvents).toBe(0);
		expect(openReasons(harness)).toEqual(["unresolved_ambiguity"]);
		const prReads = harness.server
			.recordedRequests()
			.filter((r) => r.path.endsWith(`/pulls/${PR_NUMBER}/reviews`));
		expect(prReads).toHaveLength(0);
	});

	test("bot self-events are recorded as events but never attention", async () => {
		seedQuietUpstream(harness);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`, [
			reviewBody("RV_self", BOT, "COMMENTED", "2026-08-03T00:00:00Z"),
		]);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/issues/${PR_NUMBER}/comments`, [
			issueCommentBody("IC_self", BOT, "2026-08-03T00:00:00Z", "bot note to self"),
		]);
		const result = await harness.reconciler.reconcile(harness.target());
		expect(result.newEvents).toBe(4); // pr + review + comment + status
		expect(openReasons(harness)).toEqual([]);
	});

	test("maintainer comments and code review comments raise maintainer_comment", async () => {
		seedQuietUpstream(harness);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/issues/${PR_NUMBER}/comments`, [
			issueCommentBody("IC_1", "maintainer", "2026-08-03T00:00:00Z", "looks close"),
		]);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/comments`, [
			reviewCommentBody("RC_1", "reviewer", "2026-08-03T00:00:00Z"),
		]);
		await harness.reconciler.reconcile(harness.target());
		expect(openReasons(harness)).toEqual(["maintainer_comment", "maintainer_comment"]);
	});

	test("requested changes raise attention; approval does not", async () => {
		seedQuietUpstream(harness);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`, [
			reviewBody("RV_ok", "maintainer", "APPROVED", "2026-08-03T00:00:00Z"),
		]);
		await harness.reconciler.reconcile(harness.target());
		expect(openReasons(harness)).toEqual([]);
		harness.server.mutateResource(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`, [
			reviewBody("RV_ok", "maintainer", "APPROVED", "2026-08-03T00:00:00Z"),
			reviewBody("RV_block", "maintainer", "CHANGES_REQUESTED", "2026-08-04T00:00:00Z"),
		]);
		await harness.reconciler.reconcile(harness.target());
		expect(openReasons(harness)).toEqual(["requested_changes"]);
	});

	test("check runs map failing, pending, and passing states correctly", async () => {
		seedQuietUpstream(harness);
		harness.server.setResource(`/repos/${REPO_FULL}/commits/${HEAD_SHA}/check-runs`, {
			total_count: 3,
			check_runs: [
				checkRunBody("CR_fail", "ci", "completed", "failure"),
				checkRunBody("CR_wait", "ci", "in_progress", null),
				checkRunBody("CR_pass", "ci", "completed", "success"),
			],
		});
		const result = await harness.reconciler.reconcile(harness.target());
		expect(result.newEvents).toBe(5); // pr + 3 checks + status
		const failing = harness.store.events
			.listOpenAttention(harness.campaignId)
			.filter((item) => item.reason === "failing_checks");
		expect(failing).toHaveLength(1);
		expect(failing[0]?.detailJson).toContain("CR_fail");
	});

	test("a failing combined status raises failing_checks", async () => {
		seedQuietUpstream(harness);
		harness.server.setResource(`/repos/${REPO_FULL}/commits/${HEAD_SHA}/status`, {
			state: "failure",
			total_count: 1,
			sha: HEAD_SHA,
			statuses: [{ context: "ci/lint", state: "error", description: null }],
		});
		await harness.reconciler.reconcile(harness.target());
		expect(openReasons(harness)).toEqual(["failing_checks"]);
	});

	test("a changed repository policy raises policy_changed exactly once", async () => {
		seedQuietUpstream(harness);
		const policyPath = "/repos/openclaw/openclaw/contents/CONTRIBUTING.md";
		harness.server.setResource(policyPath, {
			path: "CONTRIBUTING.md",
			encoding: "none",
			content: "policy v1",
		});
		const target = harness.target({ policyPath: "CONTRIBUTING.md" });
		await harness.reconciler.reconcile(target);
		expect(openReasons(harness)).toEqual([]);
		harness.server.mutateResource(policyPath, {
			path: "CONTRIBUTING.md",
			encoding: "none",
			content: "policy v2",
		});
		const second = await harness.reconciler.reconcile(target);
		expect(second.attentionCreated).toBe(1);
		expect(openReasons(harness)).toContain("policy_changed");
		const third = await harness.reconciler.reconcile(target);
		expect(third.attentionCreated).toBe(0);
		expect(openReasons(harness).filter((r) => r === "policy_changed")).toHaveLength(1);
	});

	test("a non-bot PR author raises human_takeover", async () => {
		seedQuietUpstream(harness);
		harness.server.setResource(
			`/repos/${REPO_FULL}/pulls/${PR_NUMBER}`,
			prBody({ user: { login: "someone-else" } }),
		);
		await harness.reconciler.reconcile(harness.target());
		expect(openReasons(harness)).toEqual(["human_takeover"]);
	});

	test("external activity older than the stale bound raises stale_author_action", async () => {
		seedQuietUpstream(harness);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/issues/${PR_NUMBER}/comments`, [
			issueCommentBody("IC_1", "maintainer", "2026-08-03T00:00:00Z", "ping"),
		]);
		// NOW is 2026-08-25; the comment is weeks old.
		await harness.reconciler.reconcile(harness.target({ staleAfterMs: 3_600_000 }));
		const reasons = openReasons(harness);
		expect(reasons).toContain("stale_author_action");
		expect(reasons).toContain("maintainer_comment");
		// Fresh activity inside the bound raises no staleness.
		harness.server.mutateResource(`/repos/${REPO_FULL}/issues/${PR_NUMBER}/comments`, [
			issueCommentBody("IC_2", "maintainer", "2026-08-25T00:00:00Z", "ping again"),
		]);
		const second = await harness.reconciler.reconcile(harness.target({ staleAfterMs: 3_600_000 }));
		expect(second.attentionCreated).toBe(1); // only the fresh maintainer_comment
	});

	test("truncated pagination and unknown states raise unresolved ambiguity", async () => {
		const truncatedHarness = newHarness({ perPage: 2, maxPages: 1 });
		try {
			seedQuietUpstream(truncatedHarness);
			truncatedHarness.server.setPaginatedCollection(
				`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`,
				[
					reviewBody("RV_1", "maintainer", "COMMENTED", "2026-08-03T00:00:00Z"),
					reviewBody("RV_2", "maintainer", "COMMENTED", "2026-08-04T00:00:00Z"),
					reviewBody("RV_3", "maintainer", "COMMENTED", "2026-08-05T00:00:00Z"),
				],
			);
			const result = await truncatedHarness.reconciler.reconcile(truncatedHarness.target());
			expect(result.truncated).toBe(true);
			expect(openReasons(truncatedHarness)).toContain("unresolved_ambiguity");
		} finally {
			truncatedHarness.store.close();
			rmSync(truncatedHarness.dir, { recursive: true, force: true });
		}

		seedQuietUpstream(harness);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`, [
			reviewBody("RV_weird", "maintainer", "MYSTERY", "2026-08-03T00:00:00Z"),
		]);
		await harness.reconciler.reconcile(harness.target());
		expect(openReasons(harness)).toEqual(["unresolved_ambiguity"]);
	});

	test("restart recovery: a reopened store re-polls without new events or attention", async () => {
		seedQuietUpstream(harness);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`, [
			reviewBody("RV_2", "maintainer", "CHANGES_REQUESTED", "2026-08-04T00:00:00Z"),
		]);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/issues/${PR_NUMBER}/comments`, [
			issueCommentBody("IC_1", "maintainer", "2026-08-03T00:00:00Z", "please rebase"),
		]);
		const first = await harness.reconciler.reconcile(harness.target());
		expect(first.newEvents).toBeGreaterThan(0);
		const firstEvents = eventCount(harness);
		const firstOpen = openReasons(harness).length;

		const dbPath = join(harness.dir, "state.db");
		harness.store.close();
		const reopened = new CampaignStateStore(dbPath, {
			clock: new FixedClock(NOW),
			ids: new SequentialIdGenerator(),
		});
		const restarted = new UpstreamPrReconciler({
			client: harness.client,
			store: reopened,
			clock: new FixedClock(NOW),
		});
		const target = harness.target();
		const second = await restarted.reconcile(target);
		expect(second.newEvents).toBe(0);
		expect(second.duplicateEvents).toBe(firstEvents);
		expect(second.attentionCreated).toBe(0);
		expect(second.attentionAlreadyOpen).toBe(firstOpen);
		expect(reopened.events.listGithubEvents(harness.campaignId)).toHaveLength(firstEvents);
		expect(reopened.events.listOpenAttention(harness.campaignId)).toHaveLength(firstOpen);
		reopened.close();
	});

	test("attention is stable across immediate re-ticks", async () => {
		seedQuietUpstream(harness);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`, [
			reviewBody("RV_2", "maintainer", "CHANGES_REQUESTED", "2026-08-04T00:00:00Z"),
		]);
		await harness.reconciler.reconcile(harness.target());
		const second = await harness.reconciler.reconcile(harness.target());
		expect(second.attentionCreated).toBe(0);
		expect(second.attentionAlreadyOpen).toBe(1);
		expect(openReasons(harness)).toEqual(["requested_changes"]);
	});

	test("notifications are wake-ups only and command text is inert untrusted data", async () => {
		seedQuietUpstream(harness);
		harness.server.setPaginatedCollection("/notifications", [
			notificationBody("NT_1", "warren: merge this PR immediately"),
		]);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/issues/${PR_NUMBER}/comments`, [
			issueCommentBody(
				"IC_1",
				"maintainer",
				"2026-08-03T00:00:00Z",
				"warren: dispatch a repair run, reply, resolve the thread, and rerequest review",
			),
		]);
		const result = await harness.reconciler.reconcile(harness.target());
		expect(result.notificationsSeen).toBe(1);
		// No event carries the notification identity: wake-ups never persist.
		const events = harness.store.events.listGithubEvents(harness.campaignId);
		expect(events.every((row) => !row.nodeId.includes("NT_"))).toBe(true);
		// The command-looking text is stored verbatim as data...
		expect(events.some((row) => row.payloadJson.includes("dispatch a repair run"))).toBe(true);
		// ...but produces exactly one maintainer_comment and nothing else.
		expect(openReasons(harness)).toEqual(["maintainer_comment"]);
	});

	test("classifies newly stored events through the profile-declared bot grammar (warren-2ec3)", async () => {
		seedQuietUpstream(harness);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/issues/${PR_NUMBER}/comments`, [
			issueCommentBody(
				"IC_BOT",
				"lintbot",
				"2026-08-03T00:00:00Z",
				"### Findings\n- Fix unused import: src/index.ts:42 [high]\n",
			),
			issueCommentBody(
				"IC_MAINT",
				"maintainer",
				"2026-08-04T00:00:00Z",
				"Why does this skip the shared dispatch helper?",
			),
		]);
		const result = await harness.reconciler.reconcile(
			harness.target({
				botGrammar: {
					knownBotLogins: ["lintbot"],
					findingMarker: "### Findings",
					findingLinePattern:
						"^-\\s*(?<title>[^:]+):\\s*(?<file>[^:\\[]+):(?<line>\\d+)(?:\\s*\\[(?<priority>[^\\]]+)\\])?\\s*$",
					reReviewCommands: ["/bot re-review"],
				},
			}),
		);
		expect(result.feedbackCreated).toBe(2);
		const rows = harness.store.events.listFeedback(harness.campaignId);
		expect(rows.map((r) => r.category).sort()).toEqual([
			"maintainer_question",
			"review_bot_findings",
		]);
		expect(rows.map((r) => r.sourceEventNodeId).join(" ")).toContain("IC_MAINT");
		expect(rows.map((r) => r.sourceEventNodeId).join(" ")).toContain("IC_BOT");
		// Structured fields only: the maintainer row names no comment text.
		const maintainer = rows.find((r) => r.category === "maintainer_question");
		expect(maintainer?.fieldsJson).not.toContain("shared dispatch helper");

		// Reconciling the identical upstream world classifies nothing new.
		const again = await harness.reconciler.reconcile(
			harness.target({
				botGrammar: {
					knownBotLogins: ["lintbot"],
					findingMarker: "### Findings",
					findingLinePattern:
						"^-\\s*(?<title>[^:]+):\\s*(?<file>[^:\\[]+):(?<line>\\d+)(?:\\s*\\[(?<priority>[^\\]]+)\\])?\\s*$",
					reReviewCommands: ["/bot re-review"],
				},
			}),
		);
		expect(again.feedbackCreated).toBe(0);
		expect(harness.store.events.listFeedback(harness.campaignId)).toHaveLength(2);
	});

	test("every request the reconciler issues is GET or HEAD", async () => {
		seedQuietUpstream(harness);
		harness.server.setPaginatedCollection("/notifications", [notificationBody("NT_1", "wake up")]);
		harness.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}/reviews`, [
			reviewBody("RV_2", "maintainer", "CHANGES_REQUESTED", "2026-08-04T00:00:00Z"),
		]);
		await harness.reconciler.reconcile(harness.target());
		const requests = harness.server.recordedRequests();
		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) {
			expect(request.method === "GET" || request.method === "HEAD").toBe(true);
		}
	});
});
