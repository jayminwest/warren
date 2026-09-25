import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@/api/types.ts";
import { refreshUrgency, urgencySince } from "./run-refresh.ts";

function ev(seq: number, kind: string, payload: unknown = null): RunEvent {
	return { id: seq, runId: "r", seq, ts: "2026-09-25T10:00:00Z", kind, stream: "system", payload };
}

describe("refreshUrgency", () => {
	test("lifecycle facts refresh now", () => {
		expect(refreshUrgency(ev(1, "reap.completed"))).toBe("now");
		expect(refreshUrgency(ev(1, "cancel.requested"))).toBe("now");
		expect(refreshUrgency(ev(1, "state_change", { type: "agent_end" }))).toBe("now");
		expect(refreshUrgency(ev(1, "state_change", { state: "running" }))).toBe("now");
	});

	test("a finished turn refreshes soon; turn bookkeeping never", () => {
		expect(refreshUrgency(ev(1, "state_change", { type: "turn_end" }))).toBe("soon");
		expect(refreshUrgency(ev(1, "state_change", { type: "turn_start" }))).toBeNull();
		expect(refreshUrgency(ev(1, "state_change", { type: "tool_execution_end" }))).toBeNull();
		expect(refreshUrgency(ev(1, "tool_use", { name: "bash" }))).toBeNull();
	});
});

describe("urgencySince", () => {
	const events = [
		ev(1, "reap.completed"),
		ev(2, "tool_use"),
		ev(3, "state_change", { type: "turn_end" }),
		ev(4, "text"),
	];

	test("reads only events newer than the cursor", () => {
		expect(urgencySince(events, 0)).toBe("now");
		expect(urgencySince(events, 1)).toBe("soon");
		expect(urgencySince(events, 3)).toBeNull();
	});
});
