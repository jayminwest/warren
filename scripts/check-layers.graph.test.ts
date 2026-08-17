import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadRules, scan } from "./check-layers.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The real manifest — fixture trees are scanned against the shipped rules. */
const RULES = loadRules(REPO_ROOT);

/** Write a fake repo whose `src/` tree holds `files`, then scan it. */
function withFixtureRepo(files: Record<string, string>, run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "warren-layers-"));
	try {
		for (const [rel, text] of Object.entries(files)) {
			const abs = join(dir, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, text);
		}
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("scan — the module-graph edges warren-d382 added", () => {
	test("flags a dynamic import() crossing a seam, invisible to the old regex", () => {
		withFixtureRepo(
			{
				"src/projects/lazy.ts":
					'export async function boot() {\n\treturn await import("../server/main/index.ts");\n}\n',
			},
			(dir) => {
				expect(scan(dir, RULES)).toEqual([
					{
						rule: "domain-owns-the-logic",
						file: "src/projects/lazy.ts",
						line: 2,
						reason: 'imports "../server/main/index.ts"',
					},
				]);
			},
		);
	});

	test("flags a require() crossing a seam", () => {
		withFixtureRepo(
			{ "src/runs/legacy.ts": 'const c = require("../server/main/index.ts");\n' },
			(dir) => {
				expect(scan(dir, RULES).map((v) => v.rule)).toEqual(["domain-owns-the-logic"]);
			},
		);
	});

	test("flags a laundered re-export: C imports A, A re-exports forbidden B", () => {
		withFixtureRepo(
			{
				"src/runs/launderer.ts": 'export { bootServer } from "../server/main/index.ts";\n',
				"src/runs/consumer.ts": 'import { bootServer } from "./launderer.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES).map((v) => `${v.file}:${v.line} ${v.reason}`)).toEqual([
					'src/runs/consumer.ts:1 imports "./launderer.ts" — laundered: ' +
						'src/runs/launderer.ts:1 re-exports "../server/main/index.ts" resolves to "src/server/main/index.ts"',
					'src/runs/launderer.ts:1 imports "../server/main/index.ts"',
				]);
			},
		);
	});

	test("a type-only re-export does not launder — the warren-02c9 barrel stays legitimate", () => {
		withFixtureRepo(
			{
				"src/db/schema.ts": "export interface RunRow { id: string }\n",
				"src/runs/index.ts": 'export type { RunRow } from "../db/schema.ts";\n',
				"src/server/handlers/ok.ts": 'import type { RunRow } from "../../runs/index.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES)).toEqual([]);
			},
		);
	});

	test("the allow list exempts a module's own edges but does not launder them for others", () => {
		withFixtureRepo(
			{
				// src/cli/commands/serve.ts is on the cli-is-a-consumer allow list:
				// its own server import is exempt. A CLI file outside the allow list
				// that imports serve.ts still reaches the server — and is flagged.
				"src/cli/commands/serve.ts": 'export { bootServer } from "../../server/main/index.ts";\n',
				"src/cli/commands/other.ts": 'import { bootServer } from "./serve.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES).map((v) => `${v.file}:${v.line}`)).toEqual([
					"src/cli/commands/other.ts:1",
				]);
			},
		);
	});
});
