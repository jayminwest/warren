import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ApiError, streamLifecycleEvents, UnauthorizedError } from "@/api/client.ts";
import { runEventStreamLoop } from "@/hooks/use-event-stream.helpers.ts";

/**
 * Global lifecycle stream → query invalidation (warren-f566, GH #847).
 *
 * The list pages used to poll their endpoints every 5s per open tab,
 * which dominated request volume and drove instance egress ~20x. Now a
 * single held-open `GET /events/stream` connection per tab receives
 * slim `{runId, hook, state, ts}` notifications and debounce-invalidates
 * the list query keys; the pages keep a slow 45s fallback poll for the
 * gaps (public mode, where the operator-gated stream refuses, and any
 * notification dropped across a reconnect — the server holds no replay).
 *
 * Reconnect policy is the shared `runEventStreamLoop` backoff
 * (500ms → 30s): a clean close while `follow` is on retries forever,
 * which is exactly the GCLB `timeoutSec: 3600` hourly cut, and an auth
 * refusal (401, or the 403 a public spectator gets on this
 * operator-gated route) stops permanently so the fallback poll is the
 * only traffic that client generates.
 *
 * One connection per tab, enforced by a module-level refcount so the
 * bridge component can be mounted in more than one place (or under
 * StrictMode's double-effect) without doubling the stream.
 */

/** Debounce between a notification and the invalidation burst. */
export const LIFECYCLE_INVALIDATE_DEBOUNCE_MS = 750;

let mountedBridges = 0;

export function useLifecycleStreamInvalidation(): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		mountedBridges += 1;
		if (mountedBridges > 1) {
			return () => {
				mountedBridges -= 1;
			};
		}

		const ctrl = new AbortController();
		let cancelled = false;
		let debounce: number | undefined;

		const invalidateLists = (): void => {
			if (debounce !== undefined) return;
			debounce = window.setTimeout(() => {
				debounce = undefined;
				void queryClient.invalidateQueries({ queryKey: ["runs"] });
				void queryClient.invalidateQueries({ queryKey: ["plan-runs"] });
			}, LIFECYCLE_INVALIDATE_DEBOUNCE_MS);
		};

		void runEventStreamLoop({
			follow: true,
			isCancelled: () => cancelled || ctrl.signal.aborted,
			openStream: () => streamLifecycleEvents({ signal: ctrl.signal }),
			// No replay surface on the server — reconnects re-open without a
			// `since` cursor and the fallback poll covers the gap.
			seqOf: () => undefined,
			// The global stream has no terminal end state — a clean close is
			// always the lifetime cap (or LB cut), so always reconnect.
			hasRunEnded: async () => false,
			isAuthError: (err) =>
				err instanceof UnauthorizedError || (err instanceof ApiError && err.status === 403),
			onEvent: invalidateLists,
			onStatus: () => {},
		});

		return () => {
			mountedBridges -= 1;
			cancelled = true;
			ctrl.abort();
			if (debounce !== undefined) window.clearTimeout(debounce);
		};
	}, [queryClient]);
}
