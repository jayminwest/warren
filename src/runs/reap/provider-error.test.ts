import { describe, expect, test } from "bun:test";
import { classifyTerminalProviderError, type ProviderErrorEventInput } from "./provider-error.ts";

/** Helper: build a `state_change`/`system` event from a pi envelope. */
function envEvent(env: Record<string, unknown>): ProviderErrorEventInput {
	return { kind: "state_change", stream: "system", payload: env };
}

const CREDIT_MESSAGE =
	'{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API"}}';
/** The upstream body's own error.message — the enriched signal prefers it (warren-4001). */
const CREDIT_INNER = "Your credit balance is too low to access the Anthropic API";

describe("classifyTerminalProviderError (warren-edc3)", () => {
	test("turn_end with stopReason=error + errorMessage -> terminal provider error", () => {
		// The credit-balance 400 shape: the error signal rides the per-turn
		// `turn_end` envelope (stopReason + errorMessage nested on `message`,
		// mirroring the success golden's layout).
		const events = [
			envEvent({ type: "turn_start" }),
			envEvent({
				type: "turn_end",
				message: { stopReason: "error", errorMessage: CREDIT_MESSAGE },
			}),
		];
		const signal = classifyTerminalProviderError(events);
		expect(signal?.message).toBe(CREDIT_INNER);
		expect(signal?.upstreamBody).toBe(CREDIT_MESSAGE);
	});

	test("agent_end with top-level stopReason=error + errorMessage -> terminal provider error", () => {
		// The 529 overloaded shape (warren-e281): stopReason + errorMessage
		// at the agent_end top level. The net must catch this too, so a run
		// that slipped past the in-stream detect is still failed at reap.
		const events = [
			envEvent({ type: "agent_end", stopReason: "error", errorMessage: "overloaded_error" }),
		];
		expect(classifyTerminalProviderError(events)).toEqual({
			message: "overloaded_error",
			provider: null,
			model: null,
			httpStatus: null,
			upstreamBody: null,
		});
	});

	test("success turn_end (stopReason=stop) -> no provider error", () => {
		// Legitimate no-op-code run: ends on a normal stop. Must NOT trip.
		const events = [
			envEvent({ type: "turn_end", message: { stopReason: "stop", content: [] } }),
			envEvent({ type: "agent_end", messages: [] }),
		];
		expect(classifyTerminalProviderError(events)).toBeNull();
	});

	test("agent_end carrying only messages (no stopReason) does not mask an earlier error turn", () => {
		// credit-400 then a clean agent_end (no stopReason): the error
		// turn_end is the real terminal — the stopReason-less agent_end
		// must NOT clear it.
		const events = [
			envEvent({
				type: "turn_end",
				message: { stopReason: "error", errorMessage: CREDIT_MESSAGE },
			}),
			envEvent({ type: "agent_end", messages: [{ role: "assistant", content: [] }] }),
		];
		const signal = classifyTerminalProviderError(events);
		expect(signal?.message).toBe(CREDIT_INNER);
		expect(signal?.upstreamBody).toBe(CREDIT_MESSAGE);
	});

	test("a later successful turn clears an earlier error turn (retried-then-succeeded)", () => {
		// Transient error that pi retried, then the run succeeded: the last
		// stopReason-carrying envelope is `stop`, so the net must NOT fail
		// the run.
		const events = [
			envEvent({
				type: "turn_end",
				message: { stopReason: "error", errorMessage: "rate_limited" },
			}),
			envEvent({
				type: "turn_end",
				message: { stopReason: "stop", content: [{ type: "text", text: "ok" }] },
			}),
			envEvent({ type: "agent_end", messages: [] }),
		];
		expect(classifyTerminalProviderError(events)).toBeNull();
	});

	test("stopReason=error without an errorMessage is not the hard-error signal", () => {
		// The issue requires BOTH stopReason=error AND a non-empty
		// errorMessage. An error stop with no message is ambiguous — don't
		// trip (and a later success still clears).
		const events = [envEvent({ type: "turn_end", message: { stopReason: "error" } })];
		expect(classifyTerminalProviderError(events)).toBeNull();
	});

	test("empty errorMessage is treated as absent", () => {
		const events = [
			envEvent({ type: "turn_end", message: { stopReason: "error", errorMessage: "" } }),
		];
		expect(classifyTerminalProviderError(events)).toBeNull();
	});

	test("ignores non-state_change events and non-system streams", () => {
		// Assistant text + tool_use ride stdout; telemetry rides system but
		// kind=telemetry. None carry the terminal signal.
		const events: ProviderErrorEventInput[] = [
			{ kind: "text", stream: "stdout", payload: { text: "working" } },
			{ kind: "tool_use", stream: "stdout", payload: { type: "tool_use", name: "Read" } },
			{ kind: "telemetry", stream: "system", payload: { type: "queue_update" } },
			{
				kind: "state_change",
				stream: "stderr",
				payload: { type: "turn_end", stopReason: "error" },
			},
		];
		expect(classifyTerminalProviderError(events)).toBeNull();
	});

	test("returns null for an empty event stream", () => {
		expect(classifyTerminalProviderError([])).toBeNull();
	});

	test("top-level stopReason on turn_end is also recognized", () => {
		// Defensive: some pi error paths may put stopReason at the envelope
		// top level even on turn_end. The classifier reads both locations.
		const events = [
			envEvent({ type: "turn_end", stopReason: "error", errorMessage: CREDIT_MESSAGE }),
		];
		const signal = classifyTerminalProviderError(events);
		expect(signal?.message).toBe(CREDIT_INNER);
		expect(signal?.upstreamBody).toBe(CREDIT_MESSAGE);
	});

	test("first-turn 400 (0 tokens, no prior output) is detected", () => {
		// run_hj207hyzz8hv shape: very first turn returned the 400, 0 tokens,
		// 0 tool calls. The error turn_end is the only model activity.
		const events = [
			envEvent({ type: "agent_start" }),
			envEvent({ type: "turn_start" }),
			envEvent({
				type: "turn_end",
				message: { stopReason: "error", errorMessage: CREDIT_MESSAGE },
			}),
		];
		const signal = classifyTerminalProviderError(events);
		expect(signal?.message).toBe(CREDIT_INNER);
		expect(signal?.upstreamBody).toBe(CREDIT_MESSAGE);
	});
});

describe("classifyTerminalProviderError — enriched signal (warren-4001)", () => {
	test("opaque 'Provider returned error' gains provider/model context from the envelope", () => {
		// The pl-61a4 shape: pi's openrouter path terminalized with the
		// literal "Provider returned error" and nothing else. The envelope's
		// assistant message still stamps provider + model, so the stored
		// message must name them.
		const events = [
			envEvent({
				type: "turn_end",
				message: {
					stopReason: "error",
					errorMessage: "Provider returned error",
					provider: "openrouter",
					model: "moonshotai/kimi-k3",
				},
			}),
		];
		const signal = classifyTerminalProviderError(events, { envPattern: null });
		expect(signal?.message).toBe(
			"Provider returned error (provider=openrouter, model=moonshotai/kimi-k3)",
		);
		expect(signal?.provider).toBe("openrouter");
		expect(signal?.model).toBe("moonshotai/kimi-k3");
		expect(signal?.httpStatus).toBeNull();
		expect(signal?.upstreamBody).toBeNull();
	});

	test("opaque message with no envelope context is stored unchanged", () => {
		const events = [
			envEvent({
				type: "turn_end",
				message: { stopReason: "error", errorMessage: "Provider returned error" },
			}),
		];
		const signal = classifyTerminalProviderError(events, { envPattern: null });
		expect(signal?.message).toBe("Provider returned error");
		expect(signal?.provider).toBeNull();
		expect(signal?.model).toBeNull();
	});

	test("httpStatus is parsed out of the error text", () => {
		const events = [
			envEvent({
				type: "agent_end",
				stopReason: "error",
				errorMessage: "Request failed with status code 529: overloaded_error",
			}),
		];
		const signal = classifyTerminalProviderError(events, { envPattern: null });
		expect(signal?.httpStatus).toBe(529);
		expect(signal?.message).toBe("Request failed with status code 529: overloaded_error");
	});

	test("embedded upstream JSON body is lifted into upstreamBody and its error.message preferred", () => {
		const events = [
			envEvent({
				type: "turn_end",
				message: { stopReason: "error", errorMessage: CREDIT_MESSAGE, provider: "anthropic" },
			}),
		];
		const signal = classifyTerminalProviderError(events, { envPattern: null });
		expect(signal?.message).toBe(CREDIT_INNER);
		expect(signal?.upstreamBody).toBe(CREDIT_MESSAGE);
		expect(signal?.provider).toBe("anthropic");
	});

	test("credential shapes in the error text are redacted before storing", () => {
		// warren-cbd8: an upstream body that echoes the request's API key
		// back must never reach the event log in the clear.
		const events = [
			envEvent({
				type: "turn_end",
				message: {
					stopReason: "error",
					errorMessage:
						"Request failed with status code 401 for key sk-ant-api03-abcdef1234567890abcdef",
				},
			}),
		];
		const signal = classifyTerminalProviderError(events, { envPattern: null });
		expect(signal?.message).not.toContain("sk-ant-");
		expect(signal?.message).toContain("[redacted]");
	});

	test("instance env secrets in the error text are redacted via the injected pattern", () => {
		const envPattern = /hunter2hunter2hunter2/g;
		const events = [
			envEvent({
				type: "turn_end",
				message: {
					stopReason: "error",
					errorMessage: "upstream rejected token hunter2hunter2hunter2 with 403",
				},
			}),
		];
		const signal = classifyTerminalProviderError(events, { envPattern });
		expect(signal?.message).toBe("upstream rejected token [redacted] with 403");
	});

	test("overlong error text is truncated to the cap with a marker", () => {
		const huge = `x${"y".repeat(5000)}`;
		const events = [
			envEvent({
				type: "turn_end",
				message: { stopReason: "error", errorMessage: huge },
			}),
		];
		const signal = classifyTerminalProviderError(events, { envPattern: null });
		expect(signal?.message.length).toBeLessThanOrEqual(2000 + "…[truncated]".length);
		expect(signal?.message.endsWith("…[truncated]")).toBe(true);
	});

	test("overlong upstream body is truncated to the cap", () => {
		const body = `{"type":"error","error":{"message":"${"z".repeat(5000)}"}}`;
		const events = [
			envEvent({
				type: "turn_end",
				message: { stopReason: "error", errorMessage: body },
			}),
		];
		const signal = classifyTerminalProviderError(events, { envPattern: null });
		expect(signal?.upstreamBody?.endsWith("…[truncated]")).toBe(true);
		expect(signal?.upstreamBody?.length).toBeLessThanOrEqual(2000 + "…[truncated]".length);
	});
});
