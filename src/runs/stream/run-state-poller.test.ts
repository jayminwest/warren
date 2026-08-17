import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { evt, makeProvider, seedBridgeRun, source } from "./test-helpers.ts";
import type { StreamEventView } from "./types.ts";

/**
 * Coverage for the run-state fallback (warren-6596) — the parallel
 * `runs.get` poll that synthesizes `terminalDetected` for declarative
 * raw-text agents that emit no in-stream terminal envelope.
 */
describe("bridgeRunStream — run-state poller (warren-6596)", () => {
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

	test("synthesizes terminalDetected for raw-text agents (no in-stream terminal envelope)", async () => {
		let probeCalls = 0;
		const runStateProbe = async (
			_: string,
			__: AbortSignal,
		): Promise<{ state: "running" | "succeeded"; exitCode: number | null }> => {
			probeCalls += 1;
			if (probeCalls < 2) return { state: "running", exitCode: null };
			return { state: "succeeded", exitCode: 0 };
		};
		const infiniteTextSource = (signal: AbortSignal): AsyncIterable<StreamEventView> => ({
			async *[Symbol.asyncIterator]() {
				let i = 1;
				while (!signal.aborted) {
					yield evt(sandboxRunId, i++, { kind: "text", payload: { text: `line ${i}` } });
					await new Promise((r) => setTimeout(r, 1));
				}
			},
		});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: (s: AbortSignal) => infiniteTextSource(s),
			runStateProbe,
			runStatePollMs: 10,
			runStateDrainMs: 20,
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(result.errored).toBe(false);
		expect(result.sandboxRunMissing).toBeUndefined();
	});

	test("maps burrow failed/cancelled to the matching terminal outcome", async () => {
		for (const sandboxState of ["failed", "cancelled"] as const) {
			db = await openDatabase({ path: ":memory:" });
			repos = createRepos(db);
			const ids = await seedBridgeRun(repos, {
				sandboxId: "bur_bbbbbbbbbbbb",
				sandboxRunId: "run_qqqqqqqqqqqq",
			});
			const localRunId = ids.runId;
			const localBurrowRunId = ids.sandboxRunId;
			broker = new RunEventBroker();
			const probe = async (
				_: string,
				__: AbortSignal,
			): Promise<{
				state: "running" | "failed" | "cancelled";
				exitCode: number | null;
			}> => ({ state: sandboxState, exitCode: sandboxState === "failed" ? 1 : null });
			const infinite = (signal: AbortSignal): AsyncIterable<StreamEventView> => ({
				async *[Symbol.asyncIterator]() {
					while (!signal.aborted) {
						yield evt(localBurrowRunId, 1);
						await new Promise((r) => setTimeout(r, 1));
					}
				},
			});
			const result = await bridgeRunStream({
				runId: localRunId,
				sandboxRunId: localBurrowRunId,
				repos,
				broker,
				sandboxId: "bur_bbbbbbbbbbbb",
				runtimeProvider: makeProvider(),
				source: (s: AbortSignal) => infinite(s),
				runStateProbe: probe,
				runStatePollMs: 5,
				runStateDrainMs: 10,
			});
			expect(result.terminalDetected).toEqual({ outcome: sandboxState });
			expect(result.errored).toBe(false);
			await db.close();
		}
	});

	test("in-stream terminal-detect wins over poller observation", async () => {
		// In-stream terminal carries exit-code semantics from the runtime
		// parser — it's authoritative when both fire.
		const claudeResultEvt = evt(sandboxRunId, 1, {
			kind: "state_change",
			stream: "system",
			payload: { type: "result", subtype: "result", is_error: true, terminal_reason: "completed" },
		});
		const probe = async (): Promise<{ state: "succeeded"; exitCode: 0 }> => ({
			state: "succeeded",
			exitCode: 0,
		});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source([claudeResultEvt]),
			runStateProbe: probe,
			runStatePollMs: 1000,
			runStateDrainMs: 1000,
		});
		expect(result.terminalDetected).toEqual({ outcome: "failed" });
	});
});
