import type { RunEvent, RunRow } from "@/api/types.ts";
import { formatElapsedMs } from "@/pages/runs/runs-format.ts";

/**
 * Stage durations for the run-detail phase rail (warren-935a). Each
 * segment spans two consecutive lifecycle edges, so the five segments
 * tile the run's full span and their sum equals `totalMs`:
 *
 *   queue+prep   created          -> workspace_ready_at
 *   agent boot   workspace_ready  -> agent_ready_at
 *   agent run    agent_ready      -> agent_ended_at
 *   reap         agent_ended      -> reaped_at
 *   delivery     reaped_at        -> the `reap.pr_opened` event ts
 *
 * `totalMs` spans created -> the final delivery boundary (the
 * `reap.pr_opened` event ts when present, else ended_at).
 *
 * Rows written before warren-7116 added the four stage columns carry
 * null there; each edge falls back to the event stream (and then to the
 * row's startedAt/endedAt) so legacy rows still render real spans. A
 * segment with an unobservable endpoint is null — rendered as the
 * pending/fallback label, never fabricated as zero.
 */

export interface StageDurations {
	queuePrepMs: number | null;
	agentBootMs: number | null;
	agentRunMs: number | null;
	reapMs: number | null;
	deliveryMs: number | null;
	totalMs: number | null;
}

const REAP_KINDS = new Set(["reap.completed", "reap_failed", "reap.orphaned"]);
const PR_OPENED_KINDS = new Set(["reap.pr_opened"]);
const AGENT_START_KINDS = new Set(["agent_start"]);

/** Latest event ts for a kind, else null. Shared with phase-rail-logic. */
export function lastEventTsOf(events: RunEvent[], kinds: ReadonlySet<string>): string | null {
	let ts: string | null = null;
	for (const e of events) {
		if (kinds.has(e.kind)) ts = e.ts;
	}
	return ts;
}

/**
 * Latest ts of a state_change event whose pi envelope type matches
 * (warren-57fb): the pi adapter collapses the harness's `agent_start`
 * lifecycle envelope to `state_change` on `system` with the raw type
 * preserved in `payload.type`, so `agent_start` as a kind never appears
 * on the wire.
 */
export function lastStateChangeTypeTs(events: RunEvent[], type: string): string | null {
	let ts: string | null = null;
	for (const e of events) {
		if (e.kind !== "state_change") continue;
		const p = e.payload;
		if (
			p !== null &&
			typeof p === "object" &&
			!Array.isArray(p) &&
			(p as Record<string, unknown>).type === type
		) {
			ts = e.ts;
		}
	}
	return ts;
}

function tsMs(iso: string | null): number | null {
	if (iso === null) return null;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}

function msBetween(startMs: number | null, endMs: number | null): number | null {
	if (startMs === null || endMs === null || endMs < startMs) return null;
	return endMs - startMs;
}

export function deriveStageDurations(run: RunRow, events: RunEvent[]): StageDurations {
	const createdMs = run.createdAt ?? tsMs(run.startedAt);
	// The workspace-ready edge: column, then the agent_start signals, then startedAt.
	const wsReadyMs =
		tsMs(run.workspaceReadyAt) ??
		tsMs(lastEventTsOf(events, AGENT_START_KINDS)) ??
		tsMs(lastStateChangeTypeTs(events, "agent_start")) ??
		tsMs(run.startedAt);
	const agentReadyMs = tsMs(run.agentReadyAt) ?? tsMs(run.startedAt);
	const agentEndedMs = tsMs(run.agentEndedAt) ?? tsMs(run.endedAt);
	const reapedMs = tsMs(run.reapedAt) ?? tsMs(lastEventTsOf(events, REAP_KINDS));
	const deliveryEndMs = tsMs(lastEventTsOf(events, PR_OPENED_KINDS)) ?? tsMs(run.endedAt);

	return {
		queuePrepMs: msBetween(createdMs, wsReadyMs),
		agentBootMs: msBetween(wsReadyMs, agentReadyMs),
		agentRunMs: msBetween(agentReadyMs, agentEndedMs),
		reapMs: msBetween(agentEndedMs, reapedMs),
		deliveryMs: msBetween(reapedMs, deliveryEndMs),
		totalMs: msBetween(createdMs, deliveryEndMs),
	};
}

/**
 * Page-header elapsed for run detail (warren-935a): created -> ended so
 * the figure matches the phase rail's total span. Falls back to
 * startedAt for rows without the epoch-ms createdAt, and ticks against
 * `now` while the run is live. `now` is REQUIRED (warren-b610).
 */
export function formatRunElapsed(run: RunRow, now: number): string {
	const startMs = run.createdAt ?? tsMs(run.startedAt);
	if (startMs === null) return "—";
	const endMs = tsMs(run.endedAt) ?? now;
	if (endMs < startMs) return "—";
	return formatElapsedMs(endMs - startMs);
}
