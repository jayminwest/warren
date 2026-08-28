/**
 * Amendment-flow end-to-end acceptance (plan pl-096b step 3, warren-35c4).
 *
 * One deterministic scenario over the fake-server vertical slice:
 *
 * 1. import/approve a one-issue campaign; tick admits and dispatches it;
 * 2. the run succeeds; the next tick reconciles it terminal — the
 *    campaign settles completed;
 * 3. the operator applies a digest-bound, owner-approved amendment
 *    appending issue 813;
 * 4. the SAME campaign row (no superseded row, no superseded attention
 *    item) re-opens and the next tick admits and dispatches 813.
 *
 * Acceptance: zero `superseded_by_new_manifest_version` attention noise
 * from the amendment path; exactly one campaign row end to end.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveCampaign, importCampaign } from "../admission.ts";
import { AMENDMENT_SCHEMA_VERSION, applyAmendment } from "../amendment.ts";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { digestOf } from "../digest.ts";
import { ReadOnlyGithubClient } from "../github/client.ts";
import { FakeGithubServer } from "../github/fake-server.ts";
import { validateCampaignManifest } from "../manifest.ts";
import { validateRepositoryPolicy } from "../repository-policy.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import { runTick, type TickDeps } from "../tick/tick.ts";
import { WarrenClient } from "../warren-client.ts";
import { FakeWarrenServer } from "../warren-fake.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const WARREN_TOKEN = "warren-amendment-token";
const FORK_BRANCH = "warren/issue-812";
const TEMP_ROOT = join(tmpdir(), `campaign-amendment-e2e-${process.pid}`);
const PROFILES_DIR = join(import.meta.dir, "..", "..", "profiles");
const COMMITTED_POLICY = JSON.parse(
	readFileSync(join(PROFILES_DIR, "openclaw.repository-policy.json"), "utf8"),
) as Record<string, unknown>;
const COMMITTED_EXAMPLE_MANIFEST = JSON.parse(
	readFileSync(join(PROFILES_DIR, "openclaw.campaign-manifest.example.json"), "utf8"),
) as Record<string, unknown>;

function campaignManifest(): Record<string, unknown> {
	const { approval: _approval, promptDigest: _promptDigest, ...rest } = COMMITTED_EXAMPLE_MANIFEST;
	const unapproved = {
		...rest,
		prompt: "Fix the assigned OpenClaw issue end to end and run the quality gates.",
		issues: [812],
	};
	return {
		...unapproved,
		approval: {
			approvedBy: "jayminwest",
			approvedAt: "2026-08-25T12:00:00.000Z",
			manifestDigest: digestOf(unapproved),
		},
	};
}

function seedGithubWorld(github: FakeGithubServer, issueNumbers: number[]): void {
	github.setResource("/repos/openclaw/openclaw", {
		node_id: "R_repo",
		name: "openclaw",
		full_name: "openclaw/openclaw",
		owner: { login: "openclaw" },
		default_branch: "main",
		fork: false,
		archived: false,
		pushed_at: null,
		html_url: "https://github.com/openclaw/openclaw",
	});
	for (const number of issueNumbers) {
		github.setResource(`/repos/openclaw/openclaw/issues/${number}`, {
			node_id: `I_${number}`,
			number,
			state: "open",
			title: `Issue ${number}: a scoped change`,
			user: { login: "openclaw-maintainer" },
			labels: [],
			created_at: "2026-08-01T00:00:00.000Z",
			updated_at: "2026-08-20T00:00:00.000Z",
			closed_at: null,
			html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
		});
	}
	github.setPaginatedCollection("/repos/openclaw/openclaw/pulls", []);
	github.setPaginatedCollection("/notifications", []);
}

describe("amendment flow end-to-end", () => {
	let store: CampaignStateStore;
	let warren: FakeWarrenServer;
	let github: FakeGithubServer;
	let deps: TickDeps;
	let campaignId: string;
	let baseDigest: string;

	beforeAll(() => {
		mkdirSync(TEMP_ROOT, { recursive: true });
		const clock = new FixedClock(NOW);
		const ids = new SequentialIdGenerator();
		store = new CampaignStateStore(join(TEMP_ROOT, "amendment.db"), { clock, ids });
		warren = new FakeWarrenServer({ token: WARREN_TOKEN });
		const warrenClient = new WarrenClient({
			baseUrl: "http://warren.test",
			token: WARREN_TOKEN,
			fetchFn: warren.fetch,
			clock,
			sleep: async () => {},
		});
		github = new FakeGithubServer({ clock });
		seedGithubWorld(github, [812]);
		const imported = importCampaign(store, {
			manifest: campaignManifest(),
			policy: COMMITTED_POLICY,
			nowMs: NOW,
		});
		approveCampaign(store, {
			campaignId: imported.campaign.id,
			manifestDigest: imported.manifestDigest,
			approvedBy: "jayminwest",
			nowMs: NOW,
		});
		campaignId = imported.campaign.id;
		baseDigest = imported.manifestDigest;
		deps = {
			store,
			warrenClient,
			github: new ReadOnlyGithubClient(github, { perPage: 2, maxPages: 10 }),
			clock,
			ids,
			policy: COMMITTED_POLICY,
			summaries: new Map(),
		};
	});

	afterAll(() => {
		store.close();
		rmSync(TEMP_ROOT, { recursive: true, force: true });
	});

	test("drives a completed campaign through an amendment to a new dispatch", async () => {
		// Committed profile data validates as-is.
		expect(() => validateRepositoryPolicy(COMMITTED_POLICY, { nowMs: NOW })).not.toThrow();
		expect(() => validateCampaignManifest(campaignManifest(), { nowMs: NOW })).not.toThrow();

		// Tick 1: admit and dispatch the original issue.
		const tick1 = await runTick(deps, campaignId);
		expect(tick1.stages.map((s) => `${s.stage}:${s.status}`)).toContain("dispatch:dispatched");
		expect(warren.createdRunCount()).toBe(1);
		expect(store.campaigns.getCampaign(campaignId)?.status).toBe("running");

		// Terminal success for issue 812.
		const dispatchStage = tick1.stages.find((s) => s.stage === "dispatch");
		const runId =
			dispatchStage === undefined ? undefined : (dispatchStage.detail as { runId?: string }).runId;
		expect(runId).toBeDefined();
		warren.setRunState(runId as string, {
			state: "succeeded",
			costUsd: 1.0,
			targetBranch: FORK_BRANCH,
		});

		// Tick 2: reconcile terminal; the campaign settles completed.
		const tick2 = await runTick(deps, campaignId);
		expect(tick2.stages.map((s) => `${s.stage}:${s.status}`)).toContain("reconcile_run:reconciled");
		expect(tick2.campaignStatus).toBe("completed");
		const items1 = store.campaigns.listWorkItems(campaignId);
		expect(items1.every((item) => item.status === "terminal")).toBe(true);

		// The amendment: append issue 813, digest-bound and owner-approved.
		const amendment = {
			schemaVersion: AMENDMENT_SCHEMA_VERSION,
			amendmentId: "ame-openclaw-append-813",
			campaignId: "camp-openclaw-eod-v0",
			baseManifestDigest: baseDigest,
			appendIssues: [813],
			approval: {
				approvedBy: "jayminwest",
				approvedAt: "2026-08-25T23:00:00.000Z",
				amendmentDigest: "",
			},
		};
		const { approval: _bound, ...unapproved } = amendment;
		amendment.approval.amendmentDigest = digestOf(unapproved);

		const applied = applyAmendment(store, { amendment, nowMs: NOW });
		expect(applied.applied).toBe(true);
		expect(applied.campaign.id).toBe(campaignId);
		expect(applied.appendedIssues).toEqual([813]);
		expect(applied.invalidatedActionIds).toEqual([]);

		// Same campaign row, in place, re-opened — ZERO superseded noise.
		expect(store.campaigns.listCampaigns()).toHaveLength(1);
		const after = store.campaigns.getCampaign(campaignId);
		expect(after?.status).toBe("approved");
		expect(after?.manifestDigest).not.toBe(baseDigest);
		expect(
			store.events
				.listAttention(campaignId, true)
				.filter((item) => item.reason === "superseded_by_new_manifest_version"),
		).toEqual([]);
		// The amendment is journaled append-only.
		expect(store.events.listAmendments(campaignId)).toHaveLength(1);

		// Tick 3: the appended issue is admitted and dispatched.
		seedGithubWorld(github, [812, 813]);
		const tick3 = await runTick(deps, campaignId);
		const stages = tick3.stages.map((s) => `${s.stage}:${s.status}`);
		expect(stages).toContain("admit:admitted");
		expect(stages).toContain("dispatch:dispatched");
		expect(warren.createdRunCount()).toBe(2);
		expect(store.campaigns.getCampaign(campaignId)?.status).toBe("running");

		// Still zero attention noise, one campaign row, one journal entry.
		expect(store.events.listOpenAttention(campaignId)).toEqual([]);
		expect(store.campaigns.listCampaigns()).toHaveLength(1);
		expect(store.events.listAmendments(campaignId)).toHaveLength(1);
	});
});
