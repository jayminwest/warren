import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError as BurrowNotFoundError, type RunEvent } from "@os-eco/burrow-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { evt, makePool, seedBridgeRun, source } from "./test-helpers.ts";

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
			burrowClientPool: await makePool(repos),
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
			burrowClientPool: await makePool(repos),
			source: source([offStream]),
		});
		expect(result.terminalDetected).toBeUndefined();
	});

	test("warren-b1a9: BurrowNotFoundError from source sets burrowRunMissing, not errored", async () => {
		const missingSource = (): AsyncIterable<RunEvent> => ({
			[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
				return {
					next: async () => {
						throw new BurrowNotFoundError(`run not found: ${burrowRunId}`);
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
			burrowClientPool: await makePool(repos),
			source: missingSource,
		});
		expect(result.burrowRunMissing).toBe(true);
		expect(result.errored).toBe(false);
		expect(result.terminalDetected).toBeUndefined();
	});

	test("warren-b1a9: non-404 throw still sets errored=true (reconnect path)", async () => {
		const transportSource = (): AsyncIterable<RunEvent> => ({
			[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
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
			burrowClientPool: await makePool(repos),
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
		const events: RunEvent[] = [
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
			burrowClientPool: await makePool(repos),
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
		const events: RunEvent[] = [
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
			burrowClientPool: await makePool(repos),
			conversationTurn: stub.handler,
			source: source(events),
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(stub.assistantTurns).toEqual([]);
	});
});
