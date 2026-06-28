import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import { makePool, stub } from "./bridges.test-helpers.ts";
import { bootBridges, createBridgeRegistry } from "./bridges.ts";

describe("bootBridges", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: { name: "refactor-bot" } });
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	test("resumes runs with a burrow_run_id; skips ones without", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const r1 = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(r1.id, {
			burrowId: "bur_xxxxxxxxxxxx",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		await repos.burrows.create({ id: "bur_xxxxxxxxxxxx", workerId: "local" });

		const r2 = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		// r2 has no burrow_run_id — partial spawn

		const calls: string[] = [];
		const result = await bootBridges({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async (input) => {
				calls.push(input.runId);
				return { written: 0, skipped: 0, errored: false };
			},
		});

		expect(result.resumed.map((r) => r.runId)).toEqual([r1.id]);
		expect(result.skipped.map((s) => s.runId)).toEqual([r2.id]);
		expect(calls).toEqual([r1.id]);
		await result.registry.stopAll();
	});

	test("warren-018a: skips runs whose burrow_id has no `burrows` placement row", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		// r1 — placed: burrow row exists.
		const r1 = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(r1.id, {
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "rb_aaaaaaaaaa",
		});
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });

		// r2 — pre-pl-9ba1 orphan: burrow_id is set but no `burrows` row.
		const r2 = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(r2.id, {
			burrowId: "bur_orphanorphan",
			burrowRunId: "rb_orphan_aaaa",
		});

		const calls: string[] = [];
		const result = await bootBridges({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async (input) => {
				calls.push(input.runId);
				return { written: 0, skipped: 0, errored: false };
			},
		});

		expect(result.resumed.map((r) => r.runId)).toEqual([r1.id]);
		expect(result.skipped).toEqual([{ runId: r2.id, reason: "no_placement" }]);
		expect(calls).toEqual([r1.id]);
		await result.registry.stopAll();
	});

	test("warren-b1a9: pre-probe 404 reconciles run to failed/burrow_run_lost without starting bridge", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");

		const r = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(r.id, {
			burrowId: "bur_lostlostlost",
			burrowRunId: "rb_ghostghost1",
		});
		await repos.burrows.create({ id: "bur_lostlostlost", workerId: "local" });
		await repos.runs.markRunning(r.id);

		// Burrow stub that 404s on GET /runs/:id (ghost).
		const ghostClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(
				async () =>
					new Response(
						JSON.stringify({
							error: { code: "not_found", message: "run not found: rb_ghostghost1" },
						}),
						{ status: 404, headers: { "content-type": "application/json" } },
					),
			),
		});
		const pool = await makePool(repos, ghostClient);

		const calls: string[] = [];
		const result = await bootBridges({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: pool,
			bridge: async (input) => {
				calls.push(input.runId);
				return { written: 0, skipped: 0, errored: false };
			},
		});

		expect(calls).toEqual([]);
		expect(result.resumed).toEqual([]);
		expect(result.skipped).toEqual([{ runId: r.id, reason: "burrow_run_lost" }]);
		const run = await repos.runs.require(r.id);
		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("burrow_run_lost");
		const events = await repos.events.listByRun(r.id);
		expect(events[0]?.kind).toBe("bridge_lost");
		expect((events[0]?.payloadJson as { reason: string }).reason).toBe("burrow_run_lost");
		expect(events.map((e) => e.kind)).toContain("reap.workspace_destroy_failed"); // warren-4f01
		await result.registry.stopAll();
	});

	test("warren-b1a9: bridge burrowRunMissing reconciles + stops reconnect loop", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const r = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.runs.attachBurrow(r.id, {
			burrowId: "bur_a",
			burrowRunId: "rb_a",
		});
		await repos.burrows.create({ id: "bur_a", workerId: "local" });
		await repos.runs.markRunning(r.id);

		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async () => {
				calls += 1;
				return { written: 0, skipped: 0, errored: false, burrowRunMissing: true as const };
			},
			reconnectBackoffMs: [0],
		});

		registry.start(r.id, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((res) => setTimeout(res, 0));
		expect(calls).toBe(1); // No reconnect after burrowRunMissing.
		const run = await repos.runs.require(r.id);
		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("burrow_run_lost");
		const events = await repos.events.listByRun(r.id);
		expect(events.some((e) => e.kind === "bridge_lost")).toBe(true);
	});

	test("returns an empty registry when no active runs", async () => {
		const result = await bootBridges({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
		});
		expect(result.resumed.length).toBe(0);
		expect(result.skipped.length).toBe(0);
		expect(result.registry.size()).toBe(0);
		await result.registry.stopAll();
	});
});
