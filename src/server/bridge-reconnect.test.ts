import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import { makePool } from "./bridges.test-helpers.ts";
import { createBridgeRegistry } from "./bridges.ts";

/**
 * Coverage for the bridge's degraded-state signalling (warren-6376):
 * `bridge_stalled` after N consecutive errored reconnects with no
 * forward progress, and `bridge_recovered` once events stream again.
 * Drives the live `runWithReconnect` loop through `createBridgeRegistry`.
 */
describe("runWithReconnect bridge_stalled/bridge_recovered (warren-6376)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
	});

	afterEach(async () => {
		await db.close();
	});

	async function seedRun(): Promise<string> {
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_a",
			burrowRunId: "rb_a",
		});
		return run.id;
	}

	test("emits one-shot bridge_stalled after N consecutive errored reconnects", async () => {
		const runId = await seedRun();
		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async () => {
				calls += 1;
				// Five errored reconnects with no progress, then a clean end.
				return calls <= 5
					? { written: 0, skipped: 0, errored: true }
					: { written: 0, skipped: 0, errored: false };
			},
			reconnectBackoffMs: [0],
			stallThreshold: 3,
		});

		registry.start(runId, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((r) => setTimeout(r, 0));

		const stalls = (await repos.events.listByRun(runId)).filter((e) => e.kind === "bridge_stalled");
		// One-shot per stall episode even though five reconnects errored.
		expect(stalls.length).toBe(1);
		expect(stalls[0]?.stream).toBe("system");
		expect((stalls[0]?.payloadJson as { attempts: number }).attempts).toBe(3);
	});

	test("emits bridge_recovered when events resume after a stall", async () => {
		const runId = await seedRun();
		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async () => {
				calls += 1;
				// 3 errored (→ stall), then a reconnect that streams events
				// (→ recover), then a clean end.
				if (calls <= 3) return { written: 0, skipped: 0, errored: true };
				if (calls === 4) return { written: 2, skipped: 0, errored: true };
				return { written: 1, skipped: 0, errored: false };
			},
			reconnectBackoffMs: [0],
			stallThreshold: 3,
		});

		registry.start(runId, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((r) => setTimeout(r, 0));

		const kinds = (await repos.events.listByRun(runId)).map((e) => e.kind);
		expect(kinds.filter((k) => k === "bridge_stalled").length).toBe(1);
		expect(kinds.filter((k) => k === "bridge_recovered").length).toBe(1);
		expect(kinds.indexOf("bridge_stalled")).toBeLessThan(kinds.indexOf("bridge_recovered"));
	});

	test("no bridge_stalled when reconnects stay under threshold", async () => {
		const runId = await seedRun();
		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async () => {
				calls += 1;
				return calls <= 2
					? { written: 0, skipped: 0, errored: true }
					: { written: 0, skipped: 0, errored: false };
			},
			reconnectBackoffMs: [0],
			stallThreshold: 3,
		});

		registry.start(runId, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((r) => setTimeout(r, 0));

		const kinds = (await repos.events.listByRun(runId)).map((e) => e.kind);
		expect(kinds).not.toContain("bridge_stalled");
	});
});
