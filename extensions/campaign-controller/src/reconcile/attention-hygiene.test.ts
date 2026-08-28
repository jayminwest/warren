/**
 * Attention-hygiene rules (warren-b853): failing_checks auto-resolves on a
 * green observation of the same check on the same PR, superseded-manifest
 * items resolve when the superseding manifest version is approved, and
 * review-bot placeholder comments never open attention at all.
 *
 * Each rule has a focused unit test, plus a replay over the captured
 * openclaw#131131 event sequence asserting zero stale attention rows at
 * the end. Resolution is monotonic and journal-free — attention is
 * derived state, so the resolved detail is stamped with the resolving
 * evidence and nothing is mutated elsewhere.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveCampaign, importCampaign } from "../admission.ts";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { digestOf } from "../digest.ts";
import { ReadOnlyGithubClient } from "../github/client.ts";
import { FakeGithubServer } from "../github/fake-server.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import { UpstreamPrReconciler, type UpstreamPrTarget } from "./reconciler.ts";

const OWNER = "openclaw";
const REPO = "openclaw";
const REPO_FULL = `${OWNER}/${REPO}`;
const BOT = "warren-run-bot";
const REVIEW_BOT = "openclaw-review-bot";
const HEAD_SHA = "abc123abc123abc123abc123abc123abc123abc1";
const NOW = Date.parse("2026-08-26T00:00:00Z");

function prBody(
	prNumber: number,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: prNumber,
		node_id: `PR_${prNumber}`,
		number: prNumber,
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
		html_url: `https://github.com/${REPO_FULL}/pull/${prNumber}`,
		...overrides,
	};
}

function commentBody(
	nodeId: string,
	login: string,
	association: string,
	updatedAt: string,
	body: string,
): Record<string, unknown> {
	return {
		id: nodeId.length,
		node_id: nodeId,
		user: { login },
		author_association: association,
		body,
		created_at: "2026-08-02T00:00:00Z",
		updated_at: updatedAt,
		html_url: `https://github.com/${REPO_FULL}/issues/131131#issuecomment-${nodeId}`,
	};
}

function checkRunBody(nodeId: string, name: string, conclusion: string): Record<string, unknown> {
	return {
		id: nodeId.length,
		node_id: nodeId,
		name,
		status: "completed",
		conclusion,
		started_at: "2026-08-02T00:00:00Z",
		completed_at: "2026-08-02T00:01:00Z",
		details_url: null,
		html_url: `https://github.com/${REPO_FULL}/runs/${nodeId}`,
	};
}

interface Harness {
	server: FakeGithubServer;
	store: CampaignStateStore;
	reconciler: UpstreamPrReconciler;
	dir: string;
	campaignId: string;
	target: () => UpstreamPrTarget;
}

const REPLAY_PR = 131131;

function newHarness(): Harness {
	const clock = new FixedClock(NOW);
	const server = new FakeGithubServer({ clock });
	const client = new ReadOnlyGithubClient(server, { perPage: 2, maxPages: 10 });
	const dir = mkdtempSync(join(tmpdir(), "campaign-hygiene-"));
	const store = new CampaignStateStore(join(dir, "state.db"), {
		clock,
		ids: new SequentialIdGenerator(),
	});
	const campaign = store.campaigns.createCampaign({
		manifestDigest: "digest-hygiene",
		manifestJson: "{}",
	});
	const reconciler = new UpstreamPrReconciler({ client, store, clock });
	return {
		server,
		store,
		reconciler,
		dir,
		campaignId: campaign.id,
		target: () => ({
			campaignId: campaign.id,
			workItemId: null,
			upstreamOwner: OWNER,
			upstreamRepo: REPO,
			prNumber: REPLAY_PR,
			botLogin: BOT,
		}),
	};
}

function seedPr(
	h: Harness,
	checks: Record<string, unknown>[],
	comments: Record<string, unknown>[],
	combinedState?: string,
): void {
	h.server.setPaginatedCollection("/notifications", []);
	h.server.setResource(`/repos/${REPO_FULL}/pulls/${REPLAY_PR}`, prBody(REPLAY_PR));
	h.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${REPLAY_PR}/reviews`, []);
	h.server.setPaginatedCollection(`/repos/${REPO_FULL}/issues/${REPLAY_PR}/comments`, comments);
	h.server.setPaginatedCollection(`/repos/${REPO_FULL}/pulls/${REPLAY_PR}/comments`, []);
	h.server.setResource(`/repos/${REPO_FULL}/commits/${HEAD_SHA}/check-runs`, {
		total_count: checks.length,
		check_runs: checks,
	});
	h.server.setResource(`/repos/${REPO_FULL}/commits/${HEAD_SHA}/status`, {
		state:
			combinedState ?? (checks.some((c) => c.conclusion === "failure") ? "failure" : "success"),
		total_count: checks.length,
		sha: HEAD_SHA,
		statuses: [],
	});
}

/** The captured openclaw#131131 sequence: PR seed, then the green turn. */
function seedReplayStart(h: Harness): void {
	seedPr(
		h,
		[checkRunBody("CR_fail_ci", "ci", "failure")],
		[
			commentBody(
				"IC_bot_start",
				REVIEW_BOT,
				"BOT",
				"2026-08-02T00:05:00Z",
				"Review started: automated analysis of this pull request.",
			),
			commentBody(
				"IC_maint",
				"maintainer",
				"MEMBER",
				"2026-08-02T01:00:00Z",
				"ci is red on this one, can you look?",
			),
		],
	);
}

function replayGreen(h: Harness): void {
	// The re-run of "ci" passes on the same PR; the stale failing run still
	// shows in the paginated check-run history.
	seedPr(
		h,
		[checkRunBody("CR_fail_ci", "ci", "failure"), checkRunBody("CR_green_ci", "ci", "success")],
		[
			commentBody(
				"IC_bot_start",
				REVIEW_BOT,
				"BOT",
				"2026-08-02T00:05:00Z",
				"Review started: automated analysis of this pull request.",
			),
			commentBody(
				"IC_maint",
				"maintainer",
				"MEMBER",
				"2026-08-02T01:00:00Z",
				"ci is red on this one, can you look?",
			),
		],
		"success",
	);
}

let harness: Harness;

beforeEach(() => {
	harness = newHarness();
});

afterEach(() => {
	harness.store.close();
	rmSync(harness.dir, { recursive: true, force: true });
});

describe("attention hygiene", () => {
	test("failing_checks auto-resolves when the same check name passes on the same PR", async () => {
		seedPr(harness, [checkRunBody("CR_ci", "ci", "failure")], []);
		await harness.reconciler.reconcile(harness.target());
		const failing = harness.store.events
			.listOpenAttention(harness.campaignId)
			.filter((item) => item.reason === "failing_checks");
		// The named check item and the combined rollup item.
		expect(failing).toHaveLength(2);

		seedPr(harness, [checkRunBody("CR_ci", "ci", "success")], []);
		const second = await harness.reconciler.reconcile(harness.target());
		// Both the named check item and the combined rollup item resolve.
		expect(second.attentionResolved).toBe(2);
		expect(harness.store.events.listOpenAttention(harness.campaignId)).toHaveLength(0);

		const resolved = harness.store.events
			.listAttention(harness.campaignId, true)
			.find((item) => item.reason === "failing_checks");
		expect(resolved?.resolvedAtMs).not.toBeNull();
		const detail = JSON.parse(resolved?.detailJson ?? "{}") as {
			resolvedByRule?: string;
			resolvingEventKey?: string;
		};
		expect(detail.resolvedByRule).toBe("failing_check_green");
		// The resolving event key is the passing check-run's durable key.
		expect(detail.resolvingEventKey).toContain("check_run|CR_ci");
	});

	test("a failing_checks item for a different check name stays open", async () => {
		seedPr(
			harness,
			[checkRunBody("CR_ci", "ci", "failure"), checkRunBody("CR_lint", "lint", "failure")],
			[],
		);
		await harness.reconciler.reconcile(harness.target());
		seedPr(harness, [checkRunBody("CR_ci", "ci", "success")], []);
		const second = await harness.reconciler.reconcile(harness.target());
		// ci and the combined rollup resolve; the lint item stays open.
		expect(second.attentionResolved).toBe(2);
		const open = harness.store.events.listOpenAttention(harness.campaignId);
		expect(open).toHaveLength(1);
		expect(JSON.parse(open[0]?.detailJson ?? "{}")).toMatchObject({ checkName: "lint" });
	});

	test("resolution is monotonic: a green observation twice resolves once", async () => {
		seedPr(harness, [checkRunBody("CR_ci", "ci", "failure")], []);
		await harness.reconciler.reconcile(harness.target());
		seedPr(harness, [checkRunBody("CR_ci", "ci", "success")], []);
		const second = await harness.reconciler.reconcile(harness.target());
		expect(second.attentionResolved).toBe(2);
		const third = await harness.reconciler.reconcile(harness.target());
		expect(third.attentionResolved).toBe(0);
		expect(harness.store.events.listOpenAttention(harness.campaignId)).toHaveLength(0);
	});

	test("review-bot placeholder comments never open attention", async () => {
		seedPr(
			harness,
			[],
			[
				commentBody("IC_bot_1", REVIEW_BOT, "BOT", "2026-08-02T00:05:00Z", "review started"),
				commentBody("IC_none", "drive-by-bot", "NONE", "2026-08-02T00:06:00Z", "checklist updated"),
				commentBody("IC_maint", "maintainer", "MEMBER", "2026-08-02T01:00:00Z", "real feedback"),
			],
		);
		const result = await harness.reconciler.reconcile(harness.target());
		// The placeholder comments are durable events, but not attention.
		const commentEvents = harness.store.events
			.listGithubEvents(harness.campaignId)
			.filter((row) => row.nodeId.includes("IC_bot_1") || row.nodeId.includes("IC_none"));
		expect(commentEvents.length).toBe(2);
		expect(result.attentionCreated).toBe(1); // only the maintainer comment
		const open = harness.store.events.listOpenAttention(harness.campaignId);
		expect(open).toHaveLength(1);
		expect(JSON.parse(open[0]?.detailJson ?? "{}")).toMatchObject({ nodeId: "IC_maint" });
	});

	test("superseded_by_new_manifest_version items resolve when the superseding manifest is approved", () => {
		const unapproved = {
			schemaVersion: 1,
			campaignId: "camp-hygiene",
			campaignVersion: 1,
			upstream: { owner: OWNER, repo: REPO },
			fork: { owner: BOT, repo: REPO },
			defaultBranch: "main",
			issues: [812],
			warren: {
				project: "openclaw-contrib",
				agent: "pi",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
			prompt: "Fix the assigned OpenClaw issue end to end.",
			budget: { perRunUsd: 5, dailyUsd: 20, totalUsd: 100 },
			maxConcurrentRuns: 2,
			expiresAt: "2026-12-31T00:00:00.000Z",
		};
		const policy = {
			schemaVersion: 1,
			profileId: "openclaw",
			upstream: { owner: OWNER, repo: REPO },
			source: {
				url: "https://raw.githubusercontent.com/openclaw/openclaw/main/CONTRIBUTING.md",
				fetchedAt: "2026-08-20T00:00:00.000Z",
				sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			},
			stalenessMaxDays: 90,
			issueFirstRequired: true,
			aiDisclosure: { required: true, evidenceRequired: true },
			allowedWorkTypes: ["bug-fix", "feature", "docs", "test", "refactor"],
			forbiddenPaths: [".github/workflows/*", "SECURITY.md"],
			protectedPaths: ["docs/CONSTITUTION.md", ".warren/triggers.yaml"],
			upstreamObservedMaxOpenPrs: 20,
			maxOpenPrs: 5,
			maxNewPrsPerDay: 2,
			requiredChecks: ["ci", "typecheck", "lint"],
			mutations: {
				createPullRequest: false,
				pushCommits: false,
				updateBranch: false,
				postComment: false,
				editComment: false,
				requestReview: false,
				addLabels: false,
				closePullRequest: false,
				reopenPullRequest: false,
				enableAutoMerge: false,
				mergePullRequest: false,
				editIssue: false,
			},
		};
		const sign = (m: Record<string, unknown>) => {
			const { approval: _omit, ...rest } = m;
			m.approval = {
				approvedBy: "jayminwest",
				approvedAt: "2026-08-25T12:00:00.000Z",
				manifestDigest: digestOf(rest),
			};
			return m;
		};

		const first = importCampaign(harness.store, {
			manifest: sign({ ...unapproved, campaignVersion: 1 }),
			policy,
			nowMs: NOW,
		});
		approveCampaign(harness.store, {
			campaignId: first.campaign.id,
			manifestDigest: first.manifestDigest,
			approvedBy: "jayminwest",
			nowMs: NOW,
		});
		const changed = sign({ ...unapproved, campaignVersion: 2 });
		const second = importCampaign(harness.store, { manifest: changed, policy, nowMs: NOW });
		expect(second.invalidatedPriorVersions).toBe(true);
		const superseded = harness.store.events
			.listOpenAttention(first.campaign.id)
			.filter((item) => item.reason === "superseded_by_new_manifest_version");
		expect(superseded).toHaveLength(1);

		// Approving the superseding version resolves the prior item and
		// stamps the resolving evidence into its detail JSON.
		approveCampaign(harness.store, {
			campaignId: second.campaign.id,
			manifestDigest: second.manifestDigest,
			approvedBy: "jayminwest",
			nowMs: NOW,
		});
		expect(harness.store.events.listOpenAttention(first.campaign.id)).toHaveLength(0);
		const resolved = harness.store.events
			.listAttention(first.campaign.id, true)
			.find((item) => item.reason === "superseded_by_new_manifest_version");
		expect(resolved?.resolvedAtMs).not.toBeNull();
		const detail = JSON.parse(resolved?.detailJson ?? "{}") as {
			resolvedByRule?: string;
			resolvingManifestDigest?: string;
		};
		expect(detail.resolvedByRule).toBe("superseding_manifest_approved");
		expect(detail.resolvingManifestDigest).toBe(second.manifestDigest);
	});

	test("replaying the captured openclaw#131131 sequence ends with zero stale attention rows", async () => {
		// Turn 1: red ci, a review-bot "review started" marker, and real
		// maintainer feedback — failing checks (named + combined) plus the
		// one genuine comment item.
		seedReplayStart(harness);
		const first = await harness.reconciler.reconcile(harness.target());
		expect(first.attentionCreated).toBe(3);
		let open = harness.store.events.listOpenAttention(harness.campaignId);
		console.error(
			"DEBUG",
			open.map((i) => i.detailJson),
		);
		expect(open.map((item) => item.reason).sort()).toEqual([
			"failing_checks",
			"failing_checks",
			"maintainer_comment",
		]);

		// Replay of the same page state changes nothing durably.
		await harness.reconciler.reconcile(harness.target());
		expect(harness.store.events.listOpenAttention(harness.campaignId)).toHaveLength(3);

		// Turn 2: the same check goes green on the same PR.
		replayGreen(harness);
		const second = await harness.reconciler.reconcile(harness.target());
		expect(second.attentionResolved).toBe(2);

		// End of the captured sequence: no stale rows remain. The failing
		// check resolved, the bot placeholder never opened, and the only
		// open item is the genuine maintainer comment.
		open = harness.store.events.listOpenAttention(harness.campaignId);
		expect(open).toHaveLength(1);
		expect(JSON.parse(open[0]?.detailJson ?? "{}")).toMatchObject({ nodeId: "IC_maint" });
		const resolved = harness.store.events
			.listAttention(harness.campaignId, true)
			.filter((item) => item.resolvedAtMs !== null);
		// Both the named-check and combined-rollup failing items resolved.
		expect(resolved).toHaveLength(2);
		expect(JSON.parse(resolved[0]?.detailJson ?? "{}")).toMatchObject({
			resolvedByRule: "failing_check_green",
		});
	});
});
