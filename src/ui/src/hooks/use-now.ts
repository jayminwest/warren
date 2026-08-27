import { useEffect, useState } from "react";

/**
 * A shared wall-clock tick (warren-b610): re-renders the caller every
 * `intervalMs` so elapsed-time figures stay live without a refetch.
 *
 * `enabled: false` stops the interval entirely — a terminal-only list
 * must not re-render on a timer. Re-enabling re-syncs `now` first so a
 * stale value never flashes. The pattern is the one operations.tsx
 * pioneered (NOW_TICK_MS), extracted so every inventory page shares it.
 */
export function useNow(intervalMs: number, enabled = true): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		setNow(Date.now());
		const t = window.setInterval(() => setNow(Date.now()), intervalMs);
		return () => window.clearInterval(t);
	}, [intervalMs, enabled]);
	return now;
}
