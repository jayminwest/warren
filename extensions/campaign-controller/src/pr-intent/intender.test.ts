/**
 * Cross-fork PR intent rendering and journaling tests (plan pl-91b6 step 8,
 * warren-fb4f).
 *
 * Every scenario runs the real pipeline — fake Warren through the real
 * WarrenClient and WarrenDispatcher — up to a SUCCEEDED run with a fork
 * branch, then exercises the intender:
 *
 * - the golden fixture pins the exact OpenClaw upstream request;
 * - double-tick and restart produce exactly one journaled intent;
 * - every refusal condition in the seed fails closed;
 * - contract/static tests prove no production GitHub method can post the
 *   rendered intent.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
	admitWorkItem,
	approveCampaign,
	type IssueSnapshot,
	importCampaign,
} from "../admission.ts";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { digestOf } from "../digest.ts";
import { WarrenDispatcher, type WarrenDispatchRequestSpec } from "../dispatch/dispatcher.ts";
import { StateError } from "../errors.ts";
import { ReadOnlyGithubClient } from "../github/client.ts";
import { FakeGithubServer } from "../github/fake-server.ts";
import { BunFetchGithubTransport } from "../github/http-transport.ts";
import { MUTATION_FLAGS } from "../mutations.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import type { ActionRow, CampaignRow, WorkItemRow } from "../store/types.ts";
import { WarrenClient } from "../warren-client.ts";
import { FakeWarrenServer } from "../warren-fake.ts";
import {
	PR_INTENT_ACTION_TYPE,
	type PrIntentInput,
	PrIntentRefusal,
	prIntentActionKey,
	prIntentMachineJson,
	renderAndJournalPrIntent,
} from "./intender.ts";

const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const TOKEN = "test-token";
const BRANCH = "warren/issue-812";
const GOLDEN_PATH = join(import.meta.dir, "__golden__", "openclaw-pr-intent.json");
const DEFAULT_GOLDEN_PATH = join(import.meta.dir, "__golden__", "default-pr-intent.json");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

/** The openclaw profile's PR-body contract (warren-e361): profile data. */
const OPENCLAW_PR_BODY_CONTRACT = (
	JSON.parse(
		readFileSync(
			new URL("../../profiles/openclaw.repository-policy.json", import.meta.url),
			"utf8",
		),
	) as { prBodyContract: Record<string, unknown> }
).prBodyContract;

/** The generic fallback contract the intender uses when a profile declares none. */
const DEFAULT_PR_BODY_CONTRACT: Record<string, unknown> = JSON.parse(
	readFileSync(new URL("../../profiles/default.pr-body-contract.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

function basePolicy(
	prBodyContract: Record<string, unknown> | null = OPENCLAW_PR_BODY_CONTRACT,
): Record<string, unknown> {
	return {
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
		prBodyContract,
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
}

function signedManifest(): Record<string, unknown> {
	const unapproved = {
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
	return {
		...unapproved,
		approval: {
			approvedBy: "jayminwest",
			approvedAt: "2026-08-25T12:00:00.000Z",
			manifestDigest: digestOf(unapproved),
		},
	};
}

const ISSUE: IssueSnapshot = {
	number: 812,
	owner: "openclaw",
	repo: "openclaw",
	title: "Flaky scheduler test",
	body: "The scheduler test flakes on cold caches.",
	labels: ["bug"],
};

const REQUEST: WarrenDispatchRequestSpec = {
	project: "openclaw-contrib",
	agent: "pi",
	prompt: "Fix issue 812 end to end.",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	maxCostUsd: 5,
};

function intentInput(overrides: Partial<PrIntentInput> = {}): PrIntentInput {
	return {
		campaignId: "",
		workItemId: "",
		issue: { number: 812, state: "open", title: "Flaky scheduler test" },
		summary: {
			problem:
				"The scheduler test flakes on cold caches, producing intermittent CI failures unrelated to the change under test.",
			solution:
				"Seed the scheduler's deterministic clock in the test setup so cold-cache ordering cannot vary between runs.",
			userImpact:
				"Contributors see stable CI results for scheduler changes; no runtime behavior changes.",
			evidence: ["bun test src/scheduler.test.ts — 42 passing, 0 failing", "bun run lint — clean"],
			changedPaths: ["src/scheduler/clock.ts", "src/scheduler/scheduler.test.ts"],
			operatorNotes:
				"Reviewed during the 2026-08-25 EOD dry-run session; full evidence in the campaign log.",
		},
		upstream: { defaultBranch: "main", forkOpenPrCount: 1, newPrsToday: 0 },
		policy: basePolicy(),
		nowMs: NOW,
		...overrides,
	};
}

interface Harness {
	readonly store: CampaignStateStore;
	readonly warren: FakeWarrenServer;
	readonly dispatcher: WarrenDispatcher;
	readonly campaign: CampaignRow;
	readonly workItem: WorkItemRow;
	readonly succeededAction: ActionRow;
	readonly runId: string;
}

/** Drive the real pipeline to a SUCCEEDED run with a fork branch. */
async function harness(options: {
	store?: CampaignStateStore;
	approve?: boolean;
	runPatch?: Record<string, unknown>;
	policy?: Record<string, unknown>;
	manifest?: Record<string, unknown>;
}): Promise<Harness> {
	const clock = new FixedClock(NOW);
	const store =
		options.store ??
		new CampaignStateStore(":memory:", { clock, ids: new SequentialIdGenerator() });
	const warren = new FakeWarrenServer({ token: TOKEN });
	const client = new WarrenClient({
		baseUrl: "http://warren.test",
		token: TOKEN,
		fetchFn: warren.fetch,
		clock,
		sleep: async () => {},
	});
	const dispatcher = new WarrenDispatcher({ store, client, ids: new SequentialIdGenerator() });
	const imported = importCampaign(store, {
		manifest: options.manifest ?? signedManifest(),
		policy: options.policy ?? basePolicy(),
		nowMs: NOW,
	});
	if (options.approve !== false) {
		approveCampaign(store, {
			campaignId: imported.campaign.id,
			manifestDigest: imported.manifestDigest,
			approvedBy: "jayminwest",
			nowMs: NOW,
		});
	}
	const admission = admitWorkItem(store, {
		campaignId: imported.campaign.id,
		issue: ISSUE,
		policy: options.policy ?? basePolicy(),
		nowMs: NOW,
	});
	const outcome = await dispatcher.dispatch({
		campaignId: imported.campaign.id,
		workItemId: admission.workItem.id,
		request: REQUEST,
		reservationId: admission.reservation.id,
	});
	const runId = outcome.runId as string;
	warren.setRunState(runId, {
		state: "succeeded",
		costUsd: 1.25,
		targetBranch: BRANCH,
		...(options.runPatch ?? {}),
	});
	await dispatcher.reconcileRun(runId);
	const succeededAction = store.actions
		.listActionsForWorkItem(admission.workItem.id)
		.find((action) => action.actionType === "warren_dispatch") as ActionRow;
	return {
		store,
		warren,
		dispatcher,
		campaign: imported.campaign,
		workItem: admission.workItem,
		succeededAction,
		runId,
	};
}

function refuse(h: Harness, input: Partial<PrIntentInput>): PrIntentRefusal {
	try {
		renderAndJournalPrIntent(h.store, {
			...intentInput({ campaignId: h.campaign.id, workItemId: h.workItem.id }),
			...input,
		});
	} catch (error) {
		expect(error).toBeInstanceOf(PrIntentRefusal);
		return error as PrIntentRefusal;
	}
	throw new Error("expected a PrIntentRefusal");
}

describe("renderAndJournalPrIntent", () => {
	test("renders and journals the exact OpenClaw cross-fork request (golden)", async () => {
		const h = await harness({});
		const result = renderAndJournalPrIntent(h.store, {
			...intentInput(),
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
		});
		const machine = prIntentMachineJson(result);
		const snapshot = { requestDigest: machine.requestDigest, request: machine.request };

		if (UPDATE) {
			mkdirSync(join(import.meta.dir, "__golden__"), { recursive: true });
			writeFileSync(GOLDEN_PATH, `${JSON.stringify(snapshot, null, "\t")}\n`);
		}
		expect(existsSync(GOLDEN_PATH)).toBe(true);
		const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as typeof snapshot;
		expect(snapshot).toEqual(golden);

		// The journal binds the exact request digest as a planned dry-run action.
		const action = h.store.actions.getActionByKey(prIntentActionKey(h.campaign.id, h.workItem.id));
		expect(action?.actionType).toBe(PR_INTENT_ACTION_TYPE);
		expect(action?.state).toBe("planned");
		expect(action?.requestDigest).toBe(snapshot.requestDigest);
		expect(action?.policyDigest).toBe(h.campaign.policyDigest);
		// The prospective PR identity is durable evidence too.
		const identity = h.store.events.getPrIdentity(result.identity.id);
		expect(identity?.headBranch).toBe(BRANCH);
		expect(identity?.upstreamOwner).toBe("openclaw");
		expect(identity?.forkOwner).toBe("warren-run-bot");
		expect(identity?.prNumber).toBeNull();
	});

	test("the golden body carries every profile-declared section", async () => {
		const h = await harness({});
		const result = renderAndJournalPrIntent(h.store, {
			...intentInput(),
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
		});
		const body = result.intent.body.body;
		// Headings and wording come from the openclaw profile contract, not source:
		const contract = OPENCLAW_PR_BODY_CONTRACT as {
			sections: { key: string; heading: string | null; required: boolean }[];
			disclosureTemplate: string;
			footerTemplate: string;
		};
		expect(body).toContain("Closes #812");
		for (const section of contract.sections) {
			if (section.heading !== null && section.required) {
				expect(body).toContain(`## ${section.heading}`);
			}
		}
		expect(body).toContain("maintainers may push edits");
		const fill: Record<string, string> = {
			campaignId: "camp-openclaw-eod-v0",
			agent: "pi",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			approvedBy: "jayminwest",
		};
		const expand = (template: string) =>
			template.replaceAll(/\{([A-Za-z]+)\}/g, (whole, name: string) => fill[name] ?? whole);
		expect(body).toContain(expand(contract.footerTemplate));
		expect(body).toContain(expand(contract.disclosureTemplate));
		expect(result.intent.body.head).toBe(`warren-run-bot:${BRANCH}`);
		expect(result.intent.body.base).toBe("main");
		expect(result.intent.body.draft).toBe(true);
		expect(result.intent.body.maintainer_can_modify).toBe(true);
	});

	test("a profile without a contract renders the shipped default contract (golden)", async () => {
		const genericPolicy = basePolicy(null);
		const h = await harness({ policy: genericPolicy });
		const result = renderAndJournalPrIntent(h.store, {
			...intentInput(),
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
			policy: genericPolicy,
		});
		const machine = prIntentMachineJson(result);
		const snapshot = { requestDigest: machine.requestDigest, request: machine.request };
		const contract = DEFAULT_PR_BODY_CONTRACT as {
			sections: { key: string; heading: string | null; required: boolean }[];
		};
		for (const section of contract.sections) {
			if (section.heading !== null && section.required) {
				expect(machine.request.body.body).toContain(`## ${section.heading}`);
			}
		}
		// The default render must differ from the openclaw render: a generic
		// contract is not the openclaw CI-gate contract (warren-e361).
		const openclawGolden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
			requestDigest: string;
		};
		expect(machine.requestDigest).not.toBe(openclawGolden.requestDigest);
		if (UPDATE) {
			mkdirSync(join(import.meta.dir, "__golden__"), { recursive: true });
			writeFileSync(DEFAULT_GOLDEN_PATH, `${JSON.stringify(snapshot, null, "\t")}\n`);
		}
		expect(existsSync(DEFAULT_GOLDEN_PATH)).toBe(true);
		const golden = JSON.parse(readFileSync(DEFAULT_GOLDEN_PATH, "utf8")) as typeof snapshot;
		expect(snapshot).toEqual(golden);
	});

	test("a double tick produces exactly one intent, not a second journal row", async () => {
		const h = await harness({});
		const input = { ...intentInput(), campaignId: h.campaign.id, workItemId: h.workItem.id };
		const first = renderAndJournalPrIntent(h.store, input);
		expect(first.created).toBe(true);
		const second = renderAndJournalPrIntent(h.store, input);
		expect(second.created).toBe(false);
		expect(second.action.id).toBe(first.action.id);
		expect(second.requestDigest).toBe(first.requestDigest);
		const intents = h.store.actions
			.listActionsForWorkItem(h.workItem.id)
			.filter((action) => action.actionType === PR_INTENT_ACTION_TYPE);
		expect(intents).toHaveLength(1);
		expect(h.store.events.listPrIdentities(h.campaign.id)).toHaveLength(1);
	});

	test("a restart (store reopen + re-render) still produces exactly one intent", async () => {
		const dir = await fs.mkdtemp(join(import.meta.dir, "tmp-"));
		const path = join(dir, "state.db");
		try {
			const first = new CampaignStateStore(path, {
				clock: new FixedClock(NOW),
				ids: new SequentialIdGenerator(),
			});
			const h1 = await harness({ store: first });
			const input = { ...intentInput(), campaignId: h1.campaign.id, workItemId: h1.workItem.id };
			const rendered = renderAndJournalPrIntent(first, input);
			first.close();

			const second = new CampaignStateStore(path, {
				clock: new FixedClock(NOW),
				ids: new SequentialIdGenerator(),
			});
			const again = renderAndJournalPrIntent(second, input);
			expect(again.created).toBe(false);
			expect(again.action.id).toBe(rendered.action.id);
			expect(again.requestDigest).toBe(rendered.requestDigest);
			const intents = second.actions
				.listActionsForWorkItem(h1.workItem.id)
				.filter((action) => action.actionType === PR_INTENT_ACTION_TYPE);
			expect(intents).toHaveLength(1);
			expect(second.events.listPrIdentities(h1.campaign.id)).toHaveLength(1);
			second.close();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("changed facts under the same action key fail closed", async () => {
		const h = await harness({});
		const input = { ...intentInput(), campaignId: h.campaign.id, workItemId: h.workItem.id };
		renderAndJournalPrIntent(h.store, input);
		expect(() =>
			renderAndJournalPrIntent(h.store, {
				...input,
				summary: { ...input.summary, problem: "A different problem entirely." },
			}),
		).toThrow(StateError);
	});
});

describe("renderAndJournalPrIntent refusals", () => {
	test("refuses an unknown campaign", async () => {
		const h = await harness({});
		const refusal = refuse(h, { campaignId: "camp-missing" });
		expect(refusal.invariant).toBe("campaign_unknown");
	});

	test("refuses an unapproved campaign", async () => {
		const h = await harness({});
		h.store.campaigns.invalidateApproval(h.campaign.id);
		const refusal = refuse(h, {});
		expect(refusal.invariant).toBe("campaign_not_approved");
	});

	test("refuses an expired campaign", async () => {
		const h = await harness({});
		const refusal = refuse(h, { nowMs: Date.parse("2027-01-01T00:00:00.000Z") });
		expect(refusal.invariant).toBe("campaign_expired");
	});

	test("refuses an unknown work item", async () => {
		const h = await harness({});
		const refusal = refuse(h, { workItemId: "nope" });
		expect(refusal.invariant).toBe("work_item_unknown");
	});

	test("refuses an issue outside the approved campaign", async () => {
		const h = await harness({});
		const refusal = refuse(h, {
			issue: { number: 999, state: "open", title: "Other" },
		});
		expect(refusal.invariant).toBe("issue_not_in_campaign");
	});

	test("refuses a work item that never reached terminal", async () => {
		const h = await harness({});
		h.store.campaigns.setWorkItemStatus(h.workItem.id, "running");
		const refusal = refuse(h, {});
		expect(refusal.invariant).toBe("work_item_not_terminal");
	});

	test("refuses a work item with no succeeded run", async () => {
		const h = await harness({
			runPatch: { state: "failed", failureReason: "agent_error" },
		});
		const refusal = refuse(h, {});
		expect(refusal.invariant).toBe("work_item_not_terminal");
		// Terminal status without a succeeded run is store drift: still refused.
		h.store.campaigns.setWorkItemStatus(h.workItem.id, "terminal");
		const drift = refuse(h, {});
		expect(drift.invariant).toBe("run_not_succeeded");
	});

	test("refuses a succeeded run with no branch (missing branch)", async () => {
		const h = await harness({ runPatch: { targetBranch: null } });
		const refusal = refuse(h, {});
		expect(refusal.invariant).toBe("run_branch_missing");
	});

	test("refuses a run branch that is not a valid ref name", async () => {
		const h = await harness({ runPatch: { targetBranch: "bad branch..name" } });
		const refusal = refuse(h, {});
		expect(refusal.invariant).toBe("run_branch_invalid");
	});

	test("refuses head == base", async () => {
		const h = await harness({ runPatch: { targetBranch: "main" } });
		const refusal = refuse(h, {});
		expect(refusal.invariant).toBe("head_equals_base");
	});

	test("refuses an upstream default branch that drifted from the manifest", async () => {
		const h = await harness({});
		const refusal = refuse(h, {
			upstream: { defaultBranch: "develop", forkOpenPrCount: 0, newPrsToday: 0 },
		});
		expect(refusal.invariant).toBe("base_branch_mismatch");
	});

	test("refuses a stale policy snapshot", async () => {
		const h = await harness({});
		const stale = basePolicy();
		(stale.source as Record<string, unknown>).fetchedAt = "2026-05-01T00:00:00.000Z";
		const refusal = refuse(h, { policy: stale });
		expect(refusal.invariant).toBe("policy_stale");
	});

	test("refuses a silently swapped policy (digest changed)", async () => {
		const h = await harness({});
		const swapped = basePolicy();
		(swapped.source as Record<string, unknown>).fetchedAt = "2026-08-21T00:00:00.000Z";
		const refusal = refuse(h, { policy: swapped });
		expect(refusal.invariant).toBe("policy_changed");
	});

	test("refuses a policy describing a different upstream", async () => {
		const h = await harness({});
		const foreign = basePolicy();
		foreign.upstream = { owner: "other", repo: "other" };
		const refusal = refuse(h, { policy: foreign });
		expect(refusal.invariant).toBe("policy_upstream_mismatch");
	});

	test("refuses absent validation evidence", async () => {
		const h = await harness({});
		const input = intentInput();
		const refusal = refuse(h, { summary: { ...input.summary, evidence: ["", "  "] } });
		expect(refusal.invariant).toBe("evidence_absent");
	});

	test("refuses an incomplete summary", async () => {
		const h = await harness({});
		const input = intentInput();
		const refusal = refuse(h, { summary: { ...input.summary, problem: " " } });
		expect(refusal.invariant).toBe("summary_incomplete");
	});

	test("refuses an issue that is not open (unapproved issue)", async () => {
		const h = await harness({});
		const refusal = refuse(h, { issue: { number: 812, state: "closed", title: "Done" } });
		expect(refusal.invariant).toBe("issue_not_open");
	});

	test("refuses a protected path and forces human attention", async () => {
		const h = await harness({});
		const input = intentInput();
		const refusal = refuse(h, {
			summary: { ...input.summary, changedPaths: ["src/ok.ts", "docs/CONSTITUTION.md"] },
		});
		expect(refusal.invariant).toBe("protected_path");
		expect(h.store.campaigns.getWorkItem(h.workItem.id)?.status).toBe("needs_attention");
		const attention = h.store.events.listOpenAttention(h.campaign.id);
		expect(attention.some((item) => item.reason === "protected_path")).toBe(true);
	});

	test("refuses a forbidden glob match", async () => {
		const h = await harness({});
		const input = intentInput();
		const refusal = refuse(h, {
			summary: { ...input.summary, changedPaths: [".github/workflows/ci.yml"] },
		});
		expect(refusal.invariant).toBe("protected_path");
	});

	test("refuses protected-path ambiguity (directory-prefix overlap)", async () => {
		const h = await harness({});
		const input = intentInput();
		const refusal = refuse(h, { summary: { ...input.summary, changedPaths: ["docs"] } });
		expect(refusal.invariant).toBe("protected_path");
	});

	test("refuses an open-PR cap breach", async () => {
		const h = await harness({});
		const refusal = refuse(h, {
			upstream: { defaultBranch: "main", forkOpenPrCount: 5, newPrsToday: 0 },
		});
		expect(refusal.invariant).toBe("open_pr_cap_breach");
	});

	test("refuses a daily PR cap breach", async () => {
		const h = await harness({});
		const refusal = refuse(h, {
			upstream: { defaultBranch: "main", forkOpenPrCount: 0, newPrsToday: 2 },
		});
		expect(refusal.invariant).toBe("daily_pr_cap_breach");
	});

	test("refuses an upstream-observed PR cap breach", async () => {
		const policy = basePolicy();
		policy.maxOpenPrs = 20;
		const h = await harness({ policy });
		const refusal = refuse(h, {
			policy,
			upstream: { defaultBranch: "main", forkOpenPrCount: 20, newPrsToday: 0 },
		});
		expect(refusal.invariant).toBe("upstream_pr_cap_breach");
	});

	test("a refusal journals no intent action", async () => {
		const h = await harness({});
		const input = intentInput();
		expect(() =>
			renderAndJournalPrIntent(h.store, {
				...intentInput({ campaignId: h.campaign.id, workItemId: h.workItem.id }),
				summary: { ...input.summary, evidence: [] },
			}),
		).toThrow(PrIntentRefusal);
		expect(h.store.actions.listUnfinishedActions()).toHaveLength(0);
		expect(h.store.events.listPrIdentities(h.campaign.id)).toHaveLength(0);
	});
});

describe("no production GitHub method can post the rendered intent", () => {
	test("ReadOnlyGithubClient exposes none of the mutation-flag method names", async () => {
		const h = await harness({});
		const result = renderAndJournalPrIntent(h.store, {
			...intentInput(),
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
		});
		expect(result.intent.method).toBe("POST");
		const prototype = Object.getPrototypeOf(new ReadOnlyGithubClient(new FakeGithubServer()));
		const methodNames = Object.getOwnPropertyNames(prototype);
		for (const flag of MUTATION_FLAGS) {
			expect(methodNames).not.toContain(flag);
		}
	});

	test("the production transport fails hard on the rendered intent's POST before any I/O", async () => {
		let fetched = false;
		const transport = new BunFetchGithubTransport({
			token: "ghp_test",
			fetchImpl: () => {
				fetched = true;
				return Promise.resolve(new Response("{}", { status: 201 }));
			},
		});
		const h = await harness({});
		const result = renderAndJournalPrIntent(h.store, {
			...intentInput(),
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
		});
		await expect(
			transport.read({ method: "POST" as "GET", path: result.intent.url }),
		).rejects.toMatchObject({ name: "BoundaryError", code: "boundary_violated" });
		expect(fetched).toBe(false);
	});

	test("static scan: the client and intender sources carry no mutation surface", async () => {
		const clientSource = await Bun.file(join(import.meta.dir, "..", "github", "client.ts")).text();
		for (const flag of MUTATION_FLAGS) {
			expect(clientSource).not.toContain(flag);
		}
		expect(clientSource).not.toContain('"POST"');
		const intenderSource = await Bun.file(join(import.meta.dir, "intender.ts")).text();
		expect(intenderSource.includes("GithubTransport")).toBe(false);
		expect(intenderSource.includes("http-transport")).toBe(false);
		expect(intenderSource.includes("fetch(")).toBe(false);
	});
});

describe("evidence tiers (warren-4dc1)", () => {
	const GOLDEN_KNOWN_GAP_PATH = join(
		import.meta.dir,
		"__golden__",
		"openclaw-pr-intent-known-gap.json",
	);
	const KNOWN_GAP =
		"A real-provider trace against the live gateway, which no network-restricted run pod can ever produce.";

	/** A manifest whose sole issue is tagged with an evidence tier. */
	function signedManifestWithTiers(tiers: Record<string, string>): Record<string, unknown> {
		const input = signedManifest() as Record<string, unknown>;
		const { approval, ...rest } = input;
		const bound = { ...rest, issueEvidenceTiers: tiers };
		const approvalRecord = approval as Record<string, unknown>;
		return { ...bound, approval: { ...approvalRecord, manifestDigest: digestOf(bound) } };
	}

	function externalInput(overrides: Partial<PrIntentInput> = {}): PrIntentInput {
		const base = intentInput();
		return {
			...base,
			summary: { ...base.summary, knownGap: KNOWN_GAP },
			...overrides,
		};
	}

	test("an external-proof-required issue renders the declared known-gap slot (golden)", async () => {
		const policy = {
			...basePolicy(),
			evidenceTiers: ["local-provable", "external-proof-required"],
		};
		const h = await harness({
			manifest: signedManifestWithTiers({ "812": "external-proof-required" }),
			policy,
		});
		const result = renderAndJournalPrIntent(
			h.store,
			externalInput({
				campaignId: h.campaign.id,
				workItemId: h.workItem.id,
				policy,
			}),
		);
		const machine = prIntentMachineJson(result);
		const snapshot = { requestDigest: machine.requestDigest, request: machine.request };
		const body = machine.request.body.body;

		const contract = OPENCLAW_PR_BODY_CONTRACT as {
			sections: { key: string; heading: string | null }[];
		};
		const knownGapHeading = contract.sections.find((section) => section.key === "knownGap");
		expect(knownGapHeading?.heading).toBeDefined();
		expect(body).toContain(`## ${knownGapHeading?.heading}`);
		expect(body).toContain(`- ${KNOWN_GAP}`);
		expect(body).toContain("an operator will attach it to this pull request before merge");
		// The known-gap slot does not displace any required section.
		for (const section of contract.sections) {
			if (section.heading !== null && section.key !== "knownGap") {
				expect(body).toContain(`## ${section.heading}`);
			}
		}

		if (UPDATE) {
			mkdirSync(join(import.meta.dir, "__golden__"), { recursive: true });
			writeFileSync(GOLDEN_KNOWN_GAP_PATH, `${JSON.stringify(snapshot, null, "\t")}\n`);
		}
		expect(existsSync(GOLDEN_KNOWN_GAP_PATH)).toBe(true);
		const golden = JSON.parse(readFileSync(GOLDEN_KNOWN_GAP_PATH, "utf8")) as typeof snapshot;
		expect(snapshot).toEqual(golden);
	});

	test("an untagged issue renders as local-provable with an unchanged body", async () => {
		const h = await harness({});
		const result = renderAndJournalPrIntent(h.store, {
			...intentInput(),
			campaignId: h.campaign.id,
			workItemId: h.workItem.id,
		});
		const untaggedDigest = prIntentMachineJson(result).requestDigest;
		// Identical to the pinned local-provable golden: default tier adds nothing.
		const pinned = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { requestDigest: string };
		expect(untaggedDigest).toBe(pinned.requestDigest);
		const contract = OPENCLAW_PR_BODY_CONTRACT as {
			sections: { key: string; heading: string | null }[];
		};
		const knownGapHeading = contract.sections.find((section) => section.key === "knownGap");
		expect(result.intent.body.body).not.toContain(knownGapHeading?.heading as string);
	});

	test("refuses an external-proof-required issue without a declared known gap", async () => {
		const h = await harness({
			manifest: signedManifestWithTiers({ "812": "external-proof-required" }),
		});
		const refusal = refuse(h, {});
		expect(refusal.invariant).toBe("known_gap_absent");
	});
});
