#!/usr/bin/env bun
/**
 * Automated doc-generation: HTTP route table extractor
 * (warren-e5fb, plan pl-7b06 step 14).
 *
 * Parses the `ROUTE_TABLE` constant in `src/server/handlers/route-table.ts` and
 * renders a Markdown table of all HTTP API routes to
 * `docs/http-api.md`. The handler module is the canonical surface for
 * the warren JSON API (rendered in docs/http-api.md), so deriving
 * the docs from it avoids the usual drift between a hand-written endpoint list and the
 * real router.
 *
 * The script ALSO emits `docs/builtin-agents.json` (warren-7b32), a
 * machine-readable manifest of the built-in agents derived from
 * `BUILTIN_AGENTS` in `src/registry/builtins/`, so downstream consumers
 * (warren-site's facts pipeline) never hand-maintain agent names or
 * counts. The registry itself is an Article IX protected path; this
 * script is strictly read-only against it — it imports and serializes,
 * never modifies.
 *
 * One-line roles are not a registry field, so they live in the
 * `BUILTIN_AGENT_ROLES` table below. Drift fails hard both ways: adding
 * a builtin without a role entry (or leaving a stale entry) throws, so
 * `gen:docs:check` goes red until the table and the manifest agree with
 * the registry.
 *
 * Why this shape (not typedoc):
 * - The HTTP routes are the meaningful API contract; internal TS APIs
 *   change shape too often to be worth typedoc'ing.
 * - No new runtime/devDep — just a small script, in the same spirit as
 *   sibling pl-7b06 readiness checks (check-file-sizes.ts,
 *   check-debt-markers.ts, check-bundle-size.ts).
 * - Regex-based extraction means we don't have to actually load the
 *   handlers module (which has heavy boot-time imports), and the script
 *   stays fast in CI.
 *
 * Modes:
 *   bun run gen:docs            # write docs/http-api.md + docs/builtin-agents.json
 *   bun run gen:docs:check      # exit 1 if either artifact is stale
 *
 * The check mode is wired into `bun run check:all`; CI fails when the
 * route table or the builtin registry changes but the docs aren't
 * regenerated. Fix by running `bun run gen:docs` and committing the result.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_AGENTS } from "../src/registry/builtins/index.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HANDLERS_PATH = resolve(REPO_ROOT, "src/server/handlers/route-table.ts");
const OUTPUT_PATH = resolve(REPO_ROOT, "docs/http-api.md");
const MANIFEST_PATH = resolve(REPO_ROOT, "docs/builtin-agents.json");

export type Route = {
	method: string;
	pattern: string;
	handler: string;
	comment?: string;
};

/**
 * Extract the `ROUTE_TABLE` array literal from handlers.ts and parse
 * each `{ method, pattern, build }` entry into a `Route`. Tolerant of
 * single-line and multi-line entry formatting; preserves preceding `//`
 * comments as per-route notes so route ordering caveats (e.g.
 * needs-attention/count being declared above /plots/:id) stay
 * documented in the generated table.
 */
export function extractRoutes(source: string): Route[] {
	const body = extractRouteTableBody(source);
	return parseRouteTableBody(body);
}

function extractRouteTableBody(source: string): string {
	const startMatch = source.match(
		/const ROUTE_TABLE: readonly RouteEntry\[\] = \[\n([\s\S]*?)\n\];/,
	);
	if (!startMatch || startMatch[1] === undefined) {
		throw new Error(
			"ROUTE_TABLE not found in src/server/handlers/route-table.ts — has the extractor's regex drifted?",
		);
	}
	return startMatch[1];
}

type ParserState = {
	depth: number;
	entryStart: number;
	pendingComment: string | undefined;
	commentBuffer: string[];
};

function parseRouteTableBody(body: string): Route[] {
	const routes: Route[] = [];
	const state: ParserState = {
		depth: 0,
		entryStart: -1,
		pendingComment: undefined,
		commentBuffer: [],
	};

	const lines = body.split("\n");
	let cursor = 0;
	for (const line of lines) {
		if (handleTopLevelLine(line, state)) {
			cursor += line.length + 1;
			continue;
		}
		scanLineBraces(line, cursor, body, state, routes);
		cursor += line.length + 1;
	}

	return routes;
}

// Returns true when the line was fully consumed at depth 0 (comment
// continuation or blank-line buffer reset) and the caller should skip
// brace scanning.
function handleTopLevelLine(line: string, state: ParserState): boolean {
	if (state.depth !== 0) return false;
	const trimmed = line.trim();
	if (trimmed.startsWith("//")) {
		state.commentBuffer.push(trimmed.replace(/^\/\/\s?/, ""));
		return true;
	}
	if (trimmed === "") {
		state.commentBuffer = [];
		return true;
	}
	return false;
}

function flushCommentBuffer(state: ParserState): string | undefined {
	if (state.commentBuffer.length === 0) return undefined;
	const joined = state.commentBuffer.join(" ").replace(/\s+/g, " ").trim();
	state.commentBuffer = [];
	return joined || undefined;
}

function scanLineBraces(
	line: string,
	cursor: number,
	body: string,
	state: ParserState,
	routes: Route[],
): void {
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "{") handleOpenBrace(state, cursor + i);
		else if (ch === "}") handleCloseBrace(state, cursor + i, body, routes);
	}
}

function handleOpenBrace(state: ParserState, position: number): void {
	if (state.depth === 0) {
		state.entryStart = position;
		state.pendingComment = flushCommentBuffer(state);
	}
	state.depth++;
}

function handleCloseBrace(
	state: ParserState,
	position: number,
	body: string,
	routes: Route[],
): void {
	state.depth--;
	if (state.depth !== 0 || state.entryStart < 0) return;
	const entryText = body.slice(state.entryStart, position + 1);
	const parsed = parseEntry(entryText);
	if (parsed) routes.push({ ...parsed, comment: state.pendingComment });
	state.entryStart = -1;
	state.pendingComment = undefined;
}

function parseEntry(text: string): { method: string; pattern: string; handler: string } | null {
	const methodMatch = text.match(/method:\s*"([A-Z]+)"/);
	const patternMatch = text.match(/pattern:\s*"([^"]+)"/);
	// `build:` may be `() =>`, `(deps) =>`, or a bare identifier reference.
	const buildMatch = text.match(/build:\s*(?:\(\s*\w*\s*\)\s*=>\s*)?([A-Za-z_][A-Za-z0-9_]*)/);
	if (!methodMatch || !patternMatch || !buildMatch) return null;
	const method = methodMatch[1];
	const pattern = patternMatch[1];
	const handler = buildMatch[1];
	if (method === undefined || pattern === undefined || handler === undefined) return null;
	return { method, pattern, handler };
}

/**
 * Group routes by the first path segment so the rendered table reads
 * resource-by-resource (`/agents`, `/projects`, `/runs`, …) without
 * forcing the source order to also be the doc order.
 */
export function groupRoutes(routes: readonly Route[]): Map<string, Route[]> {
	const groups = new Map<string, Route[]>();
	for (const route of routes) {
		const segment = route.pattern.split("/")[1] ?? "";
		const key = segment || "(root)";
		const bucket = groups.get(key) ?? [];
		bucket.push(route);
		groups.set(key, bucket);
	}
	return groups;
}

export function renderMarkdown(routes: readonly Route[]): string {
	const groups = groupRoutes(routes);
	const sections: string[] = [];

	sections.push("# warren HTTP API");
	sections.push("");
	sections.push(
		"<!-- AUTO-GENERATED by `bun run gen:docs` from `src/server/handlers/route-table.ts`. -->",
	);
	sections.push("<!-- Do not edit by hand. CI fails if this file is out of sync. -->");
	sections.push("");
	sections.push(
		"This page enumerates every HTTP route registered by warren's `Bun.serve` " +
			"router. It's derived directly from the `ROUTE_TABLE` array in " +
			"[`src/server/handlers/route-table.ts`](../src/server/handlers/route-table.ts) so it can't drift " +
			"from the running server.",
	);
	sections.push("");
	sections.push("To refresh: `bun run gen:docs`. To check (CI mode): `bun run gen:docs:check`.");
	sections.push("");
	sections.push(`Total routes: **${routes.length}**.`);
	sections.push("");

	const sortedKeys = [...groups.keys()].sort();
	for (const key of sortedKeys) {
		const bucket = groups.get(key);
		if (!bucket || bucket.length === 0) continue;
		sections.push(`## /${key}`);
		sections.push("");
		sections.push("| Method | Pattern | Handler | Notes |");
		sections.push("| --- | --- | --- | --- |");
		for (const route of bucket) {
			const notes = route.comment ? escapeCell(route.comment) : "";
			sections.push(
				`| \`${route.method}\` | \`${route.pattern}\` | \`${route.handler}\` | ${notes} |`,
			);
		}
		sections.push("");
	}

	return `${sections.join("\n").trimEnd()}\n`;
}

function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|");
}

/**
 * One-line roles for each builtin agent (warren-7b32). The registry
 * definitions carry no role field and are an Article IX protected path,
 * so the canonical one-liners live here, next to the generator that
 * consumes them. `generateBuiltinAgentsManifest` throws when this
 * table and `BUILTIN_AGENTS` disagree in either direction, which turns
 * `gen:docs:check` red on registry drift.
 */
const BUILTIN_AGENT_ROLES: Readonly<Record<string, string>> = {
	bugwatch: "Bug triage agent — investigates open bug seeds and produces a seeds fix plan per bug.",
	"claude-code":
		"General-purpose coding agent on the claude-code harness; dispatchable on a fresh install.",
	healer:
		"Closed-loop repair agent — diagnoses production alerts and opens a fresh fix branch + PR.",
	nightwatch:
		"Code patrol agent — scans repos for quality issues and files a seeds plan to fix them.",
	pi: "Multi-provider coding-agent runtime (@earendil-works/pi-coding-agent); warren's default runtime.",
	planner: "Interactive planning agent that turns a finalized intent into a structured seeds plan.",
	"pr-fixer":
		"CI-repair agent — fixes failing checks on warren-opened PRs directly on the PR branch.",
};

export type BuiltinAgentsManifest = {
	source: string;
	count: number;
	agents: { name: string; role: string }[];
};

/**
 * Serialize the builtin-agent manifest for `docs/builtin-agents.json`.
 * Deterministic (agents sorted by name, fixed key order, no timestamps)
 * so --check can byte-compare against the committed file.
 */
export function generateBuiltinAgentsManifest(): {
	content: string;
	manifest: BuiltinAgentsManifest;
} {
	const names = BUILTIN_AGENTS.map((agent) => agent.name).sort();
	const missingRoles = names.filter((name) => !(name in BUILTIN_AGENT_ROLES));
	const staleRoles = Object.keys(BUILTIN_AGENT_ROLES).filter((name) => !names.includes(name));
	if (missingRoles.length > 0 || staleRoles.length > 0) {
		const parts: string[] = [];
		if (missingRoles.length > 0) {
			parts.push(`no role entry for builtin(s): ${missingRoles.join(", ")}`);
		}
		if (staleRoles.length > 0) {
			parts.push(`role entries with no matching builtin: ${staleRoles.join(", ")}`);
		}
		throw new Error(
			`BUILTIN_AGENT_ROLES drifted from BUILTIN_AGENTS — ${parts.join("; ")}. ` +
				"Update scripts/generate-docs.ts alongside the registry change.",
		);
	}
	const agents = names.map((name) => {
		const role = BUILTIN_AGENT_ROLES[name];
		if (role === undefined) {
			throw new Error(`unreachable: role for ${name} passed the drift check`);
		}
		return { name, role };
	});
	const manifest: BuiltinAgentsManifest = {
		source: "src/registry/builtins/index.ts (BUILTIN_AGENTS)",
		count: agents.length,
		agents,
	};
	return { content: `${JSON.stringify(manifest, null, "\t")}\n`, manifest };
}

export function generate(): { content: string; routes: Route[] } {
	const source = readFileSync(HANDLERS_PATH, "utf8");
	const routes = extractRoutes(source);
	if (routes.length === 0) {
		throw new Error("Extractor found zero routes — refusing to overwrite docs/http-api.md.");
	}
	return { content: renderMarkdown(routes), routes };
}

function readExisting(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Check (or report staleness for) one generated artifact against disk. */
function checkArtifact(path: string, relPath: string, content: string): boolean {
	const existing = readExisting(path);
	if (existing === null) {
		console.error(`${relPath} is missing. Run \`bun run gen:docs\` and commit the result.`);
		return false;
	}
	if (existing !== content) {
		console.error(`${relPath} is stale relative to its generator sources.`);
		console.error("Run `bun run gen:docs` and commit the result.");
		return false;
	}
	return true;
}

function main(): void {
	const checkMode = process.argv.includes("--check");
	const { content, routes } = generate();
	const { content: manifestContent, manifest } = generateBuiltinAgentsManifest();

	if (checkMode) {
		const docOk = checkArtifact(OUTPUT_PATH, "docs/http-api.md", content);
		const manifestOk = checkArtifact(MANIFEST_PATH, "docs/builtin-agents.json", manifestContent);
		if (!docOk || !manifestOk) process.exit(1);
		console.log(`gen:docs ok (${routes.length} routes, ${manifest.count} builtin agents).`);
		return;
	}

	writeFileSync(OUTPUT_PATH, content);
	console.log(`Wrote docs/http-api.md (${routes.length} routes).`);
	writeFileSync(MANIFEST_PATH, manifestContent);
	console.log(`Wrote docs/builtin-agents.json (${manifest.count} builtin agents).`);
}

if (import.meta.main) main();
