import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@os-eco/burrow-cli";
import { detectRuntimeTerminal } from "./stream.ts";

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
function envelope(payload: Record<string, unknown>): RunEvent {
	return {
		id: 0,
		burrowId: "bur_x",
		runId: "run_x",
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
});
