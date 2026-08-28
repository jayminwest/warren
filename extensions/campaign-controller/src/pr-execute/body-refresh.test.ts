/**
 * The updatePullRequest body-refresh mutation (warren-09d2, plan pl-096b).
 *
 * Covers the issue's acceptance list: the golden for the refreshed body,
 * the divergence-refusal gate, the journal round trip, and the executor
 * settle discipline. The e2e vertical slice lives under `src/acceptance/`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { canonicalJson, sha256Hex } from "../digest.ts";
import {
	GithubMutationUncertainError,
	renderUpdatePullRequestIntent,
	type UpdatePullRequestIntent,
} from "../github/pr-mutations.ts";
import { loadDefaultPrBodyContract, type PrBodyFacts, renderPrBody } from "../pr-intent/pr-body.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import {
	BODY_REFRESH_DIVERGED_REASON,
	type BodyRefreshJournalResult,
	bodyHasDiverged,
	executeJournaledBodyRefresh,
	mergeEvidence,
	type PrBodyRefreshFacts,
	renderAndJournalBodyRefresh,
	renderedBodyDigest,
	renderRefreshedPrBody,
} from "./body-refresh.ts";
import { MUTATION_UNCERTAIN_REASON } from "./mutation-journal.ts";

const clock = new FixedClock(1_000_000);
const CONTRACT = loadDefaultPrBodyContract();
const GOLDEN = JSON.parse(
	readFileSync(
		new URL("../pr-intent/__golden__/default-pr-body-refresh.json", import.meta.url),
		"utf8",
	),
) as {
	baseFacts: PrBodyFacts;
	refresh: PrBodyRefreshFacts;
	body: string;
};

const UPSTREAM = { upstreamOwner: "openclaw", upstreamRepo: "openclaw" };

function baseFacts(): PrBodyFacts {
	return { ...GOLDEN.baseFacts };
}
function refreshFacts(): PrBodyRefreshFacts {
	return { ...GOLDEN.refresh };
}

/** A stub updater recording intents; `error` injects the failure mode. */
class RecordingUpdater {
	readonly calls: UpdatePullRequestIntent[] = [];
	constructor(readonly error?: "uncertain" | "rejected") {}
	async updatePullRequest(intent: UpdatePullRequestIntent): Promise<{ updatedAt: string | null }> {
		this.calls.push(intent);
		if (this.error === "uncertain") {
			throw new GithubMutationUncertainError("transport died mid-PATCH", { path: intent.url });
		}
		if (this.error === "rejected") {
			throw new Error(`HTTP 422 for ${intent.url}`);
		}
		return { updatedAt: "2026-08-28T00:00:00Z" };
	}
}

let dir: string;
let store: CampaignStateStore;
let campaignId: string;
let workItemId: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "body-refresh-"));
	store = new CampaignStateStore(join(dir, "state.db"), {
		clock,
		ids: new SequentialIdGenerator(),
	});
	campaignId = store.campaigns.createCampaign({
		manifestDigest: "digest-body-refresh",
		manifestJson: "{}",
		budgetCapUsdCents: 100_00,
	}).id;
	workItemId = store.campaigns.addWorkItem({
		campaignId,
		position: 1,
		issueRef: "812",
	}).id;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function journalRefresh(input: Partial<Parameters<typeof renderAndJournalBodyRefresh>[1]> = {}) {
	return renderAndJournalBodyRefresh(
		{ store },
		{
			campaignId,
			workItemId,
			prNumber: 7,
			...UPSTREAM,
			contract: CONTRACT,
			baseFacts: baseFacts(),
			refresh: refreshFacts(),
			lastRenderedBody: null,
			liveBody: null,
			...input,
		},
	);
}

describe("renderRefreshedPrBody (warren-09d2)", () => {
	test("renders the exact golden refreshed body, deterministically", () => {
		const body = renderRefreshedPrBody(CONTRACT, baseFacts(), refreshFacts());
		expect(body).toBe(GOLDEN.body);
		// The whole-body invariant: rendering the merged facts through the
		// contract directly yields the identical body — the refresh owns no
		// wording of its own and edits no region the contract does not cover.
		const merged: PrBodyFacts = {
			...baseFacts(),
			evidence: mergeEvidence(baseFacts().evidence, refreshFacts().newEvidence),
			addressedFindings: refreshFacts().addressedFindings,
			followUpRunId: "run_2222",
			knownGap: undefined,
		};
		expect(renderPrBody(CONTRACT, merged)).toBe(GOLDEN.body);
	});

	test("merges follow-up evidence order-preserving and deduped", () => {
		expect(mergeEvidence(["a", "b"], ["b", "c", " "])).toEqual(["a", "b", "c"]);
	});
});

describe("divergence refusal (warren-09d2)", () => {
	test("detects a hand-edited live body against the last render", () => {
		expect(bodyHasDiverged(null, "anything")).toBe(false);
		expect(bodyHasDiverged("body", null)).toBe(false);
		expect(bodyHasDiverged("body", "body")).toBe(false);
		expect(bodyHasDiverged("body", "hand-edited body")).toBe(true);
	});

	test("refuses to clobber a diverged body and raises attention once", () => {
		const lastRendered = renderRefreshedPrBody(CONTRACT, baseFacts(), {
			followUpRunId: null,
			newEvidence: [],
			addressedFindings: [],
			knownGap: null,
		});
		for (let i = 0; i < 2; i++) {
			const result = journalRefresh({
				lastRenderedBody: lastRendered,
				liveBody: `${lastRendered}\n\nhand-edited by a maintainer`,
			});
			expect(result.status).toBe("diverged_refused");
			if (result.status === "diverged_refused") {
				expect(result.refreshedBody).toBeNull();
				expect(result.actionId).toBeNull();
			}
		}
		const attention = store.events.listOpenAttention(campaignId);
		expect(attention).toHaveLength(1);
		expect(attention[0]?.reason).toBe(BODY_REFRESH_DIVERGED_REASON);
		// Nothing was journaled: refusal precedes any I/O.
		expect(
			store.actions
				.listActionsForCampaign(campaignId)
				.filter((action) => action.actionType === "pr_body_refresh"),
		).toHaveLength(0);
	});

	test("the operator override journals the clobber despite divergence", () => {
		const result = journalRefresh({
			lastRenderedBody: "original body",
			liveBody: "hand-edited body",
			operatorOverride: true,
		});
		expect(result.status).toBe("rendered");
	});
});

describe("journal round trip (warren-09d2)", () => {
	test("journals planned with the canonical request digest before any I/O", () => {
		const first = journalRefresh();
		expect(first.status).toBe("rendered");
		if (first.status !== "rendered") throw new Error("unreachable");
		expect(first.requestDigest).toBe(sha256Hex(canonicalJson(first.intent)));
		const row = store.actions.getAction(first.actionId);
		expect(row?.state).toBe("planned");
		expect(row?.requestDigest).toBe(first.requestDigest);
		expect(row?.actionType).toBe("pr_body_refresh");
		expect(first.intent).toEqual(
			renderUpdatePullRequestIntent({ ...UPSTREAM, prNumber: 7, body: first.refreshedBody }),
		);
		expect(first.intent.body.body).toContain("Response summary");
	});

	test("same facts replan onto the same row; changed facts fail closed while the first is pending", () => {
		const first = journalRefresh();
		const replay = journalRefresh();
		expect(replay.status).toBe("already_journaled");
		if (replay.status !== "already_journaled" || first.status !== "rendered") {
			throw new Error("unreachable");
		}
		expect(replay.actionId).toBe(first.actionId);
		expect(replay.requestDigest).toBe(first.requestDigest);
		// The store holds one active attempt per work item: while the first
		// refresh intent is still planned, changed facts cannot open a second
		// journal row — the pending intent must settle (or fail) first.
		expect(() =>
			journalRefresh({
				refresh: { ...refreshFacts(), knownGap: "A different outstanding gap" },
			}),
		).toThrow(/active attempt/);
	});
});

describe("execution settle discipline (warren-09d2)", () => {
	async function execute(result: BodyRefreshJournalResult, error?: "uncertain" | "rejected") {
		if (result.status !== "rendered") throw new Error("not journaled");
		const updater = new RecordingUpdater(error);
		const outcome = await executeJournaledBodyRefresh(
			store,
			{
				campaignId,
				action: store.actions.getAction(result.actionId) as NonNullable<
					ReturnType<typeof store.actions.getAction>
				>,
				intent: result.intent,
			},
			updater,
		);
		return { outcome, updater };
	}

	test("PATCHes the journaled intent exactly once and settles succeeded", async () => {
		const { outcome, updater } = await execute(journalRefresh());
		expect(outcome.status).toBe("succeeded");
		expect(updater.calls).toHaveLength(1);
		const row = store.actions.listActionsForCampaign(campaignId)[0];
		expect(row?.state).toBe("succeeded");
		// A re-drive never re-sends a settled mutation.
		const again = await executeJournaledBodyRefresh(
			store,
			{
				campaignId,
				action: row as NonNullable<ReturnType<typeof store.actions.getAction>>,
				intent: renderUpdatePullRequestIntent({ ...UPSTREAM, prNumber: 7, body: "x" }),
			},
			new RecordingUpdater(),
		);
		expect(again.status).toBe("already_settled");
	});

	test("a transport failure after send settles uncertain with attention, never re-sent", async () => {
		const { outcome, updater } = await execute(journalRefresh(), "uncertain");
		expect(outcome.status).toBe("settled_uncertain");
		expect(updater.calls).toHaveLength(1);
		const row = store.actions.listActionsForCampaign(campaignId)[0];
		expect(row?.state).toBe("uncertain");
		const attention = store.events.listOpenAttention(campaignId);
		expect(attention.some((item) => item.reason === MUTATION_UNCERTAIN_REASON)).toBe(true);
	});

	test("a definitive GitHub refusal settles permanent_failure with attention", async () => {
		const { outcome } = await execute(journalRefresh(), "rejected");
		expect(outcome.status).toBe("settled_failed");
		const row = store.actions.listActionsForCampaign(campaignId)[0];
		expect(row?.state).toBe("permanent_failure");
	});
});

test("renderedBodyDigest pins the divergence-comparison convention", () => {
	expect(renderedBodyDigest("body")).toBe(sha256Hex(canonicalJson({ body: "body" })));
});
