import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "../runs/index.ts";
import type { DestroyBurrowWorkspaceByIdInput } from "../runs/reap/destroy.ts";
import { reconcileLostBurrowRun } from "./bridge-reconnect.ts";
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

	test("finalizes run as failed/burrow_unreachable once stall ceiling is crossed", async () => {
		const runId = await seedRun();
		let calls = 0;
		const registry = createBridgeRegistry({
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: await makePool(repos),
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

	test("tears down the burrow workspace after finalizing (warren-4f01)", async () => {
		const runId = await seedRun();
		const pool = await makePool(repos);
		const seen: DestroyBurrowWorkspaceByIdInput[] = [];
		await reconcileLostBurrowRun({
			runId,
			burrowRunId: "rb_a",
			repos,
			broker: new RunEventBroker(),
			burrowClientPool: pool,
			failureReason: "burrow_unreachable",
			destroyWorkspace: async (input) => {
				seen.push(input);
				await input.emit("reap.workspace_destroyed", { burrowId: input.burrowId });
				return true;
			},
		});

		// Run finalized terminal, AND the workspace teardown fired with the
		// run's burrow + mode so the bwrap/pi sandbox doesn't leak on the host.
		const run = await repos.runs.get(runId);
		expect(run?.state).toBe("failed");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.burrowId).toBe("bur_a");
		expect(seen[0]?.mode).toBe("batch");
		expect(seen[0]?.burrowClientPool).toBe(pool);

		const kinds = (await repos.events.listByRun(runId)).map((e) => e.kind);
		expect(kinds).toContain("reap.workspace_destroyed");
	});

	test("skips teardown when no pool is supplied (warren-4f01)", async () => {
		const runId = await seedRun();
		let called = false;
		await reconcileLostBurrowRun({
			runId,
			burrowRunId: "rb_a",
			repos,
			broker: new RunEventBroker(),
			destroyWorkspace: async () => {
				called = true;
				return true;
			},
		});
		expect(called).toBe(false);
		expect((await repos.runs.get(runId))?.state).toBe("failed");
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
