import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { makeProvider, seedBridgeRun, source } from "./test-helpers.ts";
import type { StreamEventView } from "./types.ts";

/** Pi `turn_end` envelope carrying a per-turn cost total. */
function turnEnd(_sandboxRunId: string, seq: number, costTotal: number): StreamEventView {
	return {
		seq,
		kind: "state_change",
		stream: "system",
		payload: {
			type: "turn_end",
			message: { usage: { cost: { total: costTotal }, input: 10, output: 5 } },
		},
		ts: new Date(2026, 4, 8, 12, 0, seq),
	};
}

describe("bridgeRunStream — spend-cap enforcement (warren-a63d)", () => {
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

	test("cancels the run once cumulative cost crosses the cap", async () => {
		const cancels: string[] = [];
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			costCapUsd: 1,
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			// Two turns of $0.6 each: cumulative crosses $1 on the second.
			source: source([turnEnd(sandboxRunId, 1, 0.6), turnEnd(sandboxRunId, 2, 0.6)]),
		});

		expect(result.terminalDetected).toEqual({ outcome: "cancelled" });
		expect(cancels).toHaveLength(1);
		expect(cancels[0]).toContain("spend cap exceeded");

		// budget.exceeded event landed on the run log.
		const events = await repos.events.listByRun(runId);
		const budgetEvent = events.find((e) => e.kind === "budget.exceeded");
		expect(budgetEvent).toBeDefined();

		// Cost was persisted so the cancelled run isn't left at null.
		const run = await repos.runs.require(runId);
		expect(run.costUsd).toBeGreaterThanOrEqual(1);
	});

	test("does not cancel when cumulative cost stays at or under the cap", async () => {
		const cancels: string[] = [];
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			costCapUsd: 5,
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			source: source([turnEnd(sandboxRunId, 1, 1), turnEnd(sandboxRunId, 2, 1)]),
		});

		expect(cancels).toHaveLength(0);
		expect(result.terminalDetected).toBeUndefined();
	});

	test("no cap (null) leaves the run uncapped", async () => {
		const cancels: string[] = [];
		await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			source: source([turnEnd(sandboxRunId, 1, 100)]),
		});
		expect(cancels).toHaveLength(0);
	});

	/**
	 * warren-01d5: the cost-cap cancel must travel the SAME graceful path as an
	 * operator cancel — a single `provider.cancel`-shaped cancel request and a
	 * `cancelled` terminal outcome that drives reap's finalize/salvage pipeline
	 * (bridge terminal-detect → reap → `provider.finalize` → salvage) — not a
	 * hard stop that skips finalize. Both shapes below produce identical bridge
	 * outcomes: an operator cancel surfaces as the agent's own terminal
	 * `agent_end` envelope (warren side then cancels + reaps); a cost-cap trip
	 * breaks the stream itself. Same outcome, same cancel-seam contract.
	 */
	test("cost-cap cancel follows the same graceful terminal path as an operator cancel", async () => {
		// Operator cancel: the run-state probe — the same projection cancelRun's
		// post-cancel status re-read observes — reports the backend `cancelled`
		// phase and the bridge synthesizes the terminal outcome from it.
		const operatorResult = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			cancelBurrowRun: async () => {},
			runStatePollMs: 1,
			runStateDrainMs: 1,
			runStateProbe: async () => ({ state: "cancelled", exitCode: null }),
			source: source([turnEnd(sandboxRunId, 1, 0.1)]),
		});
		expect(operatorResult.terminalDetected).toEqual({ outcome: "cancelled" });

		// Cost-cap cancel: the bridge itself drives the graceful cancel seam and
		// reports the identical `cancelled` terminal outcome, so reap's
		// finalize/salvage pipeline runs for both paths.
		const costCapCancels: string[] = [];
		const costCapResult = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			costCapUsd: 1,
			cancelBurrowRun: async (reason) => {
				costCapCancels.push(reason);
			},
			source: source([turnEnd(sandboxRunId, 3, 2)]),
		});
		expect(costCapResult.terminalDetected).toEqual(operatorResult.terminalDetected);
		expect(costCapCancels).toHaveLength(1);
	});
});
