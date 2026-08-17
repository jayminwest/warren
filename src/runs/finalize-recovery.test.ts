/**
 * Finalize-intent recovery driver tests (warren-5202). Pins the invariants
 * that close the control-plane-restart deadlock: a run pod still polling
 * `GET /runs/:id/finalize-intent` after warren was replaced mid-run gets its
 * intent re-parked via a recovery reap — never a double-drive of the healthy
 * path, never a stacked reap, and every non-terminal run converges.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { FinalizeCoordinator } from "../runtime/k8s/finalize-coordinator.ts";
import { IN_POD_FINALIZE_WIRE_VERSION } from "../runtime/k8s/finalize-wire.ts";
import {
	createFinalizeRecovery,
	FINALIZE_RECOVERY_KIND,
	type FinalizeRecoveryHook,
} from "./finalize-recovery.ts";
import type { ReapRunInput } from "./reap/index.ts";
import {
	fakeReapResult,
	makeAgentJson,
	makeStatusProvider,
	PROJECT_ID,
	statusOf,
} from "./watchdog.test-helpers.ts";

const GRACE_MS = 1_000;
const T0 = new Date("2026-08-12T00:00:00Z");

describe("createFinalizeRecovery (warren-5202)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let coordinator: FinalizeCoordinator;
	let clock: Date;
	let reapCalls: ReapRunInput[];
	let reapError: Error | null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		coordinator = new FinalizeCoordinator();
		clock = T0;
		reapCalls = [];
		reapError = null;
		await repos.agents.upsert({ name: "claude-code", renderedJson: makeAgentJson() });
		await repos.projects.create({
			id: PROJECT_ID,
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
	});
	afterEach(async () => {
		await db.close();
	});

	async function seedRunningWithBurrow(): Promise<string> {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "go",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: "batch",
		});
		await repos.runs.markRunning(row.id, T0);
		await repos.runs.attachBurrow(row.id, { sandboxId: "pod_1", sandboxRunId: "run_b1" });
		return row.id;
	}

	function makeHook(status = statusOf({ phase: "running" })): {
		hook: FinalizeRecoveryHook;
		statusCalls: () => number;
	} {
		const { provider, statusCalls } = makeStatusProvider(status);
		const hook = createFinalizeRecovery({
			repos,
			runtimeProvider: provider,
			reap: async (input) => {
				reapCalls.push(input);
				if (reapError !== null) throw reapError;
				return fakeReapResult(input.outcome);
			},
			coordinator,
			graceMs: GRACE_MS,
			now: () => clock,
		});
		return { hook, statusCalls };
	}

	/** Advance past the grace and fire the miss that should trigger the drive. */
	function missPastGrace(hook: FinalizeRecoveryHook, runId: string, agentExit?: number): void {
		hook.onIntentMiss(runId, agentExit !== undefined ? { agentExitCode: agentExit } : undefined);
		clock = new Date(clock.getTime() + GRACE_MS + 1);
		hook.onIntentMiss(runId, agentExit !== undefined ? { agentExitCode: agentExit } : undefined);
	}

	async function settle(): Promise<void> {
		// The drive is fire-and-forget; flush microtasks until the reap lands.
		for (let i = 0; i < 20; i += 1) await Promise.resolve();
	}

	test("drives a recovery reap for a running run whose live pod is stuck awaiting an intent", async () => {
		const runId = await seedRunningWithBurrow();
		const { hook } = makeHook();
		missPastGrace(hook, runId, 0);
		await settle();

		expect(reapCalls).toHaveLength(1);
		expect(reapCalls[0]?.runId).toBe(runId);
		expect(reapCalls[0]?.outcome).toBe("succeeded");
		expect(hook.drivenCount()).toBe(1);
		const events = await repos.events.listByRun(runId);
		const recovery = events.find((e) => e.kind === FINALIZE_RECOVERY_KIND);
		expect(recovery).toBeDefined();
		expect((recovery?.payloadJson as { source?: string }).source).toBe("agent_exit_hint");
	});

	test("invariant 2: a miss inside the grace window never fires (the healthy reap path races it)", async () => {
		const runId = await seedRunningWithBurrow();
		const { hook, statusCalls } = makeHook();
		hook.onIntentMiss(runId, { agentExitCode: 0 });
		clock = new Date(clock.getTime() + GRACE_MS - 1);
		hook.onIntentMiss(runId, { agentExitCode: 0 });
		await settle();

		expect(reapCalls).toHaveLength(0);
		expect(statusCalls()).toBe(0); // never even probed
	});

	test("invariant 1: a parked intent suppresses recovery and resets the miss clock", async () => {
		const runId = await seedRunningWithBurrow();
		const { hook } = makeHook();
		hook.onIntentMiss(runId, { agentExitCode: 0 });
		// The normal path parks its intent mid-grace — recovery must stand down.
		coordinator.register(runId, {
			version: IN_POD_FINALIZE_WIRE_VERSION,
			branch: "warren/run_x",
			push: true,
			artifacts: ["seeds"],
			commit: ["seeds"],
		});
		clock = new Date(clock.getTime() + GRACE_MS + 1);
		hook.onIntentMiss(runId, { agentExitCode: 0 });
		await settle();
		expect(reapCalls).toHaveLength(0);
	});

	test("invariant 3: concurrent misses past grace stack exactly one reap", async () => {
		const runId = await seedRunningWithBurrow();
		const { hook } = makeHook();
		hook.onIntentMiss(runId, { agentExitCode: 0 });
		clock = new Date(clock.getTime() + GRACE_MS + 1);
		// The pod polls every 2s; several misses land while the first drive runs.
		hook.onIntentMiss(runId, { agentExitCode: 0 });
		hook.onIntentMiss(runId, { agentExitCode: 0 });
		hook.onIntentMiss(runId, { agentExitCode: 0 });
		await settle();
		expect(reapCalls).toHaveLength(1);
	});

	test("a thrown reap re-arms the trigger — the next miss past grace retries", async () => {
		const runId = await seedRunningWithBurrow();
		const { hook } = makeHook();
		reapError = new Error("db hiccup");
		missPastGrace(hook, runId, 0);
		await settle();
		expect(reapCalls).toHaveLength(1);

		reapError = null;
		missPastGrace(hook, runId, 0);
		await settle();
		expect(reapCalls).toHaveLength(2);
		expect(hook.drivenCount()).toBe(2);
	});

	test("invariant 4: skips a terminal row, a terminal pod, a gone pod, and a non-running probe", async () => {
		const runId = await seedRunningWithBurrow();
		// Terminal row.
		await repos.runs.finalize(runId, "succeeded", T0, null);
		const terminalRow = makeHook();
		missPastGrace(terminalRow.hook, runId, 0);
		await settle();
		expect(reapCalls).toHaveLength(0);

		const runId2 = await seedRunningWithBurrow();
		// Terminal pod — the watchdog's reconcile net (warren-c433) owns it.
		const terminalPod = makeHook(statusOf({ phase: "succeeded", exitCode: 0 }));
		missPastGrace(terminalPod.hook, runId2, 0);
		await settle();
		expect(reapCalls).toHaveLength(0);

		// Gone pod — same owner.
		const gonePod = makeHook(statusOf({ exists: false, phase: "failed" }));
		missPastGrace(gonePod.hook, runId2, 0);
		await settle();
		expect(reapCalls).toHaveLength(0);
	});

	test("outcome provenance: the pod-reported agent exit code classifies a crashed agent as failed", async () => {
		const runId = await seedRunningWithBurrow();
		const { hook } = makeHook();
		missPastGrace(hook, runId, 1);
		await settle();
		expect(reapCalls[0]?.outcome).toBe("failed");
	});

	test("outcome provenance: no hint falls back to the persisted terminal envelope", async () => {
		const runId = await seedRunningWithBurrow();
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: T0.toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "agent_end", stopReason: "error", errorMessage: "boom" },
		});
		const { hook } = makeHook();
		missPastGrace(hook, runId);
		await settle();
		expect(reapCalls[0]?.outcome).toBe("failed");
		const events = await repos.events.listByRun(runId);
		const recovery = events.find((e) => e.kind === FINALIZE_RECOVERY_KIND);
		expect((recovery?.payloadJson as { source?: string }).source).toBe("event_log");
	});

	test("outcome provenance: no hint and no terminal envelope defaults to succeeded", async () => {
		const runId = await seedRunningWithBurrow();
		const { hook } = makeHook();
		missPastGrace(hook, runId);
		await settle();
		expect(reapCalls[0]?.outcome).toBe("succeeded");
		const events = await repos.events.listByRun(runId);
		const recovery = events.find((e) => e.kind === FINALIZE_RECOVERY_KIND);
		expect((recovery?.payloadJson as { source?: string }).source).toBe("default");
	});

	test("an unknown run id is a no-op (stale poll for a deleted run)", async () => {
		const { hook } = makeHook();
		missPastGrace(hook, "run_missing", 0);
		await settle();
		expect(reapCalls).toHaveLength(0);
	});
});
