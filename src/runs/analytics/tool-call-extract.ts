/**
 * Tool-call rollup extraction (warren-7746 / pl-103e step 9).
 *
 * Thin, pure seam between the per-runtime shape registries
 * (`src/core/tool-shape.ts` + `src/core/file-shape.ts`, warren-c116) and
 * the `tool_calls` rollup table. Both rollup writers — the stream bridge
 * (populate at event-append time) and the boot-time backfill
 * (`src/runs/tool-calls-backfill.ts`) — funnel through here so a shape
 * revision lands in exactly one place.
 *
 * Null semantics are the extraction report the `tool_calls` schema
 * documents: a `tool_use` payload its runtime's shape cannot read at all
 * extracts to all-null fields (the registry's exact parse-failure
 * condition), which the command-mining coverage rollup later counts as
 * unparsed. An UNCOVERED runtime (no declared shape)
 * extracts to the same all-null row — the coverage rollup distinguishes
 * the two via its `shaped` flag, so nothing is laundered.
 */

import { fileShapeFor } from "../../core/file-shape.ts";
import { toolShapeFor } from "../../core/tool-shape.ts";
import { isKnownRuntimeId, type RuntimeId } from "../../core/wire.ts";
import { DEFAULT_RUNTIME_ID } from "../../registry/schema.ts";

/** Structured fields extracted from one `tool_use` event payload. */
export interface ToolUseExtraction {
	readonly toolName: string | null;
	readonly command: string | null;
	readonly toolUseId: string | null;
	/** File paths the call touches (fileShape registry); empty when none. */
	readonly filePaths: readonly string[];
}

/** Structured fields extracted from one `tool_result` event payload. */
export interface ToolResultExtraction {
	/** Non-null by construction: an extraction without a join id is dropped. */
	readonly toolUseId: string;
	readonly isError: boolean;
	readonly resultBytes: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

const EMPTY_USE: ToolUseExtraction = {
	toolName: null,
	command: null,
	toolUseId: null,
	filePaths: [],
};

/**
 * Extract the rollup fields from one `tool_use` payload through the
 * runtime's declared shapes. Returns the all-null extraction when the
 * payload is not an object, the runtime has no declared shape, or the
 * shape rejects the payload — never throws, never returns null, so the
 * caller always lands a row (an unparsed tool call still counts toward
 * per-runtime coverage).
 */
export function extractToolUse(runtime: RuntimeId | null, payload: unknown): ToolUseExtraction {
	const record = asRecord(payload);
	if (record === null || runtime === null) return EMPTY_USE;
	const reading = toolShapeFor(runtime)?.readToolUse(record) ?? null;
	if (reading === null) return EMPTY_USE;
	return {
		toolName: reading.toolName,
		command: reading.command,
		toolUseId: reading.toolUseId,
		filePaths: fileShapeFor(runtime)?.readPaths(record) ?? [],
	};
}

/**
 * Extract the result-join fields from one `tool_result` payload. Returns
 * `null` when the payload carries no join id — there is no row to update
 * without it, so the caller skips the write. An unreadable-but-id-bearing
 * payload still updates `is_error`/`result_bytes` from what did parse.
 */
export function extractToolResult(
	runtime: RuntimeId | null,
	payload: unknown,
): ToolResultExtraction | null {
	const record = asRecord(payload);
	if (record === null || runtime === null) return null;
	const reading = toolShapeFor(runtime)?.readToolResult(record) ?? null;
	if (reading === null || reading.toolUseId === null) return null;
	return {
		toolUseId: reading.toolUseId,
		isError: reading.isError,
		resultBytes: reading.resultBytes,
	};
}

/**
 * Resolve a run's runtime id from its frozen `rendered_agent_json`
 * frontmatter (warren-c116's `runtimeOfRun`, moved here so the bridge,
 * the backfill, and the analytics handler share one resolution site).
 * Precedence mirrors `readRuntimeId` minus the config override (dispatch
 * already froze the choice into the rendered definition): a valid
 * `frontmatter.runtime` wins, anything else falls back to the default
 * runtime.
 */
export function runtimeFromRenderedAgent(renderedAgentJson: unknown): RuntimeId {
	if (renderedAgentJson !== null && typeof renderedAgentJson === "object") {
		const fm = (renderedAgentJson as Record<string, unknown>).frontmatter;
		if (fm !== null && typeof fm === "object") {
			const r = (fm as Record<string, unknown>).runtime;
			if (isKnownRuntimeId(r)) return r;
		}
	}
	return DEFAULT_RUNTIME_ID;
}
