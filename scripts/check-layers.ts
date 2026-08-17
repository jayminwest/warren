#!/usr/bin/env bun
/**
 * Architectural layering guard (warren-89a6, plan pl-b82d step 29).
 *
 * Warren's single-source-of-truth rule (AGENTS.md, CLAUDE.md) is a layering
 * rule: the domain modules own the logic, `src/server/handlers/` is a thin
 * HTTP surface over them, and the CLI, the SDK and the UI are consumers.
 * `src/core/` sits under all of it and imports nothing, which is what keeps
 * drizzle and `bun:sqlite` out of the browser bundle.
 *
 * This guard enforces those seams mechanically. It generalizes
 * `check-burrow-boundary.ts` (warren-f796), which enforced exactly one of
 * them with two hard-coded allowlists — the burrow boundary is now two
 * ordinary entries in `scripts/layer-rules.json` alongside the rest, so a
 * new seam is a data edit and is born enforced rather than retrofitted.
 *
 * Two rule shapes, both declared in the manifest:
 *
 *   - **Import rules** (`forbidImports`) name module targets a set of source
 *     directories may not reach. A relative specifier is RESOLVED against the
 *     importing file first, so `src/server/` catches `../server/types.ts` from
 *     `src/plan-runs/` and leaves `../seeds-cli/index.ts` alone. A bare entry
 *     matches a package and its subpaths (`@os-eco/burrow-cli`), `*` matches
 *     everything, and `exceptImports` carves targets back out.
 *   - **Pattern rules** (`forbidPattern`) apply a regex to each non-comment
 *     source line, for a seam that is not about imports — today, a handler
 *     assembling a repo out of `deps.db`.
 *
 * `allow` is the escape hatch, and every entry carries a `why` because JSON
 * has no comments. Test files and test helpers are exempt throughout: a
 * fixture legitimately constructs whatever it is testing.
 *
 * MODULE GRAPH (warren-d382). Edges come from the TypeScript AST via
 * scripts/layer-graph.ts, not a line regex, so the guard sees dynamic
 * `await import("…")`, `require("…")` and every `export … from` form, and it
 * follows runtime re-export chains: when A re-exports from forbidden B and C
 * imports A, the C→B edge is reported at C's import line ("laundered").
 * Type-only edges are direct matches (parity with the regex) but are never
 * followed — an erased `export type` cannot launder a runtime dependency,
 * which is what keeps the warren-02c9 row-type barrels legitimate.
 *
 * The walk covers `src/`, `extensions/` (warren-0781, plan pl-116e — the
 * audit-log flagship is a standalone package inside this repo, and the two
 * extension-boundary rules in the manifest only have teeth if the walk reaches
 * both sides of the seam) and `scripts/` (warren-c042). The walk historically
 * covered only `src/` since the guard's birth (warren-89a6); the one
 * deliberate exclusion ever made was skipping generated output (`dist`,
 * warren-30ef), which never applied to `scripts/`. Widening gives
 * `core-does-not-import-extensions` its teeth over gate scripts and lets the
 * forge pair now declare `scripts/` in `from` so an api.github.com literal
 * cannot silently return there (docs/design/forge-contract.md §7).
 *
 * Chained into `bun run lint` (alongside check-version-sync.ts,
 * check-wire-types.ts and check-prose.ts) in the slot check-burrow-boundary.ts
 * used to hold, rather than registered as its own gate: `scripts/check-all.ts`
 * is byte-identical to the l5-toolkit template and its gate vocabulary is
 * frozen, so a repo-specific assertion folds into an existing gate. Also
 * runnable directly: `bun run check:layers`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
	type EdgeTarget,
	extractEdges,
	type ModuleEdge,
	ModuleGraph,
	resolveSpec,
} from "./layer-graph.ts";

export { resolveSpec };

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The rule manifest, repo-relative POSIX. */
export const MANIFEST = "scripts/layer-rules.json";

/** One documented exception to a rule. */
export interface AllowEntry {
	readonly path: string;
	readonly why: string;
}

/** One declared seam. See the manifest's `$comment` for the field grammar. */
export interface LayerRule {
	readonly name: string;
	readonly why: string;
	readonly from: readonly string[];
	readonly forbidImports?: readonly string[];
	readonly exceptImports?: readonly string[];
	readonly forbidPattern?: string;
	readonly allow?: readonly AllowEntry[];
}

export interface Violation {
	readonly rule: string;
	readonly file: string;
	readonly line: number;
	/** Human reason, printed after the `file:line — ` prefix. */
	readonly reason: string;
}

function isTestFile(rel: string): boolean {
	return (
		rel.endsWith(".test.ts") ||
		rel.endsWith(".test.tsx") ||
		rel.includes("test-helper") ||
		rel.includes("test-support") ||
		rel.includes(".harness.") ||
		rel.includes("__golden__")
	);
}

function isCommentLine(trimmed: string): boolean {
	return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** True when `rel` is under (or equal to) one of the declared path entries. */
export function matchesPath(rel: string, entries: readonly string[]): boolean {
	return entries.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry));
}

/** True when a resolved import target is named by one of the forbid entries. */
export function matchesTarget(target: string, entries: readonly string[]): boolean {
	return entries.some((entry) => {
		if (entry === "*") return true;
		if (entry.endsWith("/")) {
			return target.startsWith(entry) || target === entry.slice(0, -1);
		}
		return target === entry || target.startsWith(`${entry}/`);
	});
}

/** The reason string for one forbidden resolved target. */
function targetReason(t: EdgeTarget): string {
	if (t.via === undefined) return `imports "${t.spec}"`;
	return `imports "${t.spec}" — laundered: ${t.via} resolves to "${t.target}"`;
}

/** True when a resolved target is forbidden by the rule and not excepted. */
function ruleHitsTarget(rule: LayerRule, target: string): boolean {
	if (!matchesTarget(target, rule.forbidImports ?? [])) return false;
	return !matchesTarget(target, rule.exceptImports ?? []);
}

/** Violations of one import rule among a file's effective targets. */
function importViolations(
	rule: LayerRule,
	rel: string,
	edges: readonly ModuleEdge[],
	graph?: ModuleGraph,
): Violation[] {
	if (rule.forbidImports === undefined) return [];
	const violations: Violation[] = [];
	const seen = new Set<string>();
	for (const edge of edges) {
		const targets =
			graph === undefined ? directTargets(rel, edge) : graph.resolveTargets(rel, edge);
		for (const t of targets) {
			if (!ruleHitsTarget(rule, t.target)) continue;
			const key = `${t.line} ${t.target}`;
			if (seen.has(key)) continue;
			seen.add(key);
			violations.push({ rule: rule.name, file: rel, line: t.line, reason: targetReason(t) });
		}
	}
	return violations;
}

/** The direct target of one edge, for graph-less callers (scanText). */
function directTargets(rel: string, edge: ModuleEdge): EdgeTarget[] {
	return [{ target: resolveSpec(rel, edge.spec), line: edge.line, spec: edge.spec }];
}

/** Violations of one pattern rule inside one file's text (line-based). */
function patternViolations(rule: LayerRule, rel: string, lines: readonly string[]): Violation[] {
	if (rule.forbidPattern === undefined) return [];
	const pattern = new RegExp(rule.forbidPattern);
	const violations: Violation[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (isCommentLine(line.trim()) || !pattern.test(line)) continue;
		violations.push({
			rule: rule.name,
			file: rel,
			line: i + 1,
			reason: `matches /${rule.forbidPattern}/`,
		});
	}
	return violations;
}

/**
 * Direct violations of one rule inside one file's text — static imports,
 * re-exports, dynamic import() and require() — with no cross-file laundering
 * walk. Used by tests and by scanFile for the pattern rules.
 */
export function scanText(rule: LayerRule, rel: string, text: string): Violation[] {
	const edges = extractEdges(text);
	return [...importViolations(rule, rel, edges), ...patternViolations(rule, rel, text.split("\n"))];
}

function* walk(dir: string): Generator<string> {
	// Sort so the walk order (and therefore violation ordering) is
	// deterministic across filesystems — readdir order is not guaranteed.
	for (const entry of readdirSync(dir).sort()) {
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) {
			// `dist` is the built UI bundle (warren-30ef): the burrow guard walked
			// it, which cost a full tree traversal of generated output for nothing.
			if (entry === "node_modules" || entry === "dist" || entry === "__golden__") continue;
			yield* walk(abs);
		} else if (abs.endsWith(".ts") || abs.endsWith(".tsx")) {
			yield abs;
		}
	}
}

/** Read and parse the rule manifest under `repoRoot`. */
export function loadRules(repoRoot: string = REPO_ROOT): LayerRule[] {
	const parsed = JSON.parse(readFileSync(resolve(repoRoot, MANIFEST), "utf8")) as {
		rules: LayerRule[];
	};
	return parsed.rules;
}

/** Directory trees the walk covers, relative to the repo root. */
export const WALK_ROOTS = ["src", "extensions", "scripts"] as const;

/** Walk every WALK_ROOTS tree under `repoRoot` and collect every violation. */
export function scan(
	repoRoot: string = REPO_ROOT,
	rules: readonly LayerRule[] = loadRules(),
): Violation[] {
	const graph = new ModuleGraph(repoRoot, {
		repoPrefixes: WALK_ROOTS.map((r) => `${r}/`),
		isTestFile,
	});
	const violations: Violation[] = [];
	for (const root of WALK_ROOTS) {
		const rootAbs = resolve(repoRoot, root);
		if (!existsSync(rootAbs)) continue;
		for (const abs of walk(rootAbs)) {
			const rel = relative(repoRoot, abs).split("\\").join("/");
			if (isTestFile(rel)) continue;
			violations.push(...scanFile(rel, readFileSync(abs, "utf8"), rules, graph));
		}
	}
	// Deterministic order: `readdirSync` order is filesystem-dependent, so an
	// unsorted walk made multi-violation output (and its tests) flaky across
	// machines. Sort by file, then line, then rule.
	return violations.sort(
		(a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
	);
}

/** Every violation of every applicable rule inside one file. */
function scanFile(
	rel: string,
	text: string,
	rules: readonly LayerRule[],
	graph: ModuleGraph,
): Violation[] {
	const violations: Violation[] = [];
	const edges = graph.edgesFor(rel, text);
	const lines = text.split("\n");
	for (const rule of rules) {
		if (!matchesPath(rel, rule.from)) continue;
		if (
			matchesPath(
				rel,
				(rule.allow ?? []).map((a) => a.path),
			)
		)
			continue;
		violations.push(...importViolations(rule, rel, edges, graph));
		violations.push(...patternViolations(rule, rel, lines));
	}
	return violations;
}

function main(): void {
	const rules = loadRules();
	const violations = scan(REPO_ROOT, rules);
	if (violations.length === 0) {
		console.log(`check:layers — ok (${rules.length} declared seams, no violations)`);
		return;
	}

	console.error(`check:layers — ${violations.length} layering violation(s):\n`);
	for (const rule of rules) {
		const hits = violations.filter((v) => v.rule === rule.name);
		if (hits.length === 0) continue;
		console.error(`  ${rule.name} — ${rule.why}`);
		for (const hit of hits) console.error(`    ${hit.file}:${hit.line} — ${hit.reason}`);
		console.error("");
	}
	console.error(
		`Every seam above is declared in ${MANIFEST}. Move the shared declaration into\n` +
			"the layer that owns it and re-export outward, rather than importing upward. If\n" +
			"an exception is genuinely deliberate, add it to that rule's `allow` list with a\n" +
			"`why` saying what makes it legitimate.",
	);
	process.exit(1);
}

if (import.meta.main) main();
