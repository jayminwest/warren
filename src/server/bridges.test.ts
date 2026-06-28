import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import {
	type BridgeRunStreamInput,
	type BridgeRunStreamResult,
	RunEventBroker,
} from "../runs/index.ts";
import { makePool, reapStub } from "./bridges.test-helpers.ts";
import { createBridgeRegistry } from "./bridges.ts";

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
