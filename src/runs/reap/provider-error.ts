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

import { type AgentEventEnvelope, extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import type { Repos } from "../../db/repos/index.ts";
import { instanceEnvSecretPattern, scrubSecrets } from "../../observability/event-scrub.ts";
import { providerErrorEnvelopeTypes } from "../../runtime/adapters/index.ts";

/** Structural event shape the classifier consumes (subset of `EventRow`). */
export interface ProviderErrorEventInput {
	readonly kind: string;
	readonly stream: string | null;
	/**
	 * Parse-boundary provenance (warren-6646). Optional — the persisted
	 * events table predates the tag; absent reads as warren-authored.
	 * Fed into the shared envelope extractor's provenance gate
	 * (warren-27b5).
	 */
	readonly origin?: string;
	readonly payload: unknown;
}

/**
 * A detected terminal provider error, enriched warren-side (warren-4001).
 *
 * The pi harness's terminal `errorMessage` is often the opaque literal
 * "Provider returned error" — the harness swallows the upstream HTTP
 * status and error body before warren ever sees them. What IS available
 * warren-side is threaded through here so the `reap.provider_error`
 * event names the failing provider/model/status instead of forcing an
 * operator to hand-call the provider's APIs (the pl-61a4 postmortem):
 *
 *   - `provider` / `model` — read off the error envelope's assistant
 *     `message` (pi stamps them on every assistant message); the reap
 *     call site falls back to the run row's declared provider/model.
 *   - `httpStatus` — parsed out of the error text when the harness did
 *     include one ("Request failed with status code 529", an Anthropic
 *     400 body, …).
 *   - `upstreamBody` — when the error text embeds the provider's JSON
 *     error body (the Anthropic `{\"type\":\"error\",…}` shape), the body
 *     is lifted out verbatim so the payload carries it as a field.
 *
 * Every free-text field is redacted (warren-cbd8 rules, via
 * `src/observability/event-scrub.ts`) and truncated to
 * {@link PROVIDER_ERROR_TEXT_CAP} BEFORE it is stored — the upstream
 * body is exactly where a provider echoes request headers back.
 */
export interface ProviderErrorSignal {
	/** The human-readable message: redacted, truncated, and context-enriched. */
	readonly message: string;
	/** Provider id off the error envelope (e.g. `"openrouter"`), else `null`. */
	readonly provider: string | null;
	/** Model id off the error envelope (e.g. `"anthropic/claude-haiku-4-5"`), else `null`. */
	readonly model: string | null;
	/** Upstream HTTP status when the error text carries one, else `null`. */
	readonly httpStatus: number | null;
	/** The upstream error body (redacted + truncated) when embedded, else `null`. */
	readonly upstreamBody: string | null;
}

/** The `reap.provider_error` event payload for a detected signal (warren-4001). */
export function providerErrorEventPayload(signal: ProviderErrorSignal): Record<string, unknown> {
	return {
		message: signal.message,
		provider: signal.provider,
		model: signal.model,
		httpStatus: signal.httpStatus,
		upstreamBody: signal.upstreamBody,
	};
}

/**
 * Sane cap for any free-text field stored on the `reap.provider_error`
 * payload (warren-4001). An upstream body can quote a whole request; the
 * event log is not the place for it.
 */
export const PROVIDER_ERROR_TEXT_CAP = 2000;

/** Suffix marking a truncated field, so a reader knows text was cut. */
const TRUNCATED_SUFFIX = "…[truncated]";

/** Opaque harness messages that carry zero diagnostic content of their own. */
const OPAQUE_MESSAGE = /^(?:provider returned error|unknown error|error)\.?$/i;

/** A 4xx/5xx status code standing alone in the error text. */
const HTTP_STATUS_PATTERN = /\b([45]\d{2})\b/;

/** Options for the redaction pass applied before anything is stored. */
export interface ProviderErrorClassifyOptions {
	/**
	 * This instance's env-secret matcher (`buildEnvSecretPattern`).
	 * Defaults to the memoized instance pattern; tests pass `null` (shape
	 * redaction only) or a hand-built pattern.
	 */
	readonly envPattern?: RegExp | null;
	/**
	 * The run row's declared provider/model (warren-2ede), used when the
	 * error envelope itself stamps neither — the opaque-message context
	 * suffix and the signal's fields both fall back to these.
	 */
	readonly fallbackProvider?: string | null;
	readonly fallbackModel?: string | null;
}

/** Redact + truncate one free-text field. Never throws. */
function sanitizeProviderText(text: string, envPattern: RegExp | null): string {
	const scrubbed = scrubSecrets(text, envPattern);
	const clean = typeof scrubbed === "string" ? scrubbed : text;
	return clean.length > PROVIDER_ERROR_TEXT_CAP
		? `${clean.slice(0, PROVIDER_ERROR_TEXT_CAP)}${TRUNCATED_SUFFIX}`
		: clean;
}

/** Read a string field top-level first, then off the nested `message`. */
function readStringField(env: AgentEventEnvelope, key: string): string | null {
	const top = env.payload[key];
	if (typeof top === "string" && top.length > 0) return top;
	const message = env.payload.message;
	if (message !== null && typeof message === "object") {
		const nested = (message as Record<string, unknown>)[key];
		if (typeof nested === "string" && nested.length > 0) return nested;
	}
	return null;
}

/**
 * Lift an embedded upstream JSON error body out of the error text. Pi
 * stringifies the provider's response body into `errorMessage` on some
 * error paths (the Anthropic `{\"type\":\"error\",\"error\":{…}}` shape).
 * Returns the body substring (from the first `{`) when it parses as an
 * object, plus the body's own `error.message` when present — that inner
 * message is the human-readable line the enriched `message` prefers.
 */
function extractUpstreamBody(raw: string): { body: string; innerMessage: string | null } | null {
	const start = raw.indexOf("{");
	if (start < 0) return null;
	const candidate = raw.slice(start);
	try {
		const parsed: unknown = JSON.parse(candidate);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const err = (parsed as Record<string, unknown>).error;
		const inner =
			err !== null && typeof err === "object"
				? (err as Record<string, unknown>).message
				: undefined;
		return {
			body: candidate,
			innerMessage: typeof inner === "string" && inner.length > 0 ? inner : null,
		};
	} catch {
		return null;
	}
}

/**
 * Build the enriched signal from the raw harness message + envelope
 * context. Prefers the upstream body's own `error.message` as the base
 * text; when the base is opaque ("Provider returned error"), appends the
 * known provider/model/status context so the stored message diagnoses on
 * its own. All stored text is redacted + truncated.
 */
function enrichProviderError(
	env: AgentEventEnvelope,
	rawMessage: string,
	envPattern: RegExp | null,
	fallbackProvider: string | null,
	fallbackModel: string | null,
): ProviderErrorSignal {
	const provider = readStringField(env, "provider") ?? fallbackProvider;
	const model = readStringField(env, "model") ?? fallbackModel;
	const statusMatch = HTTP_STATUS_PATTERN.exec(rawMessage);
	const httpStatus = statusMatch?.[1] !== undefined ? Number(statusMatch[1]) : null;
	const upstream = extractUpstreamBody(rawMessage);

	let base = upstream?.innerMessage ?? rawMessage;
	if (OPAQUE_MESSAGE.test(base.trim())) {
		const context = [
			provider !== null ? `provider=${provider}` : null,
			model !== null ? `model=${model}` : null,
			httpStatus !== null ? `status=${httpStatus}` : null,
		]
			.filter((part) => part !== null)
			.join(", ");
		if (context.length > 0) base = `${base.trim()} (${context})`;
	}

	return {
		message: sanitizeProviderText(base, envPattern),
		provider,
		model,
		httpStatus,
		upstreamBody: upstream === null ? null : sanitizeProviderText(upstream.body, envPattern),
	};
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
	| { readonly kind: "error"; readonly signal: ProviderErrorSignal }
	| { readonly kind: "clear" }
	| { readonly kind: "ignore" };

/**
 * warren-c80e: which envelope types are authoritative is a per-harness fact
 * and now lives in the adapter registry. Read once at module load, as the
 * registry is static. This is the union across every adapter, which is the
 * same scope the hardcoded `turn_end` / `agent_end` pair had: the classifier
 * walks a persisted event log without the run's runtime id in hand.
 */
const TERMINAL_ERROR_ENVELOPE_TYPES = new Set(providerErrorEnvelopeTypes());

function classifyEnvelope(
	env: AgentEventEnvelope,
	envPattern: RegExp | null,
	options: ProviderErrorClassifyOptions | undefined,
): EnvelopeVerdict {
	if (!TERMINAL_ERROR_ENVELOPE_TYPES.has(env.type)) return { kind: "ignore" };
	const stopReason = env.stopReason;
	if (stopReason === undefined) return { kind: "ignore" };
	const errorMessage = env.errorMessage;
	if (stopReason === "error" && typeof errorMessage === "string" && errorMessage.length > 0) {
		return {
			kind: "error",
			signal: enrichProviderError(
				env,
				errorMessage,
				envPattern,
				options?.fallbackProvider ?? null,
				options?.fallbackModel ?? null,
			),
		};
	}
	return { kind: "clear" };
}

/**
 * Classify a run's persisted event stream for a terminal provider error.
 *
 * Walks the events in order (callers pass `listByRun`, which is
 * ascending by `sandbox_event_seq`). For each `state_change`/`system`
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
	options?: ProviderErrorClassifyOptions,
): ProviderErrorSignal | null {
	// Absent option → the memoized instance pattern; explicit `null` →
	// shape-redaction only (tests pin behavior without touching process.env).
	const pattern =
		options?.envPattern === undefined ? instanceEnvSecretPattern() : options.envPattern;
	let terminal: ProviderErrorSignal | null = null;
	for (const event of events) {
		const envelope = extractAgentEventEnvelope(event);
		if (envelope === null) continue;
		const verdict = classifyEnvelope(envelope, pattern, options);
		if (verdict.kind === "ignore") continue;
		terminal = verdict.kind === "error" ? verdict.signal : null;
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
	options?: ProviderErrorClassifyOptions,
): Promise<ProviderErrorSignal | null> {
	const events = await repos.events.listByRun(runId);
	return classifyTerminalProviderError(
		events.map((e) => ({ kind: e.kind, stream: e.stream, payload: e.payloadJson })),
		options,
	);
}
