import { describe, expect, test } from "bun:test";
import type { NormalizedEvent } from "../contract.ts";
import {
	DEFAULT_LOG_STALL_TIMEOUT_MS,
	type LogFollowController,
	type LogFollowFn,
	type LogFollowParams,
	resolveLogStallTimeoutMs,
	type StreamLogger,
	type StreamTerminalState,
	streamK8sLogs,
	type TerminalProbe,
} from "./log-stream.ts";

// --- Fakes (mirrors log-stream.test.ts; tests are jscpd-excluded) ------------

/** One scripted follow connection: pushes chunks + a terminal signal on open. */
type ConnScript = (onData: (chunk: string) => void, onDone: (err: unknown) => void) => void;

/**
 * A scripted log-follow seam with ABORT tracking (the stall guard's whole
 * point): each call's params + whether its controller was aborted are recorded.
 * Exhausted scripts default to an empty clean close (the drain read).
 */
class ScriptedLog {
	readonly calls: LogFollowParams[] = [];
	readonly aborted: boolean[] = [];
	private readonly scripts: ConnScript[];
	constructor(scripts: ConnScript[]) {
		this.scripts = [...scripts];
	}
	readonly follow: LogFollowFn = (params, onData, onDone) => {
		const idx = this.calls.length;
		this.calls.push(params);
		this.aborted.push(false);
		const script = this.scripts.shift() ?? ((_d, done) => done(undefined));
		script(onData, onDone); // sync push — the ChunkQueue buffers ahead of pull()
		const controller: LogFollowController = {
			abort: () => {
				this.aborted[idx] = true;
			},
		};
		return Promise.resolve(controller);
	};
}

/** A probe that yields the given states in order; the last one sticks. */
function probeSequence(...states: StreamTerminalState[]): TerminalProbe {
	let i = 0;
	return () => {
		const s = states[Math.min(i, states.length - 1)] ?? RUNNING;
		i += 1;
		return Promise.resolve(s);
	};
}

const RUNNING: StreamTerminalState = { exists: true, terminal: false };
const TERMINAL: StreamTerminalState = { exists: true, terminal: true };

const PARAMS = { namespace: "warren-runs", podName: "run-run-x", containerName: "agent" };

/** An RFC3339Nano kubelet stamp for second `s`, zero-padded. */
function ts(s: number): string {
	const base = new Date(Date.UTC(2026, 6, 12, 0, 0, s)).toISOString().replace(".000Z", "");
	return `${base}.${"0".repeat(9)}Z`;
}

/** A kubelet log line: `<stamp> <json>` — mirrors `timestamps=true` output. */
function ev(stamp: string, body: Record<string, unknown>): string {
	return `${stamp} ${JSON.stringify(body)}`;
}

/** Drain an async event stream, capturing any thrown error. */
async function drain(
	stream: AsyncIterable<NormalizedEvent>,
): Promise<{ events: NormalizedEvent[]; error: unknown }> {
	const events: NormalizedEvent[] = [];
	try {
		for await (const e of stream) events.push(e);
		return { events, error: undefined };
	} catch (error) {
		return { events, error };
	}
}

function run(
	scripts: ConnScript[],
	probe: TerminalProbe,
	extra: { stallTimeoutMs?: number; logger?: StreamLogger } = {},
): { log: ScriptedLog; stream: AsyncIterable<NormalizedEvent> } {
	const log = new ScriptedLog(scripts);
	const stream = streamK8sLogs({
		follow: log.follow,
		probe,
		params: PARAMS,
		backoffBaseMs: 1,
		backoffMaxMs: 2,
		...(extra.stallTimeoutMs !== undefined ? { stallTimeoutMs: extra.stallTimeoutMs } : {}),
		...(extra.logger !== undefined ? { logger: extra.logger } : {}),
	});
	return { log, stream };
}

// --- Liveness guard (warren-029d) --------------------------------------------

describe("streamK8sLogs — stall liveness guard (warren-029d)", () => {
	test("a healthy stream under the window is untouched — the window resets per chunk", async () => {
		// Three chunks, each 40ms apart, with a 70ms window: the CUMULATIVE 120ms
		// exceeds the window, so a timer that did not reset per delivered byte
		// would trip. A healthy stream must see NO abort, NO stall warn, NO
		// spurious reconnect — only the follow + the terminal drain.
		const warns: string[] = [];
		const logger: StreamLogger = { warn: (_o, m) => void warns.push(m) };
		const healthy: ConnScript = (onData, onDone) => {
			onData(`${ev(ts(1), { kind: "a", payload: {} })}\n`);
			setTimeout(() => onData(`${ev(ts(2), { kind: "b", payload: {} })}\n`), 40);
			setTimeout(() => onData(`${ev(ts(3), { kind: "c", payload: {} })}\n`), 80);
			setTimeout(() => onDone(undefined), 120);
		};
		const { log, stream } = run([healthy], probeSequence(TERMINAL), {
			stallTimeoutMs: 70,
			logger,
		});
		const { events, error } = await drain(stream);
		expect(error).toBeUndefined();
		expect(events.map((e) => e.kind)).toEqual(["a", "b", "c"]);
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
		// Exactly the follow + the terminal drain: NO stall-forced reconnect. (The
		// `aborted` flags are not the signal here — openAndConsume's finally always
		// aborts its controller at teardown, a no-op after a clean EOF.)
		expect(log.calls).toHaveLength(2);
		expect(warns.some((m) => m.includes("liveness window"))).toBe(false);
	});

	test("half-open + pod Running → abort and sinceTime resume with no loss or duplication", async () => {
		// The warren-3047 shape: the follow delivered a,b then half-opened (no
		// bytes, no FIN, no error). The window trips; probe says Running; the
		// resume MUST anchor at the last line's stamp and the boundary dedup MUST
		// drop the re-returned ts(2) line — kinds/seqs continue [a,b,c] / [1,2,3].
		const halfOpen: ConnScript = (onData, _onDone) => {
			onData(`${ev(ts(1), { kind: "a", payload: {} })}\n`);
			onData(`${ev(ts(2), { kind: "b", payload: {} })}\n`);
			// deliberately NO onDone: the stream half-opens.
		};
		const resumed: ConnScript = (onData, onDone) => {
			onData(`${ev(ts(2), { kind: "b", payload: {} })}\n`); // boundary re-return
			onData(`${ev(ts(3), { kind: "c", payload: {} })}\n`);
			onDone(undefined);
		};
		const { log, stream } = run([halfOpen, resumed], probeSequence(RUNNING, TERMINAL), {
			stallTimeoutMs: 30,
		});
		const { events, error } = await drain(stream);
		expect(error).toBeUndefined();
		expect(events.map((e) => e.kind)).toEqual(["a", "b", "c"]);
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
		// The half-open follow was aborted; the resume is a FORWARD sinceTime
		// follow anchored at the last delivered line's stamp.
		expect(log.aborted[0]).toBe(true);
		expect(log.calls[1]?.follow).toBe(true);
		expect(log.calls[1]?.sinceTime).toBe(ts(2));
	});

	test("half-open before ANY byte + pod Running → from-start resume, no duplication", async () => {
		// The follow never delivered a single byte (no anchor yet): the resume
		// re-reads from the start and the seq counter continues cleanly at 1.
		const silent: ConnScript = (_onData, _onDone) => {};
		const replay: ConnScript = (onData, onDone) => {
			onData(`${ev(ts(1), { kind: "a", payload: {} })}\n`);
			onData(`${ev(ts(2), { kind: "b", payload: {} })}\n`);
			onDone(undefined);
		};
		const { log, stream } = run([silent, replay], probeSequence(RUNNING, TERMINAL), {
			stallTimeoutMs: 30,
		});
		const { events, error } = await drain(stream);
		expect(error).toBeUndefined();
		expect(events.map((e) => e.kind)).toEqual(["a", "b"]);
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
		expect(log.aborted[0]).toBe(true);
		expect(log.calls[1]?.sinceTime).toBeUndefined();
	});

	test("half-open + pod terminal → drain the tail and end the stream", async () => {
		// The follow half-opened mid-run but the pod already finished: the trip
		// aborts the dead connection, the probe reports terminal, and the
		// non-follow DRAIN read surfaces the tail that flushed post-silence.
		const halfOpen: ConnScript = (onData, _onDone) => {
			onData(`${ev(ts(1), { kind: "a", payload: {} })}\n`);
		};
		const drainRead: ConnScript = (onData, onDone) => {
			onData(`${ev(ts(2), { kind: "tail", payload: { type: "result" } })}\n`);
			onDone(undefined);
		};
		const { log, stream } = run([halfOpen, drainRead], probeSequence(TERMINAL), {
			stallTimeoutMs: 30,
		});
		const { events, error } = await drain(stream);
		expect(error).toBeUndefined(); // ended, NOT hung and NOT lost
		expect(events.map((e) => e.kind)).toEqual(["a", "tail"]);
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
		expect(log.aborted[0]).toBe(true);
		expect(log.calls[1]?.follow).toBe(false); // the drain is a non-follow read
	});

	test("a stall trip warn-logs with the pod + window before resuming", async () => {
		const warns: { obj: unknown; msg: string }[] = [];
		const logger: StreamLogger = { warn: (o, m) => void warns.push({ obj: o, msg: m }) };
		const halfOpen: ConnScript = (_onData, _onDone) => {};
		await drain(run([halfOpen], probeSequence(TERMINAL), { stallTimeoutMs: 30, logger }).stream);
		const stallWarn = warns.find((w) => w.msg.includes("liveness window"));
		expect(stallWarn).toBeDefined();
		expect(stallWarn?.obj).toMatchObject({ podName: PARAMS.podName, stallTimeoutMs: 30 });
	});
});

describe("resolveLogStallTimeoutMs (warren-029d)", () => {
	test("absent/blank yields the 5-minute default", () => {
		expect(resolveLogStallTimeoutMs({})).toBe(DEFAULT_LOG_STALL_TIMEOUT_MS);
		expect(resolveLogStallTimeoutMs({ WARREN_K8S_LOG_STREAM_STALL_MS: "  " })).toBe(
			DEFAULT_LOG_STALL_TIMEOUT_MS,
		);
		expect(DEFAULT_LOG_STALL_TIMEOUT_MS).toBe(5 * 60 * 1000);
	});

	test("a non-negative integer wins; 0 disables", () => {
		expect(resolveLogStallTimeoutMs({ WARREN_K8S_LOG_STREAM_STALL_MS: "45000" })).toBe(45_000);
		expect(resolveLogStallTimeoutMs({ WARREN_K8S_LOG_STREAM_STALL_MS: "0" })).toBe(0);
	});

	test("malformed / negative values throw loudly rather than disarm the guard", () => {
		expect(() => resolveLogStallTimeoutMs({ WARREN_K8S_LOG_STREAM_STALL_MS: "5m" })).toThrow(
			/non-negative integer/,
		);
		expect(() => resolveLogStallTimeoutMs({ WARREN_K8S_LOG_STREAM_STALL_MS: "-1" })).toThrow(
			/non-negative integer/,
		);
		expect(() => resolveLogStallTimeoutMs({ WARREN_K8S_LOG_STREAM_STALL_MS: "1.5" })).toThrow(
			/non-negative integer/,
		);
	});
});
