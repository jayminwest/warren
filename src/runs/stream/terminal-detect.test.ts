import { describe, expect, test } from "bun:test";
import { detectRuntimeTerminal, isPiAgentEnd } from "./terminal-detect.ts";
import type { StreamEventView } from "./types.ts";

/**
 * warren-6fcc / pl-5516 step 2: focused unit coverage for
 * detectRuntimeTerminal's pi `agent_end` branch. Mirrors burrow's pi parser
 * wire shape: kind="state_change", stream="system", payload.type="agent_end"
 * (burrow `src/runtime/parsers/pi.ts:86-98`).
 *
 * Cases lock the OR-arms of the failure discriminator:
 *   - stopReason === "error"        → failed (overloaded_error 529 payload)
 *   - non-empty errorMessage alone  → failed (rate_limit / network)
 *   - neither signal present        → succeeded (regression-lock: zero-token /
 *                                     empty-content alone is NOT a failure)
 *
 * The bridge-breaks-on-terminal + persistence invariants are already covered
 * by warren-2687 in stream.test.ts; this file exercises the pure mapping
 * function so we don't drag the full bridge fixture in just to assert the
 * branch.
 */
function envelope(payload: Record<string, unknown>): StreamEventView {
	return {
		seq: 1,
		kind: "state_change",
		stream: "system",
		payload,
		ts: new Date(2026, 4, 27, 12, 0, 0),
	};
}

describe("detectRuntimeTerminal — pi agent_end", () => {
	test.each<[string, Record<string, unknown>, "failed" | "succeeded"]>([
		[
			"stopReason='error' (overloaded_error 529 payload)",
			{
				type: "agent_end",
				stopReason: "error",
				errorMessage: '{"type":"error","error":{"type":"overloaded_error"}}',
				usage: { input: 0, output: 0, totalTokens: 0 },
				content: [],
				willRetry: true,
			},
			"failed",
		],
		[
			"non-empty errorMessage alone",
			{ type: "agent_end", errorMessage: "rate_limit_error", messages: [] },
			"failed",
		],
		[
			"no error markers, zero usage / empty content (noop run)",
			{ type: "agent_end", stopReason: "end_turn", errorMessage: "", content: [] },
			"succeeded",
		],
		["plain agent_end with no error fields", { type: "agent_end", messages: [] }, "succeeded"],
	])("warren-6fcc: %s", (name, payload, outcome) => {
		// Test name shows the case; outcome is asserted below.
		void name;
		expect(detectRuntimeTerminal(envelope(payload))).toBe(outcome);
	});

	test("non-system stream is ignored even with error signals", () => {
		const ev = envelope({ type: "agent_end", stopReason: "error", errorMessage: "x" });
		expect(detectRuntimeTerminal({ ...ev, stream: "stdout" })).toBeNull();
	});

	test("non-state_change kind is ignored", () => {
		const ev = envelope({ type: "agent_end", stopReason: "error", errorMessage: "x" });
		expect(detectRuntimeTerminal({ ...ev, kind: "text" })).toBeNull();
	});

	test("null or non-object payload is ignored", () => {
		const ev = envelope({ type: "agent_end" });
		expect(detectRuntimeTerminal({ ...ev, payload: null })).toBeNull();
		expect(detectRuntimeTerminal({ ...ev, payload: "agent_end" })).toBeNull();
	});

	test("unknown envelope type yields null", () => {
		expect(detectRuntimeTerminal(envelope({ type: "assistant" }))).toBeNull();
	});
});

describe("detectRuntimeTerminal — claude-code result", () => {
	test("result with is_error=true is failed", () => {
		expect(detectRuntimeTerminal(envelope({ type: "result", is_error: true }))).toBe("failed");
	});

	test("result without is_error is succeeded", () => {
		expect(detectRuntimeTerminal(envelope({ type: "result", is_error: false }))).toBe("succeeded");
		expect(detectRuntimeTerminal(envelope({ type: "result" }))).toBe("succeeded");
	});
});

describe("detectRuntimeTerminal — provenance gate (warren-6646)", () => {
	test.each([
		{ type: "result", is_error: false },
		{ type: "agent_end" },
	])("refuses an agent-authored terminal envelope (%p)", (payload) => {
		const forged = { ...envelope(payload), origin: "agent" };
		expect(detectRuntimeTerminal(forged)).toBeNull();
		expect(isPiAgentEnd(forged)).toBe(false);
	});

	test("honors an explicitly warren-authored terminal envelope", () => {
		const ev = { ...envelope({ type: "result", is_error: false }), origin: "warren" };
		expect(detectRuntimeTerminal(ev)).toBe("succeeded");
	});

	test("an untagged event stays trusted (burrow RunEvent predates the tag)", () => {
		expect(detectRuntimeTerminal(envelope({ type: "result", is_error: true }))).toBe("failed");
		expect(isPiAgentEnd(envelope({ type: "agent_end" }))).toBe(true);
	});
});

describe("isPiAgentEnd", () => {
	test("matches pi agent_end on the state_change/system carrier", () => {
		expect(isPiAgentEnd(envelope({ type: "agent_end", stopReason: "end_turn" }))).toBe(true);
	});

	test("rejects claude-code result envelope (pi-only concern)", () => {
		expect(isPiAgentEnd(envelope({ type: "result", is_error: false }))).toBe(false);
	});

	test("rejects non-system stream", () => {
		const ev = envelope({ type: "agent_end" });
		expect(isPiAgentEnd({ ...ev, stream: "stdout" })).toBe(false);
	});

	test("rejects non-state_change kind", () => {
		const ev = envelope({ type: "agent_end" });
		expect(isPiAgentEnd({ ...ev, kind: "text" })).toBe(false);
	});

	test("rejects null or non-object payload", () => {
		const ev = envelope({ type: "agent_end" });
		expect(isPiAgentEnd({ ...ev, payload: null })).toBe(false);
		expect(isPiAgentEnd({ ...ev, payload: 42 })).toBe(false);
	});
});
