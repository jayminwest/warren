import { useEffect, useState } from "react";
import { runsApi, streamRunEvents, UnauthorizedError } from "@/api/client.ts";
import { isTerminalRunState } from "@/api/types.ts";
import {
	appendRunEvent,
	type EventStreamLoopDeps,
	type EventStreamState,
	emptyStreamState,
	runEventStreamLoop,
	streamStateForRun,
} from "@/hooks/use-event-stream.helpers.ts";

/**
 * Subscribe to /runs/:id/events and accumulate the parsed NDJSON
 * envelopes. `follow=true` keeps the connection open for live tail;
 * `follow=false` replays history and closes (for terminal runs).
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
 * The reconnect policy lives in `use-event-stream.helpers.ts`; this
 * file is only the React binding.
 */
export function useEventStream(runId: string, follow: boolean): EventStreamState {
	const [state, setState] = useState<EventStreamState>(() => emptyStreamState(runId));

	useEffect(() => {
		// Isolate per run: a run-id change (without a remount) resets the
		// accumulated tail; a follow flip on the same run keeps it.
		setState((s) => streamStateForRun(s, runId));

		let cancelled = false;
		const ctrl = new AbortController();

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
			onEvent: (evt) =>
				setState((s) => {
					// Drop a stale event from a previous run's stream — the
					// aborted loop may still deliver one in-flight envelope.
					if (s.runId !== runId) return s;
					const events = appendRunEvent(s.events, evt);
					return events === s.events ? s : { ...s, events };
				}),
			onStatus: (status, error) =>
				setState((s) => (s.runId === runId ? { ...s, status, error } : s)),
		};
		void runEventStreamLoop(deps);

		return () => {
			cancelled = true;
			ctrl.abort();
		};
	}, [runId, follow]);

	return state;
}
