/**
 * Reap-side capture of an interactive run's final assistant reply
 * (warren-509f / pl-df2f).
 *
 * Interactive runs (brainstorm / planner) are respawn-per-turn: each
 * user message spawns a fresh burrow turn that streams `text` envelopes
 * onto the run's event log and then terminates. The spawn side
 * (`src/runs/interactive.ts`) appends the `user_message`; this module is
 * the matching reap-side append of the agent's reply as an
 * `agent_message` event so the inline Chat surface on PlotDetail (and
 * the Formalize seam, which scans `agent_message` events) sees the
 * agent's response without operators having to open the run detail page.
 *
 * Extraction strategy: scan the persisted event rows on terminal and
 * take the final assistant turn — every `text` event on `stream=stdout`
 * that follows the last tool interaction (`tool_use` / `tool_result`).
 * burrow's jsonl-claude parser maps each assistant content block to a
 * `text` event with payload `{ text }` (raw-text declarative agents land
 * here too); we tolerate a `content` field as a fallback. Thinking
 * blocks are ignored. Returns `null` when the run produced no assistant
 * text (e.g. a crash before any model turn), in which case reap appends
 * nothing.
 */

import type { EventRow, RunRow } from "../../db/schema.ts";
import { appendAgentMessage } from "../interactive.ts";
import type { ReapRunInput } from "./types.ts";

/** Tool-interaction kinds that delimit the end of a prior assistant turn. */
const TOOL_KINDS = new Set(["tool_use", "tool_result"]);

/** Pull the text body out of a `text` event payload (`text` or `content`). */
function extractText(payload: unknown): string | null {
	if (payload === null || typeof payload !== "object") return null;
	const obj = payload as { text?: unknown; content?: unknown };
	if (typeof obj.text === "string") return obj.text;
	if (typeof obj.content === "string") return obj.content;
	return null;
}

/**
 * Extract the final assistant message from a run's persisted events.
 * Returns the concatenated text of the last assistant turn, or `null`
 * when there is no assistant text to capture.
 */
export function extractFinalAssistantMessage(events: readonly EventRow[]): string | null {
	// Start of the final assistant turn = just past the last tool event.
	let start = 0;
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const ev = events[i];
		if (ev !== undefined && TOOL_KINDS.has(ev.kind)) {
			start = i + 1;
			break;
		}
	}

	const parts: string[] = [];
	for (let i = start; i < events.length; i += 1) {
		const ev = events[i];
		if (ev === undefined || ev.stream !== "stdout" || ev.kind !== "text") continue;
		const text = extractText(ev.payloadJson);
		if (text !== null) parts.push(text);
	}

	const joined = parts.join("").trim();
	return joined === "" ? null : joined;
}

export interface CaptureInteractiveReplyInput {
	readonly run: RunRow;
	readonly input: ReapRunInput;
	readonly now: Date;
}

/**
 * Append the agent's final assistant reply onto an interactive run as an
 * `agent_message` event, then publish it to the live broker. No-op for
 * non-interactive runs and for runs that produced no assistant text.
 * Best-effort: a failure is logged and swallowed so reap never blocks on
 * it. Returns the appended event row, or `null` when nothing was
 * captured.
 */
export async function captureInteractiveReply({
	run,
	input,
	now,
}: CaptureInteractiveReplyInput): Promise<EventRow | null> {
	if (run.mode !== "interactive") return null;
	try {
		const events = await input.repos.events.listByRun(run.id);
		const content = extractFinalAssistantMessage(events);
		if (content === null) return null;
		const row = await appendAgentMessage({
			repos: input.repos,
			runId: run.id,
			agentName: run.agentName,
			content,
			now,
		});
		input.broker?.publish(run.id, row);
		return row;
	} catch (err) {
		input.logger?.error?.(
			{ runId: run.id, err: err instanceof Error ? err.message : String(err) },
			"reap interactive agent_message capture failed; continuing",
		);
		return null;
	}
}
