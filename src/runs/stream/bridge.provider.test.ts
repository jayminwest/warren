/**
 * Provider-seam coverage for the event bridge + run-state poller (warren-c531).
 *
 * The other bridge suites drive the bridge with `source`/`runStateProbe`
 * overrides, which bypass the `RuntimeProvider` entirely. These tests instead
 * inject a fake `runtimeProvider` and pass NEITHER override, so the bridge
 * exercises the REAL default wiring: `providerStreamSource(provider, handle)`
 * for the event stream and `defaultRunStateProbe(provider, handle)` for the
 * run-state poller. That is exactly the path a `WARREN_RUNTIME=k8s` boot takes,
 * where `streamEvents` is pod-log NDJSON and `status` is pod metadata.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type {
	NormalizedEvent,
	RunHandle,
	RunStatus,
	RuntimeProvider,
} from "../../runtime/contract.ts";
import { RuntimeRunNotFoundError } from "../../runtime/errors.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { defaultRunStateProbe } from "./run-state-poller.ts";
import { seedBridgeRun } from "./test-helpers.ts";

const BURROW_ID = "bur_aaaaaaaaaaaa";

interface FakeProviderConfig {
	readonly streamEvents: (handle: RunHandle) => AsyncIterable<NormalizedEvent>;
	readonly status?: () => Promise<RunStatus>;
	readonly onCancel?: (reason: string | undefined) => void;
}

/** Partial `RuntimeProvider` fake — only the three seam methods the bridge uses. */
function makeFakeProvider(cfg: FakeProviderConfig): RuntimeProvider {
	return {
		streamEvents: (handle: RunHandle) => cfg.streamEvents(handle),
		status: cfg.status ?? (async () => runningStatus()),
		cancel: async (_handle: RunHandle, reason?: string) => {
			cfg.onCancel?.(reason);
		},
	} as unknown as RuntimeProvider;
}

function runningStatus(): RunStatus {
	return { phase: "running", exitCode: null, lastEventSeq: 0, lastEventTs: null, exists: true };
}

function nevt(seq: number, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
	return {
		seq,
		ts: new Date(2026, 6, 13, 12, 0, seq).toISOString(),
		kind: "text",
		stream: "stdout",
		payload: { seq },
		...overrides,
	};
}

async function* finiteStream(events: NormalizedEvent[]): AsyncIterable<NormalizedEvent> {
	for (const e of events) yield e;
}

/**
 * A stream that yields `events`, then stays open with a periodic keepalive
 * until the consumer `return()`s it — mirroring a live pod-log tail the
 * run-state poller tears down on terminal observation. The keepalive re-yields
 * the last seq (deduped as `seq <= resumeSeq`) so the async-iterator has a yield
 * point the poller's abort can interrupt via `return()`; the seam hides the
 * signal, so an event-less `await` loop would never reach a return point.
 */
function openStream(
	events: NormalizedEvent[],
): (handle: RunHandle) => AsyncIterable<NormalizedEvent> {
	const keepaliveSeq = events.length > 0 ? (events[events.length - 1]?.seq ?? 1) : 1;
	return () => ({
		async *[Symbol.asyncIterator]() {
			for (const e of events) yield e;
			while (true) {
				await new Promise((r) => setTimeout(r, 5));
				yield nevt(keepaliveSeq);
			}
		},
	});
}

describe("bridgeRunStream — RuntimeProvider seam (warren-c531)", () => {
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

	test("persists events emitted by provider.streamEvents (default source wiring)", async () => {
		const provider = makeFakeProvider({
			streamEvents: () => finiteStream([nevt(1), nevt(2), nevt(3)]),
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: BURROW_ID,
			runtimeProvider: provider,
		});
		expect(result.written).toBe(3);
		expect(result.errored).toBe(false);
		const rows = (await repos.events.listByRun(runId)).map((e) => e.burrowEventSeq);
		expect(rows).toEqual([1, 2, 3]);
	});

	test("run-state poller reconciles terminal from provider.status (no in-stream terminal)", async () => {
		let statusCalls = 0;
		const provider = makeFakeProvider({
			streamEvents: openStream([nevt(1)]),
			status: async (): Promise<RunStatus> => {
				statusCalls += 1;
				return statusCalls < 2
					? runningStatus()
					: { phase: "succeeded", exitCode: 0, lastEventSeq: 1, lastEventTs: null, exists: true };
			},
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: BURROW_ID,
			runtimeProvider: provider,
			runStatePollMs: 5,
			runStateDrainMs: 10,
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(result.errored).toBe(false);
		expect(result.burrowRunMissing).toBeUndefined();
	});

	test("run-state poller surfaces oom_killed terminalReason as failureReason", async () => {
		const provider = makeFakeProvider({
			streamEvents: openStream([nevt(1)]),
			status: async (): Promise<RunStatus> => ({
				phase: "failed",
				exitCode: 137,
				terminalReason: "oom_killed",
				lastEventSeq: 1,
				lastEventTs: null,
				exists: true,
			}),
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: BURROW_ID,
			runtimeProvider: provider,
			runStatePollMs: 5,
			runStateDrainMs: 10,
		});
		expect(result.terminalDetected).toEqual({ outcome: "failed", failureReason: "oom_killed" });
	});

	test("provider.streamEvents RuntimeRunNotFoundError → burrowRunMissing (lost run)", async () => {
		const provider = makeFakeProvider({
			streamEvents: () => ({
				// biome-ignore lint/correctness/useYield: throws before yielding (a lost run).
				async *[Symbol.asyncIterator]() {
					throw new RuntimeRunNotFoundError("run vanished from backend");
				},
			}),
			// The stream 404 is authoritative for the ghost path; status agrees.
			status: async (): Promise<RunStatus> => ({
				phase: "running",
				exitCode: null,
				lastEventSeq: 0,
				lastEventTs: null,
				exists: false,
			}),
		});
		const result = await bridgeRunStream({
			runId,
			burrowRunId,
			repos,
			broker,
			burrowId: BURROW_ID,
			runtimeProvider: provider,
		});
		expect(result.burrowRunMissing).toBe(true);
		expect(result.errored).toBe(false);
	});
});

describe("defaultRunStateProbe (warren-c531)", () => {
	const handle: RunHandle = { runId: "run_x", sandboxId: "bur_x", providerRunId: "prb_x" };
	const signal = new AbortController().signal;

	test("maps exists:false to null so the poller keeps polling (transient/lost)", async () => {
		const provider = makeFakeProvider({
			streamEvents: () => finiteStream([]),
			status: async (): Promise<RunStatus> => ({
				phase: "running",
				exitCode: null,
				lastEventSeq: 0,
				lastEventTs: null,
				exists: false,
			}),
		});
		const probe = defaultRunStateProbe(provider, handle);
		expect(await probe(handle.providerRunId, signal)).toBeNull();
	});

	test("projects a live status to the {state, exitCode, terminalReason} triple", async () => {
		const provider = makeFakeProvider({
			streamEvents: () => finiteStream([]),
			status: async (): Promise<RunStatus> => ({
				phase: "succeeded",
				exitCode: 0,
				terminalReason: "oom_killed",
				lastEventSeq: 3,
				lastEventTs: null,
				exists: true,
			}),
		});
		const probe = defaultRunStateProbe(provider, handle);
		expect(await probe(handle.providerRunId, signal)).toEqual({
			state: "succeeded",
			exitCode: 0,
			terminalReason: "oom_killed",
		});
	});
});
