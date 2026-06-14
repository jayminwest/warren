import { beforeEach, describe, expect, test } from "bun:test";
import type { RunEvent } from "@os-eco/burrow-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { makePool, seedBridgeRun, source } from "./test-helpers.ts";

/** Pi `turn_end` envelope carrying a per-turn cost total. */
function turnEnd(burrowRunId: string, seq: number, costTotal: number): RunEvent {
	return {
		id: 0,
		burrowId: "bur_aaaaaaaaaaaa",
		runId: burrowRunId,
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
	let burrowRunId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const ids = await seedBridgeRun(repos);
		runId = ids.runId;
		burrowRunId = ids.burrowRunId;
		broker = new RunEventBroker();
	});

	test("cancels the run once cumulative cost crosses the cap", async () => {
		const cancels: string[] = [];
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			costCapUsd: 1,
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			// Two turns of $0.6 each: cumulative crosses $1 on the second.
			source: source([turnEnd(burrowRunId, 1, 0.6), turnEnd(burrowRunId, 2, 0.6)]),
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
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			costCapUsd: 5,
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			source: source([turnEnd(burrowRunId, 1, 1), turnEnd(burrowRunId, 2, 1)]),
		});

		expect(cancels).toHaveLength(0);
		expect(result.terminalDetected).toBeUndefined();
	});

	test("no cap (null) leaves the run uncapped", async () => {
		const cancels: string[] = [];
		await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			burrowClientPool: await makePool(repos),
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			source: source([turnEnd(burrowRunId, 1, 100)]),
		});
		expect(cancels).toHaveLength(0);
	});
});
