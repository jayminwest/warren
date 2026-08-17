import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { evt, makeProvider, seedBridgeRun, source } from "./test-helpers.ts";
import type { StreamEventView } from "./types.ts";

describe("bridgeRunStream — event flow", () => {
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

	afterEach(async () => {
		await db.close();
	});

	test("writes every event to the events table and returns a count", async () => {
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([evt(sandboxRunId, 1), evt(sandboxRunId, 2), evt(sandboxRunId, 3)]),
		});
		expect(result.written).toBe(3);
		expect(result.skipped).toBe(0);
		expect(result.errored).toBe(false);
		const rows = (await repos.events.listByRun(runId)).map((e) => e.sandboxEventSeq);
		expect(rows).toEqual([1, 2, 3]);
	});

	test("folds tool_use/tool_result events into the tool_calls rollup at append time (warren-7746)", async () => {
		// The seeded run's renderedAgentJson is `{}` → default runtime "pi",
		// so the pi-native dialect fields are what extract.
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([
				evt(sandboxRunId, 1, {
					kind: "tool_use",
					payload: { toolName: "bash", command: "bun test", toolCallId: "c1" },
				}),
				evt(sandboxRunId, 2, {
					kind: "tool_result",
					payload: { toolCallId: "c1", isError: true, result: "boom" },
				}),
				evt(sandboxRunId, 3, { kind: "text" }),
			]),
		});
		expect(result.written).toBe(3);
		const { rows } = await repos.toolCalls.listForRuns([runId]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			runId,
			seq: 1,
			toolName: "bash",
			command: "bun test",
			toolUseId: "c1",
			isError: true,
			resultBytes: 4,
		});
	});

	test("publishes each event to the broker after persisting", async () => {
		const sub = broker.subscribe(runId);
		const consumed: number[] = [];
		const consumer = (async () => {
			for await (const row of sub) {
				consumed.push(row.sandboxEventSeq);
				if (consumed.length >= 2) break;
			}
		})();

		await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([evt(sandboxRunId, 1), evt(sandboxRunId, 2)]),
		});
		await consumer;

		expect(consumed).toEqual([1, 2]);
		expect(broker.subscriberCount(runId)).toBe(0);
	});

	test("drops per-delta message_update telemetry snapshots (never persisted or published)", async () => {
		const published: string[] = [];
		const sub = broker.subscribe(runId);
		const consumer = (async () => {
			for await (const row of sub) {
				published.push(row.kind);
				if (published.length >= 2) break;
			}
		})();

		const messageUpdate = (seq: number): StreamEventView =>
			evt(sandboxRunId, seq, {
				kind: "telemetry",
				stream: "system",
				payload: { type: "message_update", message: { role: "assistant", content: [] } },
			});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([
				evt(sandboxRunId, 1),
				messageUpdate(2),
				messageUpdate(3),
				// Non-snapshot telemetry subtypes still persist.
				evt(sandboxRunId, 4, {
					kind: "telemetry",
					stream: "system",
					payload: { type: "auto_retry_start" },
				}),
			]),
		});
		await consumer;

		expect(result.written).toBe(2);
		expect(result.skipped).toBe(0);
		const rows = await repos.events.listByRun(runId);
		expect(rows.map((e) => e.sandboxEventSeq)).toEqual([1, 4]);
		expect(published).toEqual(["text", "telemetry"]);
	});

	test("drops per-delta noise envelopes (tool_execution_update, message_start); keeps lifecycle markers and turn_end", async () => {
		const stateChange =
			(type: string) =>
			(seq: number): StreamEventView =>
				evt(sandboxRunId, seq, {
					kind: "state_change",
					stream: "system",
					payload: { type },
				});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([
				evt(sandboxRunId, 1),
				// Dropped: burrow's parser maps pi's unknown
				// tool_execution_update into state_change.
				stateChange("tool_execution_update")(2),
				stateChange("message_start")(3),
				// Kept: once-per-invocation lifecycle markers.
				stateChange("turn_start")(4),
				stateChange("tool_execution_start")(5),
				stateChange("tool_execution_end")(6),
				// Kept: HARD CONSTRAINT — usage aggregation reads turn_end.
				stateChange("turn_end")(7),
			]),
		});

		expect(result.written).toBe(5);
		expect(result.skipped).toBe(0);
		const rows = await repos.events.listByRun(runId);
		expect(rows.map((e) => e.sandboxEventSeq)).toEqual([1, 4, 5, 6, 7]);
	});

	test("resume: skips events with seq <= MAX(sandbox_event_seq)", async () => {
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: "2026-05-08T12:00:01.000Z",
			kind: "text",
			stream: "stdout",
			payload: { seq: 1 },
		});
		await repos.events.append({
			runId,
			sandboxEventSeq: 2,
			ts: "2026-05-08T12:00:02.000Z",
			kind: "text",
			stream: "stdout",
			payload: { seq: 2 },
		});

		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([
				evt(sandboxRunId, 1),
				evt(sandboxRunId, 2),
				evt(sandboxRunId, 3),
				evt(sandboxRunId, 4),
			]),
		});
		expect(result.skipped).toBe(2);
		expect(result.written).toBe(2);
		const rows = (await repos.events.listByRun(runId)).map((e) => e.sandboxEventSeq);
		expect(rows).toEqual([1, 2, 3, 4]);
	});

	test("normalizes unknown stream tags to null", async () => {
		await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([
				evt(sandboxRunId, 1, { stream: "weird" as unknown as StreamEventView["stream"] }),
			]),
		});
		const row = (await repos.events.listByRun(runId))[0];
		expect(row?.stream).toBeNull();
	});

	test("persists the stream view's origin on the appended row (warren-5a07)", async () => {
		await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([
				evt(sandboxRunId, 1, { origin: "agent" }),
				// Absent origin persists as NULL — unknown, never folded
				// into a real bucket (mixed-semantics rule).
				evt(sandboxRunId, 2),
			]),
		});
		const rows = await repos.events.listByRun(runId);
		expect(rows[0]?.origin).toBe("agent");
		expect(rows[1]?.origin).toBeNull();
	});

	test("source error: logs, sets errored=true, and does not throw", async () => {
		const errs: object[] = [];
		const errSource = (): AsyncIterable<StreamEventView> => ({
			async *[Symbol.asyncIterator]() {
				yield evt(sandboxRunId, 1);
				throw new Error("burrow disconnected");
			},
		});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
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
		const infinite = (signal: AbortSignal): AsyncIterable<StreamEventView> => ({
			async *[Symbol.asyncIterator]() {
				let i = 1;
				while (!signal.aborted) {
					yield evt(sandboxRunId, i++);
					await new Promise((r) => setTimeout(r, 1));
				}
			},
		});

		const promise = bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
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
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([evt(sandboxRunId, 1)]),
		});

		const after = await repos.runs.require(runId);
		expect(after.state).toBe("running");
		expect(after.startedAt).not.toBeNull();
	});

	test("does not transition state when source yields no events", async () => {
		await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
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
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([evt(sandboxRunId, 1)]),
		});

		const after = await repos.runs.require(runId);
		expect(after.state).toBe("running");
		expect(after.startedAt).toBe(before.startedAt);
	});

	test("bridge end calls broker.close so live subscribers return", async () => {
		const sub = broker.subscribe(runId);
		const out: number[] = [];
		const consumer = (async () => {
			for await (const row of sub) out.push(row.sandboxEventSeq);
		})();
		await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([evt(sandboxRunId, 1)]),
		});
		await consumer;
		expect(out).toEqual([1]);
	});
});
