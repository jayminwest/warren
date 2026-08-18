/**
 * Typed per-runtime tool-event readers (warren-c116 / pl-103e step 8;
 * AgentRuntimeAdapter phase-1 material, the `toolShape` direction —
 * landed pre-adapter the same way `usageShape` did, per the plan's
 * sequencing note on GH#846).
 *
 * Sibling to `usage-shape.ts`: where that module declares how one
 * runtime's usage envelope reads, this one declares how one runtime's
 * `tool_use` / `tool_result` event payloads read — the tool name, the
 * shell command a Bash-class call carries, the `tool_use`↔`tool_result`
 * join id, the error flag, and the byte size of a result payload.
 *
 * The first consumer is the command-mining aggregator
 * (`src/runs/analytics/command-mining.ts`), which used to hardcode the
 * Anthropic payload shape (`payload.input.command`, `tool_use_id`,
 * `is_error`) for every row regardless of runtime. Resolving per-row
 * through {@link toolShapeFor} lets `/analytics/behavior` distinguish
 * "this harness emitted no commands" (no shape declared, or every call
 * was a non-command tool) from "commands did not parse" (a declared
 * shape rejected the payload).
 *
 * {@link TOOL_SHAPES} declares `claude-code` and `pi` only. A runtime
 * with no entry resolves to `null` and its rows count as unshaped, not
 * as parse failures.
 *
 * `src/core/` imports nothing outside itself (check:layers), so the
 * readers are dependency-free and structural.
 */

import type { RuntimeId } from "./wire.ts";

/**
 * One `tool_use` payload's reading. Fields are `null` when the payload
 * carries no value for them — a Read-class call legitimately has no
 * `command`, and a malformed payload may lack a join id. The consumer
 * decides what each absence means.
 */
export interface ToolUseReading {
	/** The invoked tool's name (e.g. `"Bash"`, `"read"`), or `null`. */
	readonly toolName: string | null;
	/** The shell command for Bash-class calls, or `null` for structured tools. */
	readonly command: string | null;
	/** The id a later `tool_result` joins back on, or `null`. */
	readonly toolUseId: string | null;
}

/** One `tool_result` payload's reading. */
export interface ToolResultReading {
	/** The `tool_use` id this result joins back on, or `null`. */
	readonly toolUseId: string | null;
	/** The harness-reported error flag. Absent reads as `false`. */
	readonly isError: boolean;
	/** UTF-8 byte size of the result body, or `null` when absent. */
	readonly resultBytes: number | null;
}

/**
 * The declared tool-event knowledge for one runtime: how to read a
 * `tool_use` payload and how to read a `tool_result` payload. Each
 * reader returns `null` when the payload is not readable as that event
 * class at all — the parse-failure signal the coverage rollup counts.
 */
export interface ToolShape {
	readonly runtime: RuntimeId;
	readToolUse(payload: Record<string, unknown>): ToolUseReading | null;
	readToolResult(payload: Record<string, unknown>): ToolResultReading | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function toStr(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

const encoder = new TextEncoder();

/**
 * UTF-8 byte size of a result body: the string length for text bodies,
 * the serialized length for structured ones (content-block arrays),
 * `null` when the payload carries no result body at all.
 */
function bytesOf(value: unknown): number | null {
	if (typeof value === "string") return encoder.encode(value).length;
	if (value === null || value === undefined) return null;
	if (typeof value === "object") {
		try {
			return encoder.encode(JSON.stringify(value)).length;
		} catch {
			return null;
		}
	}
	return null;
}

function firstStr(...values: readonly unknown[]): string | null {
	for (const v of values) {
		const s = toStr(v);
		if (s !== null) return s;
	}
	return null;
}

/**
 * A `tool_use` reading is only real when the payload carried at least
 * one of the three fields — otherwise an unrelated object would count
 * as a parsed tool call with three nulls, laundering a parse failure
 * into "non-command tool".
 */
function useReading(
	toolName: string | null,
	command: string | null,
	toolUseId: string | null,
): ToolUseReading | null {
	if (toolName === null && command === null && toolUseId === null) return null;
	return { toolName, command, toolUseId };
}

function resultReading(
	toolUseId: string | null,
	isError: boolean,
	resultBytes: number | null,
): ToolResultReading | null {
	if (toolUseId === null && resultBytes === null && !isError) return null;
	return { toolUseId, isError, resultBytes };
}

/**
 * Claude-code emits Anthropic content-block shaped rows:
 *   tool_use:    {"type":"tool_use", "id": "...", "name": "Bash",
 *                 "input": {"command": "..."}}
 *   tool_result: {"type":"tool_result", "tool_use_id": "...",
 *                 "is_error": bool, "content": string | blocks}
 */
const CLAUDE_CODE_TOOL_SHAPE: ToolShape = {
	runtime: "claude-code",
	readToolUse(payload) {
		return useReading(
			toStr(payload.name),
			toStr(asRecord(payload.input)?.command),
			toStr(payload.id),
		);
	},
	readToolResult(payload) {
		return resultReading(
			toStr(payload.tool_use_id),
			payload.is_error === true,
			bytesOf(payload.content),
		);
	},
};

/**
 * Pi's rows arrive through burrow's `message_end` explosion in the same
 * normalized content-block shape as claude-code's, but pi-native fields
 * ride along in camelCase (`toolName`, `toolCallId`, `isError`, a
 * top-level `command`, and `result`/`output` bodies). Pi's own
 * `toolCall` blocks wrap the args in an `arguments` record instead of
 * `input` — `{"name":"bash","type":"toolCall","arguments":{"command":…}}`
 * is the shape production emits (warren-677c). The pi shape reads the
 * normalized fields first and falls back to the native ones.
 */
const PI_TOOL_SHAPE: ToolShape = {
	runtime: "pi",
	readToolUse(payload) {
		return useReading(
			firstStr(payload.name, payload.toolName),
			firstStr(
				asRecord(payload.input)?.command,
				asRecord(payload.arguments)?.command,
				payload.command,
			),
			firstStr(payload.id, payload.toolCallId, payload.tool_use_id),
		);
	},
	readToolResult(payload) {
		return resultReading(
			firstStr(payload.tool_use_id, payload.toolCallId, payload.id),
			payload.is_error === true || payload.isError === true,
			bytesOf(payload.content) ?? bytesOf(payload.result) ?? bytesOf(payload.output),
		);
	},
};

/**
 * The tool shapes, declared per runtime id. Keyed off
 * {@link KNOWN_RUNTIME_IDS} via `Partial<Record<RuntimeId, …>>`.
 */
export const TOOL_SHAPES: Readonly<Partial<Record<RuntimeId, ToolShape>>> = {
	"claude-code": CLAUDE_CODE_TOOL_SHAPE,
	pi: PI_TOOL_SHAPE,
};

/**
 * Look up the declared tool shape for a runtime id, or `null` when the
 * runtime's tool events are not covered. A `null` here
 * means "harness emitted no readable commands", never "commands did not
 * parse" — the reader returning `null` is the parse-failure signal.
 */
export function toolShapeFor(runtime: RuntimeId): ToolShape | null {
	return TOOL_SHAPES[runtime] ?? null;
}
