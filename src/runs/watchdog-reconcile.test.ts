/**
 * Terminal-reconcile safety-net tests (warren-c433). Covers the pure
 * status→outcome projection and the `tickWatchdog` net that force-finalizes a run
 * whose pod is terminal-or-gone but whose row stayed `running` past the grace.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import type { ReapRunInput } from "./reap/index.ts";
import {
	fakeReapResult,
	makeAgentJson,
	makeStatusProvider,
	PROJECT_ID,
	statusOf,
} from "./watchdog.test-helpers.ts";
import { tickWatchdog } from "./watchdog.ts";
import {
	reconcileTargetFromStatus,
	WATCHDOG_TERMINAL_RECONCILED_KIND,
} from "./watchdog-reconcile.ts";

describe("reconcileTargetFromStatus (warren-c433)", () => {
	test("a vanished pod is a lost run", () => {
		expect(reconcileTargetFromStatus(statusOf({ exists: false, phase: "failed" }))).toEqual({
			outcome: "failed",
			failureReason: "sandbox_run_lost",
		});
	});
	test("warren-fe9b: a vanished pod WITH cancel intent reconciles to cancelled (intent wins over the lost mapping)", () => {
		expect(reconcileTargetFromStatus(statusOf({ exists: false, phase: "failed" }), true)).toEqual({
			outcome: "cancelled",
		});
	});
	test("a succeeded pod reconciles to succeeded (no failure reason)", () => {
		expect(reconcileTargetFromStatus(statusOf({ phase: "succeeded", exitCode: 0 }))).toEqual({
			outcome: "succeeded",
		});
	});
	test("a failed pod carries its terminalReason through", () => {
		expect(
			reconcileTargetFromStatus(statusOf({ phase: "failed", terminalReason: "oom_killed" })),
		).toEqual({ outcome: "failed", failureReason: "oom_killed" });
		expect(
			reconcileTargetFromStatus(statusOf({ phase: "failed", terminalReason: "evicted" })),
		).toEqual({ outcome: "failed", failureReason: "evicted" });
		// warren-ea4b: a Spot-preempted pod carries the retryable `preempted` cause.
		expect(
			reconcileTargetFromStatus(statusOf({ phase: "failed", terminalReason: "preempted" })),
		).toEqual({ outcome: "failed", failureReason: "preempted" });
		expect(reconcileTargetFromStatus(statusOf({ phase: "failed" }))).toEqual({
			outcome: "failed",
			failureReason: "crashed",
		});
	});
	test("a still-live pod yields null (keep waiting)", () => {
		expect(reconcileTargetFromStatus(statusOf({ phase: "running" }))).toBeNull();
		expect(reconcileTargetFromStatus(statusOf({ phase: "queued" }))).toBeNull();
	});
});

describe("tickWatchdog — terminal-reconcile net (warren-c433)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
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

	async function seedRunningWithBurrow(startedAt: string): Promise<string> {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "go",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: "batch",
		});
		await repos.runs.markRunning(row.id, new Date(startedAt));
		await repos.runs.attachBurrow(row.id, { sandboxId: "bur_1", sandboxRunId: "run_b1" });
		return row.id;
	}

	test("force-finalizes a terminal-but-stuck run below the heartbeat budget", async () => {
		// The exact warren-c433 shape: the pod completed (status → succeeded) but the
		// row is still `running`, idle 5 min — past the reconcile grace but well under
		// the 45-min heartbeat budget. The net reaps it with the pod's real outcome.
		const runId = await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		const { provider, statusCalls } = makeStatusProvider(
			statusOf({ phase: "succeeded", exitCode: 0 }),
		);
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 60_000,
			now: () => new Date("2026-06-05T00:05:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("succeeded");
			},
		});

		expect(result.timedOut).toEqual([]);
		expect(result.reconciled).toEqual([{ runId, idleMs: 5 * 60_000, outcome: "succeeded" }]);
		expect(statusCalls()).toBe(1);
		expect(reapCalls).toHaveLength(1);
		expect(reapCalls[0]?.outcome).toBe("succeeded");
		expect(reapCalls[0]?.failureReason).toBeUndefined();
		expect(reapCalls[0]?.runtimeProvider).toBe(provider);

		const events = await repos.events.listByRun(runId);
		const reconciled = events.find((e) => e.kind === WATCHDOG_TERMINAL_RECONCILED_KIND);
		expect(reconciled).toBeDefined();
		expect((reconciled?.payloadJson as { providerPhase?: string }).providerPhase).toBe("succeeded");
	});

	test("warren-fe9b: a vanished pod WITH a cancel.requested event reconciles to cancelled through reap (the costUsd-finalization path)", async () => {
		const runId = await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		// The cancel intent record: cancelRun appended this when it forwarded the
		// pod delete — warren itself deleted the pod, so the NotFound → lost
		// reconciliation must NOT override the operator's cancel.
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: "2026-06-05T00:04:30Z",
			kind: "cancel.requested",
			stream: "system",
			payload: { mode: "forwarded" },
		});
		const { provider } = makeStatusProvider(statusOf({ exists: false, phase: "failed" }));
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 60_000,
			now: () => new Date("2026-06-05T00:05:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("cancelled");
			},
		});
		expect(result.reconciled).toEqual([{ runId, idleMs: 30_000, outcome: "cancelled" }]);
		expect(reapCalls).toHaveLength(1);
		expect(reapCalls[0]?.outcome).toBe("cancelled");
		expect(reapCalls[0]?.failureReason).toBeUndefined();

		const events = await repos.events.listByRun(runId);
		const reconciled = events.find((e) => e.kind === WATCHDOG_TERMINAL_RECONCILED_KIND);
		expect(reconciled).toBeDefined();
		expect((reconciled?.payloadJson as { cancelRequested?: boolean }).cancelRequested).toBe(true);
	});

	test("warren-fe9b: the cancel fast path probes a cancel-intent run BEFORE the full reconcile grace elapses", async () => {
		const runId = await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: "2026-06-05T00:00:20Z",
			kind: "cancel.requested",
			stream: "system",
			payload: { mode: "forwarded" },
		});
		const { provider, statusCalls } = makeStatusProvider(
			statusOf({ exists: false, phase: "failed" }),
		);
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 120_000,
			cancelReconcileGraceMs: 15_000,
			// idle 30s — past the 15s cancel fast-path grace, well under the 2-min
			// full grace. The deliberately-deleted pod reconciles in seconds, not
			// minutes.
			now: () => new Date("2026-06-05T00:00:50Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("cancelled");
			},
		});
		expect(statusCalls()).toBe(1);
		expect(result.reconciled).toEqual([{ runId, idleMs: 30_000, outcome: "cancelled" }]);
		expect(reapCalls[0]?.outcome).toBe("cancelled");
	});

	test("warren-fe9b: the fast path leaves a run WITHOUT cancel intent unprobed until the full grace", async () => {
		await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		const { provider, statusCalls } = makeStatusProvider(
			statusOf({ exists: false, phase: "failed" }),
		);
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 120_000,
			cancelReconcileGraceMs: 15_000,
			now: () => new Date("2026-06-05T00:00:30Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});
		expect(statusCalls()).toBe(0);
		expect(result.reconciled).toEqual([]);
		expect(reapCalls).toEqual([]);
	});

	test("a vanished pod reconciles to failed(sandbox_run_lost)", async () => {
		const runId = await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		const { provider } = makeStatusProvider(statusOf({ exists: false, phase: "failed" }));
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 60_000,
			now: () => new Date("2026-06-05T00:05:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});
		expect(result.reconciled).toEqual([{ runId, idleMs: 5 * 60_000, outcome: "failed" }]);
		expect(reapCalls[0]?.outcome).toBe("failed");
		expect(reapCalls[0]?.failureReason).toBe("sandbox_run_lost");
	});

	// warren-4a95: an eviction must be diagnosable after the pod (and its
	// kubectl events) are GC'd — the kubelet's message rides the reconcile
	// event payload onto the run's event stream.
	test("an evicted pod reconciles to failed(evicted) and captures the kubelet detail on the event", async () => {
		const runId = await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		const detail = "Pod ephemeral local storage usage exceeds the total limit of containers 10Gi.";
		const { provider } = makeStatusProvider(
			statusOf({ phase: "failed", terminalReason: "evicted", terminalDetail: detail }),
		);
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 60_000,
			now: () => new Date("2026-06-05T00:05:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});
		expect(result.reconciled).toEqual([{ runId, idleMs: 5 * 60_000, outcome: "failed" }]);
		expect(reapCalls[0]?.failureReason).toBe("evicted");

		const events = await repos.events.listByRun(runId);
		const reconciled = events.find((e) => e.kind === WATCHDOG_TERMINAL_RECONCILED_KIND);
		expect(reconciled).toBeDefined();
		expect((reconciled?.payloadJson as { providerDetail?: string }).providerDetail).toBe(detail);
	});

	test("warren-7f0b: a LIVE pod with the stdin_hold_timeout kill witness reaps as failed(agent_died)", async () => {
		// The zombie shape: the in-pod entrypoint's idle watchdog killed the
		// harness (witness persisted on the system stream) but the pod still reads
		// Running — the entrypoint lives on, polling finalize-intent for up to its
		// 40-min ceiling, and nothing else terminalizes the row. The net reaps it
		// with the dedicated reason so the intent parks (and the pod's finalize
		// loop salvages the workspace) while the emptyDir still exists.
		const runId = await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: "2026-06-05T00:02:00Z",
			kind: "stdin_hold_timeout",
			stream: "system",
			payload: { idleMs: 1_800_000 },
		});
		const { provider, statusCalls } = makeStatusProvider(statusOf({ phase: "running" }));
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 60_000,
			now: () => new Date("2026-06-05T00:05:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});
		expect(result.reconciled).toEqual([{ runId, idleMs: 3 * 60_000, outcome: "failed" }]);
		expect(statusCalls()).toBe(1);
		expect(reapCalls).toHaveLength(1);
		expect(reapCalls[0]?.outcome).toBe("failed");
		expect(reapCalls[0]?.failureReason).toBe("agent_died");

		const events = await repos.events.listByRun(runId);
		const reconciled = events.find((e) => e.kind === WATCHDOG_TERMINAL_RECONCILED_KIND);
		expect(reconciled).toBeDefined();
		expect((reconciled?.payloadJson as { providerPhase?: string }).providerPhase).toBe("running");
	});

	test("warren-7f0b: a live pod with the witness only on a NON-system stream is left alone (provenance)", async () => {
		// The kill witness is only authoritative on `stream=system`, which the
		// provenance gate reserves for warren-owned writers — an agent printing
		// the kind on stdout must not get its run reaped as agent_died.
		const runId = await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: "2026-06-05T00:02:00Z",
			kind: "stdin_hold_timeout",
			stream: "stdout",
			payload: { idleMs: 1_800_000 },
		});
		const { provider } = makeStatusProvider(statusOf({ phase: "running" }));
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 60_000,
			now: () => new Date("2026-06-05T00:05:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});
		expect(result.reconciled).toEqual([]);
		expect(reapCalls).toEqual([]);
	});

	test("leaves a still-live pod alone (no reap)", async () => {
		await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		const { provider, statusCalls } = makeStatusProvider(statusOf({ phase: "running" }));
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 60_000,
			now: () => new Date("2026-06-05T00:05:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});
		expect(result.reconciled).toEqual([]);
		expect(statusCalls()).toBe(1);
		expect(reapCalls).toEqual([]);
	});

	test("does not probe before the grace elapses", async () => {
		await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		const { provider, statusCalls } = makeStatusProvider(statusOf({ phase: "succeeded" }));
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 5 * 60_000,
			// idle only 1 min — under the 5-min grace, so no probe fires.
			now: () => new Date("2026-06-05T00:01:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});
		expect(result.reconciled).toEqual([]);
		expect(statusCalls()).toBe(0);
		expect(reapCalls).toEqual([]);
	});

	test("is off when the grace is omitted (default deps shape) — no status probe", async () => {
		await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		const { provider, statusCalls } = makeStatusProvider(statusOf({ phase: "succeeded" }));
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			// terminalReconcileGraceMs omitted ⇒ net disabled.
			now: () => new Date("2026-06-05T00:30:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});
		expect(result.reconciled).toEqual([]);
		expect(statusCalls()).toBe(0);
		expect(reapCalls).toEqual([]);
	});

	test("a transient status() error does not reconcile and does not throw", async () => {
		await seedRunningWithBurrow("2026-06-05T00:00:00Z");
		const provider = {
			status: async () => {
				throw new Error("k8s api hiccup");
			},
			cancel: async () => {},
		} as unknown as RuntimeProvider;
		const reapCalls: ReapRunInput[] = [];
		const result = await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 45 * 60_000,
			terminalReconcileGraceMs: 60_000,
			now: () => new Date("2026-06-05T00:05:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});
		expect(result.reconciled).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(reapCalls).toEqual([]);
	});
});
