import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { canonicalJson, sha256Hex } from "../digest.ts";
import { StateError } from "../errors.ts";
import {
	GithubMutationUncertainError,
	type MutationIntent,
	renderFollowUpPushIntent,
	renderPostCommentIntent,
	renderUpdateBranchIntent,
	renderUpdatePullRequestIntent,
} from "../github/pr-mutations.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import {
	executeJournaledMutation,
	FOLLOW_UP_PUSH_ACTION_TYPE,
	journalMutationIntent,
	POST_COMMENT_ACTION_TYPE,
	UPDATE_BRANCH_ACTION_TYPE,
	UPDATE_PULL_REQUEST_ACTION_TYPE,
} from "./mutation-journal.ts";

const clock = new FixedClock(1_000_000);

let dir: string;
let store: CampaignStateStore;
let campaignId: string;
let workItemId: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mutation-journal-"));
	store = new CampaignStateStore(join(dir, "state.db"), {
		clock,
		ids: new SequentialIdGenerator(),
	});
	const campaign = store.campaigns.createCampaign({
		manifestDigest: "digest-mutations",
		manifestJson: "{}",
		budgetCapUsdCents: 100_00,
	});
	campaignId = campaign.id;
	workItemId = store.campaigns.addWorkItem({
		campaignId,
		position: 1,
		issueRef: "issue://1",
	}).id;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const SAMPLE_INTENTS: ReadonlyArray<{
	readonly actionType: string;
	readonly intent: MutationIntent;
}> = [
	{
		actionType: UPDATE_PULL_REQUEST_ACTION_TYPE,
		intent: renderUpdatePullRequestIntent({
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			prNumber: 7,
			title: "refreshed",
		}),
	},
	{
		actionType: POST_COMMENT_ACTION_TYPE,
		intent: renderPostCommentIntent({
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			issueNumber: 9,
			body: "reply",
		}),
	},
	{
		actionType: UPDATE_BRANCH_ACTION_TYPE,
		intent: renderUpdateBranchIntent({
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			prNumber: 7,
		}),
	},
	{
		actionType: FOLLOW_UP_PUSH_ACTION_TYPE,
		intent: renderFollowUpPushIntent({
			forkOwner: "warren-bot",
			forkRepo: "openclaw",
			headBranch: "warren/issue-9",
			refspec: "HEAD:refs/heads/warren/issue-9",
		}),
	},
];

describe("mutation journal round trip (warren-094b)", () => {
	for (const { actionType, intent } of SAMPLE_INTENTS) {
		test(`${actionType}: planned with the canonical request digest before any I/O`, () => {
			const planned = journalMutationIntent(store, {
				actionKey: `test:${actionType}:1`,
				campaignId,
				workItemId,
				actionType,
				intent,
				policyDigest: "policy-digest",
			});
			expect(planned.created).toBe(true);
			expect(planned.action.state).toBe("planned");
			expect(planned.requestDigest).toHaveLength(64);
			// The digest binds the canonical intent shape exactly.
			expect(planned.requestDigest).toBe(sha256Hex(canonicalJson(intent)));
		});

		test(`${actionType}: replans onto the same row with the same digest, fails closed on drift`, () => {
			const key = `test:${actionType}:2`;
			const first = journalMutationIntent(store, {
				actionKey: key,
				campaignId,
				actionType,
				intent,
			});
			const replay = journalMutationIntent(store, {
				actionKey: key,
				campaignId,
				actionType,
				intent,
			});
			expect(replay.created).toBe(false);
			expect(replay.action.id).toBe(first.action.id);
			expect(() =>
				journalMutationIntent(store, {
					actionKey: key,
					campaignId,
					actionType,
					intent: { ...intent, url: `${intent.url}-drifted` },
				}),
			).toThrow(StateError);
		});

		test(`${actionType}: executing before I/O, then succeeded with frozen terminal state`, async () => {
			const planned = journalMutationIntent(store, {
				actionKey: `test:${actionType}:3`,
				campaignId,
				workItemId,
				actionType,
				intent,
			});
			const ioStartedState: { state: string | null } = { state: null };
			const outcome = await executeJournaledMutation(
				store,
				{ campaignId, action: planned.action },
				async () => {
					ioStartedState.state = store.actions.getAction(planned.action.id)?.state ?? null;
					return { resultPrNumber: actionType === POST_COMMENT_ACTION_TYPE ? 4242 : null };
				},
			);
			// The row was `executing` before the caller's I/O ran.
			expect(ioStartedState.state).toBe("executing");
			expect(outcome.status).toBe("succeeded");
			expect(store.actions.getAction(planned.action.id)?.state).toBe("succeeded");
			// Terminal rows never transition again: a re-drive sees already_settled.
			const redrive = await executeJournaledMutation(
				store,
				{ campaignId, action: planned.action },
				async () => {
					throw new Error("must not run I/O again");
				},
			);
			expect(redrive.status).toBe("already_settled");
		});

		test(`${actionType}: an uncertain outcome settles uncertain and raises attention, never replays`, async () => {
			const planned = journalMutationIntent(store, {
				actionKey: `test:${actionType}:4`,
				campaignId,
				workItemId,
				actionType,
				intent,
			});
			const outcome = await executeJournaledMutation(
				store,
				{ campaignId, action: planned.action },
				async () => {
					throw new GithubMutationUncertainError("outcome unknown", { path: intent.url });
				},
			);
			expect(outcome.status).toBe("settled_uncertain");
			const row = store.actions.getAction(planned.action.id);
			expect(row?.state).toBe("uncertain");
			expect(row?.errorClass).toBe("ambiguous_response");
			expect(
				store.events
					.listOpenAttention(campaignId)
					.some((a) => a.workItemId === workItemId && a.reason === "mutation_uncertain"),
			).toBe(true);
		});

		test(`${actionType}: a definitive refusal settles permanent_failure`, async () => {
			const planned = journalMutationIntent(store, {
				actionKey: `test:${actionType}:5`,
				campaignId,
				workItemId,
				actionType,
				intent,
			});
			const outcome = await executeJournaledMutation(
				store,
				{ campaignId, action: planned.action },
				async () => {
					throw new Error("GitHub responded 422");
				},
			);
			expect(outcome.status).toBe("settled_failed");
			const row = store.actions.getAction(planned.action.id);
			expect(row?.state).toBe("permanent_failure");
			expect(row?.errorClass).toBe("github_rejected");
		});
	}

	test("an executing row left by a crash mid-I/O blocks blind replay", async () => {
		const sample = SAMPLE_INTENTS.find((entry) => entry.actionType === POST_COMMENT_ACTION_TYPE);
		if (sample === undefined) throw new Error("missing sample intent");
		const planned = journalMutationIntent(store, {
			actionKey: "test:crash:1",
			campaignId,
			workItemId,
			actionType: POST_COMMENT_ACTION_TYPE,
			intent: sample.intent,
		});
		store.actions.markExecuting(planned.action.id);
		const outcome = await executeJournaledMutation(
			store,
			{ campaignId, action: planned.action },
			async () => {
				throw new Error("must not run");
			},
		);
		expect(outcome.status).toBe("uncertain_blocked");
	});
});
