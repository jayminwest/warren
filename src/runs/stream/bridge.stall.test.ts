import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import {
	makeProvider,
	piMessageDelta,
	piTurnEnd,
	piTurnStart,
	seedBridgeRun,
	source,
} from "./test-helpers.ts";
import { type TurnClock, TurnMonitor, type TurnMonitorOptions } from "./turn-monitor.ts";
import type { StreamEventView } from "./types.ts";

/**
 * TurnMonitor trips through the real bridge loop (warren-1f85 / warren-74a7,
 * GitHub #1242). Driven with `StreamEventView` fixtures and a fake clock, the
 * same template `budget.test.ts` uses for the cancel-and-break assertions: on
 * a trip the bridge persists the known cost, emits the trip event, cancels
 * through the injected seam, and breaks with a `cancelled` terminal outcome —
 * while the deltas that tripped it stay unpersisted and unpublished.
 */

class FakeClock implements TurnClock {
	nowMs = 0;
	now(): number {
		return this.nowMs;
	}
	advance(ms: number): void {
		this.nowMs += ms;
	}
}

function makeMonitor(clock: TurnClock, overrides: Partial<TurnMonitorOptions> = {}): TurnMonitor {
	return new TurnMonitor({
		stallMs: 1_000,
		stallCheckIntervalMs: 5,
		degenerateMinDeltas: 3,
		degenerateMinBytes: null,
		costCapUsd: null,
		clock,
		...overrides,
	});
}

/** A source that yields once then parks until the abort signal fires. */
function parkedSource(
	events: StreamEventView[],
): (signal: AbortSignal) => AsyncIterable<StreamEventView> {
	return (signal) =>
		(async function* () {
			for (const event of events) yield event;
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
		})();
}

describe("bridgeRunStream — turn monitor trips (#1242)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let sandboxRunId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const ids = await seedBridgeRun(repos);
		runId = ids.runId;
		sandboxRunId = ids.sandboxRunId;
		broker = new RunEventBroker();
	});

	test("cancels a turn that stalls mid-stream and emits turn.stalled (warren-1f85)", async () => {
		const clock = new FakeClock();
		const cancels: string[] = [];
		const bridgePromise = bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			turnMonitor: makeMonitor(clock),
			// turn_start lands, then the provider stream hangs — the exact
			// warren-1b40 shape: no further events, so only the stall timer
			// (not the loop) can fire.
			source: parkedSource([piTurnStart(sandboxRunId, 1)]),
		});
		// Let the loop consume the turn_start (anchors the stall clock at 0),
		// then push wall time past the budget and let an interval tick fire.
		await Bun.sleep(20);
		clock.advance(2_000);
		const result = await bridgePromise;

		expect(result.terminalDetected).toEqual({ outcome: "cancelled" });
		expect(result.errored).toBe(false);
		expect(cancels).toHaveLength(1);
		expect(cancels[0]).toContain("turn stalled");

		// The trip event landed on the run log; the run row is terminal-bound.
		const events = await repos.events.listByRun(runId);
		const stalled = events.find((e) => e.kind === "turn.stalled");
		expect(stalled).toBeDefined();
		expect(stalled?.payloadJson).toMatchObject({ idleMs: 2_000, stallMs: 1_000 });
		// The turn_start was still persisted normally before the hang.
		expect(events.some((e) => e.sandboxEventSeq === 1)).toBe(true);
	});

	test("cancels a reasoning stream that degenerates into whitespace-only deltas (warren-74a7)", async () => {
		const clock = new FakeClock();
		const cancels: string[] = [];
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			turnMonitor: makeMonitor(clock, { stallMs: null }),
			// 5 whitespace-only thinking deltas past a threshold of 3: the
			// glm-5.3-flash spiral shape.
			source: source([
				piTurnStart(sandboxRunId, 1),
				piMessageDelta(sandboxRunId, 2, { delta: " \n " }),
				piMessageDelta(sandboxRunId, 3, { delta: "\t" }),
				piMessageDelta(sandboxRunId, 4, { delta: "   " }),
				piMessageDelta(sandboxRunId, 5, { delta: " \n" }),
				piMessageDelta(sandboxRunId, 6, { delta: "\n\n" }),
			]),
		});

		expect(result.terminalDetected).toEqual({ outcome: "cancelled" });
		expect(cancels).toHaveLength(1);
		expect(cancels[0]).toContain("degenerate turn");

		const events = await repos.events.listByRun(runId);
		const degenerate = events.find((e) => e.kind === "turn.degenerate");
		expect(degenerate).toBeDefined();
		expect(degenerate?.payloadJson).toMatchObject({ deltaCount: 3, byteCount: 7 });
		// The tripping deltas were never persisted (per-delta noise) — only
		// the turn_start and the trip event are on the log.
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("state_change");
		expect(kinds.filter((k) => k === "telemetry")).toHaveLength(0);
	});

	test("resets the whitespace streak on a content-bearing delta", async () => {
		const clock = new FakeClock();
		const cancels: string[] = [];
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			turnMonitor: makeMonitor(clock, { stallMs: null }),
			// Whitespace bursts of 2, never 3 in a row, interleaved with real
			// deltas and an empty delta (legitimate wire noise).
			source: source([
				piTurnStart(sandboxRunId, 1),
				piMessageDelta(sandboxRunId, 2, { delta: " " }),
				piMessageDelta(sandboxRunId, 3, { delta: "\n" }),
				piMessageDelta(sandboxRunId, 4, { delta: "The user asked" }),
				piMessageDelta(sandboxRunId, 5, { delta: "" }),
				piMessageDelta(sandboxRunId, 6, { delta: "  " }),
				piMessageDelta(sandboxRunId, 7, { delta: "\t" }),
				piMessageDelta(sandboxRunId, 8, { delta: "for ack." }),
			]),
		});

		expect(cancels).toHaveLength(0);
		expect(result.terminalDetected).toBeUndefined();
		const events = await repos.events.listByRun(runId);
		expect(events.some((e) => e.kind === "turn.degenerate")).toBe(false);
	});

	test("trips the spend cap mid-turn from partial usage, before any turn_end", async () => {
		const clock = new FakeClock();
		const cancels: string[] = [];
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			turnMonitor: makeMonitor(clock, { stallMs: null, costCapUsd: 1 }),
			// The cap is crossed on the second delta's cumulative partial —
			// no turn_end ever fires, so only the monitor can see it.
			source: source([
				piTurnStart(sandboxRunId, 1),
				piMessageDelta(sandboxRunId, 2, { delta: "thinking...", costTotal: 0.6 }),
				piMessageDelta(sandboxRunId, 3, { delta: "more", costTotal: 1.5 }),
			]),
		});

		expect(result.terminalDetected).toEqual({ outcome: "cancelled" });
		expect(cancels).toHaveLength(1);
		expect(cancels[0]).toContain("spend cap exceeded");

		const events = await repos.events.listByRun(runId);
		const budget = events.find((e) => e.kind === "budget.exceeded");
		expect(budget).toBeDefined();
		expect(budget?.payloadJson).toMatchObject({ costUsd: 1.5, capUsd: 1 });

		// The in-turn spend was persisted so the cut run isn't left at null.
		const run = await repos.runs.require(runId);
		expect(run.costUsd).toBe(1.5);
	});

	test("keeps a healthy streaming turn alive across the stall budget reset", async () => {
		const clock = new FakeClock();
		const cancels: string[] = [];
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			turnMonitor: makeMonitor(clock),
			source: source([
				piTurnStart(sandboxRunId, 1),
				piMessageDelta(sandboxRunId, 2, { delta: "hello" }),
				piTurnEnd(sandboxRunId, 3, { input: 10, output: 5, costTotal: 0.01 }),
				piTurnStart(sandboxRunId, 4),
				piMessageDelta(sandboxRunId, 5, { delta: "world" }),
				piTurnEnd(sandboxRunId, 6, { input: 10, output: 5, costTotal: 0.01 }),
			]),
		});

		expect(cancels).toHaveLength(0);
		expect(result.terminalDetected).toBeUndefined();
		expect(result.written).toBe(4); // deltas dropped, lifecycle events kept
	});
});
