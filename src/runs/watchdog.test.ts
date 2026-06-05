/**
 * Unit tests for the run heartbeat watchdog (warren-285d).
 *
 * Coverage:
 *   - `computeIdleMs` anchors on the newest event ts, falling back to
 *     `startedAt`, and returns null when neither is parseable.
 *   - `loadWatchdogConfigFromEnv` arms only on a positive timeout and
 *     rejects malformed values.
 *   - a running run past the heartbeat budget is force-failed: a
 *     `watchdog.timed_out` event is emitted, the burrow run is cancelled,
 *     and reap is called with `outcome: failed` / `failureReason:
 *     timed_out`.
 *   - a fresh run inside budget is left alone.
 *   - per-run error isolation so one bad row can't tear down the tick.
 *   - the single-flight `bootWatchdog` wrapper drops overlapping ticks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BurrowClientPool } from "../burrow-client/pool.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ReapRunInput, ReapRunResult } from "./reap/index.ts";
import {
	bootWatchdog,
	computeIdleMs,
	loadWatchdogConfigFromEnv,
	tickWatchdog,
	WATCHDOG_TIMED_OUT_KIND,
} from "./watchdog.ts";

const PROJECT_ID = "prj_xxxxxxxxxxxx";

function makeAgentJson() {
	return {
		name: "claude-code",
		version: 1,
		sections: { system: "be helpful" },
		resolvedFrom: [],
		frontmatter: {},
	};
}

function fakeReapResult(state: ReapRunResult["state"]): ReapRunResult {
	return {
		state,
		failureReason: state === "failed" ? "timed_out" : null,
		mulchUpdated: 0,
		mulchSkipped: 0,
		mulchAppended: 0,
		seedsClosed: 0,
		seedsCreated: 0,
		plotEventsAppended: 0,
		plotsUpdated: 0,
		plotEventsMirrored: 0,
		plotCommitted: false,
		seedsCommitted: false,
		branchPushed: false,
		commitsAhead: null,
		prUrl: null,
		previewState: null,
		previewPort: null,
		previewUrl: null,
		autoPlanRunCreated: false,
		autoPlanRunId: null,
		autoPlanRunPlanId: null,
		workspaceDestroyed: true,
		errors: [],
		alreadyTerminal: false,
	};
}

/** Minimal pool stub recording cancel calls. */
function makeCancelPool(cancels: string[]): BurrowClientPool {
	return {
		clientFor: async () => ({
			workerName: "local",
			client: {
				config: { transport: { kind: "unix", path: "/tmp/x.sock" }, token: undefined },
				http: {
					runs: {
						cancel: async (id: string) => {
							cancels.push(id);
							return {} as never;
						},
					},
				},
			},
		}),
	} as unknown as BurrowClientPool;
}

const NEVER_POOL = {
	clientFor: async () => {
		throw new Error("clientFor should not be called");
	},
} as unknown as BurrowClientPool;

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
			burrowEventSeq: 1,
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
	test("disabled by default", () => {
		const cfg = loadWatchdogConfigFromEnv({});
		expect(cfg.enabled).toBe(false);
		expect(cfg.heartbeatTimeoutMs).toBe(0);
		expect(cfg.tickMs).toBe(30_000);
	});

	test("arms on a positive timeout", () => {
		const cfg = loadWatchdogConfigFromEnv({
			WARREN_RUN_HEARTBEAT_TIMEOUT_MS: "600000",
			WARREN_WATCHDOG_TICK_MS: "10000",
		});
		expect(cfg.enabled).toBe(true);
		expect(cfg.heartbeatTimeoutMs).toBe(600_000);
		expect(cfg.tickMs).toBe(10_000);
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
		opts: { burrowId?: string; burrowRunId?: string } = {},
	): Promise<string> {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: PROJECT_ID,
			prompt: "go",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
			mode: "batch",
		});
		await repos.runs.markRunning(row.id, new Date(startedAt));
		if (opts.burrowId !== undefined || opts.burrowRunId !== undefined) {
			await repos.runs.attachBurrow(row.id, {
				...(opts.burrowId !== undefined ? { burrowId: opts.burrowId } : {}),
				...(opts.burrowRunId !== undefined ? { burrowRunId: opts.burrowRunId } : {}),
			});
		}
		return row.id;
	}

	test("force-fails a hung run: emits event, cancels burrow, reaps failed", async () => {
		const runId = await seedRunning("2026-06-05T00:00:00Z", {
			burrowId: "bur_1",
			burrowRunId: "run_b1",
		});
		const cancels: string[] = [];
		const reapCalls: ReapRunInput[] = [];

		const result = await tickWatchdog({
			repos,
			burrowClientPool: makeCancelPool(cancels),
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
		expect((timedOut?.payloadJson as { burrowRunId?: string }).burrowRunId).toBe("run_b1");
	});

	test("leaves a run inside budget alone", async () => {
		await seedRunning("2026-06-05T00:00:00Z", { burrowId: "bur_1", burrowRunId: "run_b1" });
		const reapCalls: ReapRunInput[] = [];

		const result = await tickWatchdog({
			repos,
			burrowClientPool: NEVER_POOL,
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

	test("skips the burrow cancel when the run has no burrow_run_id", async () => {
		const runId = await seedRunning("2026-06-05T00:00:00Z");
		const reapCalls: ReapRunInput[] = [];

		const result = await tickWatchdog({
			repos,
			burrowClientPool: NEVER_POOL,
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
			burrowClientPool: NEVER_POOL,
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
			burrowClientPool: NEVER_POOL,
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
			burrowClientPool: NEVER_POOL,
			heartbeatTimeoutMs: 60_000,
			tickMs: 1000,
			disabled: true,
		});
		const result = await handle.runOnce();
		expect(result).toEqual({ timedOut: [], errors: [] });
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
			burrowClientPool: NEVER_POOL,
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
