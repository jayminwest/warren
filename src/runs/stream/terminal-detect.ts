/**
 * Runtime-terminal envelope detection (warren-a69a, warren-2687,
 * warren-36c0). Pure functions — given a single `RunEvent`, classify
 * whether it represents the runtime's terminal lifecycle envelope.
 *
 * Two roles:
 *   - `detectRuntimeTerminal` returns the warren-side outcome to reap
 *     with (or `null`) and powers the bridge's "break on terminal" loop.
 *   - `isPiAgentEnd` distinguishes pi's `agent_end` envelope for the
 *     piStats out-of-band snapshot branch — both shapes ride the same
 *     state_change/system carrier, but only pi's `agent_end` should
 *     trigger the pi-specific terminal snapshot.
 */

import { extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import type { RunTerminalState } from "../../db/schema.ts";
import type { StreamEventView } from "./types.ts";

/**
 * Inspect a burrow event for a runtime-terminal shape (warren-a69a,
 * warren-2687).
 * Returns the warren-side outcome to reap with, or `null` if the event
 * doesn't carry a terminal signal.
 *
 * Two runtime terminal shapes ride the same `kind=state_change`,
 * `stream=system` carrier:
 *
 *   - claude-code: burrow's jsonl-claude parser emits `payload.type ===
 *     "result"`. The `is_error` field distinguishes a clean exit from a
 *     crash; `is_error: true` → `failed`, anything else → `succeeded`.
 *   - pi: burrow's pi parser emits `payload.type === "agent_end"` as the
 *     final lifecycle envelope. `stopReason === "error"` or a non-empty
 *     `errorMessage` → `failed` (warren-1ac2 / pl-5516); absent both,
 *     → `succeeded`. Zero-token / empty-content alone is NOT a failure
 *     signal — a legitimate noop run shares that shape.
 *
 * burrow's own cancel path emits a different terminal shape; that case
 * is handled by `cancelRun`. Future runtimes extend this dispatch by
 * adding their runtime-specific terminal shape.
 *
 * ## Provenance gate (warren-6646)
 * `kind`/`stream` are open strings that ride the same transport the
 * agent's own output does, so an event that the parse boundary could
 * not attribute to warren's event pipeline (`origin === "agent"`) is
 * refused outright — otherwise an agent printing a crafted
 * `state_change`/`system` line reaps its own run as `succeeded` and
 * short-circuits real outcome detection. The K8s parse boundary already
 * downgrades such a line's stream (`src/runtime/k8s/log-parse.ts`); the
 * provenance gate now lives in the shared extractor
 * (`src/core/event-envelope.ts`, warren-27b5), the domain-side lock on
 * the same door.
 */
export function detectRuntimeTerminal(event: StreamEventView): RunTerminalState | null {
	const env = extractAgentEventEnvelope(event);
	if (env === null) return null;
	if (env.type === "result") return env.payload.is_error === true ? "failed" : "succeeded";
	if (env.type === "agent_end") {
		const err = env.errorMessage;
		const failed = env.stopReason === "error" || (typeof err === "string" && err.length > 0);
		return failed ? "failed" : "succeeded";
	}
	return null;
}

/**
 * Match pi's `agent_end` terminal envelope (warren-36c0). Burrow's pi parser
 * (burrow `src/runtime/parsers/pi.ts`) maps every pi lifecycle line to a
 * RunEvent with `kind="state_change"`, `stream="system"`, and the original
 * envelope shoved into `payload` — so `event.kind === "agent_end"` never
 * matches on real pi runs. The piStats snapshot branch (bridgeRunStream)
 * checks this predicate to fire the terminal `get_session_stats` fetch
 * before the bridge breaks on terminal detection. Distinct from
 * `detectRuntimeTerminal`, which also accepts claude-code's `result`
 * envelope — piStats is a pi-only concern.
 */
export function isPiAgentEnd(event: StreamEventView): boolean {
	return extractAgentEventEnvelope(event)?.type === "agent_end";
}
