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

import type { RunEvent } from "@os-eco/burrow-cli";
import type { RunTerminalState } from "../../db/schema.ts";

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
 */
export function detectRuntimeTerminal(event: RunEvent): RunTerminalState | null {
	if (event.kind !== "state_change") return null;
	if (event.stream !== "system") return null;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return null;
	const env = payload as Record<string, unknown>;
	if (env.type === "result") return env.is_error === true ? "failed" : "succeeded";
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
export function isPiAgentEnd(event: RunEvent): boolean {
	if (event.kind !== "state_change") return false;
	if (event.stream !== "system") return false;
	const payload = event.payload;
	if (payload === null || typeof payload !== "object") return false;
	const env = payload as Record<string, unknown>;
	return env.type === "agent_end";
}
