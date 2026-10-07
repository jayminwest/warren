import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import {
	claudeResult,
	evt,
	makeProvider,
	piAgentEnd,
	piTurnEnd,
	seedBridgeRun,
	source,
} from "./test-helpers.ts";
import type { BridgeRunStreamResult, StreamEventView } from "./types.ts";

const SBX = "run_zzzzzzzzzzzz";

function turn(seq: number, costTotal: number): StreamEventView {
	return piTurnEnd(SBX, seq, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, costTotal });
}

describe("bridgeRunStream — usage accounting across reconnects (warren-1247)", () => {
	let repos: Repos;
	let runId: string;
	let cancels: string[];

	beforeEach(async () => {
		repos = createRepos(await openDatabase({ path: ":memory:" }));
		runId = (await seedBridgeRun(repos)).runId;
		cancels = [];
	});

	function bridge(events: StreamEventView[], costCapUsd?: number): Promise<BridgeRunStreamResult> {
		return bridgeRunStream({
			runId,
			sandboxRunId: SBX,
			repos,
			broker: new RunEventBroker(),
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			...(costCapUsd !== undefined ? { costCapUsd } : {}),
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			source: source(events),
		});
	}

	async function budgetEvents(): Promise<number> {
		const rows = await repos.events.listByRun(runId);
		return rows.filter((e) => e.kind === "budget.exceeded").length;
	}

	test("trips the cap on cumulative spend across a reconnect ($0.60 + $0.60 > $1)", async () => {
		const first = await bridge([turn(1, 0.6)], 1);
		expect(first.terminalDetected).toBeUndefined();
		expect(cancels).toHaveLength(0);

		// The resumed source replays seq 1 (duplicate) before the new events.
		const second = await bridge([turn(1, 0.6), turn(2, 0.6), piAgentEnd(SBX, 3)], 1);
		expect(second.terminalDetected).toEqual({ outcome: "cancelled" });
		expect(cancels).toHaveLength(1);
		expect(cancels[0]).toContain("spend cap exceeded: $1.2 > $1");
		expect((await repos.runs.require(runId)).costUsd).toBeCloseTo(1.2, 10);
		expect(await budgetEvents()).toBe(1);
	});

	test("matches an uninterrupted run's totals across several reconnects", async () => {
		await bridge([turn(1, 0.25)]);
		await bridge([turn(1, 0.25), turn(2, 0.25)]);
		await bridge([turn(1, 0.25), turn(2, 0.25), evt(SBX, 3), turn(4, 0.25)]);
		const last = await bridge([turn(4, 0.25), turn(5, 0.25), piAgentEnd(SBX, 6)]);
		expect(last.terminalDetected).toEqual({ outcome: "succeeded" });
		const run = await repos.runs.require(runId);
		expect(run.costUsd).toBeCloseTo(1.0, 10);
		expect(run.tokensInput).toBe(40);
		expect(run.tokensOutput).toBe(20);
		expect(run.tokensCacheRead).toBe(8);
		expect(run.tokensCacheWrite).toBe(4);
	});

	test("trips once on resume when the seeded total is already over the cap", async () => {
		// Prior pass persisted $1.50 of spend with no cap in force (stands in for
		// a crash after the event committed but before the cap fired).
		await bridge([turn(1, 0.9), turn(2, 0.6)]);
		expect(cancels).toHaveLength(0);

		const resumed = await bridge([turn(3, 0.1), piAgentEnd(SBX, 4)], 1);
		expect(resumed.terminalDetected).toEqual({ outcome: "cancelled" });
		expect(resumed.written).toBe(0);
		expect(cancels).toHaveLength(1);
		expect(cancels[0]).toContain("spend cap exceeded: $1.5 > $1");
		expect((await repos.runs.require(runId)).costUsd).toBeCloseTo(1.5, 10);
		expect(await budgetEvents()).toBe(1);
	});

	test("a replayed terminal event persists the seeded totals without double counting", async () => {
		// Prior pass appended the terminal envelope, then died before the
		// cost checkpoint landed (simulated by clearing the stats).
		await bridge([turn(1, 0.4), turn(2, 0.3), piAgentEnd(SBX, 3)]);
		await repos.runs.attachStats(runId, {
			costUsd: null,
			tokensInput: null,
			tokensOutput: null,
			tokensCacheRead: null,
			tokensCacheWrite: null,
		});

		const resumed = await bridge([turn(1, 0.4), turn(2, 0.3), piAgentEnd(SBX, 3)], 1);
		expect(resumed.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(resumed.written).toBe(0);
		expect(cancels).toHaveLength(0);
		const run = await repos.runs.require(runId);
		expect(run.costUsd).toBeCloseTo(0.7, 10);
		expect(run.tokensInput).toBe(20);
	});

	test("does not double a claude-code result envelope persisted before the reconnect", async () => {
		const result = claudeResult(SBX, 2, { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.8 });
		await bridge([evt(SBX, 1), result]);

		// Doubling the cumulative $0.80 would trip the $1 cap before the replay.
		const resumed = await bridge([evt(SBX, 1), result], 1);
		expect(resumed.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(cancels).toHaveLength(0);
		expect(await budgetEvents()).toBe(0);
		const run = await repos.runs.require(runId);
		expect(run.costUsd).toBeCloseTo(0.8, 10);
		expect(run.tokensInput).toBe(100);
	});
});
