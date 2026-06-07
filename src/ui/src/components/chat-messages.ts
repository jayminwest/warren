/**
 * Pure transcript/stream merge logic for the chat surface, split out of
 * `Chat.tsx` so the merge/dedup contract is unit-testable without
 * pulling in React's JSX runtime (warren-0732 / pl-de53 step 4).
 *
 * Wire shapes:
 *   - User turn  → event kind `user_message`  with payload `{actor, content}`
 *   - Agent turn → event kind `agent_message` with payload `{actor, content}`
 */

import type { MessageRow, RunEvent } from "@/api/types.ts";

/** Event kinds the chat surface materializes into bubbles. */
const USER_KIND = "user_message";
const AGENT_KIND = "agent_message";

/** Bubble payload shape — matches `appendUserMessage`/`appendAgentMessage`. */
interface MessagePayload {
	actor?: string;
	content?: string;
}

export interface ChatMessage {
	readonly id: number | string;
	readonly seq: number;
	readonly kind: "user" | "agent";
	readonly actor: string;
	readonly content: string;
	readonly ts: string;
}

/** Map a persisted transcript row to a chat bubble, or null to skip it. */
export function transcriptRowToMessage(row: MessageRow): ChatMessage | null {
	let kind: ChatMessage["kind"];
	if (row.role === "user") kind = "user";
	else if (row.role === "assistant") kind = "agent";
	else return null; // system / tool rows are not rendered as bubbles.
	return {
		id: row.id,
		seq: row.seq,
		kind,
		actor: row.role,
		content: row.content,
		ts: row.createdAt,
	};
}

/** Stable dedupe key for a chat bubble — (kind, content). */
export function messageDedupeKey(m: ChatMessage): string {
	return `${m.kind}\u0000${m.content}`;
}

/** Extract the chat-message digest from a streamed RunEvent. */
export function toMessage(evt: RunEvent): ChatMessage | null {
	if (evt.kind !== USER_KIND && evt.kind !== AGENT_KIND) return null;
	const payload =
		evt.payload !== null && typeof evt.payload === "object"
			? (evt.payload as MessagePayload)
			: {};
	const content = typeof payload.content === "string" ? payload.content : "";
	const actor = typeof payload.actor === "string" ? payload.actor : "unknown";
	return {
		id: evt.id,
		seq: evt.seq,
		kind: evt.kind === USER_KIND ? "user" : "agent",
		actor,
		content,
		ts: evt.ts,
	};
}

/**
 * Merge the persisted transcript (history) with the live event stream
 * into the ordered bubble list the chat renders. Transcript rows render
 * even when the stream yields no message events (e.g. a never_started
 * anchoring run), and a transcript row whose (kind, content) matches a
 * streamed event is rendered once rather than duplicated. The transcript
 * renders first (it is the persisted history); stream messages not
 * already in the transcript follow.
 */
export function buildChatMessages(
	transcript: readonly MessageRow[] | undefined,
	events: readonly RunEvent[],
): ChatMessage[] {
	const streamMessages = events
		.map(toMessage)
		.filter((m): m is ChatMessage => m !== null)
		.sort((a, b) => a.seq - b.seq);
	const transcriptMessages = (transcript ?? [])
		.map(transcriptRowToMessage)
		.filter((m): m is ChatMessage => m !== null)
		.sort((a, b) => a.seq - b.seq);
	const seen = new Set(transcriptMessages.map(messageDedupeKey));
	const merged = [...transcriptMessages];
	for (const m of streamMessages) {
		const key = messageDedupeKey(m);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(m);
	}
	return merged;
}
