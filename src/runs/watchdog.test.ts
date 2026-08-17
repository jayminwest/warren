/**
 * Unit tests for the run heartbeat watchdog (warren-285d).
 *
 * Coverage:
 *   - `computeIdleMs` anchors on the newest event ts, falling back to
 *     `startedAt`, and returns null when neither is parseable.
 *   - `loadWatchdogConfigFromEnv` is on by default with the built-in
 *     budget, honours an explicit timeout, opts out via
 *     `WARREN_WATCHDOG_DISABLED` (or a 0 budget), and rejects malformed
 *     values.
 *   - a running run past the heartbeat budget is force-failed: a
 *     `watchdog.timed_out` event is emitted, the burrow run is cancelled,
 *     and reap is called with `outcome: failed` / `failureReason:
 *     timed_out`.
 *   - a fresh run inside budget is left alone.
 *   - per-run error isolation so one bad row can't tear down the tick.
 *   - the single-flight `bootWatchdog` wrapper drops overlapping ticks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { RunMode } from "../db/schema.ts";
import type { ReapRunInput } from "./reap/index.ts";
import {
	fakeReapResult,
	makeAgentJson,
	makeCancelProvider,
	PROJECT_ID,
} from "./watchdog.test-helpers.ts";
import {
	bootWatchdog,
	computeIdleMs,
	DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS,
	tickWatchdog,
	WATCHDOG_TIMED_OUT_KIND,
} from "./watchdog.ts";
import { loadWatchdogConfigFromEnv } from "./watchdog-config.ts";
import { DEFAULT_WATCHDOG_TERMINAL_RECONCILE_GRACE_MS } from "./watchdog-reconcile.ts";

describe("computeIdleMs", () => {
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

	async function seedRunning(startedAt: string): Promise<string> {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "go",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: "batch",
		});
		await repos.runs.markRunning(row.id, new Date(startedAt));
		return row.id;
	}

	test("falls back to startedAt when no events have flowed", async () => {
		const runId = await seedRunning("2026-06-05T00:00:00Z");
		const run = await repos.runs.require(runId);
		const idle = await computeIdleMs(repos, run, new Date("2026-06-05T00:05:00Z"));
		expect(idle).toBe(5 * 60_000);
	});

	test("anchors on the newest event ts when events exist", async () => {
		const runId = await seedRunning("2026-06-05T00:00:00Z");
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: "2026-06-05T00:04:00Z",
			kind: "text",
			stream: "stdout",
			payload: {},
		});
		const run = await repos.runs.require(runId);
		const idle = await computeIdleMs(repos, run, new Date("2026-06-05T00:05:00Z"));
		expect(idle).toBe(60_000);
	});

	test("returns null when no anchor is parseable", async () => {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "go",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: "batch",
		});
		// queued row never markRunning'd ⇒ startedAt null, no events.
		const run = await repos.runs.require(row.id);
		const idle = await computeIdleMs(repos, run, new Date("2026-06-05T00:05:00Z"));
		expect(idle).toBeNull();
	});
});

describe("loadWatchdogConfigFromEnv", () => {
	test("on by default with the built-in budget", () => {
		const cfg = loadWatchdogConfigFromEnv({});
		expect(cfg.enabled).toBe(true);
		expect(cfg.heartbeatTimeoutMs).toBe(DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS);
		expect(cfg.tickMs).toBe(30_000);
		expect(cfg.terminalReconcileGraceMs).toBe(DEFAULT_WATCHDOG_TERMINAL_RECONCILE_GRACE_MS);
	});

	test("honours an explicit terminal-reconcile grace and allows pinning to 0 (warren-c433)", () => {
		expect(
			loadWatchdogConfigFromEnv({ WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS: "30000" })
				.terminalReconcileGraceMs,
		).toBe(30_000);
		expect(
			loadWatchdogConfigFromEnv({ WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS: "0" })
				.terminalReconcileGraceMs,
		).toBe(0);
	});

	test("honours an explicit timeout", () => {
		const cfg = loadWatchdogConfigFromEnv({
			WARREN_RUN_HEARTBEAT_TIMEOUT_MS: "600000",
			WARREN_WATCHDOG_TICK_MS: "10000",
		});
		expect(cfg.enabled).toBe(true);
		expect(cfg.heartbeatTimeoutMs).toBe(600_000);
		expect(cfg.tickMs).toBe(10_000);
	});

	test("opts out via WARREN_WATCHDOG_DISABLED", () => {
		const cfg = loadWatchdogConfigFromEnv({ WARREN_WATCHDOG_DISABLED: "1" });
		expect(cfg.enabled).toBe(false);
		expect(cfg.heartbeatTimeoutMs).toBe(DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS);
	});

	test("opts out when the budget is pinned to 0", () => {
		const cfg = loadWatchdogConfigFromEnv({ WARREN_RUN_HEARTBEAT_TIMEOUT_MS: "0" });
		expect(cfg.enabled).toBe(false);
		expect(cfg.heartbeatTimeoutMs).toBe(0);
	});

	test("rejects a malformed timeout", () => {
		expect(() => loadWatchdogConfigFromEnv({ WARREN_RUN_HEARTBEAT_TIMEOUT_MS: "-5" })).toThrow(
			/non-negative integer/,
		);
	});

	test("rejects a non-positive tick", () => {
		expect(() => loadWatchdogConfigFromEnv({ WARREN_WATCHDOG_TICK_MS: "0" })).toThrow(
			/positive integer/,
		);
	});
});

describe("tickWatchdog", () => {
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

	async function seedRunning(
		startedAt: string,
		opts: { sandboxId?: string; sandboxRunId?: string; mode?: RunMode } = {},
	): Promise<string> {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "go",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: opts.mode ?? "batch",
		});
		await repos.runs.markRunning(row.id, new Date(startedAt));
		if (opts.sandboxId !== undefined || opts.sandboxRunId !== undefined) {
			await repos.runs.attachBurrow(row.id, {
				...(opts.sandboxId !== undefined ? { sandboxId: opts.sandboxId } : {}),
				...(opts.sandboxRunId !== undefined ? { sandboxRunId: opts.sandboxRunId } : {}),
			});
		}
		return row.id;
	}

	test("force-fails a hung run: emits event, cancels burrow, reaps failed", async () => {
		const runId = await seedRunning("2026-06-05T00:00:00Z", {
			sandboxId: "bur_1",
			sandboxRunId: "run_b1",
		});
		const cancels: string[] = [];
		const reapCalls: ReapRunInput[] = [];

		const result = await tickWatchdog({
			repos,
			runtimeProvider: makeCancelProvider(cancels),
			heartbeatTimeoutMs: 5 * 60_000,
			now: () => new Date("2026-06-05T00:10:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});

		expect(result.timedOut).toEqual([{ runId, idleMs: 10 * 60_000 }]);
		expect(result.errors).toEqual([]);
		expect(cancels).toEqual(["run_b1"]);
		expect(reapCalls).toHaveLength(1);
		expect(reapCalls[0]?.outcome).toBe("failed");
		expect(reapCalls[0]?.failureReason).toBe("timed_out");

		const events = await repos.events.listByRun(runId);
		const timedOut = events.find((e) => e.kind === WATCHDOG_TIMED_OUT_KIND);
		expect(timedOut).toBeDefined();
		expect((timedOut?.payloadJson as { idleMs?: number }).idleMs).toBe(10 * 60_000);
		expect((timedOut?.payloadJson as { sandboxRunId?: string }).sandboxRunId).toBe("run_b1");
	});

	test("forwards the active runtimeProvider into the force-fail reap (warren-a7cb)", async () => {
		const runId = await seedRunning("2026-06-05T00:00:00Z", {
			sandboxId: "bur_1",
			sandboxRunId: "run_b1",
		});
		const provider = makeCancelProvider([]);
		const reapCalls: ReapRunInput[] = [];

		await tickWatchdog({
			repos,
			runtimeProvider: provider,
			heartbeatTimeoutMs: 5 * 60_000,
			now: () => new Date("2026-06-05T00:10:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});

		// The reap gets the SAME provider so its finalize + terminate run through the
		// active backend (in-pod under WARREN_RUNTIME=k8s), not the default burrow.
		expect(reapCalls).toHaveLength(1);
		expect(reapCalls[0]?.runtimeProvider).toBe(provider);
		expect(runId).toBeDefined();
	});

	test("leaves a run inside budget alone", async () => {
		await seedRunning("2026-06-05T00:00:00Z", { sandboxId: "bur_1", sandboxRunId: "run_b1" });
		const reapCalls: ReapRunInput[] = [];

		const result = await tickWatchdog({
			repos,
			runtimeProvider: makeCancelProvider([]),
			heartbeatTimeoutMs: 5 * 60_000,
			now: () => new Date("2026-06-05T00:02:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});

		expect(result.timedOut).toEqual([]);
		expect(reapCalls).toEqual([]);
	});

	test("skips the burrow cancel when the run has no sandbox_run_id", async () => {
		const runId = await seedRunning("2026-06-05T00:00:00Z");
		const reapCalls: ReapRunInput[] = [];

		const result = await tickWatchdog({
			repos,
			runtimeProvider: makeCancelProvider([]),
			heartbeatTimeoutMs: 60_000,
			now: () => new Date("2026-06-05T00:10:00Z"),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});

		expect(result.timedOut).toEqual([{ runId, idleMs: 10 * 60_000 }]);
		expect(reapCalls).toHaveLength(1);
	});

	test("isolates a per-run reap failure", async () => {
		const runId = await seedRunning("2026-06-05T00:00:00Z");

		const result = await tickWatchdog({
			repos,
			runtimeProvider: makeCancelProvider([]),
			heartbeatTimeoutMs: 60_000,
			now: () => new Date("2026-06-05T00:10:00Z"),
			reap: async () => {
				throw new Error("boom");
			},
		});

		expect(result.timedOut).toEqual([]);
		expect(result.errors).toEqual([{ runId, reason: "boom" }]);
	});
});

describe("bootWatchdog", () => {
	test("disabled boot is inert and stop() resolves", async () => {
		let ticked = false;
		const handle = bootWatchdog({
			repos: { runs: { listByState: async () => [] } } as unknown as Repos,
			runtimeProvider: makeCancelProvider([]),
			reap: async () => fakeReapResult("failed"),
			heartbeatTimeoutMs: 60_000,
			tickMs: 1000,
			disabled: true,
			setInterval: () => {
				ticked = true;
				return {};
			},
		});
		expect(ticked).toBe(false);
		expect(handle.tickCount()).toBe(0);
		await handle.stop();
	});

	test("runOnce ticks and tickCount increments", async () => {
		const handle = bootWatchdog({
			repos: { runs: { listByState: async () => [] } } as unknown as Repos,
			runtimeProvider: makeCancelProvider([]),
			reap: async () => fakeReapResult("failed"),
			heartbeatTimeoutMs: 60_000,
			tickMs: 1000,
			disabled: true,
		});
		const result = await handle.runOnce();
		expect(result).toEqual({ timedOut: [], reconciled: [], errors: [] });
		expect(handle.tickCount()).toBe(1);
		await handle.stop();
	});

	test("drops an overlapping tick", async () => {
		let resolveTick: () => void = () => {};
		const gate = new Promise<void>((r) => {
			resolveTick = r;
		});
		const handle = bootWatchdog({
			repos: {
				runs: {
					listByState: async () => {
						await gate;
						return [];
					},
				},
			} as unknown as Repos,
			runtimeProvider: makeCancelProvider([]),
			reap: async () => fakeReapResult("failed"),
			heartbeatTimeoutMs: 60_000,
			tickMs: 1000,
			disabled: true,
		});
		const first = handle.runOnce();
		const second = await handle.runOnce(); // in-flight ⇒ skipped ⇒ null
		expect(second).toBeNull();
		resolveTick();
		await first;
		expect(handle.tickCount()).toBe(1);
		await handle.stop();
	});
});
