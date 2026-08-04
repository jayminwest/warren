/**
 * The normalizer: maps warren's wire facts into audit facts.
 *
 * Input is what an HTTP observer can actually see — the per-run NDJSON
 * event stream plus the run-list row — NOT the in-process `warren-ext/v1`
 * bus vocabulary. FRICTION §1: the bus hooks (`run_dispatched`,
 * `run_started`, `branch_pushed`, `post_reap`) never cross the process
 * boundary, so three of the six audit event types are SYNTHESIZED:
 *
 *   - `run.dispatched` — the run's first sighting (list row or first
 *     event). The wire carries no dispatch fact and no dispatch timestamp.
 *   - `run.started` — the first observed event for the run. The bridge's
 *     queued → running claim edge is bus-only; the first persisted event
 *     is its wire-visible shadow.
 *   - `run.terminal` — the run-list state turning terminal, or a
 *     `reap.completed` event carrying a terminal `state` (whichever the
 *     observer sees first; the store's dedupe key makes them conflict).
 *
 * The remaining three map from system events the reap/steer pipelines
 * persist on the run's stream:
 *
 *   - `branch.pushed` ← `reap.completed` with `payload.branchPushed === true`
 *   - `pr.opened`     ← `reap.pr_opened`
 *   - `run.steered`   ← `steer.sent`
 *
 * FRICTION §3: no lifecycle payload carries an actor KIND, so every fact
 * records `actorKind: "unknown"` until warren-3754 lands. `steer.sent`
 * alone carries `fromActor` (an identity, not a kind); it is preserved in
 * the detail, not promoted.
 *
 * This module is pure: storage and dedupe live in `audit-store.ts`, and
 * the clock is injected by the caller (plan risk 6 — golden fixtures
 * normalize `at` at write time, never post-process).
 */

import {
	RUN_TERMINAL_STATES,
	type RunEvent,
	type RunListRow,
	isTerminalRunState,
} from "./wire.ts";

/** The audit event vocabulary this extension emits. */
export const AUDIT_EVENT_TYPES = [
	"run.dispatched",
	"run.started",
	"run.terminal",
	"branch.pushed",
	"pr.opened",
	"run.steered",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** FRICTION §3: the only honest value until actor kind lands on the wire. */
export const ACTOR_KIND_UNKNOWN = "unknown";

/** One normalized audit fact, before storage assigns its append-only id. */
export interface AuditFact {
	readonly runId: string;
	readonly event: AuditEventType;
	/** ISO timestamp — the source event's `ts`, or the injected clock for sightings. */
	readonly at: string;
	readonly actorKind: string;
	/** Kind-specific detail object, or null when the source carried nothing useful. */
	readonly detail: Readonly<Record<string, unknown>> | null;
	/**
	 * Wire `seq` the fact was derived from, or null for synthesized
	 * sightings. Part of the store's dedupe key: replaying the same wire
	 * event reproduces the same key and is an exact no-op.
	 */
	readonly sourceSeq: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** Build a detail object from the named payload fields, dropping absent ones. */
function pick(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const detail: Record<string, unknown> = {};
	for (const key of keys) {
		const value = payload[key];
		if (value !== undefined) detail[key] = value;
	}
	return detail;
}

function fact(
	runId: string,
	event: AuditEventType,
	at: string,
	sourceSeq: number | null,
	detail: Record<string, unknown> | null,
): AuditFact {
	return {
		runId,
		event,
		at,
		actorKind: ACTOR_KIND_UNKNOWN,
		detail,
		sourceSeq,
	};
}

export interface FromEventOptions {
	/** Store sets this when the run has no `run.dispatched` fact yet. */
	readonly includeDispatched: boolean;
	/** Store sets this when the run has no `run.started` fact yet. */
	readonly includeStarted: boolean;
}

/**
 * Map one wire event to zero or more audit facts. Unknown kinds map to
 * nothing — the audit log records lifecycle facts, not a mirror of the
 * stream (tool calls, messages, and telemetry stay out).
 */
export function factsFromEvent(event: RunEvent, opts: FromEventOptions): AuditFact[] {
	const facts: AuditFact[] = [];
	if (opts.includeDispatched) {
		facts.push(fact(event.runId, "run.dispatched", event.ts, null, null));
	}
	if (opts.includeStarted) {
		facts.push(fact(event.runId, "run.started", event.ts, event.seq, null));
	}

	const payload = asRecord(event.payload);
	switch (event.kind) {
		case "steer.sent":
			facts.push(
				fact(
					event.runId,
					"run.steered",
					event.ts,
					event.seq,
					payload === null
						? null
						: pick(payload, ["messageId", "priority", "fromActor", "body"]),
				),
			);
			break;
		case "reap.pr_opened":
			facts.push(
				fact(
					event.runId,
					"pr.opened",
					event.ts,
					event.seq,
					payload === null
						? null
						: pick(payload, ["prUrl", "mode", "branch", "baseBranch"]),
				),
			);
			break;
		case "reap.completed": {
			if (payload === null) break;
			const state = payload.state;
			if (typeof state === "string" && (RUN_TERMINAL_STATES as readonly string[]).includes(state)) {
				facts.push(
					fact(event.runId, "run.terminal", event.ts, null, { state, source: "reap.completed" }),
				);
			}
			if (payload.branchPushed === true) {
				facts.push(
					fact(
						event.runId,
						"branch.pushed",
						event.ts,
						event.seq,
						pick(payload, ["commitsAhead", "state"]),
					),
				);
			}
			break;
		}
		default:
			break;
	}
	return facts;
}

/**
 * Map a run-list sighting to audit facts. Always candidates
 * `run.dispatched` (the store dedupes) and, once the list state is
 * terminal, `run.terminal` — the catch-all for runs whose terminal marker
 * event was never tailed (e.g. the collector was down past the reap).
 * `at` is the injected clock: the list row carries no transition
 * timestamp (FRICTION §1).
 */
export function factsFromRun(run: RunListRow, now: Date): AuditFact[] {
	const at = now.toISOString();
	const facts: AuditFact[] = [fact(run.id, "run.dispatched", at, null, null)];
	if (isTerminalRunState(run.state)) {
		facts.push(fact(run.id, "run.terminal", at, null, { state: run.state, source: "run-list" }));
	}
	return facts;
}
