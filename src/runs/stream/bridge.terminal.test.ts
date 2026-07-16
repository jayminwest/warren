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

	test("warren-a69a: claude-code result event sets terminalDetected and breaks the loop", async () => {
		const claudeResultEvt = evt(burrowRunId, 1, {
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
			runtimeProvider: makeProvider(),
			source: source([claudeResultEvt, trailing]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
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
			runtimeProvider: makeProvider(),
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
			runtimeProvider: makeProvider(),
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
			runtimeProvider: makeProvider(),
			source: source([piEnd, trailing]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		const seqs = (await repos.events.listByRun(runId)).map((e) => e.burrowEventSeq);
		expect(seqs).toEqual([1]);
	});

	test("warren-2687: pi agent_end on non-system stream does not set terminalDetected", async () => {
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
			burrowEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: terminalPayload,
		});
		// The resumed stream replays that same terminal event (seq 1 <= resumeSeq).
		const replayed = evt(burrowRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: terminalPayload,
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([replayed]),
		});
		// The terminal is detected on the already-persisted (deduped) event, so reap
		// still finalizes — without re-appending the row (dedup intact).
		expect(result.terminalDetected).toEqual({ outcome: "failed" });
		expect(result.written).toBe(0);
		expect(result.skipped).toBe(1);
		const seqs = (await repos.events.listByRun(runId)).map((e) => e.burrowEventSeq);
		expect(seqs).toEqual([1]); // no duplicate row appended
	});

	test("warren-b1a9: RuntimeRunNotFoundError from source sets burrowRunMissing, not errored", async () => {
		// The seam neutralizes burrow's raw 404 into `RuntimeRunNotFoundError`
		// (warren-1f56); the bridge's ghost-run catch keys off the neutral class.
		const missingSource = (): AsyncIterable<StreamEventView> => ({
			[Symbol.asyncIterator](): AsyncIterator<StreamEventView> {
				return {
					next: async () => {
						throw new RuntimeRunNotFoundError(`run not found: ${burrowRunId}`);
					},
				};
			},
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: missingSource,
		});
		expect(result.burrowRunMissing).toBe(true);
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
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: transportSource,
		});
		expect(result.burrowRunMissing).toBeUndefined();
		expect(result.errored).toBe(true);
	});
});

describe("bridgeRunStream — conversation keep-alive (warren-df71)", () => {
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

	function makeStubTurnHandler() {
		const assistantTurns: { runId: string; text: string }[] = [];
		const intentPatches: { runId: string; patch: unknown }[] = [];
		return {
			handler: {
				async persistAssistantTurn(input: { runId: string; text: string }) {
					assistantTurns.push(input);
				},
				async applyIntentPatch(input: { runId: string; patch: unknown }) {
					intentPatches.push(input);
				},
			},
			assistantTurns,
			intentPatches,
		};
	}

	test("agent_end is a turn boundary: keeps streaming, no terminalDetected", async () => {
		const stub = makeStubTurnHandler();
		const events: StreamEventView[] = [
			evt(burrowRunId, 1, { kind: "text", stream: "stdout", payload: { text: "Hello " } }),
			evt(burrowRunId, 2, { kind: "text", stream: "stdout", payload: { text: "world" } }),
			evt(burrowRunId, 3, {
				kind: "state_change",
				stream: "system",
				payload: {
					type: "tool_execution_end",
					toolName: "propose_intent",
					toolCallId: "tc_1",
					result: { content: [], details: { intent_patch: { goal: "ship the feature" } } },
				},
			}),
			evt(burrowRunId, 4, {
				kind: "state_change",
				stream: "system",
				payload: { type: "agent_end", messages: [] },
			}),
			evt(burrowRunId, 5, { kind: "text", stream: "stdout", payload: { text: "next turn" } }),
		];
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			mode: "conversation",
			conversationTurn: stub.handler,
			source: source(events),
		});

		expect(result.terminalDetected).toBeUndefined();
		// All five events written — the run did NOT break on agent_end.
		const seqs = (await repos.events.listByRun(runId)).map((e) => e.burrowEventSeq);
		expect(seqs).toEqual([1, 2, 3, 4, 5]);
		// Assistant text accumulated across the turn and flushed once at agent_end.
		expect(stub.assistantTurns).toEqual([{ runId, text: "Hello world" }]);
		// propose_intent patch applied as it streamed.
		expect(stub.intentPatches).toEqual([{ runId, patch: { goal: "ship the feature" } }]);
	});

	test("batch mode is unaffected: agent_end still sets terminalDetected", async () => {
		const stub = makeStubTurnHandler();
		const events: StreamEventView[] = [
			evt(burrowRunId, 1, {
				kind: "state_change",
				stream: "system",
				payload: { type: "agent_end", messages: [] },
			}),
		];
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			conversationTurn: stub.handler,
			source: source(events),
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(stub.assistantTurns).toEqual([]);
	});
});
