import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunEvent } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowClientPool } from "../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { RunEventBroker } from "./events.ts";
import type { PiStatsClient, SessionStats } from "./stream.ts";
import { bridgeRunStream, recoverActiveRunStreams } from "./stream.ts";

function makeBurrowClient(): BurrowClient {
	const fetchImpl = (async () =>
		new Response("{}", {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: fetchImpl,
	});
}

/**
 * One-worker pool wired to a stub burrow client (warren-c0c9). Upserts a
 * `local` worker row so `pool.clientFor` resolves cleanly; tests that exercise
 * a non-test source (i.e. don't pass `source: ...`) also seed a `burrows` row.
 */
async function makePool(
	repos: Repos,
	client?: BurrowClient,
	workerName = "local",
): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: workerName, url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register(workerName, client ?? makeBurrowClient());
	return pool;
}

function evt(burrowRunId: string, seq: number, overrides: Partial<RunEvent> = {}): RunEvent {
	return {
		id: 0,
		burrowId: "bur_x",
		runId: burrowRunId,
		seq,
		kind: "text",
		stream: "stdout",
		payload: { seq },
		ts: new Date(2026, 4, 8, 12, 0, seq),
		...overrides,
	};
}

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
	for (const i of items) yield i;
}

function source(events: RunEvent[]): (signal: AbortSignal) => AsyncIterable<RunEvent> {
	return () => asyncIter(events);
}

/**
 * Build a pi-shaped `agent_end` envelope as it lands after burrow's pi
 * parser (kind="state_change", stream="system", payload.type="agent_end").
 * Mirrors burrow `src/runtime/parsers/pi.ts:86-98` (warren-36c0). The
 * synthetic `{kind:"agent_end"}` shape never appears in production.
 */
function piAgentEnd(burrowRunId: string, seq: number): RunEvent {
	return evt(burrowRunId, seq, {
		kind: "state_change",
		stream: "system",
		payload: { type: "agent_end", messages: [] },
	});
}

describe("bridgeRunStream", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let burrowRunId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
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
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		runId = run.id;
		burrowRunId = "run_zzzzzzzzzzzz";
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	test("writes every event to the events table and returns a count", async () => {
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([evt(burrowRunId, 1), evt(burrowRunId, 2), evt(burrowRunId, 3)]),
		});
		expect(result.written).toBe(3);
		expect(result.skipped).toBe(0);
		expect(result.errored).toBe(false);
		const rows = (await repos.events.listByRun(runId)).map((e) => e.burrowEventSeq);
		expect(rows).toEqual([1, 2, 3]);
	});

	test("publishes each event to the broker after persisting", async () => {
		const sub = broker.subscribe(runId);
		const consumed: number[] = [];
		const consumer = (async () => {
			for await (const row of sub) {
				consumed.push(row.burrowEventSeq);
				if (consumed.length >= 2) break;
			}
		})();

		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([evt(burrowRunId, 1), evt(burrowRunId, 2)]),
		});
		await consumer;

		expect(consumed).toEqual([1, 2]);
		// Bridge calls broker.close on exit, so subscriberCount returns to 0.
		expect(broker.subscriberCount(runId)).toBe(0);
	});

	test("resume: skips events with seq <= MAX(burrow_event_seq)", async () => {
		// Pre-populate as if a previous warren had persisted seqs 1,2.
		await repos.events.append({
			runId,
			burrowEventSeq: 1,
			ts: "2026-05-08T12:00:01.000Z",
			kind: "text",
			stream: "stdout",
			payload: { seq: 1 },
		});
		await repos.events.append({
			runId,
			burrowEventSeq: 2,
			ts: "2026-05-08T12:00:02.000Z",
			kind: "text",
			stream: "stdout",
			payload: { seq: 2 },
		});

		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				evt(burrowRunId, 1),
				evt(burrowRunId, 2),
				evt(burrowRunId, 3),
				evt(burrowRunId, 4),
			]),
		});
		expect(result.skipped).toBe(2);
		expect(result.written).toBe(2);
		const rows = (await repos.events.listByRun(runId)).map((e) => e.burrowEventSeq);
		expect(rows).toEqual([1, 2, 3, 4]);
	});

	test("normalizes unknown stream tags to null", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([evt(burrowRunId, 1, { stream: "weird" as unknown as RunEvent["stream"] })]),
		});
		const row = (await repos.events.listByRun(runId))[0];
		expect(row?.stream).toBeNull();
	});

	test("source error: logs, sets errored=true, and does not throw", async () => {
		const errs: object[] = [];
		const source = (): AsyncIterable<RunEvent> => ({
			async *[Symbol.asyncIterator]() {
				yield evt(burrowRunId, 1);
				throw new Error("burrow disconnected");
			},
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: () => source(),
			logger: {
				error(obj) {
					errs.push(obj);
				},
			},
		});
		expect(result.written).toBe(1);
		expect(result.errored).toBe(true);
		expect(errs.length).toBe(1);
	});

	test("AbortSignal stops consumption mid-stream", async () => {
		const ctrl = new AbortController();
		// An infinite source — guarded by signal abort.
		const source = (signal: AbortSignal): AsyncIterable<RunEvent> => ({
			async *[Symbol.asyncIterator]() {
				let i = 1;
				while (!signal.aborted) {
					yield evt(burrowRunId, i++);
					await new Promise((r) => setTimeout(r, 1));
				}
			},
		});

		const promise = bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			signal: ctrl.signal,
			source: (s) => source(s),
		});

		await new Promise((r) => setTimeout(r, 20));
		ctrl.abort();
		const result = await promise;
		expect(result.written).toBeGreaterThan(0);
		// No assertion on errored — abort is allowed to surface as either
		// a clean stop or an AbortError; both are acceptable here.
	});

	test("first event transitions run queued → running and sets startedAt", async () => {
		const before = await repos.runs.require(runId);
		expect(before.state).toBe("queued");
		expect(before.startedAt).toBeNull();

		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([evt(burrowRunId, 1)]),
		});

		const after = await repos.runs.require(runId);
		expect(after.state).toBe("running");
		expect(after.startedAt).not.toBeNull();
	});

	test("does not transition state when source yields no events", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([]),
		});
		const after = await repos.runs.require(runId);
		expect(after.state).toBe("queued");
		expect(after.startedAt).toBeNull();
	});

	test("claim is a no-op when run is already running (resume after restart)", async () => {
		const startedAt = new Date(2026, 0, 1).toISOString();
		await repos.runs.markRunning(runId, new Date(startedAt));
		const before = await repos.runs.require(runId);

		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([evt(burrowRunId, 1)]),
		});

		const after = await repos.runs.require(runId);
		expect(after.state).toBe("running");
		// startedAt was not overwritten by a second claim attempt.
		expect(after.startedAt).toBe(before.startedAt);
	});

	test("warren-a69a: claude-code result event sets terminalDetected and breaks the loop", async () => {
		const claudeResult = evt(burrowRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "result", subtype: "result", is_error: false, terminal_reason: "completed" },
		});
		const trailing = evt(burrowRunId, 2, { kind: "text", payload: { text: "post-terminal" } });
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([claudeResult, trailing]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		// The trailing event after terminal must NOT be persisted — bridge breaks.
		const seqs = (await repos.events.listByRun(runId)).map((e) => e.burrowEventSeq);
		expect(seqs).toEqual([1]);
	});

	test("warren-a69a: claude-code result with is_error=true maps to failed", async () => {
		const claudeFail = evt(burrowRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "result", subtype: "result", is_error: true, terminal_reason: "completed" },
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([claudeFail]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "failed" });
	});

	test("warren-a69a: non-terminal state_change events do not set terminalDetected", async () => {
		const init = evt(burrowRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "system", subtype: "init" },
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([init]),
		});
		expect(result.terminalDetected).toBeUndefined();
	});

	test("warren-2687: pi agent_end envelope sets terminalDetected and breaks the loop", async () => {
		const piEnd = evt(burrowRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "agent_end", messages: [] },
		});
		const trailing = evt(burrowRunId, 2, { kind: "text", payload: { text: "post-terminal" } });
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([piEnd, trailing]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		// The trailing event after terminal must NOT be persisted — bridge breaks.
		const seqs = (await repos.events.listByRun(runId)).map((e) => e.burrowEventSeq);
		expect(seqs).toEqual([1]);
	});

	test("warren-2687: pi agent_end on non-system stream does not set terminalDetected", async () => {
		// Defensive: agent_end must arrive on the canonical system stream
		// to be recognized; payload type alone isn't enough.
		const offStream = evt(burrowRunId, 1, {
			kind: "state_change",
			stream: "stdout",
			payload: { type: "agent_end", messages: [] },
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([offStream]),
		});
		expect(result.terminalDetected).toBeUndefined();
	});

	test("piStats: snapshots baseline + terminal and persists the delta on agent_end", async () => {
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

	test("piStats: undefined leaves cost columns null (parity with claude-code)", async () => {
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

	test("piStats: only the first agent_end triggers the terminal snapshot", async () => {
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
		// One baseline + one terminal. The first wire-shape agent_end fires
		// the piStats branch (calls=2) and is the same envelope
		// detectRuntimeTerminal recognizes, so the bridge breaks before
		// reaching the second agent_end — exercising both the statsPersisted
		// guard and the terminal-break belt-and-braces.
		expect(calls).toBe(2);
	});

	test("piStats: terminal fetch failure logs and leaves cost null", async () => {
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
				warn(obj) {
					warns.push(obj);
				},
			},
			source: source([evt(burrowRunId, 1, { kind: "agent_start" }), piAgentEnd(burrowRunId, 2)]),
		});
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeNull();
		expect(warns.length).toBeGreaterThanOrEqual(1);
	});

	test("piStats: baseline failure falls back to terminal value (best-effort)", async () => {
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

	test("piStats: terminalDetected (non-pi runtime path) still attempts terminal snapshot", async () => {
		let terminalCalled = false;
		const piStats: PiStatsClient = {
			async fetch(_burrow, _signal) {
				if (!terminalCalled) {
					// baseline
					return {
						costUsd: 0,
						tokensInput: 0,
						tokensOutput: 0,
						tokensCacheRead: 0,
						tokensCacheWrite: 0,
					};
				}
				return null;
			},
		};
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
		expect(piStats).toBeDefined();
		expect(terminalCalled).toBe(true);
	});

	// In-stream pi cost extraction (warren-17a4). Pi v0.74 emits
	// `turn_end` envelopes carrying `message.usage.{input,output,cacheRead,
	// cacheWrite,cost.total}` — see burrow's
	// `src/runtime/parsers/__golden__/pi-v0.74.0-anthropic-*.jsonl`. The
	// bridge accumulates these as events flow through and persists the
	// run-level totals at `agent_end`, no PiStatsClient required.
	function piTurnEnd(
		burrowRunId: string,
		seq: number,
		usage: {
			input: number;
			output: number;
			cacheRead?: number;
			cacheWrite?: number;
			costTotal: number;
		},
	): RunEvent {
		return evt(burrowRunId, seq, {
			kind: "state_change",
			stream: "system",
			payload: {
				type: "turn_end",
				message: {
					role: "assistant",
					usage: {
						input: usage.input,
						output: usage.output,
						cacheRead: usage.cacheRead ?? 0,
						cacheWrite: usage.cacheWrite ?? 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: usage.costTotal,
						},
					},
				},
			},
		});
	}

	test("in-stream: single-turn turn_end usage lands in cost/token columns at agent_end", async () => {
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

	test("in-stream: multi-turn turn_end usage accumulates across turns", async () => {
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

	test("in-stream: no turn_end events leaves columns null (claude-code parity)", async () => {
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

	test("in-stream: PiStatsClient override wins over in-stream usage", async () => {
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
		// PiStatsClient delta = terminal(9.99) − baseline(9.99) = 0. The
		// explicit override takes precedence and overwrites whatever
		// in-stream accumulation would have produced (0.123).
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0);
		expect(after.tokensInput).toBe(0);
	});

	test("in-stream: terminalDetected via claude-code result still persists pi usage if observed", async () => {
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
		// detectRuntimeTerminal fires on the `result` envelope (claude-code
		// shape) — but the bridge has already accumulated a pi `turn_end`,
		// so the in-stream fallback persists it before the bridge breaks.
		const after = await repos.runs.require(runId);
		expect(after.costUsd).toBeCloseTo(0.001);
		expect(after.tokensInput).toBe(100);
	});

	// claude-code cost extraction (warren-87f9). Claude-code emits a
	// single terminal `result` envelope carrying `total_cost_usd` +
	// `usage.{input_tokens,output_tokens,cache_read_input_tokens,
	// cache_creation_input_tokens}`. Burrow's jsonl-claude parser maps it
	// to state_change/system, so the bridge sniffs the payload shape.
	function claudeResult(
		burrowRunId: string,
		seq: number,
		usage: {
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
			totalCostUsd: number;
			isError?: boolean;
		},
	): RunEvent {
		return evt(burrowRunId, seq, {
			kind: "state_change",
			stream: "system",
			payload: {
				type: "result",
				subtype: "success",
				is_error: usage.isError ?? false,
				total_cost_usd: usage.totalCostUsd,
				usage: {
					input_tokens: usage.inputTokens,
					output_tokens: usage.outputTokens,
					cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
					cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
				},
			},
		});
	}

	test("in-stream claude: result envelope lands in cost/token columns at terminal", async () => {
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

	test("in-stream claude: result with no total_cost_usd / usage leaves columns null", async () => {
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

	test("in-stream claude: failed result (is_error=true) still records cost", async () => {
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

	test("in-stream claude: pi turn_end + claude result — pi wins (parity)", async () => {
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

	test("in-stream: turn_end with malformed usage is ignored (no row update)", async () => {
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([
				// turn_end with no usage field at all — defensive shape from a
				// hypothetical future pi version. Should not crash, and should
				// not mark the run as having pi usage.
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

	test("bridge end calls broker.close so live subscribers return", async () => {
		const sub = broker.subscribe(runId);
		const out: number[] = [];
		const consumer = (async () => {
			for await (const row of sub) out.push(row.burrowEventSeq);
		})();
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			source: source([evt(burrowRunId, 1)]),
		});
		await consumer;
		expect(out).toEqual([1]);
	});
});

describe("recoverActiveRunStreams", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		// Seed three runs:
		//   run_a: queued + burrowRunId  → bridge
		//   run_b: running + burrowRunId → bridge
		//   run_c: running, no burrowRunId → skip
		//   run_d: succeeded             → ignore
		await repos.runs.create({
			id: "run_aaaaaaaaaaaa",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_a",
			burrowRunId: "rb_a",
		});
		const b = await repos.runs.create({
			id: "run_bbbbbbbbbbbb",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_b",
			burrowRunId: "rb_b",
		});
		await repos.runs.markRunning(b.id);
		await repos.runs.create({
			id: "run_cccccccccccc",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		await repos.runs.markRunning("run_cccccccccccc");
		const d = await repos.runs.create({
			id: "run_dddddddddddd",
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_d",
			burrowRunId: "rb_d",
		});
		await repos.runs.markRunning(d.id);
		await repos.runs.finalize(d.id, "succeeded");
		broker = new RunEventBroker();
	});

	afterEach(async () => {
		await db.close();
	});

	test("starts a bridge for each active run with a burrow_run_id", async () => {
		const calls: { runId: string; burrowRunId: string }[] = [];
		const result = await recoverActiveRunStreams({
			repos,
			broker,
			burrowClientPool: await makePool(repos),
			bridge: async (input) => {
				calls.push({ runId: input.runId, burrowRunId: input.burrowRunId });
				return { written: 0, skipped: 0, errored: false };
			},
		});
		expect(result.bridges).toHaveLength(2);
		expect(result.skipped).toEqual([{ runId: "run_cccccccccccc", reason: "no_burrow_run_id" }]);
		// Wait for the bridges to settle (they're started synchronously).
		await Promise.all(result.bridges.map((b) => b.done));
		const ids = calls.map((c) => c.runId).sort();
		expect(ids).toEqual(["run_aaaaaaaaaaaa", "run_bbbbbbbbbbbb"]);
	});

	test("returned AbortControllers can stop in-flight bridges", async () => {
		const result = await recoverActiveRunStreams({
			repos,
			broker,
			burrowClientPool: await makePool(repos),
			bridge: async (input) => {
				await new Promise<void>((resolve) => {
					if (input.signal === undefined) {
						resolve();
						return;
					}
					if (input.signal.aborted) {
						resolve();
						return;
					}
					input.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return { written: 0, skipped: 0, errored: false };
			},
		});
		for (const b of result.bridges) b.abort.abort();
		await Promise.all(result.bridges.map((b) => b.done));
		// Sanity: nothing terminated by itself before we aborted.
		expect(result.bridges).toHaveLength(2);
	});
});
