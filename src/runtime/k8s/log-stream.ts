/**
 * K8s pod-log → `NormalizedEvent` stream with a SYNTHESIZED per-run seq cursor
 * (pl-829f step 17 / warren-026c, design doc §5.1). This is the single biggest
 * K8s implementation burden the runtime contract calls out (§6.4): burrow
 * server-assigns a monotonic `seq`; pod logs have NO native sequence, so the
 * provider must synthesize a deterministic, resumable cursor over the log lines.
 *
 * ## The seq-synthesis scheme
 * Logs are followed with `timestamps=true` (kubelet prefixes every line with an
 * RFC3339Nano stamp) from the container's start. **`seq` is the 1-based index of
 * a physical, non-blank log line in the container's log replay.** The kubelet
 * replays a container's log deterministically from its retained head, so line N
 * (by content) sits at the same ordinal on every read — the SAME line always
 * gets the SAME seq. Malformed / non-JSON lines still consume an index (they bump
 * the counter but are dropped + counted), so a given JSON line's seq never
 * shifts because a neighbour failed to parse; the yielded seqs are monotonic but
 * may have gaps, which is all the contract requires (the domain dedups by
 * `seq <= sinceSeq`, gaps are harmless).
 *
 * ## Resume — two paths, both rotation-aware
 *   - **Transient reconnect (pod still live):** a dropped follow stream is
 *     re-opened with `sinceTime = <last line's kubelet stamp>` — a FORWARD-only
 *     resume that never re-reads the (possibly-rotated) head, so the running
 *     `seq` counter continues equal to the absolute line index. The boundary
 *     second is de-duplicated by skipping the exact number of lines already
 *     counted at that stamp (`skipAtAnchor`). This is why reconnect is immune to
 *     kubelet log rotation of the head: we only ever ask for newer lines.
 *   - **Cold re-subscribe (`opts.sinceSeq = N`):** a fresh `streamEvents` call
 *     replays from the start, re-deriving `seq` as the physical line index, and
 *     yields only lines with `seq > N` (identical to LocalProvider's client-side
 *     dedup, and to how `bridge.ts` itself dedups against its persisted max seq).
 *
 * ## Log rotation (kubelet `containerLogMaxSize`, default ~10Mi)
 * Rotation truncates the OLDEST lines. Within a live stream this is a non-issue
 * (sinceTime resume is forward-only). Across a cold re-subscribe it is only
 * *provably* detectable when the retained log holds FEWER lines than the resume
 * cursor (`observed physical lines < sinceSeq`): the cursor's line has rotated
 * away and the absolute mapping is unrecoverable from a `seq` alone. Rather than
 * silently re-number surviving lines (which would drop real tail events), the
 * stream emits a structured `stream_gap` event (kind `STREAM_GAP_KIND`) so the
 * gap is visible, then re-anchors and continues. This is the ONLY soundly
 * detectable rotation case — a live forward (`sinceTime`) reconnect is immune,
 * and timestamp adjacency is unknowable, so the stream never guesses at a
 * mid-session gap.
 *
 * Documented residual: a *partial* head rotation on a cold re-subscribe (retained
 * lines >= sinceSeq but the head still shifted) cannot be detected from `sinceSeq`
 * alone; it is mitigated operationally — kubelet's rotation size dwarfs a single
 * run's event volume, and the pod GC deletes terminal pods within 30 min so live
 * runs of normal length never rotate. A future `StreamOpts.sinceTs` anchor would
 * close it (see warren-026c discoveries).
 *
 * ## Termination + drain (step-16 discovery)
 * The pod-phase terminal signal (via the watcher / `status()`) arrives ~1-2s
 * BEFORE the final log lines flush. This stream never gates a live follow on the
 * phase — it only consults `status()` AFTER a follow connection ENDS: a clean EOF
 * means the container terminated and the kubelet already flushed the tail into
 * that stream. On a terminal observation it still performs one final non-follow
 * DRAIN read from the last anchor (belt-and-suspenders for a disconnect that
 * coincided with termination) before ending. A pod that has vanished (404 /
 * `exists:false`) mid-stream throws `RuntimeRunNotFoundError` — the seam's `lost`
 * signal — exactly as LocalProvider maps burrow's 404, never a crash.
 *
 * ## Liveness guard (warren-029d — root cause of warren-3047)
 * The reconnect loop only advances when the follow's `onDone` fires. A HALF-OPEN
 * HTTP log stream — no bytes, no FIN, no error, e.g. a silently dropped
 * LB/apiserver connection mid-stream — blocked `openAndConsume` forever, muting
 * the event bridge for the rest of the run; warren never saw the terminal
 * envelope and the run died `finalize_failed` (run_pnknyar9yw3d, 2026-07-30).
 * A per-pull `stallTimeoutMs` window bounds that blind window: ANY delivered
 * byte resets the timer; on a trip the connection is aborted and the loop falls
 * through to its normal probe — pod Running ⇒ `sinceTime` resume (the
 * seq/high-water dedup makes the resume lossless and dup-free), pod terminal ⇒
 * drain the tail and end. This mirrors the pod-watcher's `resyncPeriodMs`
 * backstop for the same silently-stalled-stream shape (warren-4f2b). A healthy
 * but quiet agent (a long silent tool call) pays one probe + forward resume per
 * window — cheap, and it never loses or duplicates an event.
 */

import type { NormalizedEvent, StreamOpts } from "../contract.ts";
import { RuntimeRunNotFoundError } from "../errors.ts";
import {
	type CursorState,
	LogConnection,
	type LogConnectionDeps,
	type StreamCounterSink,
	type StreamLogger,
} from "./log-connection.ts";
import { ChunkQueue, type QueueItem } from "./log-parse.ts";

// The sink/logger surfaces live in `./log-connection.ts`; re-export so existing
// consumers (the provider, tests) keep importing them from this module.
export type { StreamCounterSink, StreamLogger } from "./log-connection.ts";

/** The synthetic-event kind emitted when a resume cursor predates retained logs. */
export const STREAM_GAP_KIND = "stream_gap";

const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 15_000;

/**
 * Liveness window for the pod-log follow (warren-029d): when no bytes arrive
 * for this long, the stream is presumed half-open; the connection is aborted
 * and the loop probes + resumes. 5 minutes matches the pod-watcher's
 * `DEFAULT_RESYNC_PERIOD_MS` precedent for the same stalled-stream shape — long
 * enough that a healthy-but-quiet agent rarely pays a spurious reconnect, short
 * enough that warren's blindness to a dropped stream is bounded. Override via
 * `WARREN_K8S_LOG_STREAM_STALL_MS`; `0` disables.
 */
export const DEFAULT_LOG_STALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Parse `WARREN_K8S_LOG_STREAM_STALL_MS` (warren-029d): non-negative integer
 * milliseconds. `0` disables the liveness guard; absent/blank yields the
 * `DEFAULT_LOG_STALL_TIMEOUT_MS` default. Rejects non-integer / negative /
 * malformed values loudly so a typo in a deploy config fails the run's stream
 * setup rather than silently disarming the guard (mirrors the
 * `WARREN_K8S_POD_WATCHER_RESYNC_MS` resolver, warren-4f2b).
 */
export function resolveLogStallTimeoutMs(
	env: Readonly<Record<string, string | undefined>>,
): number {
	const raw = env.WARREN_K8S_LOG_STREAM_STALL_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_LOG_STALL_TIMEOUT_MS;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || String(n) !== raw.trim()) {
		throw new Error(
			`WARREN_K8S_LOG_STREAM_STALL_MS must be a non-negative integer (got ${JSON.stringify(raw)})`,
		);
	}
	return n;
}

/**
 * Sentinel the pull race resolves with — and `openAndConsume` returns — when
 * the liveness window trips. Distinct from every transport end signal (clean
 * EOF is `undefined`; failures are errors) so the pump can fall through to its
 * probe without mis-classifying the abort as a 404 or a stream error.
 */
const LOG_STALL: unique symbol = Symbol("k8s-pod-log-stall");

/** Terminal pod phases (mirrors the seam's `RunPhase` terminal set). */
const TERMINAL_PHASES = new Set(["succeeded", "failed", "cancelled"]);

/** The kubelet log-follow parameters the seam exposes (a subset of `LogOptions`). */
export interface LogFollowParams {
	readonly namespace: string;
	readonly podName: string;
	readonly containerName: string;
	/** `true` for a live tail; `false` for a bounded drain read. */
	readonly follow: boolean;
	/** Always `true` — the RFC3339Nano prefix is the resume anchor + seq witness. */
	readonly timestamps: true;
	/** RFC3339 lower bound for a forward reconnect / drain; omitted ⇒ from start. */
	readonly sinceTime?: string;
}

/** Aborts an in-flight log follow — `AbortController` satisfies this structurally. */
export interface LogFollowController {
	abort(): void;
}

/**
 * The low-level log-follow seam (mirrors `@kubernetes/client-node`'s `Log.log`):
 * open a follow at the container's log, invoking `onData(chunk)` per received
 * chunk (arbitrary byte boundaries — NOT line-aligned) and `onDone(err)` exactly
 * once when the stream ends (`err` is the failure, or `undefined`/`null` on a
 * clean server close). Resolves to a controller that aborts the stream. Injected
 * so the NDJSON parsing / seq synthesis / reconnect logic is exercised against a
 * scripted fake, matching the pod-watcher's `WatchFn` seam.
 */
export type LogFollowFn = (
	params: LogFollowParams,
	onData: (chunk: string) => void,
	onDone: (err: unknown) => void,
) => Promise<LogFollowController>;

// `StreamCounterSink` / `StreamLogger` are imported above from
// `./log-connection.ts` and re-exported below the import block.

/** Reconcile snapshot the stream consults to decide terminate-vs-reconnect. */
export interface StreamTerminalState {
	/** `false` ⇒ the pod vanished (404 / GC'd) — the stream ends with `lost`. */
	readonly exists: boolean;
	/** `true` ⇒ the pod reached a terminal phase; drain, then end the stream. */
	readonly terminal: boolean;
	/**
	 * `true` ⇒ the pod is still Pending (scheduling / image pull / init; phase
	 * `queued`). A follow that ends here is EXPECTED — no agent log to tail — so the
	 * reconnect loop logs it quietly instead of warning every backoff for the pod's
	 * whole Pending window (warren-c433). Omitted ⇒ the pre-existing live-disconnect warn.
	 */
	readonly pending?: boolean;
}

/** Probes whether the run's pod is still live / terminal (wraps `status()`). */
export type TerminalProbe = () => Promise<StreamTerminalState>;

export interface K8sLogStreamDeps {
	readonly follow: LogFollowFn;
	readonly probe: TerminalProbe;
	readonly params: Pick<LogFollowParams, "namespace" | "podName" | "containerName">;
	readonly opts?: StreamOpts;
	/** Parse-failure counter sink (`METRIC_LOG_PARSE_FAILURES_TOTAL`). */
	readonly metrics?: StreamCounterSink;
	readonly backoffBaseMs?: number;
	readonly backoffMaxMs?: number;
	/**
	 * Liveness window (ms) for a follow that delivers NO bytes (warren-029d).
	 * Default `DEFAULT_LOG_STALL_TIMEOUT_MS`; `0` disables. On a trip the
	 * connection is aborted and the loop probes: pod Running ⇒ `sinceTime`
	 * resume, pod terminal ⇒ drain + end. Any delivered byte resets the window.
	 */
	readonly stallTimeoutMs?: number;
	readonly logger?: StreamLogger;
}

/**
 * Follow a run pod's logs and yield `NormalizedEvent`s with a synthesized,
 * resumable seq cursor. Sync-returns the generator (matching
 * `RuntimeProvider.streamEvents`); the body runs lazily on first `.next()`.
 */
export function streamK8sLogs(deps: K8sLogStreamDeps): AsyncGenerator<NormalizedEvent, void, void> {
	return pump(deps);
}

async function* pump(deps: K8sLogStreamDeps): AsyncGenerator<NormalizedEvent, void, void> {
	const sinceSeq = deps.opts?.sinceSeq ?? 0;
	const state: CursorState = {
		lineSeq: 0,
		lastYieldedSeq: sinceSeq,
		anchorTs: undefined,
		skipAtAnchor: 0,
		gapEmitted: false,
	};
	let backoff = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
	const backoffMax = deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
	let firstConnection = true;

	for (;;) {
		const resumeViaSinceTime = !firstConnection && state.anchorTs !== undefined;
		const conn = new LogConnection(state, connDeps(deps), resumeViaSinceTime);
		// Stream events out as each chunk is parsed — a live `follow:true`
		// connection stays open for the pod's whole lifetime, so events MUST be
		// yielded incrementally (not batched at connection close, warren-245d).
		// The generator's RETURN value carries the connection's end error.
		const endErr = yield* openAndConsume(deps, conn, followExtra(true, resumeViaSinceTime, state));

		// A pod deleted out from under the follow (404) is the seam's `lost` signal.
		// A stall-trip abort (LOG_STALL) is NOT a transport error: fall through to
		// the probe — Running ⇒ sinceTime resume, terminal ⇒ drain + end (warren-029d).
		if (endErr !== LOG_STALL && isNotFound(endErr)) throw runNotFound(deps.params.podName);

		const gap = coldResumeGap(state, firstConnection, sinceSeq);
		if (gap !== null) yield gap;

		const term = await deps.probe();
		if (!term.exists) throw runNotFound(deps.params.podName);
		if (term.terminal) {
			// Drain any tail that flushed after this follow connection ended, then end.
			yield* drainTail(deps, state);
			return;
		}

		firstConnection = false;
		logReconnect(deps, term, backoff);
		await sleep(backoff);
		backoff = Math.min(backoff * 2, backoffMax);
	}
}

/**
 * Log a live-follow disconnect before backing off to reconnect. A Pending pod's
 * disconnect is EXPECTED (info); a live-pod disconnect warns as before (warren-c433).
 * Split out so `pump` stays under the complexity ratchet.
 */
function logReconnect(deps: K8sLogStreamDeps, term: StreamTerminalState, backoff: number): void {
	const b = { podName: deps.params.podName, backoffMs: backoff };
	if (term.pending === true) {
		deps.logger?.info?.(b, "pod-log follow waiting for pending pod to start; backing off");
		return;
	}
	deps.logger?.warn?.(b, "pod-log follow disconnected while pod live; backing off before resume");
}

/**
 * The cold-resume rotation gap, or `null`. Fires only on the FIRST connection of
 * a resumed stream when the retained log held FEWER physical lines than the
 * resume cursor — the cursor's line has rotated away and re-numbering survivors
 * would silently drop tail events. This is the only SOUNDLY detectable rotation
 * case: a mid-session forward (`sinceTime`) resume is immune (it only asks for
 * newer lines), and timestamp adjacency is unknowable, so we never guess.
 */
function coldResumeGap(
	state: CursorState,
	firstConnection: boolean,
	sinceSeq: number,
): NormalizedEvent | null {
	if (!firstConnection || sinceSeq <= 0 || state.gapEmitted || state.lineSeq >= sinceSeq) {
		return null;
	}
	return emitGap(state, "cursor_predates_retained_logs", {
		sinceSeq,
		retainedLines: state.lineSeq,
	});
}

/** Project the pump's deps onto the narrow slice a `LogConnection` needs. */
function connDeps(deps: K8sLogStreamDeps): LogConnectionDeps {
	return {
		podName: deps.params.podName,
		...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
		...(deps.logger !== undefined ? { logger: deps.logger } : {}),
	};
}

/** Build the `{ follow, sinceTime? }` extra for a connection open. */
function followExtra(
	follow: boolean,
	resumeViaSinceTime: boolean,
	state: CursorState,
): { follow: boolean; sinceTime?: string } {
	return {
		follow,
		...(resumeViaSinceTime && state.anchorTs !== undefined ? { sinceTime: state.anchorTs } : {}),
	};
}

/**
 * One final NON-follow read from the last anchor after a terminal observation.
 * Captures a tail that flushed between the follow's end and termination; usually
 * a no-op because a clean follow EOF already carried the flushed tail.
 */
async function* drainTail(
	deps: K8sLogStreamDeps,
	state: CursorState,
): AsyncGenerator<NormalizedEvent> {
	const resumeViaSinceTime = state.anchorTs !== undefined;
	const conn = new LogConnection(state, connDeps(deps), resumeViaSinceTime);
	// Non-follow read: the connection ends on its own (EOF); its end error is
	// intentionally ignored — a 404 on the drain read means the pod was GC'd right
	// at termination, and the events we already yielded stand (terminal seen).
	yield* openAndConsume(deps, conn, followExtra(false, resumeViaSinceTime, state));
}

/**
 * Open a follow/drain connection and pull its chunks through the line parser,
 * YIELDING each parsed event as it arrives — a live `follow:true` connection
 * stays open for the pod's lifetime, so events must stream out incrementally
 * rather than be batched at close (warren-245d). Buffers partial lines across
 * chunk boundaries; on a clean EOF flushes a trailing newline-less line (a
 * complete final write), on a transient error discards it (the reconnect
 * re-reads it in full). The generator's RETURN value is the connection's end
 * error (`undefined` on a clean EOF), which the caller classifies.
 */
async function* openAndConsume(
	deps: K8sLogStreamDeps,
	conn: LogConnection,
	extra: { follow: boolean; sinceTime?: string },
): AsyncGenerator<NormalizedEvent, unknown, void> {
	const queue = new ChunkQueue();
	const controller = await openFollow(deps, extra, queue);
	const stallMs = deps.stallTimeoutMs ?? DEFAULT_LOG_STALL_TIMEOUT_MS;
	try {
		for (;;) {
			const item = await pullNext(queue, stallMs);
			if (item === LOG_STALL) {
				// Half-open stream (no bytes, no FIN, no error): abort and let the
				// pump's probe decide resume-vs-drain (warren-029d). The `finally`
				// aborts the controller; buffered-but-unpulled chunks are re-read by
				// the resume (seq/high-water dedup keeps that lossless + dup-free).
				deps.logger?.warn?.(
					{ podName: deps.params.podName, stallTimeoutMs: stallMs, follow: extra.follow },
					"pod-log stream delivered no bytes within the liveness window; aborting to force a resume",
				);
				return LOG_STALL;
			}
			if (!item.done) {
				yield* conn.consume(item.chunk);
				continue;
			}
			// Clean EOF ⇒ flush a complete-but-unterminated final line; a transient
			// error discards the partial (the reconnect re-reads it in full).
			if (item.err === undefined || item.err === null) {
				yield* conn.flush();
			}
			return item.err;
		}
	} finally {
		// Teardown must never throw out of this finally — an escaped AbortError
		// here crashed the control plane on GKE (warren-4e36). The production
		// follower swallows its own abort noise (log-follow.ts), but guard the
		// seam too so no `LogFollowFn` impl can take down the pump.
		try {
			controller?.abort();
		} catch {
			// expected teardown noise; the stream is already ending
		}
	}
}

/**
 * Pull the next queue item, resolving `LOG_STALL` when no chunk / end signal
 * arrives within `stallMs` — the half-open case (warren-029d). A FRESH timer
 * per pull means any delivered byte resets the window; `stallMs <= 0` disables
 * the guard entirely. On a trip the orphaned `queue.pull()` resolves later
 * (abort → `finish` → wake) with no consumer — harmless. A REJECTED pull
 * resolves `LOG_STALL` and recovers through the same stall path (abort →
 * probe → resume), never a fatal unhandled rejection (warren-9a4a).
 */
function pullNext(queue: ChunkQueue, stallMs: number): Promise<QueueItem | typeof LOG_STALL> {
	if (stallMs <= 0) return queue.pull();
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(LOG_STALL), stallMs);
		const done = (item: QueueItem | typeof LOG_STALL): void => {
			clearTimeout(timer);
			resolve(item);
		};
		void queue.pull().then(done, () => done(LOG_STALL));
	});
}

/** Open a follow connection and route its chunks / end signal into `queue`. */
async function openFollow(
	deps: K8sLogStreamDeps,
	extra: { follow: boolean; sinceTime?: string },
	queue: ChunkQueue,
): Promise<LogFollowController | undefined> {
	const params: LogFollowParams = {
		namespace: deps.params.namespace,
		podName: deps.params.podName,
		containerName: deps.params.containerName,
		follow: extra.follow,
		timestamps: true,
		...(extra.sinceTime !== undefined ? { sinceTime: extra.sinceTime } : {}),
	};
	try {
		return await deps.follow(
			params,
			(chunk) => queue.push(chunk),
			(err) => queue.finish(err),
		);
	} catch (err) {
		queue.finish(err);
		return undefined;
	}
}

/**
 * Emit a structured gap event, reserving the next monotonic seq slot for it.
 * The slot is placed strictly ABOVE the resume high-water mark (`lastYieldedSeq`,
 * which is `>= sinceSeq`), not merely above the physical line count — otherwise a
 * cold-resume gap (where far fewer lines survived than the cursor) would land at
 * a seq the domain has already persisted and be dedup'd away.
 */
function emitGap(
	state: CursorState,
	reason: string,
	details: Record<string, unknown>,
): NormalizedEvent {
	state.gapEmitted = true;
	const seq = Math.max(state.lineSeq, state.lastYieldedSeq) + 1;
	state.lineSeq = seq;
	state.lastYieldedSeq = seq;
	return {
		seq,
		ts: new Date().toISOString(),
		kind: STREAM_GAP_KIND,
		stream: "system",
		payload: { type: STREAM_GAP_KIND, reason, ...details },
	};
}

/** Is `phase` (the seam's `RunPhase`) terminal? */
export function isTerminalPhase(phase: string): boolean {
	return TERMINAL_PHASES.has(phase);
}

function isNotFound(err: unknown): boolean {
	if (err === undefined || err === null) return false;
	const code = (err as { code?: unknown; statusCode?: unknown }).code;
	const statusCode = (err as { statusCode?: unknown }).statusCode;
	if (code === 404 || statusCode === 404) return true;
	const msg = err instanceof Error ? err.message : String(err);
	return /\b404\b/.test(msg) || /not ?found/i.test(msg);
}

function runNotFound(podName: string): RuntimeRunNotFoundError {
	return new RuntimeRunNotFoundError(`pod ${podName} no longer exists (log follow 404)`, {
		recoveryHint: "the pod was deleted / GC'd; reconcile the warren run row as lost.",
	});
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}
