import { describe, expect, test } from "bun:test";
import { FILE_SHAPES, fileShapeFor } from "./file-shape.ts";
import { KNOWN_RUNTIME_IDS } from "./wire.ts";

describe("fileShape registry", () => {
	test("covers claude-code and pi", () => {
		expect(Object.keys(FILE_SHAPES).sort()).toEqual(["claude-code", "pi"]);
		expect(fileShapeFor("claude-code")?.runtime).toBe("claude-code");
		expect(fileShapeFor("pi")?.runtime).toBe("pi");
		for (const id of KNOWN_RUNTIME_IDS) {
			const shape = fileShapeFor(id);
			if (shape !== null) expect(shape.runtime).toBe(id);
		}
	});
});

describe("claude-code fileShape", () => {
	const shape = fileShapeFor("claude-code");
	if (shape === null) throw new Error("claude-code shape missing");

	test("reads file_path from Read/Edit/Write-class tool inputs", () => {
		for (const name of ["Read", "Write", "Edit", "MultiEdit"]) {
			expect(shape.readPaths({ name, input: { file_path: "src/core/wire.ts" } })).toEqual([
				"src/core/wire.ts",
			]);
		}
	});

	test("reads path from search-scope tools (Glob/Grep/LS)", () => {
		expect(shape.readPaths({ name: "Grep", input: { path: "src", pattern: "x" } })).toEqual([
			"src",
		]);
	});

	test("returns an empty list for non-file tools", () => {
		expect(shape.readPaths({ name: "Bash", input: { command: "ls" } })).toEqual([]);
		expect(shape.readPaths({ name: "WebFetch", input: { url: "https://x" } })).toEqual([]);
	});

	test("returns an empty list when the payload is unreadable or pathless", () => {
		expect(shape.readPaths({})).toEqual([]);
		expect(shape.readPaths({ name: "Read" })).toEqual([]);
		expect(shape.readPaths({ name: "Read", input: { file_path: 42 } })).toEqual([]);
		expect(shape.readPaths({ name: "read", input: { path: "x" } })).toEqual([]);
	});
});

describe("pi fileShape", () => {
	const shape = fileShapeFor("pi");
	if (shape === null) throw new Error("pi shape missing");

	test("reads pi-native lowercase path tools", () => {
		expect(shape.readPaths({ name: "read", input: { path: "AGENTS.md" } })).toEqual(["AGENTS.md"]);
		expect(shape.readPaths({ toolName: "edit", input: { path: "src/a.ts" } })).toEqual([
			"src/a.ts",
		]);
	});

	test("reads the normalized Anthropic shape too", () => {
		expect(shape.readPaths({ name: "Write", input: { file_path: "docs/x.md" } })).toEqual([
			"docs/x.md",
		]);
	});

	test("reads the pi-native toolCall block with the arguments wrapper (warren-677c)", () => {
		// The exact shape production emits: 3,944/3,944 pi edit/read/write
		// rows landed with empty file_paths because only `input` was read.
		expect(shape.readPaths({ name: "read", type: "toolCall", arguments: { path: "AGENTS.md" } })) //
			.toEqual(["AGENTS.md"]);
		expect(shape.readPaths({ name: "edit", arguments: { path: "src/a.ts" } })).toEqual([
			"src/a.ts",
		]);
		expect(shape.readPaths({ name: "write", arguments: { file_path: "docs/x.md" } })).toEqual([
			"docs/x.md",
		]);
	});

	test("prefers input paths over arguments paths when both are present", () => {
		expect(
			shape.readPaths({
				name: "read",
				input: { path: "from-input.ts" },
				arguments: { path: "from-arguments.ts" },
			}),
		).toEqual(["from-input.ts"]);
	});

	test("returns an empty list for non-file tools and unreadable payloads", () => {
		expect(shape.readPaths({ name: "bash", input: { command: "pwd" } })).toEqual([]);
		expect(shape.readPaths({ name: "bash", arguments: { command: "pwd" } })).toEqual([]);
		expect(shape.readPaths({})).toEqual([]);
	});
});

describe("claude-code fileShape ignores the arguments dialect", () => {
	const shape = fileShapeFor("claude-code");
	if (shape === null) throw new Error("claude-code shape missing");

	test("arguments wrapper belongs to pi", () => {
		expect(shape.readPaths({ name: "Read", arguments: { file_path: "x.ts" } })).toEqual([]);
	});
});
