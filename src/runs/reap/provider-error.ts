/**
 * Terminal provider-error detection (warren-edc3).
 *
 * When an agent's final model turn ends with a hard provider error —
 * `stopReason === "error"` plus a non-empty `errorMessage` (e.g. Anthropic
 * `400` "Your credit balance is too low to access the Anthropic API") —
 * burrow still observes the agent process exiting 0 and marks the run
 * `succeeded`. warren's in-stream terminal detect
 * (`src/runs/stream/terminal-detect.ts`, warren-e281 / pl-5516) keys off
 * the `agent_end` envelope, so it misses the case where the error signal
 * rides the per-turn `turn_end` envelope instead (a different pi error
 * path than the 529 `overloaded_error` case warren-e281 fixed). The run
 * then reaps `succeeded`: a bookkeeping-only PR ships, the seed closes,
 * the plan-run advances, and the agent's uncommitted edits are discarded
 * by `reap.workspace_destroyed`.
 *
 * This module is reap's safety net: after the run is terminal, scan the
 * persisted event log for the terminal error turn and surface its
 * provider message so `reapRun` can flip an otherwise-`succeeded` run to
 * `failed` (`failure_reason: "provider_error"`). The signal is explicit
 * and unambiguous — `stopReason === "error"` + non-empty `errorMessage` —
 * so it fails exactly the hard-error runs without punishing legitimate
 * no-op-code runs that end on a normal `end_turn`/`stop`.
 *
 * Pure (no DB): `classifyTerminalProviderError` takes an iterable of
 * event rows so it unit-tests without a database; the thin async wrapper
 * `detectTerminalProviderError` mirrors `inferFailureReason`'s
 * `(repos, runId)` shape for the reap call site.
 */

import type { Repos } from "../../db/repos/index.ts";

/** Structural event shape the classifier consumes (subset of `EventRow`). */
export interface ProviderErrorEventInput {
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

/** A detected terminal provider error + the provider's message. */
export interface ProviderErrorSignal {
	readonly message: string;
}

/**
 * Read `stopReason` from a pi envelope, accepting either the top-level
 * field (agent_end's shape, warren-e281) or the nested `message.stopReason`
 * (turn_end / message_end's shape — see burrow's
 * `__golden__/pi-v0.78.1-anthropic-success.jsonl`). Returns `undefined`
 * when the envelope carries no stop reason at all (e.g. a success
 * `agent_end` that only has `messages`) so the caller can leave the
 * running verdict untouched instead of clearing a prior error turn.
 */
function readStopReason(env: Record<string, unknown>): unknown {
	if (env.stopReason !== undefined) return env.stopReason;
	const message = env.message;
	if (message !== null && typeof message === "object") {
		const v = (message as Record<string, unknown>).stopReason;
		if (v !== undefined) return v;
	}
	return undefined;
}

/**
 * Read `errorMessage` from a pi envelope, accepting either the top-level
 * field (agent_end) or the nested `message.errorMessage` (turn_end).
 * Returns `undefined` when absent.
 */
function readErrorMessage(env: Record<string, unknown>): unknown {
	if (env.errorMessage !== undefined) return env.errorMessage;
	const message = env.message;
	if (message !== null && typeof message === "object") {
		const v = (message as Record<string, unknown>).errorMessage;
		if (v !== undefined) return v;
	}
	return undefined;
}

/**
 * Verdict for a single `turn_end` / `agent_end` envelope:
 *   - `error`  — the hard-error signal (stopReason=error + non-empty errorMessage)
 *   - `clear`  — a non-error stopReason; a later successful turn that overrides
 *                an earlier error turn.
 *   - `ignore` — no stopReason on this envelope (e.g. a success `agent_end`
 *                carrying only `messages`); leaves the running verdict untouched.
 */
type EnvelopeVerdict =
	| { readonly kind: "error"; readonly message: string }
	| { readonly kind: "clear" }
	| { readonly kind: "ignore" };

function classifyEnvelope(env: Record<string, unknown>): EnvelopeVerdict {
	const type = env.type;
	if (type !== "turn_end" && type !== "agent_end") return { kind: "ignore" };
	const stopReason = readStopReason(env);
	if (stopReason === undefined) return { kind: "ignore" };
	const errorMessage = readErrorMessage(env);
	if (stopReason === "error" && typeof errorMessage === "string" && errorMessage.length > 0) {
		return { kind: "error", message: errorMessage };
	}
	return { kind: "clear" };
}

/**
 * Classify a run's persisted event stream for a terminal provider error.
 *
 * Walks the events in order (callers pass `listByRun`, which is
 * ascending by `burrow_event_seq`). For each `state_change`/`system`
 * event whose payload is pi's `turn_end` or `agent_end` lifecycle
 * envelope, the **last** envelope that carries a `stopReason` wins:
 *
 *   - `stopReason === "error"` + non-empty `errorMessage` → record the
 *     provider message as the terminal error.
 *   - any other `stopReason` (e.g. `stop` / `end_turn`) → clear: a later
 *     successful turn means the run did NOT end on the error.
 *   - envelope with no `stopReason` at all (e.g. a success `agent_end`
 *     carrying only `messages`) → ignored, so it can't mask an earlier
 *     error turn that was the real terminal.
 *
 * "Last stopReason-carrying envelope wins" is what makes the detection
 * terminal-aware: a transient error that pi retried and then succeeded
 * has a later `turn_end` with `stopReason: "stop"`, so it does NOT trip
 * the net — only a run whose final model activity was the error turn
 * fails. Both `turn_end` (per-turn terminal) and `agent_end` (run
 * terminal) are inspected so the net catches the error signal whichever
 * envelope pi attaches it to for a given provider error path.
 *
 * Defensive: malformed envelopes never throw — worst case is "we don't
 * detect the error", same posture as the usage aggregators.
 */
export function classifyTerminalProviderError(
	events: Iterable<ProviderErrorEventInput>,
): ProviderErrorSignal | null {
	let terminal: ProviderErrorSignal | null = null;
	for (const event of events) {
		if (event.kind !== "state_change" || event.stream !== "system") continue;
		const payload = event.payload;
		if (payload === null || typeof payload !== "object") continue;
		const verdict = classifyEnvelope(payload as Record<string, unknown>);
		if (verdict.kind === "ignore") continue;
		terminal = verdict.kind === "error" ? { message: verdict.message } : null;
	}
	return terminal;
}

/**
 * Scan a run's persisted events for a terminal provider error. Returns
 * the provider message (or `null`) so `reapRun` can override an
 * otherwise-`succeeded` outcome to `failed` / `provider_error`.
 */
export async function detectTerminalProviderError(
	repos: Repos,
	runId: string,
): Promise<ProviderErrorSignal | null> {
	const events = await repos.events.listByRun(runId);
	return classifyTerminalProviderError(
		events.map((e) => ({ kind: e.kind, stream: e.stream, payload: e.payloadJson })),
	);
}
