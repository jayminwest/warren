import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { RunEvent } from "@/api/types.ts";

/**
 * Stream-driven refresh of the run row (warren-7d17). The run's own
 * event stream is already open, so the page re-reads `GET /runs/:id`
 * when an event says the row moved, instead of polling every 3s:
 *
 *   - "now"  — lifecycle facts (agent start/end, reap steps, cancel,
 *              preview flips): refetch after a short debounce;
 *   - "soon" — a turn finished, so tokens and cost moved: refetch at
 *              most every SOON_MS, which keeps Spend live without a
 *              request per turn.
 *
 * The old trigger set refetched on every `state_change`, which for the
 * pi adapter is four events per tool call. The page keeps a slow
 * fallback poll for anything the stream misses.
 */

export type RefreshUrgency = "now" | "soon" | null;

export const NOW_DEBOUNCE_MS = 400;
export const SOON_MS = 10_000;

const NOW_KINDS: ReadonlySet<string> = new Set([
	"agent_start",
	"agent_end",
	"cancel.requested",
	"reap_failed",
	"preview_launched",
	"preview_evicted",
	"preview_torn_down",
	"bridge_stalled",
	"bridge_recovered",
]);

const NOW_STATE_TYPES: ReadonlySet<string> = new Set(["agent_start", "agent_end", "result"]);

function payloadField(evt: RunEvent, key: string): unknown {
	const p = evt.payload;
	if (p === null || typeof p !== "object" || Array.isArray(p)) return undefined;
	return (p as Record<string, unknown>)[key];
}

export function refreshUrgency(evt: RunEvent): RefreshUrgency {
	if (NOW_KINDS.has(evt.kind) || evt.kind.startsWith("reap.")) return "now";
	if (evt.kind !== "state_change") return null;
	const type = payloadField(evt, "type");
	if (typeof type === "string" && NOW_STATE_TYPES.has(type)) return "now";
	if (typeof payloadField(evt, "state") === "string") return "now";
	return type === "turn_end" ? "soon" : null;
}

/** The most urgent refresh among events newer than `afterSeq` (buffer is seq-ordered). */
export function urgencySince(events: readonly RunEvent[], afterSeq: number): RefreshUrgency {
	let out: RefreshUrgency = null;
	for (let i = events.length - 1; i >= 0; i--) {
		const evt = events[i];
		if (evt === undefined || evt.seq <= afterSeq) break;
		const u = refreshUrgency(evt);
		if (u === "now") return "now";
		if (u === "soon") out = "soon";
	}
	return out;
}

export function useRunRefreshOnEvents(runId: string, events: readonly RunEvent[]): void {
	const qc = useQueryClient();
	const lastSeq = useRef(Number.POSITIVE_INFINITY);
	const timer = useRef<number | null>(null);
	const lastSoon = useRef(0);

	// A new run id starts a fresh stream; the first batch is history the
	// row already reflects, so it only sets the cursor.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runId resets the cursor
	useEffect(() => {
		lastSeq.current = Number.POSITIVE_INFINITY;
	}, [runId]);

	useEffect(() => {
		const tail = events[events.length - 1];
		if (tail === undefined) return;
		const since = lastSeq.current;
		lastSeq.current = tail.seq;
		if (since === Number.POSITIVE_INFINITY) return;
		const urgency = urgencySince(events, since);
		if (urgency === null) return;
		const nowMs = Date.now();
		if (urgency === "soon" && nowMs - lastSoon.current < SOON_MS) return;
		if (urgency === "soon") lastSoon.current = nowMs;
		if (timer.current !== null) return;
		timer.current = window.setTimeout(() => {
			timer.current = null;
			void qc.invalidateQueries({ queryKey: ["runs", runId], exact: true });
		}, NOW_DEBOUNCE_MS);
	}, [events, runId, qc]);

	useEffect(
		() => () => {
			if (timer.current !== null) window.clearTimeout(timer.current);
		},
		[],
	);
}
