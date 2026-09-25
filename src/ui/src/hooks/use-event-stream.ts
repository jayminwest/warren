import { useEffect, useRef, useState } from "react";
import { runsApi, streamRunEvents, UnauthorizedError } from "@/api/client.ts";
import { isTerminalRunState, type RunEvent } from "@/api/types.ts";
import {
	appendEvents,
	createFrameBatcher,
	EMPTY_EVENT_BUFFER,
	type EventBuffer,
} from "@/hooks/use-event-stream.helpers.buffer.ts";
import {
	type EventStreamLoopDeps,
	runEventStreamLoop,
	type StreamStatus,
} from "@/hooks/use-event-stream.helpers.ts";

interface State {
	/** Seq-ordered, deduped, bounded to the newest EVENT_BUFFER_MAX. */
	events: RunEvent[];
	/** Older events dropped to hold the ceiling (0 for most runs). */
	trimmed: number;
	status: StreamStatus;
	error: string | null;
}

const INITIAL: State = { ...EMPTY_EVENT_BUFFER, status: "connecting", error: null };

const FRAME_DEPS = {
	requestFrame: (cb: () => void) => window.requestAnimationFrame(cb),
	cancelFrame: (id: number) => window.cancelAnimationFrame(id),
	setTimer: (cb: () => void, ms: number) => window.setTimeout(cb, ms),
	clearTimer: (id: number) => window.clearTimeout(id),
};

/**
 * Subscribe to /runs/:id/events and accumulate the parsed NDJSON
 * envelopes. `follow=true` keeps the connection open for live tail;
 * `follow=false` replays history and closes (for terminal runs).
 *
 * Events arriving in the same animation frame land in one state update
 * (warren-4a47), and the buffer stays sorted, deduped by seq, and bounded
 * (`use-event-stream.helpers.buffer.ts`), so a long run costs one concat
 * per frame instead of one full-array copy per event.
 *
 * Auto-reconnects with exponential backoff (max 30s) on transport
 * errors when following, and ALSO on a clean close while the run is
 * still non-terminal: the server's per-connection lifetime cap
 * (`WARREN_EVENT_STREAM_MAX_LIFETIME`, warren-3995) ends the stream
 * cleanly, which is indistinguishable on the wire from the broker
 * closing on run termination, so the loop re-reads the run state to
 * tell them apart and resumes via `since` on the former.
 * UnauthorizedError aborts permanently so the auth gate can boot the
 * user back to login.
 *
 * `follow` is read when the subscription opens, not tracked: a live tail
 * ends by itself when the run does, so a run turning terminal must not
 * tear the stream down and replay the whole history. `enabled: false`
 * holds the connection until the caller knows which mode it wants.
 */
export function useEventStream(runId: string, follow: boolean, enabled = true): State {
	const [state, setState] = useState<State>(INITIAL);
	const followRef = useRef(follow);
	followRef.current = follow;

	useEffect(() => {
		if (!enabled) return;
		const follow = followRef.current;
		let cancelled = false;
		const ctrl = new AbortController();
		setState(INITIAL);

		const batcher = createFrameBatcher<RunEvent>((batch) => {
			setState((s) => {
				const prev: EventBuffer = { events: s.events, trimmed: s.trimmed };
				const next = appendEvents(prev, batch);
				return next === prev ? s : { ...s, events: next.events, trimmed: next.trimmed };
			});
		}, FRAME_DEPS);

		const deps: EventStreamLoopDeps = {
			follow,
			isCancelled: () => cancelled || ctrl.signal.aborted,
			openStream: (sinceSeq) =>
				streamRunEvents(runId, {
					follow,
					signal: ctrl.signal,
					...(sinceSeq !== undefined ? { sinceSeq } : {}),
				}),
			hasRunEnded: async () => {
				try {
					const run = await runsApi.get(runId, ctrl.signal);
					return isTerminalRunState(run.state);
				} catch {
					// A failed state read must not kill the tail — reconnect
					// and let the stream's own error path surface any real
					// problem.
					return false;
				}
			},
			isAuthError: (err) => err instanceof UnauthorizedError,
			onEvent: batcher.push,
			onStatus: (status, error) => {
				// Deliver buffered lines before the status flips, so "ended"
				// never renders ahead of the events that preceded it.
				batcher.flush();
				setState((s) => (s.status === status && s.error === error ? s : { ...s, status, error }));
			},
		};
		void runEventStreamLoop(deps);

		return () => {
			cancelled = true;
			ctrl.abort();
			batcher.cancel();
		};
	}, [runId, enabled]);

	return state;
}
