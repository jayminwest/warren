import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { type ReapRunInput, type ReapRunResult, RunEventBroker } from "../runs/index.ts";
import { reconcileLostSandboxRun } from "./bridge-reconnect.ts";
import { makeProvider } from "./bridges.test-helpers.ts";
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
			sandboxId: "bur_a",
			sandboxRunId: "rb_a",
		});
		return run.id;
	}

	test("emits one-shot bridge_stalled after N consecutive errored reconnects", async () => {
		const runId = await seedRun();
		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: makeProvider().provider,
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
			runtimeProvider: makeProvider().provider,
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

	test("finalizes run as failed/sandbox_unreachable once stall ceiling is crossed", async () => {
		const runId = await seedRun();
		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: makeProvider().provider,
			// Burrow is up but unresponsive: every reconnect errors with
			// sandboxRunMissing:false, so the loop would spin forever without
			// the hard ceiling (warren-af76).
			bridge: async () => {
				calls += 1;
				return { written: 0, skipped: 0, errored: true };
			},
			reconnectBackoffMs: [0],
			stallThreshold: 2,
			stallCeiling: 4,
		});

		registry.start(runId, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((r) => setTimeout(r, 0));

		// The loop gave up instead of reconnecting indefinitely.
		expect(calls).toBe(4);

		const run = await repos.runs.get(runId);
		expect(run?.state).toBe("failed");
		expect(run?.failureReason).toBe("sandbox_unreachable");

		const events = await repos.events.listByRun(runId);
		expect(events.filter((e) => e.kind === "bridge_stalled").length).toBe(1);
		const lost = events.filter((e) => e.kind === "bridge_lost");
		expect(lost.length).toBe(1);
		expect((lost[0]?.payloadJson as { reason: string }).reason).toBe("sandbox_unreachable");
		expect((lost[0]?.payloadJson as { finalized: boolean }).finalized).toBe(true);
	});

	test("tears down the workspace via provider.terminate on the stall-ceiling path (warren-4f01/warren-5a3f)", async () => {
		const runId = await seedRun();
		// The boot-resolved backend is always threaded now (warren-5a3f): the
		// reconciler tears down through `provider.terminate` — no domain-side burrow
		// call, works for both K8s pod delete and burrow destroy.
		const { provider, terminateCalls } = makeProvider();
		await reconcileLostSandboxRun({
			runId,
			sandboxRunId: "rb_a",
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: provider,
			failureReason: "sandbox_unreachable",
		});

		// Run finalized terminal, AND the run's sandbox was torn down through the seam.
		const run = await repos.runs.get(runId);
		expect(run?.state).toBe("failed");
		expect(terminateCalls).toEqual([{ runId, sandboxId: "bur_a", providerRunId: "rb_a" }]);

		const kinds = (await repos.events.listByRun(runId)).map((e) => e.kind);
		expect(kinds).toContain("reap.workspace_destroyed");
	});

	test("skips teardown when the run has no sandbox id (warren-4f01)", async () => {
		// A run with no sandbox_id ⇒ nothing to tear down, but the run still
		// finalizes terminal and the teardown seam is never invoked.
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y2",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxRunId: "rb_nosandbox1",
		});
		const { provider, terminateCalls } = makeProvider();
		await reconcileLostSandboxRun({
			runId: run.id,
			sandboxRunId: "rb_nosandbox1",
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: provider,
		});
		expect(terminateCalls).toEqual([]);
		const kinds = (await repos.events.listByRun(run.id)).map((e) => e.kind);
		expect(kinds).not.toContain("reap.workspace_destroyed");
		expect(kinds).not.toContain("reap.workspace_destroy_failed");
		expect((await repos.runs.get(run.id))?.state).toBe("failed");
	});

	test("no bridge_stalled when reconnects stay under threshold", async () => {
		const runId = await seedRun();
		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: makeProvider().provider,
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

/**
 * warren-a7cb: reap orchestration routes through the RuntimeProvider seam.
 * The inline terminal-detect reap forwards the active provider, and the lost-run
 * reconcile tears down through `provider.terminate` so both backends (K8s pod
 * delete / burrow destroy) are covered — without a direct burrow call.
 */
describe("reap orchestration through the provider seam (warren-a7cb)", () => {
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
			sandboxId: "bur_a",
			sandboxRunId: "rb_a",
		});
		return run.id;
	}

	test("inline terminal-detect reap forwards the active runtimeProvider", async () => {
		const runId = await seedRun();
		const { provider } = makeProvider();
		let seen: ReapRunInput | undefined;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: provider,
			bridge: async () => ({
				written: 1,
				skipped: 0,
				errored: false,
				terminalDetected: { outcome: "succeeded" },
			}),
			reap: async (input): Promise<ReapRunResult> => {
				seen = input;
				return { state: "succeeded", alreadyTerminal: false } as unknown as ReapRunResult;
			},
		});

		registry.start(runId, "rb_a", "bur_a");
		while (registry.size() > 0) await new Promise((r) => setTimeout(r, 0));

		// The reap saw the SAME provider instance the registry was booted with, so
		// under WARREN_RUNTIME=k8s finalize + terminate run in-pod, not over burrow.
		expect(seen?.runtimeProvider).toBe(provider);
	});

	test("reconcile tears down via provider.terminate and emits workspace_destroyed", async () => {
		const runId = await seedRun();
		const { provider, terminateCalls } = makeProvider();
		await reconcileLostSandboxRun({
			runId,
			sandboxRunId: "rb_a",
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: provider,
			failureReason: "sandbox_run_lost",
		});

		// terminate() got the seam handle (opaque ids), NOT a burrow-typed call.
		expect(terminateCalls).toHaveLength(1);
		expect(terminateCalls[0]).toEqual({ runId, sandboxId: "bur_a", providerRunId: "rb_a" });

		const destroyed = (await repos.events.listByRun(runId)).find(
			(e) => e.kind === "reap.workspace_destroyed",
		);
		expect(destroyed).toBeDefined();
		expect(destroyed?.payloadJson).toMatchObject({
			sandboxId: "bur_a",
			archived: false,
			deletedEvents: 3,
			deletedRuns: 1,
		});
		expect((await repos.runs.get(runId))?.state).toBe("failed");
	});

	test("reconcile degrades a terminate failure to workspace_destroy_failed", async () => {
		const runId = await seedRun();
		const { provider } = makeProvider({ throwOnTerminate: new Error("pod delete 500") });
		await reconcileLostSandboxRun({
			runId,
			sandboxRunId: "rb_a",
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: provider,
		});

		const failed = (await repos.events.listByRun(runId)).find(
			(e) => e.kind === "reap.workspace_destroy_failed",
		);
		expect(failed).toBeDefined();
		expect(failed?.payloadJson).toMatchObject({ sandboxId: "bur_a", step: "destroy" });
		// The run still finalized despite the best-effort teardown failure.
		expect((await repos.runs.get(runId))?.state).toBe("failed");
	});
});
