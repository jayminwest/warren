import type { RunEvent } from "../api/types.ts";

export type StreamStatus = "idle" | "connecting" | "live" | "ended" | "error";

/**
 * Everything the stream loop needs from its React host, injected so the
 * loop itself is a pure async function the tests can drive with the same
 * streaming-fetch stub harness as `src/ui/src/api/client.stream.test.ts`.
 */
export interface EventStreamLoopDeps<T = RunEvent> {
	/** Open the NDJSON stream; `sinceSeq` resumes after a reconnect. */
	readonly openStream: (sinceSeq: number | undefined) => AsyncIterable<T>;
	/**
	 * Resume cursor for `openStream` (warren-f566). Defaults to the
	 * per-run `RunEvent.seq`. A stream with no replay surface (the global
	 * lifecycle stream) passes `() => undefined`, so reconnects re-open
	 * without a `since`.
	 */
	readonly seqOf?: (evt: T) => number | undefined;
	/**
	 * Fresh read of whether the run has reached a terminal state. This is
	 * the discriminator between a genuine end-of-stream (the broker
	 * closed because the run finished) and a server-initiated lifetime
	 * close (`WARREN_EVENT_STREAM_MAX_LIFETIME`, warren-3995): both look
	 * like a clean close on the wire, so the loop asks here. A failed
	 * read answers `false` — reconnecting is the safe default.
	 */
	readonly hasRunEnded: () => Promise<boolean>;
	readonly follow: boolean;
	readonly isCancelled: () => boolean;
	readonly onEvent: (evt: T) => void;
	readonly onStatus: (status: StreamStatus, error: string | null) => void;
	readonly isAuthError: (err: unknown) => boolean;
	/** Overridable in tests; defaults to a real timer. */
	readonly sleep?: (ms: number) => Promise<void>;
}

export const STREAM_RECONNECT_BASE_BACKOFF_MS = 500;
export const STREAM_RECONNECT_MAX_BACKOFF_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The reconnect loop behind `useEventStream`. Extracted so the resume-on-
 * clean-close policy (warren-3995) is unit-testable without a DOM:
 *
 *   - transport error while following  → backoff, resume with sinceSeq
 *   - clean close, `follow=false`      → "ended" (replay-only mode)
 *   - clean close, run is terminal     → "ended" (genuine end-of-stream)
 *   - clean close, run still active    → backoff, resume with sinceSeq
 *     (the server's lifetime cap expired; the run is still going)
 *   - auth error                       → "error", no retry
 */
export async function runEventStreamLoop<T = RunEvent>(
	deps: EventStreamLoopDeps<T>,
): Promise<void> {
	const sleep = deps.sleep ?? defaultSleep;
	let backoff = STREAM_RECONNECT_BASE_BACKOFF_MS;
	let lastSeq: number | null = null;

	while (!deps.isCancelled()) {
		const result: AttachResult = await attachOnce(deps, lastSeq);
		lastSeq = result.lastSeq;
		if (result.action === "stop") return;
		if (result.action === "ended") {
			deps.onStatus("ended", null);
			return;
		}
		// A successful connection resets the backoff; a failed one grows it.
		backoff = result.connected ? STREAM_RECONNECT_BASE_BACKOFF_MS : backoff;
		await sleep(backoff);
		backoff = Math.min(backoff * 2, STREAM_RECONNECT_MAX_BACKOFF_MS);
	}
}

type AttachResult =
	| { readonly action: "stop"; readonly lastSeq: number | null }
	| { readonly action: "ended"; readonly lastSeq: number | null }
	| { readonly action: "retry"; readonly connected: boolean; readonly lastSeq: number | null };

/**
 * One connection attempt: stream until close, error, or cancellation, then
 * classify what the loop should do next. Split out of `runEventStreamLoop`
 * to keep both under the cognitive-complexity ceiling.
 */
async function attachOnce<T>(
	deps: EventStreamLoopDeps<T>,
	lastSeq: number | null,
): Promise<AttachResult> {
	const seqOf = deps.seqOf ?? ((evt: T) => (evt as unknown as RunEvent).seq);
	deps.onStatus("connecting", null);
	try {
		const iter = deps.openStream(lastSeq === null ? undefined : lastSeq + 1);
		deps.onStatus("live", null);
		for await (const evt of iter) {
			if (deps.isCancelled()) return { action: "stop", lastSeq };
			lastSeq = seqOf(evt) ?? lastSeq;
			deps.onEvent(evt);
		}
		if (deps.isCancelled()) return { action: "stop", lastSeq };
		// The stream closed cleanly. Without a run-state check this is
		// ambiguous: the broker closes on run termination, and the lifetime
		// cap closes on expiry — identical on the wire.
		if (!deps.follow || (await deps.hasRunEnded())) return { action: "ended", lastSeq };
		return { action: "retry", connected: true, lastSeq };
	} catch (err) {
		if (deps.isCancelled()) return { action: "stop", lastSeq };
		deps.onStatus("error", errorMessage(err));
		if (deps.isAuthError(err) || !deps.follow) return { action: "stop", lastSeq };
		return { action: "retry", connected: false, lastSeq };
	}
}
