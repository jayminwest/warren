/**
 * Canonical agent event-envelope extractor (warren-27b5 / pl-882c step 5;
 * AgentRuntimeAdapter phase-1 item 10).
 *
 * Every agent-payload consumer used to re-implement the same prelude:
 * gate on `kind === "state_change"` and `stream === "system"`, narrow
 * `payload` to an object, read `payload.type`, and (in one of three
 * places) apply the `origin === "agent"` provenance gate (warren-6646).
 * The three copies disagreed — two lacked the provenance gate and two
 * missed the nested `message.stopReason` / `message.errorMessage`
 * fallback — so the envelope read now lives here, once, and the domain
 * parsers (`src/runs/stream/terminal-detect.ts`,
 * `src/runs/usage-aggregate.ts`, `src/runs/reap/provider-error.ts`)
 * consume it.
 *
 * Reconciled read (the provider-error superset, applied to all):
 *
 *   - provenance gate: `origin === "agent"` refuses the envelope
 *     outright. `kind`/`stream` are open strings riding the same
 *     transport the agent's own output does, so an unattributed line
 *     must never carry terminal/usage authority — otherwise an agent
 *     printing a crafted `state_change`/`system` line reaps its own
 *     run. Absent `origin` reads as trusted: burrow's `RunEvent`
 *     predates the tag and arrives over a host-side channel.
 *   - carrier gate: `kind === "state_change"` and `stream === "system"`.
 *   - `payload` must be a non-null object with a string `type`.
 *   - `stopReason` / `errorMessage` are read top-level first (agent_end's
 *     shape) with a nested `message.*` fallback (turn_end / message_end's
 *     shape — see burrow's
 *     `__golden__/pi-v0.78.1-anthropic-success.jsonl`). `undefined`
 *     means the envelope carries no such field at all.
 *
 * `src/core/` imports nothing (check:layers), so this module is
 * dependency-free and structural: `StreamEventView`, `NormalizedEvent`,
 * event rows, and burrow's `RunEvent` all satisfy `EventEnvelopeInput`
 * without adapters.
 */

/**
 * Structural subset every event source shares. `origin` is optional
 * because burrow's `RunEvent` and the persisted events table predate
 * the provenance tag — absent reads as warren-authored (trusted).
 */
export interface EventEnvelopeInput {
	readonly kind: string;
	readonly stream: string | null;
	readonly origin?: string;
	readonly payload: unknown;
}

/**
 * A trusted, carrier-matched agent envelope. `trusted` is always `true`
 * on a returned envelope — the provenance gate is folded in here, once,
 * so consumers never re-check `origin`.
 */
export interface AgentEventEnvelope {
	/** Always `true` — the envelope passed the provenance gate. */
	readonly trusted: true;
	/** `payload.type` (e.g. `"result"`, `"agent_end"`, `"turn_end"`). */
	readonly type: string;
	/** The narrowed payload object, for envelope-specific fields. */
	readonly payload: Record<string, unknown>;
	/** Top-level `stopReason`, else nested `message.stopReason`, else `undefined`. */
	readonly stopReason: unknown;
	/** Top-level `errorMessage`, else nested `message.errorMessage`, else `undefined`. */
	readonly errorMessage: unknown;
}

/**
 * True when the parse boundary tagged this event as an unattributed,
 * agent-writable line (warren-6646). Such lines never carry terminal or
 * usage authority.
 */
export function isAgentAuthoredEvent(event: EventEnvelopeInput): boolean {
	return event.origin === "agent";
}

/**
 * Read a field top-level first, then from the nested `message` object.
 * Returns `undefined` when the envelope carries the field nowhere.
 */
function readWithMessageFallback(env: Record<string, unknown>, key: string): unknown {
	if (env[key] !== undefined) return env[key];
	const message = env.message;
	if (message !== null && typeof message === "object") {
		const v = (message as Record<string, unknown>)[key];
		if (v !== undefined) return v;
	}
	return undefined;
}

/**
 * Extract the trusted agent envelope from a raw event, or return `null`
 * when the event fails any gate: agent-authored provenance, wrong
 * carrier (`kind`/`stream`), non-object payload, or missing string
 * `payload.type`.
 */
export function extractAgentEventEnvelope(event: EventEnvelopeInput): AgentEventEnvelope | null {
	if (isAgentAuthoredEvent(event)) return null;
	if (event.kind !== "state_change") return null;
	if (event.stream !== "system") return null;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return null;
	const env = payload as Record<string, unknown>;
	if (typeof env.type !== "string") return null;
	return {
		trusted: true,
		type: env.type,
		payload: env,
		stopReason: readWithMessageFallback(env, "stopReason"),
		errorMessage: readWithMessageFallback(env, "errorMessage"),
	};
}
