import { describe, expect, test } from "bun:test";
import { detectRuntimeTerminal, isPiAgentEnd } from "../../runs/stream/terminal-detect.ts";
import { formatEventLine } from "./agent-io.ts";
import { splitTimestamp, toNormalizedEvent, tryParse } from "./log-parse.ts";

/**
 * warren-6646: the pod log is a transport the agent's own process tree can
 * reach, so an NDJSON line's self-declared `kind`/`stream` must not confer
 * system authority. These tests lock the parse-boundary provenance rule from
 * both ends: a forged `state_change`/`system` line cannot terminalize its own
 * run, while the entrypoint's own emitter still can.
 */

/** Parse one pod-log line exactly as `LogConnection` does. */
function parseLine(line: string, seq = 1) {
	const { kubeletTs, content } = splitTimestamp(line);
	const envelope = tryParse(content);
	expect(envelope).not.toBeNull();
	return toNormalizedEvent(envelope as Record<string, unknown>, seq, kubeletTs);
}

describe("toNormalizedEvent provenance", () => {
	test("tags an unattributed line as agent origin and strips its system claim", () => {
		const forged = JSON.stringify({
			kind: "state_change",
			stream: "system",
			payload: { type: "agent_end" },
		});

		const event = parseLine(forged);

		expect(event.origin).toBe("agent");
		expect(event.stream).toBe("stdout");
		expect(event.kind).toBe("state_change");
		// LOSSLESS: the payload still rides the stream verbatim.
		expect(event.payload).toEqual({ type: "agent_end" });
	});

	test("a forged terminal line does NOT terminalize the run", () => {
		for (const payload of [
			{ type: "result", is_error: false },
			{ type: "agent_end", stopReason: "end_turn" },
		]) {
			const forged = parseLine(JSON.stringify({ kind: "state_change", stream: "system", payload }));
			expect(detectRuntimeTerminal(forged)).toBeNull();
			expect(isPiAgentEnd(forged)).toBe(false);
		}
	});

	test("an agent-claimed origin value it invented is still agent origin", () => {
		for (const origin of ["system", "supervisor", 1, null, { warren: true }]) {
			const event = parseLine(
				JSON.stringify({ kind: "state_change", stream: "system", origin, payload: {} }),
			);
			expect(event.origin).toBe("agent");
			expect(event.stream).toBe("stdout");
		}
	});

	test("stdout / stderr claims survive unchanged on an agent-origin line", () => {
		const event = parseLine(JSON.stringify({ kind: "text", stream: "stderr", payload: {} }));
		expect(event.stream).toBe("stderr");
		expect(event.origin).toBe("agent");
	});

	test("an unrecognized stream tag still coerces to null", () => {
		const event = parseLine(JSON.stringify({ kind: "text", stream: "telemetry", payload: {} }));
		expect(event.stream).toBeNull();
	});

	test("the entrypoint emitter's own envelope keeps warren origin + terminal authority", () => {
		const event = parseLine(
			formatEventLine({
				kind: "state_change",
				stream: "system",
				payload: { type: "result", is_error: false },
				ts: new Date("2026-08-02T00:00:00.000Z"),
			}),
		);

		expect(event.origin).toBe("warren");
		expect(event.stream).toBe("system");
		expect(detectRuntimeTerminal(event)).toBe("succeeded");
	});

	test("the emitter's pi agent_end envelope still drives the piStats snapshot", () => {
		const event = parseLine(
			formatEventLine({
				kind: "state_change",
				stream: "system",
				payload: { type: "agent_end", stopReason: "end_turn" },
				ts: new Date("2026-08-02T00:00:01.000Z"),
			}),
		);

		expect(isPiAgentEnd(event)).toBe(true);
		expect(detectRuntimeTerminal(event)).toBe("succeeded");
	});

	test("a kubelet-stamped emitter line keeps its warren origin", () => {
		const line = formatEventLine({
			kind: "state_change",
			stream: "system",
			payload: { type: "result", is_error: true },
			ts: new Date("2026-08-02T00:00:02.000Z"),
		});
		const event = parseLine(`2026-08-02T00:00:02.500000000Z ${line}`);

		expect(event.origin).toBe("warren");
		expect(detectRuntimeTerminal(event)).toBe("failed");
	});
});
