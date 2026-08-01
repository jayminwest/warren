/**
 * Per-connection line assembler + seq synthesizer for the K8s pod-log stream
 * (pl-829f step 17 / warren-026c). Split out of `./log-stream.ts` so the pump
 * module stays under the file-size ratchet after the warren-029d liveness
 * guard landed; the seq-synthesis scheme itself is documented in
 * `./log-stream.ts`'s module header. This module owns the mechanics of ONE
 * connection: buffering partial lines across chunk boundaries, assigning each
 * physical non-blank line its absolute 1-based index, de-duplicating the
 * `sinceTime` resume boundary, and mutating the shared `CursorState` so the
 * absolute line index survives across reconnects.
 */

import type { NormalizedEvent } from "../contract.ts";
import { splitTimestamp, toNormalizedEvent, tryParse, tsLess } from "./log-parse.ts";
import { METRIC_LOG_PARSE_FAILURES_TOTAL } from "./pod-metrics.ts";

/** Minimal counter surface for the parse-failure metric — satisfied by `MetricsRegistry`. */
export interface StreamCounterSink {
	increment(name: string, labels?: Readonly<Record<string, string>>, by?: number): void;
}

/** Minimal structured-logger surface the pump logs backoff/parse warnings through. */
export interface StreamLogger {
	info?: (obj: unknown, msg: string) => void;
	warn?: (obj: unknown, msg: string) => void;
}

/** Mutable cursor state carried across reconnects within one `streamEvents` call. */
export interface CursorState {
	/** Absolute physical-line index of the most recently PROCESSED (counted) line. */
	lineSeq: number;
	/** High-water mark of the last YIELDED seq (dedup floor for cold resume). */
	lastYieldedSeq: number;
	/** Kubelet stamp of the most recently counted line — the reconnect anchor. */
	anchorTs: string | undefined;
	/** Count of counted lines whose stamp == `anchorTs` (skip-count on resume). */
	skipAtAnchor: number;
	/** Emitted-gap guard so a persistent rotation only signals once. */
	gapEmitted: boolean;
}

/** The narrow slice of the pump's deps a connection needs. */
export interface LogConnectionDeps {
	readonly podName: string;
	readonly metrics?: StreamCounterSink;
	readonly logger?: StreamLogger;
}

/**
 * One follow/drain connection's line assembler + seq synthesizer. Owns the
 * partial-line buffer and the sinceTime resume-boundary dedup; mutates the
 * shared `CursorState` so the absolute line index survives across reconnects.
 */
export class LogConnection {
	private partial = "";
	/** Anchor captured at connection start — fixed for the resume-skip window. */
	private readonly resumeAnchorTs: string | undefined;
	private readonly resumeSkipCount: number;
	private skipped = 0;

	constructor(
		private readonly state: CursorState,
		private readonly deps: LogConnectionDeps,
		private readonly resumeViaSinceTime: boolean,
	) {
		this.resumeAnchorTs = state.anchorTs;
		this.resumeSkipCount = state.skipAtAnchor;
	}

	*consume(chunk: string): Generator<NormalizedEvent> {
		this.partial += chunk;
		let nl = this.partial.indexOf("\n");
		while (nl >= 0) {
			const raw = this.partial.slice(0, nl);
			this.partial = this.partial.slice(nl + 1);
			yield* this.processLine(raw);
			nl = this.partial.indexOf("\n");
		}
	}

	/** Flush a trailing newline-less line at a clean EOF (a complete final write). */
	*flush(): Generator<NormalizedEvent> {
		const rest = this.partial;
		this.partial = "";
		if (rest.length > 0) yield* this.processLine(rest);
	}

	private *processLine(raw: string): Generator<NormalizedEvent> {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const { kubeletTs, content } = splitTimestamp(line);
		if (content.trim() === "") return; // blank log line — no seq slot

		// sinceTime resume-boundary dedup: skip the exact lines already counted at
		// the anchor stamp, without advancing the counter (they are not new). The
		// kubelet may or may not re-return the boundary-stamp line (sinceTime is
		// inclusive but nanosecond-exact); either way this converges — an
		// unreturned anchor just skips zero, a re-returned one skips `skipAtAnchor`.
		if (this.resumeViaSinceTime && this.resumeAnchorTs !== undefined) {
			if (kubeletTs !== null && tsLess(kubeletTs, this.resumeAnchorTs)) return;
			if (
				kubeletTs !== null &&
				kubeletTs === this.resumeAnchorTs &&
				this.skipped < this.resumeSkipCount
			) {
				this.skipped += 1;
				return;
			}
		}

		// A NEW physical line: it occupies the next absolute index.
		this.state.lineSeq += 1;
		const seq = this.state.lineSeq;
		this.advanceAnchor(kubeletTs);

		// Cold-resume dedup floor: skip lines at/below the persisted cursor.
		if (seq <= this.state.lastYieldedSeq) return;

		const envelope = tryParse(content);
		if (envelope === null) {
			this.deps.metrics?.increment(METRIC_LOG_PARSE_FAILURES_TOTAL);
			this.deps.logger?.warn?.(
				{ podName: this.deps.podName, seq },
				"dropped a non-JSON pod-log line",
			);
			return; // dropped — the index slot is a gap, seq stays stable
		}
		this.state.lastYieldedSeq = seq;
		yield toNormalizedEvent(envelope, seq, kubeletTs);
	}

	/** Advance the shared anchor + same-stamp skip count as new lines are counted. */
	private advanceAnchor(kubeletTs: string | null): void {
		if (kubeletTs === null) return; // keep the last real stamp as the anchor
		if (kubeletTs === this.state.anchorTs) {
			this.state.skipAtAnchor += 1;
		} else {
			this.state.anchorTs = kubeletTs;
			this.state.skipAtAnchor = 1;
		}
	}
}
