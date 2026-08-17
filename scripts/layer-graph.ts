/**
 * Module-graph extraction for scripts/check-layers.ts (warren-d382).
 *
 * The guard's first cut matched import specifiers with a line regex, which
 * made three edge shapes invisible:
 *
 *   1. dynamic `await import(…)` expressions,
 *   2. laundered re-exports — module A re-exports from forbidden module B,
 *      module C imports A, and the C→B edge never appears on any line of C,
 *   3. `export … from` forms the regex did not recognise, and CommonJS
 *      `require(…)` calls.
 *
 * This module closes that with a real scan. The repo pins typescript@7, the
 * native tsgo port, whose npm package exposes no JS compiler API — so instead
 * of a line regex the extractor below is a single-pass, comment- and
 * string-aware tokenizer over the source text. It tracks line, block and
 * template-literal state (including `${}` substitution nesting), so a
 * specifier mentioned in a comment or a string literal is never an edge,
 * multi-line import statements resolve to their specifier's line, and
 * `import type` / `export type` are recognised as erased-at-compile-time.
 *
 * The laundering walk follows RUNTIME re-export edges only. A type-only edge
 * (`import type`, `export type`) is erased at compile time, so following it
 * would flag coupling that does not exist — the domain barrels legitimately
 * re-export row types with `export type { RunRow } from "../db/schema.ts"`
 * (warren-02c9), and a handler importing that type has no runtime dependency
 * on the schema module. A value re-export is different: C's bundle really
 * does pull B in, so the seam rule fires as if C had imported B directly.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** One module-reference edge found in a source file. */
export interface ModuleEdge {
	/** The specifier exactly as written (`../server/types.ts`, `octokit`). */
	readonly spec: string;
	/** 1-based line of the string literal, matching the old regex's report. */
	readonly line: number;
	/**
	 * False for `import type` / `export type` edges, which are erased at
	 * compile time and so cannot launder a runtime dependency.
	 */
	readonly runtime: boolean;
	readonly kind: "import" | "reexport" | "dynamic" | "require";
}

/** A resolved import target: the direct edge plus anything laundered through it. */
export interface EdgeTarget {
	/** Repo-relative POSIX path for relative specifiers, the bare name otherwise. */
	readonly target: string;
	/** Line of the importing edge in the scanned file. */
	readonly line: number;
	/** The specifier as written in the scanned file. */
	readonly spec: string;
	/** Set when this target was reached through a re-export chain. */
	readonly via?: string;
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

/**
 * The repo-relative target a specifier names. Relative specifiers resolve
 * against the importing file so a prefix rule compares like with like; bare
 * package specifiers pass through untouched.
 */
export function resolveSpec(rel: string, spec: string): string {
	if (!spec.startsWith(".")) return spec;
	return join(dirname(rel), spec).split("\\").join("/");
}

function isIdentStart(c: string): boolean {
	return /[A-Za-z_$]/.test(c);
}

function isIdentChar(c: string): boolean {
	return /[\w$]/.test(c);
}

function isQuote(c: string): boolean {
	return c === '"' || c === "'";
}

/** Mutable scan state over one file's text: position plus 1-based line. */
interface Cursor {
	i: number;
	line: number;
}

function advance(cur: Cursor, text: string, to: number): void {
	while (cur.i < to) {
		if (text[cur.i] === "\n") cur.line++;
		cur.i++;
	}
}

function skipWhitespace(cur: Cursor, text: string): void {
	while (cur.i < text.length && /\s/.test(text[cur.i] ?? "")) {
		if (text[cur.i] === "\n") cur.line++;
		cur.i++;
	}
}

/** Consume one comment at the cursor; true when one was consumed. */
function skipComment(cur: Cursor, text: string): boolean {
	if (text.startsWith("//", cur.i)) {
		while (cur.i < text.length && text[cur.i] !== "\n") cur.i++;
		return true;
	}
	if (!text.startsWith("/*", cur.i)) return false;
	const end = text.indexOf("*/", cur.i + 2);
	advance(cur, text, end === -1 ? text.length : end + 2);
	return end !== -1;
}

/** Skip whitespace and comments; returns false if the file ran out. */
function skipTrivia(cur: Cursor, text: string): boolean {
	for (;;) {
		skipWhitespace(cur, text);
		if (!text.startsWith("//", cur.i) && !text.startsWith("/*", cur.i)) {
			return cur.i < text.length;
		}
		if (!skipComment(cur, text)) return false;
	}
}

/** Skip a quoted string starting at text[cur.i]; returns the literal text. */
function readString(cur: Cursor, text: string): string {
	const quote = text[cur.i] ?? "";
	let out = "";
	cur.i++;
	while (cur.i < text.length) {
		const c = text[cur.i] ?? "";
		if (c === "\\") {
			advance(cur, text, cur.i + 2);
			continue;
		}
		cur.i++;
		if (c === quote) return out;
		out += c;
	}
	return out;
}

/** Read an identifier starting at text[cur.i]; the caller checked isIdentStart. */
function readWord(cur: Cursor, text: string): string {
	let out = "";
	while (cur.i < text.length && isIdentChar(text[cur.i] ?? "")) {
		out += text[cur.i];
		cur.i++;
	}
	return out;
}

/**
 * Consume one non-code atom at the cursor — a string literal, a template
 * literal, or a comment. Returns true when something was consumed.
 */
function skipAtom(cur: Cursor, text: string, edges: ModuleEdge[]): boolean {
	const c = text[cur.i] ?? "";
	if (isQuote(c)) {
		readString(cur, text);
		return true;
	}
	if (c === "`") {
		skipTemplate(cur, text, edges);
		return true;
	}
	if (c === "/" && (text[cur.i + 1] === "/" || text[cur.i + 1] === "*")) {
		skipTrivia(cur, text);
		return true;
	}
	return false;
}

/**
 * Skip a template literal starting at the backtick. A `${}` substitution is
 * code, not text — one holding a dynamic import is a real edge — so the
 * scanner recurses into it with scanInto at brace depth 1.
 */
function skipTemplate(cur: Cursor, text: string, edges: ModuleEdge[]): void {
	cur.i++;
	while (cur.i < text.length) {
		const c = text[cur.i] ?? "";
		if (c === "\\") {
			advance(cur, text, cur.i + 2);
			continue;
		}
		if (c === "`") {
			cur.i++;
			return;
		}
		if (c === "$" && text[cur.i + 1] === "{") {
			advance(cur, text, cur.i + 2);
			scanInto(cur, text, edges, 1);
			continue;
		}
		if (c === "\n") cur.line++;
		cur.i++;
	}
}

/** A `require(…)` call at the cursor's `require` word, or undefined. */
function readRequireCall(cur: Cursor, text: string): ModuleEdge | undefined {
	const save = { ...cur };
	if (!skipTrivia(cur, text) || text[cur.i] !== "(") {
		Object.assign(cur, save);
		return undefined;
	}
	cur.i++;
	if (!skipTrivia(cur, text) || !isQuote(text[cur.i] ?? "")) {
		Object.assign(cur, save);
		return undefined;
	}
	const specLine = cur.line;
	const spec = readString(cur, text);
	return { spec, line: specLine, runtime: true, kind: "require" };
}

/** One identifier inside an import/export statement, or "continue" scanning. */
function fromClauseWord(
	cur: Cursor,
	text: string,
	kind: "import" | "reexport",
	typeOnly: boolean,
	depth: number,
): ModuleEdge | "continue" | undefined {
	const wordStart = cur.i;
	const word = readWord(cur, text);
	if (word === "from" && depth === 0) {
		if (!skipTrivia(cur, text)) return undefined;
		if (!isQuote(text[cur.i] ?? "")) {
			cur.i = wordStart + 4;
			return "continue"; // `from` used as an identifier, not the clause
		}
		const specLine = cur.line;
		const spec = readString(cur, text);
		return { spec, line: specLine, runtime: !typeOnly, kind };
	}
	if (word === "require" && kind === "import") {
		const req = readRequireCall(cur, text);
		if (req !== undefined) return req; // import x = require("…")
	}
	return "continue";
}

/** Bracket depth after consuming one character (0 for anything else). */
function trackBracket(c: string, depth: number): number {
	if (c === "(" || c === "[" || c === "{") return depth + 1;
	if (c === ")" || c === "]" || c === "}") return depth - 1;
	return depth;
}

/** The `from "…"` clause of an import/export statement, or undefined. */
function readFromClause(
	cur: Cursor,
	text: string,
	kind: "import" | "reexport",
	typeOnly: boolean,
): ModuleEdge | undefined {
	let depth = 0;
	while (cur.i < text.length) {
		const c = text[cur.i] ?? "";
		if (c === ";" && depth === 0) return undefined;
		if (skipAtom(cur, text, [])) continue;
		if (isIdentStart(c)) {
			const found = fromClauseWord(cur, text, kind, typeOnly, depth);
			if (found !== "continue") return found;
			continue;
		}
		depth = trackBracket(c, depth);
		advance(cur, text, cur.i + 1);
	}
	return undefined;
}

/** Consume a leading `type` modifier (import type / export type); true when found. */
function readTypeOnly(cur: Cursor, text: string): boolean {
	const save = { ...cur };
	if (!skipTrivia(cur, text) || !isIdentStart(text[cur.i] ?? "")) return false;
	if (readWord(cur, text) !== "type") {
		Object.assign(cur, save);
		return false;
	}
	// `import type, { x }` and `import type from "x"` bind a local named
	// `type` — not a type-only statement. Anything else after `type` is the
	// type-only modifier (export type with no from-clause finds no edge anyway).
	const after = { ...cur };
	if (!skipTrivia(cur, text)) return true;
	if (text[cur.i] === ",") {
		Object.assign(cur, after);
		return false;
	}
	if (isIdentStart(text[cur.i] ?? "")) {
		const peek = { ...cur };
		if (readWord(peek, text) === "from") {
			Object.assign(cur, after);
			return false;
		}
	}
	return true;
}

/** A dynamic import(…) edge when the cursor sits at the call's `(`. */
function dynamicImportCall(cur: Cursor, text: string): ModuleEdge | undefined {
	cur.i++;
	if (!skipTrivia(cur, text) || !isQuote(text[cur.i] ?? "")) return undefined;
	const specLine = cur.line;
	const spec = readString(cur, text);
	return { spec, line: specLine, runtime: true, kind: "dynamic" };
}

/** The edge an `import` token opens: static, side-effect, dynamic, or equals. */
function importEdge(cur: Cursor, text: string): ModuleEdge | undefined {
	if (!skipTrivia(cur, text)) return undefined;
	const c = text[cur.i] ?? "";
	if (c === ".") return undefined; // import.meta
	if (c === "(") return dynamicImportCall(cur, text);
	if (isQuote(c)) {
		const specLine = cur.line;
		const spec = readString(cur, text);
		return { spec, line: specLine, runtime: true, kind: "import" };
	}
	return readFromClause(cur, text, "import", readTypeOnly(cur, text));
}

/** The edge an `export` token opens — only the `export … from` form is one. */
function exportEdge(cur: Cursor, text: string): ModuleEdge | undefined {
	const save = { ...cur };
	if (!skipTrivia(cur, text)) return undefined;
	const edge = readFromClause(cur, text, "reexport", readTypeOnly(cur, text));
	if (edge === undefined) Object.assign(cur, save);
	return edge;
}

/** The edge an identifier token opens, or undefined. */
function wordEdge(word: string, cur: Cursor, text: string, start: number): ModuleEdge | undefined {
	if (word === "import") return importEdge(cur, text);
	if (word === "export") return exportEdge(cur, text);
	if (word === "require" && text[start - 1] !== ".") return readRequireCall(cur, text);
	return undefined;
}

/**
 * Every module-reference edge in one file's text: static imports, side-effect
 * imports, `export … from` re-exports, dynamic import(…), require(…) and
 * `import x = require(…)`. Comments and string literals that merely mention a
 * specifier are not edges — the tokenizer sees what the compiler sees.
 */
export function extractEdges(text: string): ModuleEdge[] {
	const edges: ModuleEdge[] = [];
	const cur: Cursor = { i: 0, line: 1 };
	scanInto(cur, text, edges, -1);
	return edges;
}

/**
 * The main scanner loop. `depth` -1 scans to end of file; a non-negative
 * depth scans a template substitution and returns after its closing brace.
 */
function scanInto(cur: Cursor, text: string, edges: ModuleEdge[], depth: number): void {
	while (cur.i < text.length) {
		if (skipAtom(cur, text, edges)) continue;
		const c = text[cur.i] ?? "";
		if (isIdentStart(c)) {
			const start = cur.i;
			const edge = wordEdge(readWord(cur, text), cur, text, start);
			if (edge !== undefined) edges.push(edge);
			continue;
		}
		const brace = substitutionBrace(c, depth);
		depth = brace.depth;
		advance(cur, text, cur.i + 1);
		if (brace.done) return;
	}
}

/** Brace bookkeeping inside a template substitution (inactive when depth < 0). */
function substitutionBrace(c: string, depth: number): { depth: number; done: boolean } {
	if (depth < 0) return { depth, done: false };
	if (c === "{") return { depth: depth + 1, done: false };
	if (c === "}") return { depth: depth - 1, done: depth === 0 };
	return { depth, done: false };
}

export interface ModuleGraphOptions {
	/** Repo-relative POSIX prefixes the laundering walk may follow into. */
	readonly repoPrefixes: readonly string[];
	/** Test files are exempt from the guard, so chains do not follow them. */
	readonly isTestFile: (rel: string) => boolean;
}

/**
 * The module graph over the walked trees. Edges are parsed lazily and cached
 * per file, so the whole scan parses each file exactly once.
 */
export class ModuleGraph {
	private readonly cache = new Map<string, ModuleEdge[]>();

	constructor(
		private readonly repoRoot: string,
		private readonly options: ModuleGraphOptions,
	) {}

	/** Edges of one file, from the caller's text or from disk (cached). */
	edgesFor(rel: string, text?: string): ModuleEdge[] {
		const cached = this.cache.get(rel);
		if (cached !== undefined) return cached;
		const source = text ?? readRepoFile(this.repoRoot, rel);
		const edges = extractEdges(source);
		this.cache.set(rel, edges);
		return edges;
	}

	/** The on-disk file a resolved target names, or undefined when unresolvable. */
	private toFileRel(target: string): string | undefined {
		if (!this.options.repoPrefixes.some((p) => target.startsWith(p))) return undefined;
		if (this.options.isTestFile(target)) return undefined;
		const candidates = RESOLVE_EXTENSIONS.some((ext) => target.endsWith(ext))
			? [target]
			: [
					...RESOLVE_EXTENSIONS.map((ext) => `${target}${ext}`),
					...RESOLVE_EXTENSIONS.map((ext) => `${target}/index${ext}`),
				];
		return candidates.find((c) => existsSync(resolve(this.repoRoot, c)));
	}

	/**
	 * Every target an edge effectively reaches: the direct target plus, for
	 * runtime edges, anything the target module re-exports at runtime,
	 * transitively. Type-only chains are not followed — they are erased at
	 * compile time (see the module doc comment).
	 */
	resolveTargets(rel: string, edge: ModuleEdge): EdgeTarget[] {
		const direct = resolveSpec(rel, edge.spec);
		const out: EdgeTarget[] = [{ target: direct, line: edge.line, spec: edge.spec }];
		if (!edge.runtime) return out;
		const visited = new Set<string>([rel]);
		this.followReexports(edge, direct, visited, out);
		return out;
	}

	private followReexports(
		origin: ModuleEdge,
		target: string,
		visited: Set<string>,
		out: EdgeTarget[],
	): void {
		if (visited.has(target)) return;
		visited.add(target);
		const fileRel = this.toFileRel(target);
		if (fileRel === undefined) return;
		visited.add(fileRel);
		for (const e of this.edgesFor(fileRel)) {
			if (e.kind !== "reexport" || !e.runtime) continue;
			const next = resolveSpec(fileRel, e.spec);
			if (visited.has(next)) continue;
			// Normalise to the resolved file so exact-file rule entries (e.g.
			// src/db/schema.ts) match extensionless re-export specifiers too.
			const resolved = this.toFileRel(next);
			out.push({
				target: resolved ?? next,
				line: origin.line,
				spec: origin.spec,
				via: `${fileRel}:${e.line} re-exports "${e.spec}"`,
			});
			this.followReexports(origin, next, visited, out);
		}
	}
}

function readRepoFile(repoRoot: string, rel: string): string {
	const abs = resolve(repoRoot, rel);
	return existsSync(abs) ? readFileSync(abs, "utf8") : "";
}
