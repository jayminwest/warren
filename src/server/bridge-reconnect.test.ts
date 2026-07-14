import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { type ReapRunInput, type ReapRunResult, RunEventBroker } from "../runs/index.ts";
import type { RunHandle, RuntimeProvider, TeardownResult } from "../runtime/contract.ts";
import { reconcileLostBurrowRun } from "./bridge-reconnect.ts";
import { makePool, stub } from "./bridges.test-helpers.ts";
import { createBridgeRegistry } from "./bridges.ts";

/** Minimal RuntimeProvider fake exposing only `terminate` (records handles). */
function fakeTerminateProvider(opts: { throwErr?: Error } = {}): {
	provider: RuntimeProvider;
	calls: RunHandle[];
} {
	const calls: RunHandle[] = [];
	const provider = {
		terminate: async (handle: RunHandle): Promise<TeardownResult> => {
			calls.push(handle);
			if (opts.throwErr !== undefined) throw opts.throwErr;
			return { archived: false, deletedEvents: 3, deletedMessages: 1, deletedRuns: 1 };
		},
	} as unknown as RuntimeProvider;
	return { provider, calls };
}

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
			burrowClient: await makePool(repos),
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
			burrowClient: await makePool(repos),
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

	test("finalizes run as failed/burrow_unreachable once stall ceiling is crossed", async () => {
		const runId = await seedRun();
		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClient: await makePool(repos),
			// Burrow is up but unresponsive: every reconnect errors with
			// burrowRunMissing:false, so the loop would spin forever without
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
		expect(run?.failureReason).toBe("burrow_unreachable");

		const events = await repos.events.listByRun(runId);
		expect(events.filter((e) => e.kind === "bridge_stalled").length).toBe(1);
		const lost = events.filter((e) => e.kind === "bridge_lost");
		expect(lost.length).toBe(1);
		expect((lost[0]?.payloadJson as { reason: string }).reason).toBe("burrow_unreachable");
		expect((lost[0]?.payloadJson as { finalized: boolean }).finalized).toBe(true);
	});

	test("tears down the workspace via a LocalProvider resolved from the burrow client (warren-4f01/warren-48b2)", async () => {
		const runId = await seedRun();
		// A burrow client whose DELETE /burrows/:id succeeds. With no runtimeProvider
		// threaded, the reconciler resolves a LocalProvider over this client
		// (warren-48b2) and tears down through `provider.terminate` — the burrow
		// destroy no longer happens through a domain-side burrow call.
		const destroyed: string[] = [];
		const destroyClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async (input, init) => {
				const url = new URL(String(input), "http://localhost");
				const method = init?.method ?? "GET";
				const m = url.pathname.match(/^\/burrows\/([^/]+)$/);
				if (method === "DELETE" && m?.[1] !== undefined) {
					destroyed.push(m[1]);
					return new Response(
						JSON.stringify({
							burrowId: m[1],
							archived: { events: 0 },
							deletedEvents: 3,
							deletedMessages: 1,
							deletedRuns: 2,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response(JSON.stringify({ error: { code: "not_found", message: "stub" } }), {
					status: 404,
				});
			}),
		});
		await reconcileLostBurrowRun({
			runId,
			burrowRunId: "rb_a",
			repos,
			broker: new RunEventBroker(),
			burrowClient: destroyClient,
			failureReason: "burrow_unreachable",
		});

		// Run finalized terminal, AND the run's burrow was torn down so the bwrap/pi
		// sandbox doesn't leak on the host.
		const run = await repos.runs.get(runId);
		expect(run?.state).toBe("failed");
		expect(destroyed).toEqual(["bur_a"]);

		const kinds = (await repos.events.listByRun(runId)).map((e) => e.kind);
		expect(kinds).toContain("reap.workspace_destroyed");
	});

	test("skips teardown when no provider can be resolved (warren-4f01/warren-48b2)", async () => {
		const runId = await seedRun();
		// Neither a runtimeProvider nor a burrowClient ⇒ no provider to resolve ⇒
		// teardown is skipped (no workspace-destroy event), but the run still
		// finalizes terminal.
		await reconcileLostBurrowRun({
			runId,
			burrowRunId: "rb_a",
			repos,
			broker: new RunEventBroker(),
		});
		const kinds = (await repos.events.listByRun(runId)).map((e) => e.kind);
		expect(kinds).not.toContain("reap.workspace_destroyed");
		expect(kinds).not.toContain("reap.workspace_destroy_failed");
		expect((await repos.runs.get(runId))?.state).toBe("failed");
	});

	test("no bridge_stalled when reconnects stay under threshold", async () => {
		const runId = await seedRun();
		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClient: await makePool(repos),
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

	async function seedRun(mode: "batch" | "conversation" = "batch"): Promise<string> {
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
			mode,
		});
		return run.id;
	}

	test("inline terminal-detect reap forwards the active runtimeProvider", async () => {
		const runId = await seedRun();
		const { provider } = fakeTerminateProvider();
		let seen: ReapRunInput | undefined;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClient: await makePool(repos),
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
		const { provider, calls } = fakeTerminateProvider();
		await reconcileLostBurrowRun({
			runId,
			burrowRunId: "rb_a",
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: provider,
			failureReason: "burrow_run_lost",
		});

		// terminate() got the seam handle (opaque ids), NOT a burrow-typed call.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ runId, sandboxId: "bur_a", providerRunId: "rb_a" });

		const destroyed = (await repos.events.listByRun(runId)).find(
			(e) => e.kind === "reap.workspace_destroyed",
		);
		expect(destroyed).toBeDefined();
		expect(destroyed?.payloadJson).toMatchObject({
			burrowId: "bur_a",
			archived: false,
			deletedEvents: 3,
			deletedRuns: 1,
		});
		expect((await repos.runs.get(runId))?.state).toBe("failed");
	});

	test("reconcile skips provider.terminate for conversation runs", async () => {
		const runId = await seedRun("conversation");
		const { provider, calls } = fakeTerminateProvider();
		await reconcileLostBurrowRun({
			runId,
			burrowRunId: "rb_a",
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: provider,
		});

		expect(calls).toHaveLength(0);
		const kinds = (await repos.events.listByRun(runId)).map((e) => e.kind);
		expect(kinds).toContain("reap.workspace_destroy_skipped");
	});

	test("reconcile degrades a terminate failure to workspace_destroy_failed", async () => {
		const runId = await seedRun();
		const { provider } = fakeTerminateProvider({ throwErr: new Error("pod delete 500") });
		await reconcileLostBurrowRun({
			runId,
			burrowRunId: "rb_a",
			repos,
			broker: new RunEventBroker(),
			runtimeProvider: provider,
		});

		const failed = (await repos.events.listByRun(runId)).find(
			(e) => e.kind === "reap.workspace_destroy_failed",
		);
		expect(failed).toBeDefined();
		expect(failed?.payloadJson).toMatchObject({ burrowId: "bur_a", step: "destroy" });
		// The run still finalized despite the best-effort teardown failure.
		expect((await repos.runs.get(runId))?.state).toBe("failed");
	});
});
