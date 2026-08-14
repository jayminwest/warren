#!/usr/bin/env bun
/**
 * Client/server route contract gate (warren-4d2d).
 *
 * `check:wire-types` holds the type half of the contract between the UI and
 * the server. The path half has no guard: nothing proves that a path the UI
 * fetches is a path the server routes. That gap produced user-visible
 * breakage three times (warren-b229, warren-1f12, warren-e274), and a human
 * hitting a broken page found it every time.
 *
 * Both sides are already machine readable. `ROUTE_TABLE` in
 * `src/server/handlers/route-table.ts` is the canonical HTTP surface, and
 * `scripts/generate-docs.ts` already parses it. Every UI request goes through
 * one of two functions in `src/ui/src/api/client.ts`: the `request<T>`
 * wrapper and the NDJSON streamer. This gate parses the second file the way
 * the docs generator parses the first, then diffs the two lists.
 *
 * Direction matters. A UI call with no matching route fails the gate, because
 * that is the warren-1f12 shape: a page that asks for a surface nobody
 * serves. A route that no UI call reaches is informational only, since the
 * CLI and the SDK consume routes too.
 *
 * The parser never guesses. A request path it cannot resolve statically fails
 * the gate at that `file:line` instead of being skipped, because a silent
 * skip turns the gate into false confidence. Two path shapes are resolvable:
 * a `${encodeURIComponent(x)}` segment, which becomes `:param`, and a
 * trailing query-string suffix, which drops. The suffix rule is derived from
 * the source rather than allowlisted: a trailing interpolation drops only
 * when every string it can produce is empty or starts with `?`, either
 * inline or through a local helper. A helper that starts returning a path
 * segment leaves that set and fails the gate.
 *
 * Chained into `bun run lint` next to check-wire-types.ts and check-rls.ts
 * rather than registered as its own gate: `scripts/check-all.ts` is
 * byte-identical to the l5-toolkit template and its gate vocabulary is
 * frozen. Also runnable directly: `bun run check:client-contract`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractRoutes } from "./generate-docs.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The UI's single network module, repo-relative POSIX. */
export const CLIENT_PATH = "src/ui/src/api/client.ts";

/** The canonical route table, repo-relative POSIX. */
export const ROUTE_TABLE_PATH = "src/server/handlers/route-table.ts";

/**
 * The functions in `client.ts` that reach the network. `request` carries its
 * method in the options object and defaults to GET; the NDJSON streamer is
 * GET by construction.
 */
const REQUEST_FUNCTIONS = ["request", "streamNdjsonEvents"] as const;

/** A resolved UI request: what the browser asks the server for. */
export interface UiCall {
	readonly method: string;
	readonly path: string;
	readonly line: number;
}

/** A call site the gate rejects, with the reason a reader needs. */
export interface ContractViolation {
	readonly line: number;
	readonly reason: "no_matching_route" | "unresolvable_path";
	readonly detail: string;
}

/** Everything one pass over `client.ts` produces. */
export interface ClientScan {
	readonly calls: UiCall[];
	readonly unresolvable: ContractViolation[];
}

/* ----------------------------------------------------------------------- */
/* Source scanning                                                          */
/* ----------------------------------------------------------------------- */

/** 1-based line number of a source offset. */
function lineAt(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < source.length; i++) {
		if (source[i] === "\n") line++;
	}
	return line;
}

/**
 * Index just past the region opened at `start`, which must be a quote, a
 * backtick, or an opening bracket. Understands escapes, nested templates,
 * and both comment forms, so a brace inside a string never moves the depth.
 */
function skipRegion(source: string, start: number): number {
	const opener = source[start];
	if (opener === '"' || opener === "'") return skipQuoted(source, start, opener);
	if (opener === "`") return skipTemplate(source, start);
	return skipBracketed(source, start);
}

function skipQuoted(source: string, start: number, quote: string): number {
	for (let i = start + 1; i < source.length; i++) {
		const ch = source[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === quote) return i + 1;
	}
	return source.length;
}

function skipTemplate(source: string, start: number): number {
	for (let i = start + 1; i < source.length; i++) {
		const ch = source[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "`") return i + 1;
		if (ch === "$" && source[i + 1] === "{") {
			i = skipBracketed(source, i + 1) - 1;
		}
	}
	return source.length;
}

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * Index just past the string, template, or comment that starts at `i`, or -1
 * when `i` holds none of those. Bracket counting jumps over these, so a brace
 * inside a comment or a quoted string never moves the depth.
 */
function skipOpaqueAt(source: string, i: number): number {
	const ch = source[i] ?? "";
	if (ch === '"' || ch === "'" || ch === "`") return skipRegion(source, i);
	if (ch !== "/") return -1;
	if (source[i + 1] === "/") {
		const newline = source.indexOf("\n", i);
		return newline === -1 ? source.length : newline;
	}
	if (source[i + 1] === "*") {
		const end = source.indexOf("*/", i);
		return end === -1 ? source.length : end + 2;
	}
	return -1;
}

function skipBracketed(source: string, start: number): number {
	const open = source[start] ?? "";
	const close = CLOSERS[open] ?? "";
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const opaque = skipOpaqueAt(source, i);
		if (opaque !== -1) {
			i = opaque - 1;
			continue;
		}
		const ch = source[i];
		if (ch === open) {
			depth++;
			continue;
		}
		if (ch === close) {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return source.length;
}

/** The top-level arguments of the call whose `(` sits at `open`. */
export function splitArguments(source: string, open: number): string[] {
	const end = skipBracketed(source, open);
	const args: string[] = [];
	let current = "";
	for (let i = open + 1; i < end - 1; i++) {
		const ch = source[i] ?? "";
		if (ch === '"' || ch === "'" || ch === "`" || ch === "(" || ch === "[" || ch === "{") {
			const next = skipRegion(source, i);
			current += source.slice(i, next);
			i = next - 1;
			continue;
		}
		if (ch === ",") {
			args.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim().length > 0) args.push(current.trim());
	return args;
}

/* ----------------------------------------------------------------------- */
/* Path resolution                                                          */
/* ----------------------------------------------------------------------- */

/** A template literal split into its static chunks and its `${…}` expressions. */
function templateParts(literal: string): { chunks: string[]; exprs: string[] } {
	const chunks: string[] = [];
	const exprs: string[] = [];
	let chunk = "";
	for (let i = 1; i < literal.length - 1; i++) {
		if (literal[i] === "$" && literal[i + 1] === "{") {
			const end = skipBracketed(literal, i + 1);
			exprs.push(literal.slice(i + 2, end - 1).trim());
			chunks.push(chunk);
			chunk = "";
			i = end - 1;
			continue;
		}
		chunk += literal[i];
	}
	chunks.push(chunk);
	return { chunks, exprs };
}

/** Every string and template literal that appears inside an expression. */
function literalsIn(expr: string): string[] {
	const found: string[] = [];
	for (let i = 0; i < expr.length; i++) {
		const ch = expr[i] ?? "";
		if (ch === '"' || ch === "'" || ch === "`") {
			const end = skipRegion(expr, i);
			found.push(expr.slice(i + 1, end - 1));
			i = end - 1;
		}
	}
	return found;
}

/** True when every string the expression can produce is empty or a query string. */
function yieldsOnlyQuery(expr: string): boolean {
	const literals = literalsIn(expr);
	if (literals.length === 0) return false;
	return literals.every((value) => value.length === 0 || value.startsWith("?"));
}

/** The body of a locally declared function, or undefined when it is not one. */
function localFunctionBody(source: string, name: string): string | undefined {
	const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
	if (match === null) return undefined;
	const brace = source.indexOf("{", match.index + match[0].length);
	if (brace === -1) return undefined;
	return source.slice(brace, skipBracketed(source, brace));
}

/**
 * True when a trailing interpolation can only append a query string, so
 * dropping it leaves the path intact. Either the expression carries the
 * literals itself, or it calls a local helper whose returns do.
 */
export function isQuerySuffix(expr: string, source: string): boolean {
	if (yieldsOnlyQuery(expr)) return true;
	const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
	if (call?.[1] === undefined) return false;
	const body = localFunctionBody(source, call[1]);
	if (body === undefined) return false;
	const returns = [...body.matchAll(/return\s+([^;]+);/g)].map((m) => m[1] ?? "");
	if (returns.length === 0) return false;
	return returns.every((value) => yieldsOnlyQuery(value));
}

/** What `resolvePath` decided about one request argument. */
export type PathResolution =
	| { readonly kind: "resolved"; readonly path: string }
	| { readonly kind: "unresolvable"; readonly expr: string };

/**
 * Turn the first argument of a request call into a route pattern. Quoted
 * literals pass through; a template resolves when every interpolation is
 * either an `encodeURIComponent` segment or a trailing query suffix.
 */
export function resolvePath(arg: string, source: string): PathResolution {
	const trimmed = arg.trim();
	const quote = trimmed[0] ?? "";
	if (quote === '"' || quote === "'") {
		return { kind: "resolved", path: stripQuery(trimmed.slice(1, -1)) };
	}
	if (quote !== "`") return { kind: "unresolvable", expr: trimmed };

	const { chunks, exprs } = templateParts(trimmed);
	let path = chunks[0] ?? "";
	for (let i = 0; i < exprs.length; i++) {
		const expr = exprs[i] ?? "";
		const rest = chunks[i + 1] ?? "";
		if (/^encodeURIComponent\s*\(/.test(expr)) {
			path += `:param${rest}`;
			continue;
		}
		const isLast = i === exprs.length - 1 && rest.length === 0;
		if (isLast && isQuerySuffix(expr, source)) continue;
		return { kind: "unresolvable", expr };
	}
	return { kind: "resolved", path: stripQuery(path) };
}

function stripQuery(path: string): string {
	const mark = path.indexOf("?");
	return mark === -1 ? path : path.slice(0, mark);
}

/* ----------------------------------------------------------------------- */
/* The scan                                                                 */
/* ----------------------------------------------------------------------- */

const METHOD_RE = /\bmethod\s*:\s*"([A-Z]+)"/;

/** Every request `client.ts` makes, plus the call sites the parser rejects. */
export function scanClient(source: string): ClientScan {
	const calls: UiCall[] = [];
	const unresolvable: ContractViolation[] = [];
	for (const fn of REQUEST_FUNCTIONS) {
		const re = new RegExp(`\\b${fn}\\s*(?:<[^(]*>)?\\s*\\(`, "g");
		for (const match of source.matchAll(re)) {
			const start = match.index;
			if (/\bfunction\s*\*?\s*$/.test(source.slice(Math.max(0, start - 24), start))) continue;
			const open = start + match[0].length - 1;
			const args = splitArguments(source, open);
			const first = args[0];
			const line = lineAt(source, start);
			if (first === undefined) continue;
			const resolved = resolvePath(first, source);
			if (resolved.kind === "unresolvable") {
				unresolvable.push({
					line,
					reason: "unresolvable_path",
					detail: `request path is not statically resolvable: \${${resolved.expr}}`,
				});
				continue;
			}
			calls.push({
				method: METHOD_RE.exec(args[1] ?? "")?.[1] ?? "GET",
				path: resolved.path,
				line,
			});
		}
	}
	return { calls: calls.sort(byLine), unresolvable: unresolvable.sort(byLine) };
}

function byLine(a: { line: number }, b: { line: number }): number {
	return a.line - b.line;
}

/**
 * True when the server routes this call. A `:param` segment on either side
 * matches anything, which is what the router itself does.
 */
export function routeMatches(callPath: string, pattern: string): boolean {
	const call = callPath.split("/");
	const route = pattern.split("/");
	if (call.length !== route.length) return false;
	return call.every((segment, i) => {
		const other = route[i];
		if (other === undefined) return false;
		if (segment.startsWith(":") || other.startsWith(":")) return true;
		return segment === other;
	});
}

/** Route-table entries, reduced to the method and pattern pair. */
export interface RoutePattern {
	readonly method: string;
	readonly pattern: string;
}

/** UI calls that no route serves, plus the paths the parser could not read. */
export function contractViolations(scan: ClientScan, routes: RoutePattern[]): ContractViolation[] {
	const missing = scan.calls
		.filter(
			(call) => !routes.some((r) => r.method === call.method && routeMatches(call.path, r.pattern)),
		)
		.map<ContractViolation>((call) => ({
			line: call.line,
			reason: "no_matching_route",
			detail: `${call.method} ${call.path} is not in ${ROUTE_TABLE_PATH}`,
		}));
	return [...scan.unresolvable, ...missing].sort(byLine);
}

/** Routes the UI never calls. The CLI and the SDK use routes too, so this only informs. */
export function unusedRoutes(scan: ClientScan, routes: RoutePattern[]): RoutePattern[] {
	return routes.filter(
		(route) =>
			!scan.calls.some((c) => c.method === route.method && routeMatches(c.path, route.pattern)),
	);
}

function readRepoFile(repoRoot: string, relative: string): string {
	return readFileSync(resolve(repoRoot, relative), "utf8");
}

/** Run the gate against a checkout and report what it found. */
export function scan(repoRoot: string = REPO_ROOT): {
	violations: ContractViolation[];
	calls: UiCall[];
	unused: RoutePattern[];
	routeCount: number;
} {
	const clientSource = readRepoFile(repoRoot, CLIENT_PATH);
	const routes = extractRoutes(readRepoFile(repoRoot, ROUTE_TABLE_PATH)).map<RoutePattern>((r) => ({
		method: r.method,
		pattern: r.pattern,
	}));
	const clientScan = scanClient(clientSource);
	return {
		violations: contractViolations(clientScan, routes),
		calls: clientScan.calls,
		unused: unusedRoutes(clientScan, routes),
		routeCount: routes.length,
	};
}

function main(): void {
	const result = scan();
	if (result.violations.length === 0) {
		console.log(
			`check:client-contract ok (${result.calls.length} UI calls against ${result.routeCount} routes, ` +
				`${result.unused.length} routes the UI never calls)`,
		);
		return;
	}

	console.error(`check:client-contract failed: ${result.violations.length} call site(s)\n`);
	for (const v of result.violations) {
		console.error(`  ${CLIENT_PATH}:${v.line} ${v.detail}`);
	}
	console.error(
		`\nwarren-4d2d: every request in ${CLIENT_PATH} must hit a route the server\n` +
			`serves. Add the route to ROUTE_TABLE, correct the call, or rewrite the path\n` +
			"so the parser can read it (a literal, an encodeURIComponent segment, or a\n" +
			"trailing query suffix).",
	);
	process.exit(1);
}

if (import.meta.main) main();
