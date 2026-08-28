import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { MIGRATIONS } from "./schema.ts";
import { CampaignStateStore } from "./state-store.ts";

const clock = new FixedClock(1_000_000);
const ids = new SequentialIdGenerator();

let dir: string;
let dbPath: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "campaign-store-"));
	dbPath = join(dir, "state.db");
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function openStore(): CampaignStateStore {
	return new CampaignStateStore(dbPath, { clock, ids });
}

describe("CampaignStateStore", () => {
	test("migrates an empty database exactly once and replays nothing on reopen", () => {
		const store = openStore();
		expect(store.appliedMigrationIds()).toEqual(MIGRATIONS.map((migration) => migration.id));
		expect(store.journalMode()).toBe("wal");
		store.close();

		const reopened = openStore();
		expect(reopened.appliedMigrationIds()).toEqual(MIGRATIONS.map((m) => m.id));
		reopened.close();
	});

	test("reopen after restart sees every committed row", () => {
		const store = openStore();
		const campaign = store.campaigns.createCampaign({
			manifestDigest: "digest-restart",
			manifestJson: "{}",
			budgetCapUsdCents: 100_00,
		});
		const workItem = store.campaigns.addWorkItem({
			campaignId: campaign.id,
			position: 1,
			issueRef: "https://github.com/openclaw/openclaw/issues/1",
		});
		const action = store.actions.beginAction({
			actionKey: "warren:dispatch:digest-restart:1",
			campaignId: campaign.id,
			workItemId: workItem.id,
			actionType: "warren_dispatch",
			requestDigest: "req-1",
		});
		store.events.recordGithubEvent({
			nodeId: "node-1",
			campaignId: campaign.id,
			eventKind: "review_comment",
			payloadJson: "{}",
		});
		store.close();

		const reopened = openStore();
		expect(reopened.campaigns.getCampaignByDigest("digest-restart")?.id).toBe(campaign.id);
		expect(reopened.campaigns.listWorkItems(campaign.id)).toHaveLength(1);
		expect(reopened.actions.getActionByKey(action.actionKey)?.id).toBe(action.id);
		expect(reopened.events.getGithubEvent("node-1")?.eventKind).toBe("review_comment");
		reopened.close();
	});

	test("a throwing transaction rolls back every write inside it", () => {
		const store = openStore();
		const campaign = store.campaigns.createCampaign({
			manifestDigest: "digest-rollback",
			manifestJson: "{}",
		});
		expect(() =>
			store.transaction(() => {
				store.campaigns.addWorkItem({
					campaignId: campaign.id,
					position: 99,
					issueRef: "issue://rolled-back",
				});
				throw new Error("simulated crash mid-transaction");
			}),
		).toThrow("simulated crash mid-transaction");
		const workItems = store.campaigns
			.listWorkItems(campaign.id)
			.filter((item) => item.position === 99);
		expect(workItems).toHaveLength(0);
		store.close();
	});

	test("timestamps come from the injected clock, not wall time", () => {
		const store = openStore();
		const campaign = store.campaigns.createCampaign({
			manifestDigest: "digest-clock",
			manifestJson: "{}",
		});
		expect(campaign.createdAtMs).toBe(1_000_000);
		clock.advance(5_000);
		const workItem = store.campaigns.addWorkItem({
			campaignId: campaign.id,
			position: 1,
			issueRef: "issue://clock",
		});
		expect(workItem.createdAtMs).toBe(1_005_000);
		clock.advance(-5_000);
		store.close();
	});

	test("no schema column can hold a secret, token, credential, or password", () => {
		const store = openStore();
		const columns = store.inspectSchema();
		expect(columns.length).toBeGreaterThan(50);
		const forbidden = columns.filter((column) =>
			/secret|token|credential|password|api_key|apikey|pat\b/i.test(column.column),
		);
		expect(forbidden).toEqual([]);
		store.close();
	});

	test("an in-memory store works for tests without touching the filesystem", () => {
		const store = new CampaignStateStore(":memory:", { clock, ids });
		expect(store.appliedMigrationIds()).toEqual(MIGRATIONS.map((m) => m.id));
		store.close();
	});
});
