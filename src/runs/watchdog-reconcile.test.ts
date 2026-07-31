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
			failureReason: "burrow_run_lost",
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
		await repos.runs.attachBurrow(row.id, { burrowId: "bur_1", burrowRunId: "run_b1" });
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

	test("a vanished pod reconciles to failed(burrow_run_lost)", async () => {
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
		expect(reapCalls[0]?.failureReason).toBe("burrow_run_lost");
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
