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

/** Resolve `p`, or the `"timeout"` sentinel if it doesn't settle in `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
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

/**
 * A pod-log stream that yields `events`, then parks FOREVER on `next()` (no more
 * chunks, no EOF) and whose `return()` also never resolves — the warren-c433
 * incident shape: the kubelet never closed the follow after the pod completed, so
 * the pump can't be torn down by `.return()`. Proves the bounded teardown lets the
 * bridge still reach terminal/reap.
 */
function hangingStream(
	events: NormalizedEvent[],
): (handle: RunHandle) => AsyncIterable<NormalizedEvent> {
	return () => ({
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				next(): Promise<IteratorResult<NormalizedEvent>> {
					if (i < events.length) {
						const value = events[i++];
						if (value !== undefined) return Promise.resolve({ done: false, value });
					}
					return new Promise<IteratorResult<NormalizedEvent>>(() => {});
				},
				return(): Promise<IteratorResult<NormalizedEvent>> {
					return new Promise<IteratorResult<NormalizedEvent>>(() => {});
				},
			};
		},
	});
}

describe("bridgeRunStream — RuntimeProvider seam (warren-c531)", () => {
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

	test("persists events emitted by provider.streamEvents (default source wiring)", async () => {
		const provider = makeFakeProvider({
			streamEvents: () => finiteStream([nevt(1), nevt(2), nevt(3)]),
		});
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: BURROW_ID,
			runtimeProvider: provider,
		});
		expect(result.written).toBe(3);
		expect(result.errored).toBe(false);
		const rows = (await repos.events.listByRun(runId)).map((e) => e.sandboxEventSeq);
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
			sandboxRunId,
			repos,
			broker,
			sandboxId: BURROW_ID,
			runtimeProvider: provider,
			runStatePollMs: 5,
			runStateDrainMs: 10,
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(result.errored).toBe(false);
		expect(result.sandboxRunMissing).toBeUndefined();
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
			sandboxRunId,
			repos,
			broker,
			sandboxId: BURROW_ID,
			runtimeProvider: provider,
			runStatePollMs: 5,
			runStateDrainMs: 10,
		});
		expect(result.terminalDetected).toEqual({ outcome: "failed", failureReason: "oom_killed" });
	});

	test("terminal via pod-exit still reaps when the pod-log teardown hangs (warren-c433)", async () => {
		// The pod completed (status → succeeded) but its follow never EOF'd and
		// its teardown hangs — the incident that wedged run_nejha296p9es in
		// `running` for 40+ min. With the bounded teardown the bridge must still
		// synthesize `terminalDetected` (which drives reap → finalize → intent park)
		// instead of hanging forever on `iterator.return()`.
		let statusCalls = 0;
		const provider = makeFakeProvider({
			streamEvents: hangingStream([nevt(1)]),
			status: async (): Promise<RunStatus> => {
				statusCalls += 1;
				return statusCalls < 2
					? runningStatus()
					: { phase: "succeeded", exitCode: 0, lastEventSeq: 1, lastEventTs: null, exists: true };
			},
		});
		const result = await within(
			bridgeRunStream({
				runId,
				sandboxRunId,
				repos,
				broker,
				sandboxId: BURROW_ID,
				runtimeProvider: provider,
				runStatePollMs: 5,
				runStateDrainMs: 5,
				streamTeardownMs: 20, // hung teardown must not outlast this
			}),
			2000,
		);
		expect(result).not.toBe("timeout");
		const bridged = result as Awaited<ReturnType<typeof bridgeRunStream>>;
		expect(bridged.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(bridged.errored).toBe(false);
	});

	test("provider.streamEvents RuntimeRunNotFoundError → sandboxRunMissing (lost run)", async () => {
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
			sandboxRunId,
			repos,
			broker,
			sandboxId: BURROW_ID,
			runtimeProvider: provider,
		});
		expect(result.sandboxRunMissing).toBe(true);
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
