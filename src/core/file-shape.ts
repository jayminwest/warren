/**
 * Typed per-runtime file-path readers (warren-c116 / pl-103e step 8;
 * AgentRuntimeAdapter phase-1 material, the `fileShape` direction —
 * landed pre-adapter the same way `usageShape` did, per the plan's
 * sequencing note on GH#846).
 *
 * Sibling to `tool-shape.ts`: where that module reads the command a
 * tool call carries, this one reads the file paths a Read/Edit/Write-
 * class tool call touches. It is the data feed for the per-directory
 * difficulty insight — which paths agents keep re-reading and
 * re-editing is the raw signal for "this directory is hard to work
 * in". The rollup table that consumes it is warren-7746; this module
 * is only the pure, unit-tested extractor.
 *
 * Sapling is intentionally uncovered: it is being retired, so
 * {@link FILE_SHAPES} declares `claude-code` and `pi` only.
 *
 * `src/core/` imports nothing outside itself (check:layers), so the
 * readers are dependency-free and structural.
 */

import type { RuntimeId } from "./wire.ts";

/**
 * The declared file-touch knowledge for one runtime: given a `tool_use`
 * payload, return the file paths the call touches. Non-file tools
 * (Bash, web fetches, task orchestration) and unreadable payloads both
 * yield an empty list — path extraction has no failure channel worth
 * distinguishing, because a file-class call missing its path is
 * indistinguishable from a schema revision neither side has seen.
 */
export interface FileShape {
	readonly runtime: RuntimeId;
	readPaths(payload: Record<string, unknown>): readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function toStr(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Tool-name → input keys carrying file paths, for Anthropic-shaped
 * tool_use rows. `file_path` tools touch exactly one file; `path`
 * tools (Glob/Grep/LS) scope a search to a directory, which is still a
 * meaningful "touched" signal for per-directory rollups.
 */
const ANTHROPIC_FILE_TOOLS: Readonly<Record<string, readonly string[]>> = {
	Read: ["file_path"],
	Write: ["file_path"],
	Edit: ["file_path"],
	MultiEdit: ["file_path"],
	NotebookEdit: ["notebook_path", "file_path"],
	Glob: ["path"],
	Grep: ["path"],
	LS: ["path"],
};

/**
 * Pi's native file tools are lowercase and path-keyed (`read`, `edit`,
 * `write` take `path`). Pi's rows also arrive normalized into the
 * Anthropic content-block shape by burrow's `message_end` explosion, so
 * the pi shape reads both dialects.
 */
const PI_FILE_TOOLS: Readonly<Record<string, readonly string[]>> = {
	...ANTHROPIC_FILE_TOOLS,
	read: ["path", "file_path"],
	write: ["path", "file_path"],
	edit: ["path", "file_path"],
};

function readPathsWith(
	payload: Record<string, unknown>,
	table: Readonly<Record<string, readonly string[]>>,
	nameKeys: readonly string[],
): readonly string[] {
	let name: string | null = null;
	for (const key of nameKeys) {
		name = toStr(payload[key]);
		if (name !== null) break;
	}
	if (name === null) return [];
	const keys = table[name];
	if (keys === undefined) return [];
	const input = asRecord(payload.input);
	if (input === null) return [];
	const out: string[] = [];
	for (const key of keys) {
		const p = toStr(input[key]);
		if (p !== null) out.push(p);
	}
	return out;
}

const CLAUDE_CODE_FILE_SHAPE: FileShape = {
	runtime: "claude-code",
	readPaths(payload) {
		return readPathsWith(payload, ANTHROPIC_FILE_TOOLS, ["name"]);
	},
};

const PI_FILE_SHAPE: FileShape = {
	runtime: "pi",
	readPaths(payload) {
		return readPathsWith(payload, PI_FILE_TOOLS, ["name", "toolName"]);
	},
};

/**
 * The file shapes, declared per runtime id. Keyed off
 * {@link KNOWN_RUNTIME_IDS} via `Partial<Record<RuntimeId, …>>` —
 * sapling, being retired, is deliberately absent.
 */
export const FILE_SHAPES: Readonly<Partial<Record<RuntimeId, FileShape>>> = {
	"claude-code": CLAUDE_CODE_FILE_SHAPE,
	pi: PI_FILE_SHAPE,
};

/**
 * Look up the declared file shape for a runtime id, or `null` when the
 * runtime's tool events are not covered (sapling today).
 */
export function fileShapeFor(runtime: RuntimeId): FileShape | null {
	return FILE_SHAPES[runtime] ?? null;
}
