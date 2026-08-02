import { describe, expect, test } from "bun:test";
import type { NormalizedEvent } from "../contract.ts";
import { RuntimeRunNotFoundError } from "../errors.ts";
import {
	type LogFollowController,
	type LogFollowFn,
	type LogFollowParams,
	STREAM_GAP_KIND,
	type StreamCounterSink,
	type StreamLogger,
	type StreamTerminalState,
	streamK8sLogs,
	type TerminalProbe,
} from "./log-stream.ts";
import { METRIC_LOG_PARSE_FAILURES_TOTAL } from "./pod-metrics.ts";

// --- Fakes ------------------------------------------------------------------

/** One scripted follow connection: pushes chunks + a terminal signal on open. */
type ConnScript = (onData: (chunk: string) => void, onDone: (err: unknown) => void) => void;

/** Deliver these lines (each gets a trailing newline) then close cleanly. */
function lines(...ls: string[]): ConnScript {
	return (onData, onDone) => {
		for (const l of ls) onData(`${l}\n`);
		onDone(undefined);
	};
}

/** Deliver raw chunks verbatim (no added newlines) then close cleanly. */
function chunks(...cs: string[]): ConnScript {
	return (onData, onDone) => {
		for (const c of cs) onData(c);
		onDone(undefined);
	};
}

/** Deliver lines then end with a transient (non-404) disconnect. */
function linesThenDrop(...ls: string[]): ConnScript {
	return (onData, onDone) => {
		for (const l of ls) onData(`${l}\n`);
		onDone(new Error("network blip"));
	};
}

/** Deliver lines then end with a 404 (pod deleted mid-follow). */
function linesThen404(...ls: string[]): ConnScript {
	return (onData, onDone) => {
		for (const l of ls) onData(`${l}\n`);
		onDone(Object.assign(new Error("pods not found"), { code: 404 }));
	};
}

/**
 * A scripted log-follow seam: each `streamK8sLogs` follow call pops the next
 * script; every call's params are recorded so tests assert `sinceTime` / `follow`.
 * Exhausted scripts default to an empty clean close (the drain read).
 */
class ScriptedLog {
	readonly calls: LogFollowParams[] = [];
	private readonly scripts: ConnScript[];
	constructor(scripts: ConnScript[]) {
		this.scripts = [...scripts];
	}
	readonly follow: LogFollowFn = (params, onData, onDone) => {
		this.calls.push(params);
		const script = this.scripts.shift() ?? ((_d, done) => done(undefined));
		script(onData, onDone); // sync push — the ChunkQueue buffers ahead of pull()
		const controller: LogFollowController = { abort: () => {} };
		return Promise.resolve(controller);
	};
}

class FakeCounters implements StreamCounterSink {
	readonly counts = new Map<string, number>();
	increment(name: string, _labels?: Readonly<Record<string, string>>, by = 1): void {
		this.counts.set(name, (this.counts.get(name) ?? 0) + by);
	}
	get(name: string): number {
		return this.counts.get(name) ?? 0;
	}
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
const GONE: StreamTerminalState = { exists: false, terminal: false };
const PENDING: StreamTerminalState = { exists: true, terminal: false, pending: true };

const PARAMS = { namespace: "warren-runs", podName: "run-run-x", containerName: "agent" };

/** An RFC3339Nano kubelet stamp for second `s` (+ optional nanos), zero-padded. */
function ts(s: number, nanos = 0): string {
	const base = new Date(Date.UTC(2026, 6, 12, 0, 0, s)).toISOString().replace(".000Z", "");
	return `${base}.${String(nanos).padStart(9, "0")}Z`;
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
	extra: { sinceSeq?: number; metrics?: StreamCounterSink } = {},
): { log: ScriptedLog; stream: AsyncIterable<NormalizedEvent> } {
	const log = new ScriptedLog(scripts);
	const stream = streamK8sLogs({
		follow: log.follow,
		probe,
		params: PARAMS,
		backoffBaseMs: 1,
		backoffMaxMs: 2,
		...(extra.sinceSeq !== undefined ? { opts: { sinceSeq: extra.sinceSeq } } : {}),
		...(extra.metrics !== undefined ? { metrics: extra.metrics } : {}),
	});
	return { log, stream };
}

// --- live-follow incremental delivery (warren-245d) -------------------------

describe("streamK8sLogs — live-follow incremental delivery", () => {
	test("yields events from a connection that stays OPEN, before it ever closes", async () => {
		// A live `follow:true` connection stays open for the pod's whole lifetime:
		// it pushes the retained log, then streams, and only closes at pod
		// termination. Events MUST arrive incrementally. The pre-fix code buffered
		// every event until the connection CLOSED, so a running pod's events (incl.
		// its terminal `result`) never reached the bridge — the run deadlocked in
		// `queued` and finalize was never triggered (warren-245d live k3d finding).
		const stayOpen: ConnScript = (onData, _onDone) => {
			onData(`${ev(ts(1), { type: "event", kind: "text", stream: "stdout", payload: "one" })}\n`);
			onData(`${ev(ts(2), { type: "event", kind: "text", stream: "stdout", payload: "two" })}\n`);
			// deliberately NO onDone(): the follow connection remains open.
		};
		const log = new ScriptedLog([stayOpen]);
		const gen = streamK8sLogs({
			follow: log.follow,
			probe: probeSequence(RUNNING),
			params: PARAMS,
			backoffBaseMs: 1,
			backoffMaxMs: 2,
		});
		const withTimeout = <T>(p: Promise<T>): Promise<T> =>
			Promise.race([
				p,
				new Promise<T>((_r, reject) =>
					setTimeout(
						() =>
							reject(new Error("timed out — events not yielded from an OPEN follow (regression)")),
						1000,
					),
				),
			]);
		try {
			const first = await withTimeout(gen.next());
			const second = await withTimeout(gen.next());
			expect(first.done).toBe(false);
			expect(second.done).toBe(false);
			expect(first.value?.seq).toBe(1);
			expect(second.value?.seq).toBe(2);
		} finally {
			await gen.return(undefined);
		}
	});
});

// --- NDJSON parsing + seq synthesis -----------------------------------------

describe("streamK8sLogs — NDJSON parse + synthesized seq", () => {
	test("assigns a monotonic 1-based seq per physical line; payload is lossless", async () => {
		const script = lines(
			ev(ts(1), { type: "event", seq: 99, kind: "tool_use", stream: "stdout", payload: { a: 1 } }),
			ev(ts(2), { type: "event", kind: "text", stream: "stderr", payload: "hello" }),
		);
		const { events, error } = await drain(run([script], probeSequence(TERMINAL)).stream);
		expect(error).toBeUndefined();
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
		// seq is SYNTHESIZED (line index), not the envelope's own `seq: 99`.
		expect(events[0]).toMatchObject({
			seq: 1,
			kind: "tool_use",
			stream: "stdout",
			payload: { a: 1 },
			ts: ts(1),
		});
		expect(events[1]?.payload).toBe("hello");
		expect(events[1]?.stream).toBe("stderr");
	});

	test("a bare JSON object (no envelope) rides wholesale as payload (lossless)", async () => {
		const script = lines(ev(ts(1), { kind: "raw", foo: 1, nested: { x: [1, 2] } }));
		const { events } = await drain(run([script], probeSequence(TERMINAL)).stream);
		expect(events[0]?.kind).toBe("raw");
		expect(events[0]?.payload).toEqual({ kind: "raw", foo: 1, nested: { x: [1, 2] } });
	});

	test("a claude-code result envelope round-trips so detectRuntimeTerminal still fires", async () => {
		const script = lines(
			ev(ts(1), {
				type: "event",
				kind: "state_change",
				stream: "system",
				origin: "warren", // warren-6646: the in-pod emitter's marker; without it, no system claim

				payload: { type: "result", is_error: false, total_cost_usd: 0.42 },
			}),
		);
		const { events } = await drain(run([script], probeSequence(TERMINAL)).stream);
		expect(events[0]).toMatchObject({ kind: "state_change", stream: "system", origin: "warren" });
		expect(events[0]?.payload).toEqual({ type: "result", is_error: false, total_cost_usd: 0.42 });
	});

	test("prefers the envelope ts; falls back to the kubelet stamp when absent", async () => {
		const script = lines(
			ev(ts(1), { kind: "a", ts: "2020-01-01T00:00:00.000Z", payload: {} }),
			ev(ts(2), { kind: "b", payload: {} }),
		);
		const { events } = await drain(run([script], probeSequence(TERMINAL)).stream);
		expect(events[0]?.ts).toBe("2020-01-01T00:00:00.000Z");
		expect(events[1]?.ts).toBe(ts(2));
	});

	test("blank lines consume no seq slot", async () => {
		const script = lines(
			ev(ts(1), { kind: "a", payload: {} }),
			`${ts(2)} `,
			ev(ts(3), { kind: "b" }),
		);
		const { events } = await drain(run([script], probeSequence(TERMINAL)).stream);
		expect(events.map((e) => e.kind)).toEqual(["a", "b"]);
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
	});
});

describe("streamK8sLogs — partial lines + garbage", () => {
	test("reassembles a JSON line split across chunk boundaries", async () => {
		const full = ev(ts(1), { kind: "split", payload: { big: "value" } });
		const mid = Math.floor(full.length / 2);
		const script = chunks(full.slice(0, mid), full.slice(mid), "\n");
		const { events } = await drain(run([script], probeSequence(TERMINAL)).stream);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ seq: 1, kind: "split", payload: { big: "value" } });
	});

	test("interleaved non-JSON lines are dropped + counted, never kill the stream", async () => {
		const metrics = new FakeCounters();
		const script = lines(
			"npm warn: deprecated foo",
			ev(ts(1), { kind: "a", payload: {} }),
			"not-json {oops",
			ev(ts(2), { kind: "b", payload: {} }),
		);
		const { events } = await drain(run([script], probeSequence(TERMINAL), { metrics }).stream);
		// Only the two JSON lines are yielded, at their PHYSICAL indices (2 and 4)
		// — garbage still consumes a slot, so seqs are stable-but-gapped.
		expect(events.map((e) => e.kind)).toEqual(["a", "b"]);
		expect(events.map((e) => e.seq)).toEqual([2, 4]);
		expect(metrics.get(METRIC_LOG_PARSE_FAILURES_TOTAL)).toBe(2);
	});

	test("flushes a complete-but-unterminated final line at a clean terminal EOF", async () => {
		// No trailing newline on the last line — a complete final write.
		const script = chunks(`${ev(ts(1), { kind: "last", payload: {} })}`);
		const { events } = await drain(run([script], probeSequence(TERMINAL)).stream);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("last");
	});
});

// --- Resume + reconnect -----------------------------------------------------

describe("streamK8sLogs — resume cursor", () => {
	test("cold resume (sinceSeq) delivers exactly the not-yet-seen remainder", async () => {
		const script = lines(
			ev(ts(1), { kind: "a", payload: {} }),
			ev(ts(2), { kind: "b", payload: {} }),
			ev(ts(3), { kind: "c", payload: {} }),
			ev(ts(4), { kind: "d", payload: {} }),
			ev(ts(5), { kind: "e", payload: {} }),
		);
		const { events } = await drain(run([script], probeSequence(TERMINAL), { sinceSeq: 2 }).stream);
		expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
		expect(events.map((e) => e.kind)).toEqual(["c", "d", "e"]);
	});

	test("the SAME lines get the SAME seqs across a fresh (cold) re-subscribe", async () => {
		const body = [
			ev(ts(1), { kind: "a", payload: {} }),
			ev(ts(2), { kind: "b", payload: {} }),
			ev(ts(3), { kind: "c", payload: {} }),
		];
		const first = await drain(run([lines(...body)], probeSequence(TERMINAL)).stream);
		expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3]);
		// Replay the identical log from a mid cursor — the survivors keep their seqs.
		const second = await drain(
			run([lines(...body)], probeSequence(TERMINAL), { sinceSeq: 1 }).stream,
		);
		expect(second.events.map((e) => e.seq)).toEqual([2, 3]);
	});

	test("a transient disconnect reconnects via sinceTime and continues the counter", async () => {
		const conn1 = linesThenDrop(
			ev(ts(1), { kind: "a", payload: {} }),
			ev(ts(2), { kind: "b", payload: {} }),
			ev(ts(3), { kind: "c", payload: {} }),
		);
		const conn2 = lines(
			ev(ts(4), { kind: "d", payload: {} }),
			ev(ts(5), { kind: "e", payload: {} }),
		);
		const { log, stream } = run([conn1, conn2], probeSequence(RUNNING, TERMINAL));
		const { events } = await drain(stream);
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
		// First follow reads from start (no sinceTime); the reconnect resumes from
		// the last delivered line's kubelet stamp.
		expect(log.calls[0]?.sinceTime).toBeUndefined();
		expect(log.calls[1]?.sinceTime).toBe(ts(3));
	});

	test("sinceTime reconnect de-dups the boundary stamp without double-counting", async () => {
		// conn1: two lines share ts(2); anchor=ts(2), skipAtAnchor=1 (one line at ts(2)).
		const conn1 = linesThenDrop(
			ev(ts(1), { kind: "a", payload: {} }),
			ev(ts(2), { kind: "b", payload: {} }),
		);
		// conn2 (sinceTime=ts(2)) re-returns the ts(2) line (already counted) + new ones.
		const conn2 = lines(
			ev(ts(2), { kind: "b", payload: {} }),
			ev(ts(3), { kind: "c", payload: {} }),
			ev(ts(4), { kind: "d", payload: {} }),
		);
		const { events } = await drain(run([conn1, conn2], probeSequence(RUNNING, TERMINAL)).stream);
		// The re-delivered ts(2) line is skipped; new lines continue 3, 4 (no dup, no reset).
		expect(events.map((e) => e.kind)).toEqual(["a", "b", "c", "d"]);
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
	});

	test("sinceTime reconnect de-dups boundary lines that share a MILLISECOND but differ in nanos (warren-245d)", async () => {
		// Two lines in the SAME wall-clock millisecond (.000) but distinct nanos —
		// kubelet emits RFC3339Nano, and the sinceTime resume is second-granularity,
		// so the reconnect re-returns BOTH. Before the fix, `tsLess`'s millisecond
		// `Date.parse` saw ts(2,100) as NEITHER less-than nor equal-to the anchor
		// ts(2,200) (equal by ms, unequal by nanosecond string), so it fell through
		// and was re-counted with a fresh seq — a duplicate event. Reproduced live
		// against k3d (3 same-ms NDJSON lines yielded 5 events instead of 3).
		const conn1 = linesThenDrop(
			ev(ts(2, 100), { kind: "a", payload: {} }),
			ev(ts(2, 200), { kind: "b", payload: {} }),
		);
		// conn2 (sinceTime=ts(2,200)) re-returns the whole second — both counted
		// lines — plus a genuinely new one at ts(3).
		const conn2 = lines(
			ev(ts(2, 100), { kind: "a", payload: {} }),
			ev(ts(2, 200), { kind: "b", payload: {} }),
			ev(ts(3), { kind: "c", payload: {} }),
		);
		const { events } = await drain(run([conn1, conn2], probeSequence(RUNNING, TERMINAL)).stream);
		expect(events.map((e) => e.kind)).toEqual(["a", "b", "c"]);
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
	});
});

// --- Termination + drain ----------------------------------------------------

describe("streamK8sLogs — termination + drain", () => {
	test("after terminal phase, drains a tail that flushed post-EOF (ordering preserved)", async () => {
		const conn1 = lines(
			ev(ts(1), { kind: "a", payload: {} }),
			ev(ts(2), { kind: "b", payload: {} }),
		);
		// The drain read (follow=false, sinceTime=ts(2)) surfaces the late tail line.
		const drainRead = lines(ev(ts(3), { kind: "tail", payload: {} }));
		const { log, stream } = run([conn1, drainRead], probeSequence(TERMINAL));
		const { events } = await drain(stream);
		expect(events.map((e) => e.kind)).toEqual(["a", "b", "tail"]);
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
		// The drain read is a NON-follow read anchored at the last stamp.
		expect(log.calls[1]?.follow).toBe(false);
		expect(log.calls[1]?.sinceTime).toBe(ts(2));
	});

	test("does not truncate: terminal is only checked AFTER a follow connection ends", async () => {
		// Even though probe reports terminal immediately, the whole first-connection
		// payload is delivered before the stream ends.
		const conn1 = lines(
			ev(ts(1), { kind: "a", payload: {} }),
			ev(ts(2), { kind: "b", payload: {} }),
			ev(ts(3), { kind: "c", payload: {} }),
		);
		const { events } = await drain(run([conn1], probeSequence(TERMINAL)).stream);
		expect(events.map((e) => e.kind)).toEqual(["a", "b", "c"]);
	});
});

// --- Lost / pod-gone --------------------------------------------------------

describe("streamK8sLogs — pod vanished", () => {
	test("a 404 on the follow mid-stream throws RuntimeRunNotFoundError after yielding", async () => {
		const conn1 = linesThen404(ev(ts(1), { kind: "a", payload: {} }));
		const { events, error } = await drain(run([conn1], probeSequence(RUNNING)).stream);
		expect(events.map((e) => e.kind)).toEqual(["a"]);
		expect(error).toBeInstanceOf(RuntimeRunNotFoundError);
	});

	test("probe reporting exists:false (pod GC'd) ends the stream as lost, not a crash", async () => {
		const conn1 = linesThenDrop(ev(ts(1), { kind: "a", payload: {} }));
		const { events, error } = await drain(run([conn1], probeSequence(GONE)).stream);
		expect(events.map((e) => e.kind)).toEqual(["a"]);
		expect(error).toBeInstanceOf(RuntimeRunNotFoundError);
	});
});

// --- Rotation ---------------------------------------------------------------

describe("streamK8sLogs — log rotation", () => {
	test("cold resume whose cursor predates retained logs emits a structured gap", async () => {
		// Only 2 lines survive but the resume cursor is 5 → the cursor rotated away.
		const script = lines(
			ev(ts(6), { kind: "x", payload: {} }),
			ev(ts(7), { kind: "y", payload: {} }),
		);
		const { events } = await drain(run([script], probeSequence(TERMINAL), { sinceSeq: 5 }).stream);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe(STREAM_GAP_KIND);
		expect(events[0]?.payload).toMatchObject({
			type: STREAM_GAP_KIND,
			reason: "cursor_predates_retained_logs",
			sinceSeq: 5,
			retainedLines: 2,
		});
		// The gap seq is placed strictly ABOVE the cursor so the domain won't dedup it.
		expect(events[0]?.seq).toBeGreaterThan(5);
	});

	test("a normal reconnect that does not re-return the boundary line emits NO gap", async () => {
		// The kubelet may resume strictly AFTER the anchor stamp (nanosecond-exact
		// sinceTime). That is the common case, NOT rotation — no false gap, no dup.
		const conn1 = linesThenDrop(
			ev(ts(1), { kind: "a", payload: {} }),
			ev(ts(2), { kind: "b", payload: {} }),
		);
		const conn2 = lines(
			ev(ts(3), { kind: "c", payload: {} }),
			ev(ts(4), { kind: "d", payload: {} }),
		);
		const { events } = await drain(run([conn1, conn2], probeSequence(RUNNING, TERMINAL)).stream);
		expect(events.map((e) => e.kind)).toEqual(["a", "b", "c", "d"]);
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
		expect(events.some((e) => e.kind === STREAM_GAP_KIND)).toBe(false);
	});
});

describe("streamK8sLogs — pending-pod reconnect noise (warren-c433)", () => {
	test("a follow ending while the pod is Pending logs quietly, not a warn", async () => {
		const warns: string[] = [];
		const infos: string[] = [];
		const logger: StreamLogger = {
			info: (_o, m) => void infos.push(m),
			warn: (_o, m) => void warns.push(m),
		};
		// First connection drops transiently while the pod is still Pending; the
		// second (default clean close) reports terminal and ends the stream. The
		// Pending disconnect must NOT warn "disconnected while pod live".
		await drain(
			streamK8sLogs({
				follow: new ScriptedLog([linesThenDrop()]).follow,
				probe: probeSequence(PENDING, TERMINAL),
				params: PARAMS,
				backoffBaseMs: 1,
				backoffMaxMs: 2,
				logger,
			}),
		);
		expect(warns.some((m) => m.includes("disconnected while pod live"))).toBe(false);
		expect(infos.some((m) => m.includes("waiting for pending pod to start"))).toBe(true);
	});
});
