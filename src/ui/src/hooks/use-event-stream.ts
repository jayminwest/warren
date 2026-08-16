import { useEffect, useState } from "react";
import { runsApi, streamRunEvents, UnauthorizedError } from "@/api/client.ts";
import { isTerminalRunState, type RunEvent } from "@/api/types.ts";
import {
	type EventStreamLoopDeps,
	runEventStreamLoop,
	type StreamStatus,
} from "@/hooks/use-event-stream.helpers.ts";

interface State {
	events: RunEvent[];
	status: StreamStatus;
	error: string | null;
}

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
export function useEventStream(runId: string, follow: boolean): State {
	const [state, setState] = useState<State>({
		events: [],
		status: "connecting",
		error: null,
	});

	useEffect(() => {
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
			onEvent: (evt) => setState((s) => ({ ...s, events: [...s.events, evt] })),
			onStatus: (status, error) => setState((s) => ({ ...s, status, error })),
		};
		void runEventStreamLoop(deps);

		return () => {
			cancelled = true;
			ctrl.abort();
		};
	}, [runId, follow]);

	return state;
}
