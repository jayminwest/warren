import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RuntimeRunNotFoundError } from "../../runtime/errors.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { evt, makeProvider, seedBridgeRun, source } from "./test-helpers.ts";
import type { StreamEventView } from "./types.ts";

describe("bridgeRunStream — in-stream terminal detection", () => {
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

	test("warren-a69a: claude-code result event sets terminalDetected and breaks the loop", async () => {
		const claudeResultEvt = evt(sandboxRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "result", subtype: "result", is_error: false, terminal_reason: "completed" },
		});
		const trailing = evt(sandboxRunId, 2, { kind: "text", payload: { text: "post-terminal" } });
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([claudeResultEvt, trailing]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		const seqs = (await repos.events.listByRun(runId)).map((e) => e.sandboxEventSeq);
		expect(seqs).toEqual([1]);
	});

	test("warren-a69a: claude-code result with is_error=true maps to failed", async () => {
		const claudeFail = evt(sandboxRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "result", subtype: "result", is_error: true, terminal_reason: "completed" },
		});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([claudeFail]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "failed" });
	});

	test("warren-a69a: non-terminal state_change events do not set terminalDetected", async () => {
		const init = evt(sandboxRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "system", subtype: "init" },
		});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([init]),
		});
		expect(result.terminalDetected).toBeUndefined();
	});

	test("warren-2687: pi agent_end envelope sets terminalDetected and breaks the loop", async () => {
		const piEnd = evt(sandboxRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "agent_end", messages: [] },
		});
		const trailing = evt(sandboxRunId, 2, { kind: "text", payload: { text: "post-terminal" } });
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([piEnd, trailing]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		const seqs = (await repos.events.listByRun(runId)).map((e) => e.sandboxEventSeq);
		expect(seqs).toEqual([1]);
	});

	test("warren-2687: pi agent_end on non-system stream does not set terminalDetected", async () => {
		const offStream = evt(sandboxRunId, 1, {
			kind: "state_change",
			stream: "stdout",
			payload: { type: "agent_end", messages: [] },
		});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([offStream]),
		});
		expect(result.terminalDetected).toBeUndefined();
	});

	test("warren-2206: a resumed pass reaps a terminal event a prior pass already persisted", async () => {
		// A prior bridge pass appended the terminal event (seq 1) then was torn down
		// before its inline reap fired. Pre-persist it so `resumeSeq` == 1.
		const terminalPayload = {
			type: "result",
			subtype: "result",
			is_error: true,
			terminal_reason: "completed",
		};
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: terminalPayload,
		});
		// The resumed stream replays that same terminal event (seq 1 <= resumeSeq).
		const replayed = evt(sandboxRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: terminalPayload,
		});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([replayed]),
		});
		// The terminal is detected on the already-persisted (deduped) event, so reap
		// still finalizes — without re-appending the row (dedup intact).
		expect(result.terminalDetected).toEqual({ outcome: "failed" });
		expect(result.written).toBe(0);
		expect(result.skipped).toBe(1);
		const seqs = (await repos.events.listByRun(runId)).map((e) => e.sandboxEventSeq);
		expect(seqs).toEqual([1]); // no duplicate row appended
	});

	test("warren-b1a9: RuntimeRunNotFoundError from source sets sandboxRunMissing, not errored", async () => {
		// The seam neutralizes burrow's raw 404 into `RuntimeRunNotFoundError`
		// (warren-1f56); the bridge's ghost-run catch keys off the neutral class.
		const missingSource = (): AsyncIterable<StreamEventView> => ({
			[Symbol.asyncIterator](): AsyncIterator<StreamEventView> {
				return {
					next: async () => {
						throw new RuntimeRunNotFoundError(`run not found: ${sandboxRunId}`);
					},
				};
			},
		});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: missingSource,
		});
		expect(result.sandboxRunMissing).toBe(true);
		expect(result.errored).toBe(false);
		expect(result.terminalDetected).toBeUndefined();
	});

	test("warren-b1a9: non-404 throw still sets errored=true (reconnect path)", async () => {
		const transportSource = (): AsyncIterable<StreamEventView> => ({
			[Symbol.asyncIterator](): AsyncIterator<StreamEventView> {
				return {
					next: async () => {
						throw new Error("ECONNRESET");
					},
				};
			},
		});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: transportSource,
		});
		expect(result.sandboxRunMissing).toBeUndefined();
		expect(result.errored).toBe(true);
	});
});
