import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractEdges, ModuleGraph, resolveSpec } from "./layer-graph.ts";

function edgeSummary(text: string): string[] {
	return extractEdges(text).map((e) => `${e.kind}${e.runtime ? "" : ":type"}@${e.line} ${e.spec}`);
}

describe("extractEdges", () => {
	test("sees static, side-effect, multi-line and re-export forms with specifier lines", () => {
		const text = [
			'import { x } from "../server/types.ts";',
			'import "@os-eco/burrow-cli";',
			"import {",
			"	a,",
			'} from "../../seeds-cli/index.ts";',
			'export { y } from "./types.ts";',
			'export * as ns from "./ns.ts";',
		].join("\n");
		expect(edgeSummary(text)).toEqual([
			"import@1 ../server/types.ts",
			"import@2 @os-eco/burrow-cli",
			"import@5 ../../seeds-cli/index.ts",
			"reexport@6 ./types.ts",
			"reexport@7 ./ns.ts",
		]);
	});

	test("sees dynamic import(), require() and import-equals-require as runtime edges", () => {
		const text = [
			"export async function load() {",
			'	const m = await import("../server/main.ts");',
			'	const r = require("../legacy/mod.ts");',
			"}",
			'import eq = require("./eq.ts");',
		].join("\n");
		expect(edgeSummary(text)).toEqual([
			"dynamic@2 ../server/main.ts",
			"require@3 ../legacy/mod.ts",
			"require@5 ./eq.ts",
		]);
	});

	test("marks import type and export type as erased (non-runtime) edges", () => {
		const text = [
			'import type { B } from "../server/types.ts";',
			'export type { RunRow } from "../db/schema.ts";',
			'import { type C, d } from "./mixed.ts";',
		].join("\n");
		expect(edgeSummary(text)).toEqual([
			"import:type@1 ../server/types.ts",
			"reexport:type@2 ../db/schema.ts",
			"import@3 ./mixed.ts",
		]);
	});

	test("specifiers inside comments, strings and template literals are not edges", () => {
		const text = [
			'// import { a } from "../server/comment.ts";',
			'/* export { b } from "../server/block.ts"; */',
			' * see `from "../server/doc.ts"`',
			"const s = 'from \"../server/string.ts\"';",
			"const t = `value " + "${" + " '../server/tpl.ts' }`;",
			'const re = /from "..\\/server\\/regex.ts"/;',
		].join("\n");
		expect(edgeSummary(text)).toEqual([]);
	});

	test("a dynamic import inside a template substitution is still an edge", () => {
		const text = "const t = `" + "${" + " await import('../server/main.ts') }`;\n";
		expect(edgeSummary(text)).toEqual(["dynamic@1 ../server/main.ts"]);
	});
});

describe("resolveSpec", () => {
	test("resolves a relative specifier against the importing file", () => {
		expect(resolveSpec("src/plan-runs/dispatch.ts", "../server/types.ts")).toBe(
			"src/server/types.ts",
		);
	});

	test("bare package specifiers pass through untouched", () => {
		expect(resolveSpec("src/runtime/k8s/agent.ts", "@os-eco/burrow-cli")).toBe(
			"@os-eco/burrow-cli",
		);
	});
});

describe("ModuleGraph.resolveTargets — the laundering walk", () => {
	function withRepo(files: Record<string, string>, run: (dir: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), "layer-graph-"));
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

	const NOT_TEST = (rel: string): boolean => rel.endsWith(".test.ts");

	function graph(dir: string): ModuleGraph {
		return new ModuleGraph(dir, { repoPrefixes: ["src/"], isTestFile: NOT_TEST });
	}

	test("follows a runtime re-export chain transitively, direct target first", () => {
		withRepo(
			{
				"src/a.ts": 'export { b } from "./b.ts";\n',
				"src/b.ts": 'export * from "./c.ts";\n',
				"src/c.ts": "export const c = 1;\n",
			},
			(dir) => {
				const g = graph(dir);
				const edge = g.edgesFor("src/consumer.ts", 'import { b } from "./a.ts";\n')[0];
				expect(edge).toBeDefined();
				if (edge === undefined) return;
				expect(g.resolveTargets("src/consumer.ts", edge).map((t) => t.target)).toEqual([
					"src/a.ts",
					"src/b.ts",
					"src/c.ts",
				]);
			},
		);
	});

	test("does not follow type-only re-export edges or type-only importer edges", () => {
		withRepo(
			{
				"src/a.ts": 'export type { T } from "./b.ts";\nexport const a = 1;\n',
				"src/b.ts": "export type T = string;\n",
			},
			(dir) => {
				const g = graph(dir);
				const runtime = g.edgesFor("src/c.ts", 'import { a } from "./a.ts";\n')[0];
				if (runtime === undefined) throw new Error("no edge");
				expect(g.resolveTargets("src/c.ts", runtime).map((t) => t.target)).toEqual(["src/a.ts"]);
				const typeOnly = g.edgesFor("src/d.ts", 'import type { a } from "./a.ts";\n')[0];
				if (typeOnly === undefined) throw new Error("no edge");
				expect(g.resolveTargets("src/d.ts", typeOnly).map((t) => t.target)).toEqual(["src/a.ts"]);
			},
		);
	});

	test("terminates on a re-export cycle", () => {
		withRepo(
			{
				"src/a.ts": 'export { b } from "./b.ts";\nexport const a = 1;\n',
				"src/b.ts": 'export { a } from "./a.ts";\nexport const b = 1;\n',
			},
			(dir) => {
				const g = graph(dir);
				const edge = g.edgesFor("src/c.ts", 'import { a } from "./a.ts";\n')[0];
				if (edge === undefined) throw new Error("no edge");
				const targets = g.resolveTargets("src/c.ts", edge).map((t) => t.target);
				expect(targets).toContain("src/a.ts");
				expect(targets).toContain("src/b.ts");
				expect(targets).toHaveLength(2);
			},
		);
	});

	test("resolves extensionless and directory-index specifiers when following", () => {
		withRepo(
			{
				"src/a/index.ts": 'export { b } from "../b";\n',
				"src/b.ts": "export const b = 1;\n",
			},
			(dir) => {
				const g = graph(dir);
				const edge = g.edgesFor("src/c.ts", 'import { b } from "./a/index.ts";\n')[0];
				if (edge === undefined) throw new Error("no edge");
				expect(g.resolveTargets("src/c.ts", edge).map((t) => t.target)).toEqual([
					"src/a/index.ts",
					"src/b.ts",
				]);
			},
		);
	});

	test("does not follow into package specifiers, test files, or missing modules", () => {
		withRepo(
			{
				"src/a.ts": [
					'export { x } from "octokit";',
					'export { t } from "./helper.test.ts";',
					'export { g } from "./gone.ts";',
					"export const a = 1;",
				].join("\n"),
			},
			(dir) => {
				const g = graph(dir);
				const edge = g.edgesFor("src/c.ts", 'import { a } from "./a.ts";\n')[0];
				if (edge === undefined) throw new Error("no edge");
				const targets = g.resolveTargets("src/c.ts", edge).map((t) => t.target);
				expect(targets).toEqual(["src/a.ts", "octokit", "src/helper.test.ts", "src/gone.ts"]);
			},
		);
	});
});
