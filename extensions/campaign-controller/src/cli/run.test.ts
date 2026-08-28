/**
 * Operator CLI contract tests (plan pl-91b6 step 10, warren-d050).
 *
 * Every test drives `runCli` — the same entrypoint `src/cli/main.ts` uses —
 * with an injected clock and the fake Warren/GitHub servers, and pins the
 * NDJSON envelopes and exit codes:
 *
 * - manifest validate/import, digest approval, tick, status, journal, and
 *   attention list/ack success shapes;
 * - dry-run default and the refusal of any live-mode flag;
 * - missing-secret behavior (named env vars only, never echoed);
 * - credential redaction from every emitted line;
 * - concurrent-tick refusal through the campaign lease;
 * - read-only authenticated GitHub calls without and with a token.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock } from "../clock.ts";
import { digestOf } from "../digest.ts";
import { FakeGithubServer } from "../github/fake-server.ts";
import type { FetchLike as GithubFetchLike } from "../github/http-transport.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import type { FetchLike } from "../warren-client.ts";
import { FakeWarrenServer } from "../warren-fake.ts";
import { runCli } from "./run.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const WARREN_TOKEN = "warren-secret-token";
const GITHUB_TOKEN = "github-secret-token";
const BRANCH = "warren/issue-812";
const TEMP_ROOT = join(tmpdir(), `campaign-cli-test-${process.pid}`);

const POLICY: Record<string, unknown> = {
	schemaVersion: 1,
	profileId: "openclaw",
	upstream: { owner: "openclaw", repo: "openclaw" },
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
	protectedPaths: ["docs/CONSTITUTION.md"],
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

const UNAPPROVED_MANIFEST: Record<string, unknown> = {
	schemaVersion: 1,
	campaignId: "camp-openclaw-eod-v0",
	campaignVersion: 1,
	upstream: { owner: "openclaw", repo: "openclaw" },
	fork: { owner: "warren-run-bot", repo: "openclaw" },
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
const MANIFEST = {
	...UNAPPROVED_MANIFEST,
	approval: {
		approvedBy: "jayminwest",
		approvedAt: "2026-08-25T12:00:00.000Z",
		manifestDigest: digestOf(UNAPPROVED_MANIFEST),
	},
};
const MANIFEST_DIGEST = digestOf(UNAPPROVED_MANIFEST);

const SUMMARY = {
	problem: "The scheduler test flakes on cold caches.",
	solution: "Seed the scheduler's deterministic clock in the test setup.",
	userImpact: "Contributors see stable CI results; no runtime behavior changes.",
	evidence: ["bun test src/scheduler.test.ts — 42 passing", "bun run lint — clean"],
	changedPaths: ["src/scheduler/clock.ts"],
	operatorNotes: "Reviewed during the 2026-08-25 EOD dry-run session.",
};

interface CliResult {
	readonly code: number;
	readonly text: string;
}

interface Fixture {
	readonly dbPath: string;
	readonly warren: FakeWarrenServer;
	readonly github: FakeGithubServer;
	readonly baseEnv: Record<string, string>;
	run(argv: readonly string[], envOverrides?: Record<string, string>): Promise<CliResult>;
}

function seedGithub(github: FakeGithubServer): void {
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
	github.setResource("/repos/openclaw/openclaw/issues/812", {
		node_id: "I_812",
		number: 812,
		state: "open",
		title: "Flaky scheduler test",
		user: { login: "openclaw-maintainer" },
		labels: [],
		created_at: "2026-08-01T00:00:00.000Z",
		updated_at: "2026-08-20T00:00:00.000Z",
		closed_at: null,
		html_url: "https://github.com/openclaw/openclaw/issues/812",
	});
	github.setPaginatedCollection("/repos/openclaw/openclaw/pulls", [
		{
			node_id: "PR_9001",
			number: 9001,
			state: "open",
			draft: false,
			title: "Another fork contribution",
			user: { login: "warren-run-bot" },
			head: {
				ref: "warren/issue-900",
				sha: "a".repeat(40),
				repo: { full_name: "warren-run-bot/openclaw" },
			},
			base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "openclaw/openclaw" } },
			merged_at: null,
			closed_at: null,
			created_at: "2026-08-25T10:00:00.000Z",
			updated_at: "2026-08-25T10:00:00.000Z",
			html_url: "https://github.com/openclaw/openclaw/pull/9001",
		},
	]);
	github.setResource("/notifications", []);
}

/** Route the production GitHub transport's fetch onto the fake server. */
function githubFetchOf(github: FakeGithubServer): GithubFetchLike {
	return async (url, init) => {
		const parsed = new URL(url.toString());
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		const response = await github.read({
			method: (init?.method ?? "GET") === "HEAD" ? "HEAD" : "GET",
			path: `${parsed.pathname}${parsed.search}`,
			headers,
		});
		return new Response(response.body ?? null, {
			status: response.status,
			headers: response.headers,
		});
	};
}

function fixture(options: { githubToken?: string } = {}): Fixture {
	const dbPath = join(TEMP_ROOT, `db-${Math.random().toString(36).slice(2)}.sqlite`);
	const manifestPath = join(TEMP_ROOT, "manifest.json");
	const policyPath = join(TEMP_ROOT, "policy.json");
	const summariesPath = join(TEMP_ROOT, "summaries.json");
	writeFileSync(manifestPath, `${JSON.stringify(MANIFEST, null, "\t")}\n`);
	writeFileSync(policyPath, `${JSON.stringify(POLICY, null, "\t")}\n`);
	writeFileSync(summariesPath, `${JSON.stringify({ "812": SUMMARY }, null, "\t")}\n`);
	const warren = new FakeWarrenServer({ token: WARREN_TOKEN });
	const github = new FakeGithubServer({
		clock: new FixedClock(NOW),
		redactionSecret: options.githubToken,
	});
	seedGithub(github);
	const baseEnv: Record<string, string> = {
		CAMPAIGN_DB_PATH: dbPath,
		CAMPAIGN_MANIFEST_PATH: manifestPath,
		CAMPAIGN_POLICY_PATH: policyPath,
		CAMPAIGN_SUMMARIES_PATH: summariesPath,
		WARREN_BASE_URL: "http://warren.test",
		WARREN_API_TOKEN: WARREN_TOKEN,
		...(options.githubToken !== undefined ? { GITHUB_TOKEN: options.githubToken } : {}),
	};
	return {
		dbPath,
		warren,
		github,
		baseEnv,
		async run(argv, envOverrides = {}) {
			let text = "";
			const code = await runCli(argv, {
				env: { ...baseEnv, ...envOverrides },
				write: (line) => {
					text += line;
				},
				clock: new FixedClock(NOW),
				warrenFetch: warren.fetch as FetchLike,
				githubFetch: githubFetchOf(github),
			});
			return { code, text };
		},
	};
}

/** The NDJSON envelope shape every command emits exactly one of. */
interface Envelope {
	ok: boolean;
	command: string;
	result?: unknown;
	error?: { code: string; message: string; invariant?: string };
}

/** Parse the single NDJSON envelope line a command emits. */
function envelope(result: CliResult): Envelope {
	const lines = result.text.split("\n").filter((line) => line.length > 0);
	expect(lines).toHaveLength(1);
	return JSON.parse(lines[0] as string) as Envelope;
}

function record(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
	return value as unknown[];
}

/** The run id a dispatch stage correlated. */
function runIdOf(result: Record<string, unknown>): string {
	const dispatch = list(result.stages).find((stage) => record(stage).stage === "dispatch") as
		| Record<string, unknown>
		| undefined;
	const runId = record(dispatch?.detail).runId;
	expect(typeof runId).toBe("string");
	return runId as string;
}

/** Import + approve the fixture campaign; returns the campaign id. */
async function approvedCampaignId(fx: Fixture): Promise<string> {
	const imported = await fx.run(["manifest", "import"]);
	expect(imported.code).toBe(0);
	const id = (envelope(imported).result as { campaign: { id: string } }).campaign.id;
	const approved = await fx.run([
		"approve",
		"--campaign",
		id,
		"--digest",
		MANIFEST_DIGEST,
		"--by",
		"jayminwest",
	]);
	expect(approved.code).toBe(0);
	return id;
}

beforeAll(() => {
	mkdirSync(TEMP_ROOT, { recursive: true });
});

afterAll(() => {
	rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe("runCli", () => {
	test("manifest validate emits the digests with exit 0", async () => {
		const fx = fixture();
		const result = await fx.run(["manifest", "validate"]);
		expect(result.code).toBe(0);
		expect(envelope(result)).toEqual({
			ok: true,
			command: "manifest validate",
			result: {
				campaignId: "camp-openclaw-eod-v0",
				manifestDigest: MANIFEST_DIGEST,
				policyDigest: expect.any(String),
				issues: [812],
				expiresAt: "2026-12-31T00:00:00.000Z",
				promptBound: true,
			},
		});
	});

	test("an invalid manifest fails with exit 2 and input_invalid", async () => {
		const fx = fixture();
		const badPath = join(TEMP_ROOT, "bad-manifest.json");
		writeFileSync(badPath, `${JSON.stringify({ ...MANIFEST, unknownKey: 1 })}\n`);
		const result = await fx.run(["manifest", "validate"], {
			CAMPAIGN_MANIFEST_PATH: badPath,
		});
		expect(result.code).toBe(2);
		const error = envelope(result).error as Record<string, string>;
		expect(error.code).toBe("input_invalid");
	});

	test("a missing manifest path is a config error (exit 3)", async () => {
		const fx = fixture();
		const result = await fx.run(["manifest", "validate"], { CAMPAIGN_MANIFEST_PATH: "" });
		expect(result.code).toBe(3);
		const error = envelope(result).error as Record<string, string>;
		expect(error.code).toBe("config_invalid");
		expect(error.message).toContain("CAMPAIGN_MANIFEST_PATH");
	});

	test("manifest import, approval, and status round-trip", async () => {
		const fx = fixture();
		const id = await approvedCampaignId(fx);
		const status = await fx.run(["status", "--campaign", id]);
		expect(status.code).toBe(0);
		const result = record(envelope(status).result);
		expect(record(result.campaign).status).toBe("approved");
		const workItems = list(result.workItems);
		expect(workItems).toHaveLength(1);
		expect(record(workItems[0]).issueRef).toBe("812");
		expect(result.budget).toEqual({ capUsdCents: 10000, availableUsdCents: 10000 });
		expect(result.openAttention).toBe(0);
		const report = record(result.report);
		expect(report.campaignId).toBe(id);
		expect(report.prsOpened).toBe(0);
		expect(report.prsMerged).toBe(0);
		expect(report.costPerMergedPrUsdCents).toBeNull();
		expect(list(report.items)).toHaveLength(1);
	});

	test("approve with the wrong digest refuses with exit 4 and the invariant", async () => {
		const fx = fixture();
		const imported = await fx.run(["manifest", "import"]);
		const id = record(record(envelope(imported).result).campaign).id as string;
		const result = await fx.run([
			"approve",
			"--campaign",
			id,
			"--digest",
			"0".repeat(64),
			"--by",
			"jayminwest",
		]);
		expect(result.code).toBe(4);
		const error = envelope(result).error as Record<string, string>;
		expect(error.code).toBe("admission_refused");
		expect(error.invariant).toBe("approval_digest_mismatch");
	});

	test("tick is dry-run by default and composes the full pipeline", async () => {
		const fx = fixture({ githubToken: GITHUB_TOKEN });
		const id = await approvedCampaignId(fx);
		const tick1 = await fx.run(["tick", "--campaign", id, "--dry-run"]);
		expect(tick1.code).toBe(0);
		const result = record(envelope(tick1).result);
		expect(result.dryRun).toBe(true);
		expect(
			list(result.stages).map((stage) => `${record(stage).stage}:${record(stage).status}`),
		).toEqual(["lease:acquired", "admit:admitted", "dispatch:dispatched", "github_reconcile:none"]);
		expect(fx.warren.createdRunCount()).toBe(1);

		// Terminal reconciliation, PR-intent rendering, and journal evidence.
		fx.warren.setRunState(runIdOf(result), {
			state: "succeeded",
			costUsd: 1.25,
			targetBranch: BRANCH,
		});
		const tick2 = await fx.run(["tick", "--campaign", id]);
		expect(tick2.code).toBe(0);
		const second = record(envelope(tick2).result);
		expect(second.campaignStatus).toBe("completed");
		expect(
			list(second.stages).map((stage) => `${record(stage).stage}:${record(stage).status}`),
		).toContain("pr_intent:rendered");

		const journal = await fx.run(["journal", "--campaign", id]);
		expect(journal.code).toBe(0);
		const actions = list(record(envelope(journal).result).actions);
		expect(actions.map((action) => record(action).actionType).sort()).toEqual([
			"pr_intent",
			"warren_dispatch",
		]);

		const firstItem = record(list(record(second.report).workItems)[0]);
		const status = await fx.run([
			"status",
			"--campaign",
			id,
			"--work-item",
			firstItem.id as string,
		]);
		expect(status.code).toBe(0);
		expect(record(record(envelope(status).result).workItem).status).toBe("terminal");
		// No secret ever reaches stdout.
		expect(tick1.text).not.toContain(WARREN_TOKEN);
		expect(tick1.text).not.toContain(GITHUB_TOKEN);
	});

	test("tick without the named Warren env var fails with exit 3, naming the variable", async () => {
		const fx = fixture();
		const id = await approvedCampaignId(fx);
		const result = await fx.run(["tick", "--campaign", id], { WARREN_API_TOKEN: "" });
		expect(result.code).toBe(3);
		const error = envelope(result).error as Record<string, string>;
		expect(error.code).toBe("config_invalid");
		expect(error.message).toContain("WARREN_API_TOKEN");
		expect(result.text).not.toContain(WARREN_TOKEN);
		// No dispatch happened.
		expect(fx.warren.createdRunCount()).toBe(0);
	});

	test("tick without the repository-policy snapshot is a config error", async () => {
		const fx = fixture();
		const id = await approvedCampaignId(fx);
		const result = await fx.run(["tick", "--campaign", id], { CAMPAIGN_POLICY_PATH: "" });
		expect(result.code).toBe(3);
		const error = envelope(result).error as Record<string, string>;
		expect(error.code).toBe("config_invalid");
		expect(error.message).toContain("CAMPAIGN_POLICY_PATH");
	});

	test("a live-mode flag is refused as a usage error", async () => {
		const fx = fixture();
		const id = await approvedCampaignId(fx);
		for (const flag of ["--live", "--no-dry-run", "--execute"]) {
			const result = await fx.run(["tick", "--campaign", id, flag]);
			expect(result.code).toBe(1);
			const error = envelope(result).error as Record<string, string>;
			expect(error.code).toBe("usage_invalid");
			expect(error.message).toContain("no live mode");
		}
	});

	test("a secret passed as a flag is refused", async () => {
		const fx = fixture();
		const result = await fx.run(["manifest", "validate", "--token", "abc"]);
		expect(result.code).toBe(1);
		const error = envelope(result).error as Record<string, string>;
		expect(error.message).toContain("environment variables");
	});

	test("a concurrent tick is refused with exit 4 and tick_concurrent", async () => {
		const fx = fixture();
		const id = await approvedCampaignId(fx);
		const store = new CampaignStateStore(fx.dbPath, {
			clock: new FixedClock(NOW),
			ids: { newId: () => "manual" },
		});
		expect(store.leases.acquireLease(`tick:${id}`, "another-holder", 60_000)).not.toBeNull();
		store.close();
		const result = await fx.run(["tick", "--campaign", id]);
		expect(result.code).toBe(4);
		const error = envelope(result).error as Record<string, string>;
		expect(error.code).toBe("tick_concurrent");
		expect(fx.warren.createdRunCount()).toBe(0);
	});

	test("attention list and ack manage the queue; unknown ack refuses", async () => {
		const fx = fixture();
		const id = await approvedCampaignId(fx);
		const empty = await fx.run(["attention", "list", "--campaign", id]);
		expect(empty.code).toBe(0);
		expect(list(record(envelope(empty).result).items)).toEqual([]);

		// Untrusted detail data that embeds the credential must be redacted.
		const store = new CampaignStateStore(fx.dbPath, {
			clock: new FixedClock(NOW),
			ids: { newId: () => "manual" },
		});
		store.events.addAttention({
			campaignId: id,
			reason: "untrusted_detail",
			detailJson: JSON.stringify({ note: `token=${WARREN_TOKEN}` }),
		});
		store.close();
		const listed = await fx.run(["attention", "list", "--campaign", id]);
		expect(listed.code).toBe(0);
		expect(listed.text).not.toContain(WARREN_TOKEN);
		expect(listed.text).toContain("[redacted]");
		const item = record(list(record(envelope(listed).result).items)[0]);

		const acked = await fx.run(["attention", "ack", "--campaign", id, "--id", item.id as string]);
		expect(acked.code).toBe(0);
		const again = await fx.run(["attention", "ack", "--campaign", id, "--id", item.id as string]);
		expect(again.code).toBe(4);
		const resolved = await fx.run(["attention", "list", "--campaign", id, "--all"]);
		expect(
			(envelope(resolved).result as { items: Array<Record<string, string>> }).items[0]
				?.resolvedAtMs,
		).not.toBeNull();
	});

	test("read-only GitHub calls work unauthenticated and authenticate when the token exists", async () => {
		// Without GITHUB_TOKEN the reads still happen — public, unauthenticated.
		const noToken = fixture();
		const idA = await approvedCampaignId(noToken);
		const tickA = await noToken.run(["tick", "--campaign", idA]);
		expect(tickA.code).toBe(0);
		const githubRequests = noToken.github.recordedRequests();
		expect(githubRequests.length).toBeGreaterThan(0);
		for (const request of githubRequests) {
			expect(request.headers.authorization).toBeUndefined();
		}

		// With GITHUB_TOKEN the reads authenticate — and the recorded
		// headers show it redacted, never echoed.
		const withToken = fixture({ githubToken: GITHUB_TOKEN });
		const idB = await approvedCampaignId(withToken);
		const tickB = await withToken.run(["tick", "--campaign", idB]);
		expect(tickB.code).toBe(0);
		const authed = withToken.github
			.recordedRequests()
			.find((request) => request.headers.authorization !== undefined);
		expect(authed).toBeDefined();
		expect(authed?.headers.authorization).not.toContain(GITHUB_TOKEN);
		expect(tickB.text).not.toContain(GITHUB_TOKEN);
	});

	test("unknown commands and flags are usage errors (exit 1)", async () => {
		const fx = fixture();
		expect((await fx.run(["frobnicate"])).code).toBe(1);
		expect((await fx.run(["tick", "--campaign", "x", "--frob"])).code).toBe(1);
		expect((await fx.run([])).code).toBe(1);
	});

	test("no command posts, comments, or discovers GKE secrets", async () => {
		const fx = fixture();
		for (const cmd of ["post-pr", "comment", "push", "gke-secrets", "enable-live"]) {
			const result = await fx.run([cmd]);
			expect(result.code).toBe(1);
			const error = envelope(result).error as Record<string, string>;
			expect(error.code).toBe("usage_invalid");
		}
	});

	test("human format renders readable output", async () => {
		const fx = fixture();
		const result = await fx.run(["manifest", "validate", "--format", "human"]);
		expect(result.code).toBe(0);
		expect(result.text).toContain("manifest validate: ok");
		expect(() => JSON.parse(result.text)).toThrow();
	});
});
