import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import {
	claudeResult,
	evt,
	makePool,
	piAgentEnd,
	piTurnEnd,
	seedBridgeRun,
	source,
} from "./test-helpers.ts";
import type { PiStatsClient, SessionStats } from "./types.ts";

describe("bridgeRunStream — PiStatsClient (warren-a7dc)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let burrowRunId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const ids = await seedBridgeRun(repos);
		runId = ids.runId;
		burrowRunId = ids.burrowRunId;
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	test("snapshots baseline + terminal and persists the delta on agent_end", async () => {
		const calls: { burrowRunId: string; phase: "baseline" | "terminal" }[] = [];
		const responses: SessionStats[] = [
			{
				costUsd: 0.1,
				tokensInput: 100,
				tokensOutput: 50,
				tokensCacheRead: 10,
				tokensCacheWrite: 5,
			},
			{
				costUsd: 0.75,
				tokensInput: 600,
				tokensOutput: 220,
				tokensCacheRead: 40,
				tokensCacheWrite: 12,
			},
		];
		const piStats: PiStatsClient = {
			async fetch(burrowRunId) {
				const idx = calls.length;
				calls.push({ burrowRunId, phase: idx === 0 ? "baseline" : "terminal" });
				return responses[idx] ?? null;
			},
		};
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			piStats,
			source: source([
				evt(burrowRunId, 1, { kind: "agent_start" }),
				evt(burrowRunId, 2, { kind: "text" }),
				piAgentEnd(burrowRunId, 3),
			]),
		});
		expect(calls.map((c) => c.phase)).toEqual(["baseline", "terminal"]);
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0.65);
		expect(after.tokensInput).toBe(500);
		expect(after.tokensOutput).toBe(170);
		expect(after.tokensCacheRead).toBe(30);
		expect(after.tokensCacheWrite).toBe(7);
	});

	test("undefined leaves cost columns null (parity with claude-code)", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([evt(burrowRunId, 1, { kind: "agent_start" }), piAgentEnd(burrowRunId, 2)]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeNull();
		expect(after.tokensInput).toBeNull();
	});

	test("only the first agent_end triggers the terminal snapshot", async () => {
		let calls = 0;
		const piStats: PiStatsClient = {
			async fetch() {
				calls += 1;
				return {
					costUsd: calls * 0.1,
					tokensInput: calls * 100,
					tokensOutput: calls * 50,
					tokensCacheRead: 0,
					tokensCacheWrite: 0,
				};
			},
		};
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			piStats,
			source: source([
				evt(burrowRunId, 1, { kind: "agent_start" }),
				piAgentEnd(burrowRunId, 2),
				piAgentEnd(burrowRunId, 3),
			]),
		});
		expect(calls).toBe(2);
	});

	test("terminal fetch failure logs and leaves cost null", async () => {
		const warns: object[] = [];
		let phase = 0;
		const piStats: PiStatsClient = {
			async fetch() {
				phase += 1;
				if (phase === 1) {
					return {
						costUsd: 0.05,
						tokensInput: 50,
						tokensOutput: 20,
						tokensCacheRead: 0,
						tokensCacheWrite: 0,
					};
				}
				throw new Error("rpc channel closed");
			},
		};
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			piStats,
			logger: {
				warn(obj: object) {
					warns.push(obj);
				},
			},
			source: source([evt(burrowRunId, 1, { kind: "agent_start" }), piAgentEnd(burrowRunId, 2)]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeNull();
		expect(warns.length).toBeGreaterThanOrEqual(1);
	});

	test("baseline failure falls back to terminal value (best-effort)", async () => {
		const fetches: string[] = [];
		const piStats: PiStatsClient = {
			async fetch() {
				if (fetches.length === 0) {
					fetches.push("baseline-fail");
					throw new Error("rpc unavailable at start");
				}
				fetches.push("terminal-ok");
				return {
					costUsd: 0.3,
					tokensInput: 200,
					tokensOutput: 80,
					tokensCacheRead: 0,
					tokensCacheWrite: 0,
				};
			},
		};
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			piStats,
			source: source([evt(burrowRunId, 1, { kind: "agent_start" }), piAgentEnd(burrowRunId, 2)]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0.3);
		expect(after.tokensInput).toBe(200);
	});

	test("terminalDetected (non-pi runtime path) still attempts terminal snapshot", async () => {
		let terminalCalled = false;
		// Treat the terminal path defensively — a pi run that happens to
		// emit a claude-code-shaped result event (forward-compat) should
		// still snapshot before the bridge breaks.
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			piStats: {
				async fetch() {
					terminalCalled = true;
					return null;
				},
			},
			source: source([
				evt(burrowRunId, 1, {
					kind: "state_change",
					stream: "system",
					payload: { type: "result", subtype: "result", is_error: false },
				}),
			]),
		});
		expect(terminalCalled).toBe(true);
	});
});

describe("bridgeRunStream — in-stream pi cost extraction (warren-17a4)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let burrowRunId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const ids = await seedBridgeRun(repos);
		runId = ids.runId;
		burrowRunId = ids.burrowRunId;
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	test("single-turn turn_end usage lands in cost/token columns at agent_end", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				evt(burrowRunId, 1, { kind: "agent_start" }),
				piTurnEnd(burrowRunId, 2, { input: 446, output: 44, costTotal: 0.000666 }),
				piAgentEnd(burrowRunId, 3),
			]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0.000666);
		expect(after.tokensInput).toBe(446);
		expect(after.tokensOutput).toBe(44);
		expect(after.tokensCacheRead).toBe(0);
		expect(after.tokensCacheWrite).toBe(0);
	});

	test("multi-turn turn_end usage accumulates across turns", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				evt(burrowRunId, 1, { kind: "agent_start" }),
				piTurnEnd(burrowRunId, 2, { input: 1658, output: 128, costTotal: 0.002298 }),
				piTurnEnd(burrowRunId, 3, { input: 1812, output: 56, costTotal: 0.002092 }),
				piAgentEnd(burrowRunId, 4),
			]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0.00439);
		expect(after.tokensInput).toBe(3470);
		expect(after.tokensOutput).toBe(184);
	});

	test("no turn_end events leaves columns null (claude-code parity)", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([evt(burrowRunId, 1, { kind: "agent_start" }), piAgentEnd(burrowRunId, 2)]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeNull();
		expect(after.tokensInput).toBeNull();
	});

	test("PiStatsClient override wins over in-stream usage", async () => {
		const piStats: PiStatsClient = {
			async fetch() {
				return {
					costUsd: 9.99,
					tokensInput: 1,
					tokensOutput: 1,
					tokensCacheRead: 0,
					tokensCacheWrite: 0,
				};
			},
		};
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			piStats,
			source: source([
				piTurnEnd(burrowRunId, 1, { input: 500, output: 200, costTotal: 0.123 }),
				piAgentEnd(burrowRunId, 2),
			]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0);
		expect(after.tokensInput).toBe(0);
	});

	test("terminalDetected via claude-code result still persists pi usage if observed", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				piTurnEnd(burrowRunId, 1, { input: 100, output: 25, costTotal: 0.001 }),
				evt(burrowRunId, 2, {
					kind: "state_change",
					stream: "system",
					payload: { type: "result", subtype: "result", is_error: false },
				}),
			]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0.001);
		expect(after.tokensInput).toBe(100);
	});

	test("turn_end with malformed usage is ignored (no row update)", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				evt(burrowRunId, 1, {
					kind: "state_change",
					stream: "system",
					payload: { type: "turn_end", message: { role: "assistant" } },
				}),
				piAgentEnd(burrowRunId, 2),
			]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeNull();
		expect(after.tokensInput).toBeNull();
	});
});

describe("bridgeRunStream — in-stream claude cost extraction (warren-87f9)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let burrowRunId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const ids = await seedBridgeRun(repos);
		runId = ids.runId;
		burrowRunId = ids.burrowRunId;
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	test("result envelope lands in cost/token columns at terminal", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				evt(burrowRunId, 1, { kind: "agent_start" }),
				claudeResult(burrowRunId, 2, {
					inputTokens: 1200,
					outputTokens: 400,
					cacheReadInputTokens: 5000,
					cacheCreationInputTokens: 200,
					totalCostUsd: 0.0421,
				}),
			]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0.0421);
		expect(after.tokensInput).toBe(1200);
		expect(after.tokensOutput).toBe(400);
		expect(after.tokensCacheRead).toBe(5000);
		expect(after.tokensCacheWrite).toBe(200);
	});

	test("result with no total_cost_usd / usage leaves columns null", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				evt(burrowRunId, 1, { kind: "agent_start" }),
				evt(burrowRunId, 2, {
					kind: "state_change",
					stream: "system",
					payload: { type: "result", subtype: "success", is_error: false },
				}),
			]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeNull();
		expect(after.tokensInput).toBeNull();
	});

	test("failed result (is_error=true) still records cost", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				claudeResult(burrowRunId, 1, {
					inputTokens: 50,
					outputTokens: 10,
					totalCostUsd: 0.0009,
					isError: true,
				}),
			]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0.0009);
		expect(after.tokensInput).toBe(50);
	});

	test("pi turn_end + claude result — pi wins (parity)", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				piTurnEnd(burrowRunId, 1, { input: 100, output: 25, costTotal: 0.005 }),
				claudeResult(burrowRunId, 2, {
					inputTokens: 999,
					outputTokens: 999,
					totalCostUsd: 9.99,
				}),
			]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0.005);
		expect(after.tokensInput).toBe(100);
	});
});
