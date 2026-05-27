import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { AgentsRepo } from "../db/repos/agents.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { buildSpawn, CanopyClient, CFG, FAKE_CLONE, rendered } from "./refresh.test-helpers.ts";
import { refreshAgentRegistry } from "./refresh.ts";

describe("refreshAgentRegistry", () => {
	let db: WarrenDb;
	let agents: AgentsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		agents = new AgentsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("registers every valid agent and caches its rendered definition", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "refactor-bot", version: 2, status: "active" },
					{ name: "docs-bot", version: 1, status: "active" },
				],
			},
			{
				"refactor-bot": { ok: rendered("refactor-bot", { system: "refactor" }, 2) },
				"docs-bot": { ok: rendered("docs-bot", { system: "docs", skills: "..." }) },
			},
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });

		const result = await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
		});

		expect(result.registered.map((r) => r.name).sort()).toEqual(["docs-bot", "refactor-bot"]);
		expect(result.skipped).toEqual([]);
		expect(result.removed).toEqual([]);
		const refactor = await agents.require("refactor-bot");
		expect((refactor.renderedJson as { sections: { system: string } }).sections.system).toBe(
			"refactor",
		);
	});

	test("skips a prompt whose render fails (e.g. archived between list and render) without aborting", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "good-bot", version: 1, status: "active" },
					{ name: "raced-bot", version: 1, status: "active" },
				],
			},
			{
				"good-bot": { ok: rendered("good-bot", { system: "ok" }) },
				"raced-bot": {
					exit: 1,
					ok: { success: false, command: "render", error: 'Prompt "raced-bot" not found' },
				},
			},
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });

		const result = await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
		});

		expect(result.registered.map((r) => r.name)).toEqual(["good-bot"]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]).toMatchObject({
			name: "raced-bot",
			code: "canopy_unavailable",
			reason: expect.stringContaining("not found"),
		});
	});

	test("skips a prompt that fails warren's semantic schema (missing system)", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [
					{ name: "bad-bot", version: 1, status: "active" },
					{ name: "ok-bot", version: 1, status: "active" },
				],
			},
			{
				"bad-bot": { ok: rendered("bad-bot", { skills: "no system" }) },
				"ok-bot": { ok: rendered("ok-bot", { system: "ok" }) },
			},
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });

		const result = await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
		});

		expect(result.registered.map((r) => r.name)).toEqual(["ok-bot"]);
		expect(result.skipped[0]).toMatchObject({
			name: "bad-bot",
			code: "agent_schema_error",
			reason: expect.stringContaining("system"),
		});
	});

	test("re-running the refresh upserts (lastRefreshed bumps, registeredAt preserved)", async () => {
		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "refactor-bot", version: 1, status: "active" }],
			},
			{ "refactor-bot": { ok: rendered("refactor-bot", { system: "v1" }) } },
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });
		await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
			now: () => new Date("2026-05-08T12:00:00.000Z"),
		});

		// Second refresh, new render, new clock.
		const spawn2 = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "refactor-bot", version: 2, status: "active" }],
			},
			{ "refactor-bot": { ok: rendered("refactor-bot", { system: "v2" }, 2) } },
		);
		const client2 = CanopyClient.forLibrary({ config: CFG, spawn: spawn2 });
		await refreshAgentRegistry({
			client: client2,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn: spawn2 },
			now: () => new Date("2026-05-09T12:00:00.000Z"),
		});

		const row = await agents.require("refactor-bot");
		expect(row.registeredAt).toBe("2026-05-08T12:00:00.000Z");
		expect(row.lastRefreshed).toBe("2026-05-09T12:00:00.000Z");
		expect((row.renderedJson as { version: number }).version).toBe(2);
	});

	test("prune: deletes warren rows missing from the canopy listing when prune=true", async () => {
		// First populate the db with two agents.
		await agents.upsert({ name: "stale-bot", renderedJson: { sections: {} } });
		await agents.upsert({ name: "live-bot", renderedJson: { sections: { system: "x" } } });

		const spawn = buildSpawn(
			{
				success: true,
				command: "list",
				prompts: [{ name: "live-bot", version: 1, status: "active" }],
			},
			{ "live-bot": { ok: rendered("live-bot", { system: "x" }) } },
		);
		const client = CanopyClient.forLibrary({ config: CFG, spawn });

		const result = await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
			prune: true,
		});

		expect(result.removed).toEqual(["stale-bot"]);
		expect(await agents.get("stale-bot")).toBeNull();
		expect(await agents.get("live-bot")).not.toBeNull();
	});

	test("prune defaults to off — stale rows are left alone", async () => {
		await agents.upsert({ name: "stale-bot", renderedJson: { sections: {} } });

		const spawn = buildSpawn({ success: true, command: "list", prompts: [] }, {});
		const client = CanopyClient.forLibrary({ config: CFG, spawn });

		const result = await refreshAgentRegistry({
			client,
			agents,
			clone: FAKE_CLONE,
			cloneOptions: { config: CFG, spawn },
		});

		expect(result.removed).toEqual([]);
		expect(await agents.get("stale-bot")).not.toBeNull();
	});
});
