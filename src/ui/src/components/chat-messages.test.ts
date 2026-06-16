import { describe, expect, test } from "bun:test";
import type { MessageRow, RunEvent } from "@/api/types.ts";
import { buildChatMessages } from "./chat-messages.ts";

function row(over: Partial<MessageRow>): MessageRow {
	return {
		id: "msg_1",
		conversationId: "conv_1",
		seq: 1,
		role: "user",
		content: "hello",
		runId: null,
		createdAt: "2026-06-07T00:00:00.000Z",
		...over,
	};
}

function event(over: Partial<RunEvent>): RunEvent {
	return {
		id: 1,
		runId: "run_1",
		seq: 1,
		ts: "2026-06-07T00:00:01.000Z",
		kind: "user_message",
		stream: null,
		payload: { actor: "user", content: "hello" },
		plotId: null,
		...over,
	};
}

describe("buildChatMessages", () => {
	test("renders transcript rows when the event stream yields no message events", () => {
		const transcript: MessageRow[] = [
			row({ id: "msg_1", seq: 1, role: "user", content: "fix the bug" }),
			row({ id: "msg_2", seq: 2, role: "assistant", content: "on it" }),
		];

		const result = buildChatMessages(transcript, []);

		expect(result.map((m) => ({ kind: m.kind, content: m.content }))).toEqual([
			{ kind: "user", content: "fix the bug" },
			{ kind: "agent", content: "on it" },
		]);
	});

	test("renders transcript rows even when the stream carries only non-message events", () => {
		const transcript: MessageRow[] = [
			row({ id: "msg_1", seq: 1, role: "user", content: "fix the bug" }),
		];
		// A never-started anchoring run only ever emits system noise, not
		// user_message/agent_message — the transcript must still render.
		const events: RunEvent[] = [
			event({ id: 1, seq: 1, kind: "reap.completed", payload: {} }),
		];

		const result = buildChatMessages(transcript, events);

		expect(result).toHaveLength(1);
		expect(result[0]?.content).toBe("fix the bug");
	});

	test("does not duplicate a transcript row matching a streamed event", () => {
		const transcript: MessageRow[] = [
			row({ id: "msg_1", seq: 1, role: "user", content: "hello" }),
		];
		const events: RunEvent[] = [
			event({
				id: 10,
				seq: 1,
				kind: "user_message",
				payload: { actor: "user", content: "hello" },
			}),
		];

		const result = buildChatMessages(transcript, events);

		expect(result).toHaveLength(1);
		expect(result[0]?.content).toBe("hello");
	});

	test("merges distinct streamed turns after the transcript history", () => {
		const transcript: MessageRow[] = [
			row({ id: "msg_1", seq: 1, role: "user", content: "hello" }),
		];
		const events: RunEvent[] = [
			event({
				id: 10,
				seq: 1,
				kind: "user_message",
				payload: { actor: "user", content: "hello" },
			}),
			event({
				id: 11,
				seq: 2,
				kind: "agent_message",
				payload: { actor: "agent", content: "hi there" },
			}),
		];

		const result = buildChatMessages(transcript, events);

		expect(result.map((m) => ({ kind: m.kind, content: m.content }))).toEqual([
			{ kind: "user", content: "hello" },
			{ kind: "agent", content: "hi there" },
		]);
	});

	test("interleaves transcript and stream chronologically by timestamp, not by source", () => {
		// Transcript seq and event seq are independent numbering systems, so a
		// concat-of-two-seq-sorted-groups merge would mis-order any turn that
		// straddles the boundary. Here the streamed user turn happens BETWEEN
		// two transcript turns in wall-clock time and must render in the middle.
		const transcript: MessageRow[] = [
			row({ id: "msg_1", seq: 1, role: "user", content: "first ask", createdAt: "2026-06-07T00:00:00.000Z" }),
			row({ id: "msg_2", seq: 2, role: "assistant", content: "final reply", createdAt: "2026-06-07T00:00:30.000Z" }),
		];
		const events: RunEvent[] = [
			event({
				id: 10,
				seq: 1,
				kind: "user_message",
				ts: "2026-06-07T00:00:15.000Z",
				payload: { actor: "user", content: "mid-run steer" },
			}),
		];

		const result = buildChatMessages(transcript, events);

		expect(result.map((m) => m.content)).toEqual(["first ask", "mid-run steer", "final reply"]);
	});

	test("collapses a streamed assistant turn and its persisted transcript copy into one bubble", () => {
		// The persisted assistant row and the streamed pi `text` event carry the
		// same content; they must render once, keeping the persisted copy.
		const transcript: MessageRow[] = [
			row({ id: "msg_1", seq: 1, role: "assistant", content: "all done", createdAt: "2026-06-07T00:00:05.000Z" }),
		];
		const events: RunEvent[] = [
			event({ id: 20, seq: 1, kind: "text", ts: "2026-06-07T00:00:05.000Z", payload: { text: "all done" } }),
		];

		const result = buildChatMessages(transcript, events);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ id: "msg_1", kind: "agent", content: "all done" });
	});

	test("omits system and tool transcript rows", () => {
		const transcript: MessageRow[] = [
			row({ id: "msg_1", seq: 1, role: "system", content: "boot" }),
			row({ id: "msg_2", seq: 2, role: "tool", content: "ran tool" }),
			row({ id: "msg_3", seq: 3, role: "user", content: "real turn" }),
		];

		const result = buildChatMessages(transcript, []);

		expect(result).toHaveLength(1);
		expect(result[0]?.content).toBe("real turn");
	});

	test("returns an empty list when there is no transcript and no message events", () => {
		expect(buildChatMessages(undefined, [])).toEqual([]);
	});

	test("renders pi text events as agent bubbles", () => {
		const events: RunEvent[] = [
			event({ id: 1, seq: 1, kind: "text", payload: { text: "shaping the intent" } }),
		];

		const result = buildChatMessages(undefined, events);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ kind: "agent", content: "shaping the intent" });
	});

	test("renders pi thinking events as collapsible thinking rows", () => {
		const events: RunEvent[] = [
			event({ id: 1, seq: 1, kind: "thinking", payload: { text: "let me reason about this" } }),
		];

		const result = buildChatMessages(undefined, events);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ kind: "thinking", content: "let me reason about this" });
	});

	test("renders pi tool_use as a compact one-liner (name + short arg)", () => {
		const events: RunEvent[] = [
			event({
				id: 1,
				seq: 1,
				kind: "tool_use",
				payload: { type: "toolCall", name: "bash", arguments: { command: "cd /workspace && ls" } },
			}),
		];

		const result = buildChatMessages(undefined, events);

		expect(result[0]).toMatchObject({ kind: "tool", content: "bash: cd /workspace && ls" });
	});

	test("renders an argument-less tool_use as just the tool name", () => {
		const events: RunEvent[] = [
			event({ id: 1, seq: 1, kind: "tool_use", payload: { type: "toolCall", name: "propose_intent" } }),
		];

		const result = buildChatMessages(undefined, events);

		expect(result[0]).toMatchObject({ kind: "tool", content: "propose_intent" });
	});

	test("renders pi tool_result with a snippet and flags errors", () => {
		const events: RunEvent[] = [
			event({
				id: 1,
				seq: 1,
				kind: "tool_result",
				payload: {
					role: "toolResult",
					toolName: "ls",
					isError: false,
					content: [{ type: "text", text: "a.txt\nb.txt" }],
				},
			}),
			event({
				id: 2,
				seq: 2,
				kind: "tool_result",
				payload: {
					role: "toolResult",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "command not found" }],
				},
			}),
		];

		const result = buildChatMessages(undefined, events);

		expect(result[0]).toMatchObject({ kind: "tool", content: "ls → a.txt b.txt", isError: false });
		expect(result[1]).toMatchObject({
			kind: "tool",
			content: "bash failed → command not found",
			isError: true,
		});
	});

	test("does not collapse repeated identical tool rows from the stream", () => {
		const events: RunEvent[] = [
			event({ id: 1, seq: 1, kind: "tool_use", payload: { name: "bash", arguments: { command: "ls" } } }),
			event({ id: 2, seq: 2, kind: "tool_use", payload: { name: "bash", arguments: { command: "ls" } } }),
		];

		const result = buildChatMessages(undefined, events);

		expect(result).toHaveLength(2);
	});

	test("ignores pi noise events (telemetry, state_change, mulch.record.skipped, reap.*)", () => {
		const events: RunEvent[] = [
			event({ id: 1, seq: 1, kind: "telemetry", payload: { type: "message_update" } }),
			event({ id: 2, seq: 2, kind: "state_change", payload: { type: "turn_end" } }),
			event({ id: 3, seq: 3, kind: "mulch.record.skipped", payload: {} }),
			event({ id: 4, seq: 4, kind: "reap.completed", payload: {} }),
			event({ id: 5, seq: 5, kind: "text", payload: { text: "" } }),
		];

		expect(buildChatMessages(undefined, events)).toEqual([]);
	});
});
