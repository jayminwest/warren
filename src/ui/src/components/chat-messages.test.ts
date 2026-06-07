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
});
