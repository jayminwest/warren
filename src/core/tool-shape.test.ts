import { describe, expect, test } from "bun:test";
import { TOOL_SHAPES, toolShapeFor } from "./tool-shape.ts";
import { KNOWN_RUNTIME_IDS } from "./wire.ts";

describe("toolShape registry", () => {
	test("covers claude-code and pi", () => {
		expect(Object.keys(TOOL_SHAPES).sort()).toEqual(["claude-code", "pi"]);
		expect(toolShapeFor("claude-code")?.runtime).toBe("claude-code");
		expect(toolShapeFor("pi")?.runtime).toBe("pi");
		for (const id of KNOWN_RUNTIME_IDS) {
			const shape = toolShapeFor(id);
			if (shape !== null) expect(shape.runtime).toBe(id);
		}
	});

	test("every declared shape's runtime matches its registry key", () => {
		for (const [key, shape] of Object.entries(TOOL_SHAPES)) {
			expect(key).toBe(shape?.runtime ?? "");
		}
	});
});

describe("claude-code toolShape", () => {
	const shape = toolShapeFor("claude-code");
	if (shape === null) throw new Error("claude-code shape missing");

	test("reads an Anthropic-shaped Bash tool_use", () => {
		const reading = shape.readToolUse({
			type: "tool_use",
			id: "toolu_1",
			name: "Bash",
			input: { command: "bun test" },
		});
		expect(reading).toEqual({ toolName: "Bash", command: "bun test", toolUseId: "toolu_1" });
	});

	test("reads a structured tool_use with no command", () => {
		const reading = shape.readToolUse({
			type: "tool_use",
			id: "toolu_2",
			name: "Read",
			input: { file_path: "src/index.ts" },
		});
		expect(reading).toEqual({ toolName: "Read", command: null, toolUseId: "toolu_2" });
	});

	test("returns null for a payload with no tool fields (parse failure)", () => {
		expect(shape.readToolUse({})).toBeNull();
		expect(shape.readToolUse({ type: "text", text: "hello" })).toBeNull();
	});

	test("reads a string-bodied tool_result with the join id and error flag", () => {
		const reading = shape.readToolResult({
			type: "tool_result",
			tool_use_id: "toolu_1",
			is_error: true,
			content: "boom",
		});
		expect(reading).toEqual({ toolUseId: "toolu_1", isError: true, resultBytes: 4 });
	});

	test("reads a block-array tool_result and sizes it serialized", () => {
		const content = [{ type: "text", text: "ok" }];
		const reading = shape.readToolResult({
			tool_use_id: "toolu_1",
			is_error: false,
			content,
		});
		expect(reading?.toolUseId).toBe("toolu_1");
		expect(reading?.isError).toBe(false);
		expect(reading?.resultBytes).toBe(JSON.stringify(content).length);
	});

	test("ignores camelCase fields — that dialect belongs to pi", () => {
		expect(shape.readToolResult({ tool_use_id: "x", isError: true })).toEqual({
			toolUseId: "x",
			isError: false,
			resultBytes: null,
		});
	});

	test("returns null for a tool_result with no join id, body, or error", () => {
		expect(shape.readToolResult({ type: "tool_result" })).toBeNull();
	});
});

describe("pi toolShape", () => {
	const shape = toolShapeFor("pi");
	if (shape === null) throw new Error("pi shape missing");

	test("reads the normalized content-block shape burrow emits", () => {
		const reading = shape.readToolUse({
			type: "tool_use",
			id: "call_1",
			name: "bash",
			input: { command: "git status" },
		});
		expect(reading).toEqual({ toolName: "bash", command: "git status", toolUseId: "call_1" });
	});

	test("reads the pi-native toolCall block with the arguments wrapper (warren-677c)", () => {
		// The exact shape production emits: 10,583/10,583 pi bash rows
		// landed command=NULL because only input/command were read.
		const reading = shape.readToolUse({
			name: "bash",
			type: "toolCall",
			id: "call_7",
			arguments: { command: "bun run check:all" },
		});
		expect(reading).toEqual({
			toolName: "bash",
			command: "bun run check:all",
			toolUseId: "call_7",
		});
	});

	test("prefers input.command over arguments.command over top-level command", () => {
		expect(
			shape.readToolUse({
				name: "bash",
				input: { command: "from-input" },
				arguments: { command: "from-arguments" },
				command: "from-top",
			})?.command,
		).toBe("from-input");
		expect(
			shape.readToolUse({
				name: "bash",
				arguments: { command: "from-arguments" },
				command: "from-top",
			})?.command,
		).toBe("from-arguments");
	});

	test("falls back to pi-native camelCase fields", () => {
		const reading = shape.readToolUse({
			toolName: "bash",
			command: "sd ready",
			toolCallId: "call_2",
		});
		expect(reading).toEqual({ toolName: "bash", command: "sd ready", toolUseId: "call_2" });
	});

	test("prefers the normalized fields when both dialects are present", () => {
		const reading = shape.readToolUse({
			id: "call_3",
			toolCallId: "native_3",
			name: "bash",
			input: { command: "bun run lint" },
			command: "ignored",
		});
		expect(reading).toEqual({
			toolName: "bash",
			command: "bun run lint",
			toolUseId: "call_3",
		});
	});

	test("reads both is_error and isError on tool_result", () => {
		expect(shape.readToolResult({ tool_use_id: "a", is_error: true })?.isError).toBe(true);
		expect(shape.readToolResult({ toolCallId: "b", isError: true })?.isError).toBe(true);
		expect(shape.readToolResult({ tool_use_id: "c", content: "ok" })?.isError).toBe(false);
	});

	test("sizes result/output bodies when content is absent", () => {
		expect(shape.readToolResult({ toolCallId: "a", result: "done" })?.resultBytes).toBe(4);
		expect(shape.readToolResult({ toolCallId: "a", output: "stdout!" })?.resultBytes).toBe(7);
	});

	test("returns null for a payload with no tool fields (parse failure)", () => {
		expect(shape.readToolUse({ type: "message" })).toBeNull();
		expect(shape.readToolResult({})).toBeNull();
	});
});
