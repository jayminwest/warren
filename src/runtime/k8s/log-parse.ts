/**
 * Pure line-parsing helpers + the chunk-pull adapter for the K8s pod-log stream
 * (pl-829f step 17 / warren-026c). Split out of `log-stream.ts` to keep that
 * module — where the seq synthesis, resume, and reconnect control-flow live —
 * under the file-size ratchet. Everything here is side-effect-free and
 * independently unit-testable (no cluster, no clock beyond `Date`).
 */

import { EVENT_STREAMS, type EventOrigin } from "../../core/wire.ts";
import type { NormalizedEvent } from "../contract.ts";

/**
 * The provenance marker `./agent-io.ts`'s `formatEventLine` stamps onto every
 * envelope warren's in-pod event pipeline authors (warren-6646). Its ABSENCE is
 * the signal that matters: a line that reached the pod log without going through
 * that emitter — e.g. an agent writing NDJSON straight at the entrypoint's stdout
 * fd — is classified `"agent"` and loses system-stream authority here, at the
 * parse boundary, before any consumer can read a terminal envelope off it.
 */
export const WARREN_ORIGIN_MARKER = "warren";

/**
 * Split a `timestamps=true` log line into its kubelet RFC3339 stamp + content.
 * A line that does not lead with a stamp (timestamps somehow absent, or agent
 * output that already contained a leading space) yields `kubeletTs: null` and the
 * whole line as content — defensive, never throws.
 */
export function splitTimestamp(line: string): { kubeletTs: string | null; content: string } {
	const sp = line.indexOf(" ");
	if (sp <= 0) return { kubeletTs: null, content: line };
	const maybe = line.slice(0, sp);
	return isRfc3339(maybe)
		? { kubeletTs: maybe, content: line.slice(sp + 1) }
		: { kubeletTs: null, content: line };
}

/** Cheap RFC3339(Nano) shape check — a date, a `T`, and a zone marker. */
function isRfc3339(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
}

/**
 * `a < b` on RFC3339(Nano) stamps at FULL nanosecond precision (defensive
 * lower-bound guard). `Date.parse` truncates to milliseconds, but kubelet emits
 * nanosecond stamps (`…588100297Z`); the resume-boundary dedup (`log-stream.ts`)
 * pairs this with a nanosecond-EXACT string equality check, so a millisecond
 * comparison here leaves lines that share the anchor's millisecond but differ in
 * sub-millisecond nanos classified as neither "less" (skip-before) nor "equal"
 * (skip-at-anchor) — they fall through and get re-counted with a fresh seq on
 * every reconnect / terminal drain, duplicating events whenever ≥2 log lines land
 * in the anchor's millisecond (warren-245d). Comparing at nanosecond precision
 * keeps the two checks on the same granularity so the dedup stays exact.
 */
export function tsLess(a: string, b: string): boolean {
	const na = epochNanos(a);
	const nb = epochNanos(b);
	if (na === null || nb === null) return false;
	return na < nb;
}

/**
 * Parse an RFC3339(Nano) stamp into whole epoch-nanoseconds. The whole-second
 * part is parsed via `Date.parse` (which handles the `Z`/offset zone) after the
 * fractional group is stripped; the fractional digits are right-padded/truncated
 * to exactly 9 to form the nanosecond remainder. `null` on an unparseable stamp.
 */
function epochNanos(ts: string): bigint | null {
	const frac = ts.match(/\.(\d+)/);
	const nanosStr = frac?.[1] !== undefined ? frac[1].padEnd(9, "0").slice(0, 9) : "000000000";
	const wholeMs = Date.parse(ts.replace(/\.\d+/, ""));
	if (Number.isNaN(wholeMs)) return null;
	return BigInt(Math.trunc(wholeMs / 1000)) * 1_000_000_000n + BigInt(nanosStr);
}

/** Parse a log line's JSON content; `null` on any malformed / non-object line. */
export function tryParse(content: string): Record<string, unknown> | null {
	const trimmed = content.trim();
	if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
	try {
		const value: unknown = JSON.parse(trimmed);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
		return value as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Re-shape a parsed NDJSON envelope onto the seam's `NormalizedEvent` (payload
 * LOSSLESS, §6.6). Mirrors LocalProvider's `normalizeEvent`: an envelope with a
 * top-level `payload` carries it through verbatim; a bare JSON object rides
 * wholesale as the payload so nothing is dropped. `ts` prefers the envelope's own
 * stamp (the agent's event time) and falls back to the kubelet line stamp.
 *
 * ## Provenance (warren-6646)
 * `kind` is an OPEN string taken from the line, and the pod log is a transport
 * the agent's own process tree can reach. So the envelope's SELF-DECLARED
 * `stream: "system"` is only honored when the line also carries warren's origin
 * marker (stamped by the in-pod entrypoint's emitter, `./agent-io.ts`). An
 * unattributed line is tagged `origin: "agent"` and its system claim is
 * downgraded to `"stdout"` — it still rides the stream verbatim, it just cannot
 * pose as the runtime's terminal envelope and reap its own run as succeeded.
 */
export function toNormalizedEvent(
	envelope: Record<string, unknown>,
	seq: number,
	kubeletTs: string | null,
): NormalizedEvent {
	const payload = "payload" in envelope ? envelope.payload : envelope;
	const origin = normalizeOrigin(envelope.origin);
	return {
		seq,
		ts: pickTs(envelope.ts, kubeletTs),
		kind: typeof envelope.kind === "string" ? envelope.kind : "log",
		stream: normalizeStream(envelope.stream, origin),
		origin,
		payload,
	};
}

/**
 * Classify a log line's provenance. Only the exact marker warren's own emitter
 * writes yields `"warren"`; everything else (absent, malformed, or a value the
 * agent invented) is `"agent"`.
 */
function normalizeOrigin(value: unknown): EventOrigin {
	return value === WARREN_ORIGIN_MARKER ? "warren" : "agent";
}

function pickTs(envelopeTs: unknown, kubeletTs: string | null): string {
	if (typeof envelopeTs === "string" && envelopeTs.length > 0) return envelopeTs;
	if (kubeletTs !== null) return kubeletTs;
	return new Date().toISOString();
}

/**
 * Coerce an envelope's `stream` tag onto the canonical `EVENT_STREAMS`
 * (`src/core/wire.ts`) or `null` — warren-7b7a removed the local copy of the tag
 * list — then apply the provenance rule (warren-6646): `"system"` is warren's
 * own authority tag, so an `"agent"`-origin line claiming it is downgraded to
 * `"stdout"` rather than dropped.
 */
function normalizeStream(value: unknown, origin: EventOrigin): NormalizedEvent["stream"] {
	if (typeof value !== "string" || !(EVENT_STREAMS as readonly string[]).includes(value)) {
		return null;
	}
	if (value === "system" && origin !== "warren") return "stdout";
	return value as NormalizedEvent["stream"];
}

/** One pulled item from the chunk queue: a chunk, or the terminal end signal. */
export type QueueItem = { done: false; chunk: string } | { done: true; err: unknown };

/**
 * A push→pull adapter over the callback-shaped `LogFollowFn`: `onData` pushes,
 * `onDone` finishes, and the consumer `pull()`s one chunk (or the terminal
 * signal) at a time. Chunks that arrive before a `pull()` are buffered, so a
 * follow that dumps its whole payload synchronously on open loses nothing.
 */
export class ChunkQueue {
	private readonly chunks: string[] = [];
	private done = false;
	private endErr: unknown = undefined;
	private waiter: (() => void) | undefined;

	push(chunk: string): void {
		this.chunks.push(chunk);
		this.wake();
	}

	finish(err: unknown): void {
		if (this.done) return;
		this.done = true;
		this.endErr = err;
		this.wake();
	}

	private wake(): void {
		const w = this.waiter;
		this.waiter = undefined;
		w?.();
	}

	async pull(): Promise<QueueItem> {
		for (;;) {
			const chunk = this.chunks.shift();
			if (chunk !== undefined) return { done: false, chunk };
			if (this.done) return { done: true, err: this.endErr };
			await new Promise<void>((resolve) => {
				this.waiter = resolve;
			});
		}
	}
}
