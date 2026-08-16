/**
 * Pi RPC stdout parser (pi --mode rpc, v0.74.0).
 *
 * Source-lifted verbatim from burrow's `src/runtime/parsers/pi.ts`
 * (warren-7933, plan pl-3007) — the telemetry/state_change collapse rules
 * below are pinned byte-for-byte by the golden fixtures in `./__golden__/`.
 *
 * Pi emits one JSON object per line. The line vocabulary is wider than
 * claude-code's stream-json — it covers lifecycle (`agent_start`/`end`,
 * `turn_start`/`end`), per-message envelopes (`message_start`/`update`/`end`
 * with role ∈ {user, assistant, toolResult}), tool execution lifecycle
 * (`tool_execution_start`/`end`), and exceptional events
 * (`queue_update`, `compaction_*`, `auto_retry_*`, `extension_error`,
 * `extension_ui_request`). Pi's RPC also acks each command via
 * `{"type":"response","command":"prompt","success":true}`.
 *
 * We collapse this into burrow's stable taxonomy (SPEC §14.1):
 *
 *   - assistant `message_end` content blocks (the canonical fully-assembled
 *     content per README #3) expand to `text` / `thinking` / `tool_use`
 *   - toolResult `message_end` becomes a single `tool_result`
 *   - lifecycle / ack envelopes (`response`, `agent_*`, `turn_*`,
 *     user/assistant `message_start`, `tool_execution_*`, `compaction_*`,
 *     `extension_error`, `extension_ui_request`) → `state_change` on the
 *     `system` stream
 *   - streaming telemetry envelopes (`message_update`, `queue_update`,
 *     `auto_retry_*`) → `telemetry` on the `system` stream
 *   - unknown envelope types are preserved as `state_change` so future
 *     vocabulary additions are observable without code changes (matches the
 *     additive-only posture of SPEC §14.1)
 *
 * Lossy collapse is intentional. The full envelope is preserved in
 * `payload` so principled kind-widening (e.g. promoting `compaction` to a
 * first-class kind) is non-breaking.
 *
 * Note on assistant content blocks: pi uses `toolCall` (camelCase) where
 * claude-code uses `tool_use`. The block is preserved verbatim in
 * `payload`; only the burrow event `kind` is normalized to `tool_use`.
 */

import type { AdapterRuntimeEvent as RuntimeEvent } from "../types.ts";

interface PiContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	[key: string]: unknown;
}

interface PiMessage {
	role?: string;
	content?: PiContentBlock[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	[key: string]: unknown;
}

interface PiEnvelope {
	type?: string;
	message?: PiMessage;
	assistantMessageEvent?: { type?: string; [key: string]: unknown };
	[key: string]: unknown;
}

export function parsePiEvents(line: string): RuntimeEvent[] {
	const trimmed = line.trim();
	if (trimmed.length === 0) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [
			{
				kind: "text",
				stream: "stdout",
				payload: { text: line, parseError: "invalid JSON" },
			},
		];
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return [{ kind: "text", stream: "stdout", payload: { text: line } }];
	}

	const env = parsed as PiEnvelope;
	const type = typeof env.type === "string" ? env.type : "";

	switch (type) {
		case "response":
		case "agent_start":
		case "agent_end":
		case "turn_start":
		case "turn_end":
		case "tool_execution_start":
		case "tool_execution_end":
		case "compaction_start":
		case "compaction_end":
		case "extension_error":
		case "extension_ui_request":
			return [{ kind: "state_change", stream: "system", payload: env }];

		case "message_update":
		case "queue_update":
		case "auto_retry_start":
		case "auto_retry_end":
			return [{ kind: "telemetry", stream: "system", payload: env }];

		case "message_start":
			return [{ kind: "state_change", stream: "system", payload: env }];

		case "message_end":
			return mapMessageEnd(env);

		default:
			return [{ kind: "state_change", stream: "system", payload: env }];
	}
}

function mapMessageEnd(env: PiEnvelope): RuntimeEvent[] {
	const msg = env.message;
	if (!msg || typeof msg !== "object") {
		return [{ kind: "state_change", stream: "system", payload: env }];
	}

	if (msg.role === "assistant" && Array.isArray(msg.content)) {
		const events: RuntimeEvent[] = [];
		for (const block of msg.content) {
			const ev = mapAssistantBlock(block);
			if (ev !== null) events.push(ev);
		}
		return events;
	}

	if (msg.role === "toolResult") {
		return [{ kind: "tool_result", stream: "stdout", payload: msg }];
	}

	// user / unknown role — lifecycle echo, preserve as state_change.
	return [{ kind: "state_change", stream: "system", payload: env }];
}

function mapAssistantBlock(block: PiContentBlock): RuntimeEvent | null {
	if (!block || typeof block !== "object") return null;

	if (block.type === "text") {
		return { kind: "text", stream: "stdout", payload: { text: block.text ?? "" } };
	}
	if (block.type === "thinking") {
		// Empty-text thinking blocks are pi's pre-tool placeholder (parity with
		// claude-code's burrow-5d64 behavior — drop instead of forwarding
		// noise).
		const text = block.thinking ?? "";
		if (text.length === 0) return null;
		return { kind: "thinking", stream: "stdout", payload: { text } };
	}
	if (block.type === "toolCall") {
		return { kind: "tool_use", stream: "stdout", payload: block };
	}
	// Unknown block kinds still surface — better to record than drop.
	return { kind: "text", stream: "stdout", payload: { block } };
}
