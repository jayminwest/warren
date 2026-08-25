import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { StateError } from "../errors.ts";
import { CampaignStateStore } from "./state-store.ts";

const clock = new FixedClock(1_000_000);

let dir: string;
let store: CampaignStateStore;
let campaignId: string;
let workItemId: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "campaign-events-"));
	store = new CampaignStateStore(join(dir, "state.db"), {
		clock,
		ids: new SequentialIdGenerator(),
	});
	const campaign = store.campaigns.createCampaign({
		manifestDigest: "digest-events",
		manifestJson: "{}",
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

describe("GitHub event idempotency", () => {
	test("a stable node id is ingested exactly once", () => {
		const first = store.events.recordGithubEvent({
			nodeId: "PRR_kwDOCff",
			campaignId,
			eventKind: "review",
			payloadJson: '{"state":"approved"}',
		});
		const second = store.events.recordGithubEvent({
			nodeId: "PRR_kwDOCff",
			campaignId,
			eventKind: "review",
			payloadJson: '{"state":"approved"}',
		});
		expect(first).toBe(true);
		expect(second).toBe(false);
		const event = store.events.getGithubEvent("PRR_kwDOCff");
		expect(event?.observedAtMs).toBe(clock.nowMs());
		expect(event?.eventKind).toBe("review");
	});
});

describe("Warren run correlation", () => {
	test("correlating a known run again returns the existing link", () => {
		const action = store.actions.beginAction({
			actionKey: "warren:dispatch:digest-events:1",
			campaignId,
			workItemId,
			actionType: "warren_dispatch",
			requestDigest: "req",
		});
		const link = store.events.correlateRun({
			runId: "run_77",
			campaignId,
			workItemId,
			actionId: action.id,
			branch: "warren/run_77",
		});
		const replay = store.events.correlateRun({
			runId: "run_77",
			campaignId,
			workItemId,
			actionId: action.id,
		});
		expect(replay).toEqual(link);
		expect(link.branch).toBe("warren/run_77");
	});
});

describe("prospective cross-fork PR identity", () => {
	test("records the prospective request and updates upstream identity later", () => {
		const prospective = store.events.recordPrIdentity({
			campaignId,
			workItemId,
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			forkOwner: "warren-run-bot",
			forkRepo: "openclaw",
			headBranch: "warren/run_77",
			title: "Add telemetry",
			bodyDigest: "body-digest-1",
		});
		expect(prospective.prNumber).toBeNull();
		expect(prospective.upstreamOwner).toBe("openclaw");

		const upstream = store.events.recordPrIdentity({
			campaignId,
			workItemId,
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			forkOwner: "warren-run-bot",
			forkRepo: "openclaw",
			headBranch: "warren/run_77",
			prNumber: 4242,
			prUrl: "https://github.com/openclaw/openclaw/pull/4242",
		});
		expect(upstream.id).toBe(prospective.id);
		expect(upstream.prNumber).toBe(4242);
		expect(upstream.bodyDigest).toBe("body-digest-1");
		expect(store.events.listPrIdentities(campaignId)).toHaveLength(1);
	});
});

describe("attention items", () => {
	test("open items list and resolve exactly once", () => {
		const item = store.events.addAttention({
			campaignId,
			reason: "dispatch_uncertain",
			workItemId,
		});
		expect(store.events.listOpenAttention(campaignId)).toHaveLength(1);
		store.events.resolveAttention(item.id);
		expect(store.events.listOpenAttention(campaignId)).toHaveLength(0);
		expect(() => store.events.resolveAttention(item.id)).toThrow(StateError);
	});
});

describe("leases", () => {
	test("a live lease blocks a second holder and an expired lease does not", () => {
		const lease = store.leases.acquireLease("campaign:digest-events", "tick-1", 60_000);
		expect(lease?.holder).toBe("tick-1");
		expect(store.leases.acquireLease("campaign:digest-events", "tick-2", 60_000)).toBeNull();

		clock.advance(61_000);
		const taken = store.leases.acquireLease("campaign:digest-events", "tick-2", 60_000);
		expect(taken?.holder).toBe("tick-2");
	});

	test("only the holder may release a lease", () => {
		store.leases.acquireLease("campaign:digest-events", "tick-1", 60_000);
		expect(store.leases.releaseLease("campaign:digest-events", "tick-2")).toBe(false);
		expect(store.leases.releaseLease("campaign:digest-events", "tick-1")).toBe(true);
		expect(store.leases.getLease("campaign:digest-events")).toBeNull();
	});

	test("the boot sweep expires abandoned leases only", () => {
		store.leases.acquireLease("scope:stale", "tick-1", 1_000);
		store.leases.acquireLease("scope:fresh", "tick-1", 600_000);
		clock.advance(2_000);
		expect(store.leases.expireLeases()).toBe(1);
		expect(store.leases.getLease("scope:stale")).toBeNull();
		expect(store.leases.getLease("scope:fresh")?.holder).toBe("tick-1");
	});
});
