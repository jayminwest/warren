import { describe, expect, test } from "bun:test";
import {
	extractToolResult,
	extractToolUse,
	runtimeFromRenderedAgent,
} from "./tool-call-extract.ts";

describe("extractToolUse", () => {
	test("reads the claude-code (Anthropic content-block) dialect", () => {
		const out = extractToolUse("claude-code", {
			type: "tool_use",
			id: "u1",
			name: "Bash",
			input: { command: "bun test" },
		});
		expect(out).toEqual({
			toolName: "Bash",
			command: "bun test",
			toolUseId: "u1",
			filePaths: [],
		});
	});

	test("reads the pi-native camelCase dialect", () => {
		const out = extractToolUse("pi", {
			toolName: "bash",
			command: "git status",
			toolCallId: "c1",
		});
		expect(out.toolName).toBe("bash");
		expect(out.command).toBe("git status");
		expect(out.toolUseId).toBe("c1");
	});

	test("extracts file paths through the fileShape registry", () => {
		const out = extractToolUse("claude-code", {
			name: "Read",
			id: "r1",
			input: { file_path: "/src/index.ts" },
		});
		expect(out.command).toBeNull();
		expect(out.filePaths).toEqual(["/src/index.ts"]);
		// pi's native file tools are path-keyed.
		expect(
			extractToolUse("pi", { toolName: "edit", input: { path: "a.ts" }, id: "p" }).filePaths,
		).toEqual(["a.ts"]);
	});

	test("lands the all-null extraction for unreadable payloads", () => {
		const empty = { toolName: null, command: null, toolUseId: null, filePaths: [] };
		expect(extractToolUse("pi", null)).toEqual(empty);
		expect(extractToolUse("pi", "garbage")).toEqual(empty);
		expect(extractToolUse("pi", { input: { command: "" } })).toEqual(empty);
	});

	test("lands the all-null extraction for an unattributed runtime", () => {
		const empty = { toolName: null, command: null, toolUseId: null, filePaths: [] };
		expect(extractToolUse(null, { name: "Bash", input: { command: "git status" } })).toEqual(empty);
	});
});

describe("extractToolResult", () => {
	test("reads the claude-code dialect with byte size of the result body", () => {
		const out = extractToolResult("claude-code", {
			type: "tool_result",
			tool_use_id: "u1",
			is_error: true,
			content: "boom",
		});
		expect(out).toEqual({ toolUseId: "u1", isError: true, resultBytes: 4 });
	});

	test("reads the pi dialect (isError + result/output bodies)", () => {
		const out = extractToolResult("pi", { toolCallId: "c1", isError: true, result: "fail" });
		expect(out).toEqual({ toolUseId: "c1", isError: true, resultBytes: 4 });
	});

	test("returns null when no join id is present (nothing to update)", () => {
		expect(extractToolResult("claude-code", { is_error: true })).toBeNull();
		expect(extractToolResult("claude-code", null)).toBeNull();
		expect(extractToolResult(null, { tool_use_id: "u1" })).toBeNull();
	});
});

describe("runtimeFromRenderedAgent", () => {
	test("reads a valid frontmatter.runtime", () => {
		expect(runtimeFromRenderedAgent({ frontmatter: { runtime: "pi" } })).toBe("pi");
	});

	test("falls back to the default runtime for missing/invalid values", () => {
		expect(runtimeFromRenderedAgent({ frontmatter: {} })).toBe("pi");
		expect(runtimeFromRenderedAgent({ frontmatter: { runtime: "nope" } })).toBe("pi");
		expect(runtimeFromRenderedAgent(null)).toBe("pi");
		expect(runtimeFromRenderedAgent("garbage")).toBe("pi");
	});
});
