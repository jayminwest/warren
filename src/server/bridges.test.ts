import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import {
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	RunEventBroker,
} from "../runs/index.ts";
import { makePool, reapStub, stub } from "./bridges.test-helpers.ts";
import { bootBridges, createBridgeRegistry } from "./bridges.ts";

describe("createBridgeRegistry", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		await db.close();
	});

	test("start() invokes the bridge factory once per runId", async () => {
		const calls: BridgeRunStreamInput[] = [];
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async (input) => {
				calls.push(input);
				return { written: 0, skipped: 0, errored: false };
			},
		});

		registry.start("run_aaaaaaaaaaaa", "burrow_run_xxxxxxxxxx", "bur_a");
		registry.start("run_aaaaaaaaaaaa", "burrow_run_xxxxxxxxxx", "bur_a"); // idempotent
		registry.start("run_bbbbbbbbbbbb", "burrow_run_yyyyyyyyyy", "bur_b");

		expect(calls.length).toBe(2);
		expect(registry.size()).toBe(2);
	});

	test("resolved bridges auto-detach", async () => {
		const resolvers: Array<() => void> = [];
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: () =>
				new Promise<BridgeRunStreamResult>((resolve) => {
					resolvers.push(() => resolve({ written: 0, skipped: 0, errored: false }));
				}),
		});

		registry.start("run_aaaaaaaaaaaa", "burrow_run_xxxxxxxxxx", "bur_a");
		expect(registry.size()).toBe(1);

		for (const r of resolvers) r();
		await new Promise((r) => setTimeout(r, 0));
		expect(registry.size()).toBe(0);
	});

	test("stopAll() aborts in-flight bridges and waits for drain", async () => {
		let abortObserved = false;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: (input) =>
				new Promise<BridgeRunStreamResult>((resolve) => {
					input.signal?.addEventListener("abort", () => {
						abortObserved = true;
						resolve({ written: 0, skipped: 0, errored: false });
					});
				}),
		});

		registry.start("run_aaaaaaaaaaaa", "burrow_run_xxxxxxxxxx", "bur_a");
		await registry.stopAll();
		expect(abortObserved).toBe(true);
		expect(registry.size()).toBe(0);
	});

	test("reconnects after errored=true while run is still non-terminal (warren-b8fc)", async () => {
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
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

		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async () => {
				calls += 1;
				// First two attempts fail mid-stream (e.g., burrow's 10s
				// idleTimeout drops the connection). Third reconnect lands
				// after burrow has finished and ends naturally.
				return calls < 3
					? { written: 1, skipped: 0, errored: true }
					: { written: 1, skipped: 0, errored: false };
			},
			reconnectBackoffMs: [0],
		});

		registry.start(run.id, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((r) => setTimeout(r, 0));
		expect(calls).toBe(3);
	});

	test("stops reconnecting once warren has finalized the run (mx-fadaa2)", async () => {
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
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

		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async () => {
				calls += 1;
				// Simulate the reaper finalizing between the first errored
				// bridge and the next reconnect attempt.
				if (calls === 1) {
					await repos.runs.markRunning(run.id);
					await repos.runs.finalize(run.id, "succeeded");
				}
				return { written: 0, skipped: 0, errored: true };
			},
			reconnectBackoffMs: [0],
		});

		registry.start(run.id, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((r) => setTimeout(r, 0));
		expect(calls).toBe(1);
		expect((await repos.runs.require(run.id)).state).toBe("succeeded");
	});

	test("warren-a69a: bridge terminalDetected triggers reap and stops reconnect loop", async () => {
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
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

		let bridgeCalls = 0;
		const reapCalls: { runId: string; outcome: string }[] = [];
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async () => {
				bridgeCalls += 1;
				return {
					written: 1,
					skipped: 0,
					errored: false,
					terminalDetected: { outcome: "failed" },
				};
			},
			reap: async (input) => {
				reapCalls.push({ runId: input.runId, outcome: input.outcome });
				return reapStub(input.outcome);
			},
			reconnectBackoffMs: [0],
		});

		registry.start(run.id, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((r) => setTimeout(r, 0));
		expect(bridgeCalls).toBe(1);
		expect(reapCalls).toEqual([{ runId: run.id, outcome: "failed" }]);
	});

	test("warren-a69a: reap throwing inside the registry does not crash the registry", async () => {
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
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

		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async () => ({
				written: 1,
				skipped: 0,
				errored: false,
				terminalDetected: { outcome: "succeeded" },
			}),
			reap: async () => {
				throw new Error("disk full");
			},
			reconnectBackoffMs: [0],
		});

		registry.start(run.id, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((r) => setTimeout(r, 0));
		// No reconnect after terminalDetected even when reap throws.
		expect(registry.size()).toBe(0);
	});

	test("warren-018a: a synchronous throw inside bridge does not crash the registry", async () => {
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
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

		const errors: { runId: string; err: string }[] = [];
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async () => {
				throw new Error("burrow has no placement record: bur_a");
			},
			logger: {
				error: (obj: object) => {
					const o = obj as { runId?: string; err?: string };
					if (o.runId !== undefined && o.err !== undefined) {
						errors.push({ runId: o.runId, err: o.err });
					}
				},
			},
			reconnectBackoffMs: [0],
		});

		registry.start(run.id, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((r) => setTimeout(r, 0));

		// Rejection was caught (no unhandled rejection ⇒ no process exit).
		expect(errors.some((e) => e.runId === run.id && /placement/.test(e.err))).toBe(true);

		// A `bridge_fatal` system event landed so the UI shows why the
		// bridge stopped.
		const tail = await repos.events.listByRun(run.id);
		expect(tail.length).toBe(1);
		expect(tail[0]?.kind).toBe("bridge_fatal");
		expect(tail[0]?.stream).toBe("system");
		expect((tail[0]?.payloadJson as { error: string }).error).toMatch(/placement/);
	});

	test("stopAll() aborts a reconnect sleep so the loop exits promptly", async () => {
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
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

		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
			bridge: async () => {
				calls += 1;
				return { written: 0, skipped: 0, errored: true };
			},
			// Long sleep we abort before it elapses.
			reconnectBackoffMs: [60_000],
		});

		registry.start(run.id, "rb_a", "bur_a");
		await new Promise((r) => setTimeout(r, 5));
		await registry.stopAll();
		expect(calls).toBe(1);
		expect(registry.size()).toBe(0);
	});
});

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
