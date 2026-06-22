import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunEvent } from "@os-eco/burrow-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { evt, makePool, seedBridgeRun, source } from "./test-helpers.ts";

describe("bridgeRunStream — event flow", () => {
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
		expect(broker.subscriberCount(runId)).toBe(0);
	});

	test("resume: skips events with seq <= MAX(burrow_event_seq)", async () => {
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
		const errSource = (): AsyncIterable<RunEvent> => ({
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
			source: () => errSource(),
			logger: {
				error(obj: object) {
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
		const infinite = (signal: AbortSignal): AsyncIterable<RunEvent> => ({
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
			source: (s: AbortSignal) => infinite(s),
		});

		await new Promise((r) => setTimeout(r, 20));
		ctrl.abort();
		const result = await promise;
		expect(result.written).toBeGreaterThan(0);
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
		expect(after.startedAt).toBe(before.startedAt);
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
