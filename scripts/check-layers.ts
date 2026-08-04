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
 * KNOWN LIMITATION. Matching is per line and lexical, so it sees static
 * `import` / `export … from` forms only. A dynamic `await import("…")` and a
 * laundered re-export (importing the forbidden module through a permitted
 * one that re-exports it) both slip through. That is deliberate — an AST or
 * module-graph walk would catch them, and it is not worth the dependency for
 * a guard whose job is to stop the accidental regression. Note it, do not
 * route around it.
 *
 * The walk covers `src/` and `extensions/` (warren-0781, plan pl-116e): the
 * audit-log flagship is a standalone package inside this repo, and the two
 * extension-boundary rules in the manifest only have teeth if the walk reaches
 * both sides of the seam.
 *
 * Chained into `bun run lint` (alongside check-version-sync.ts,
 * check-wire-types.ts and check-prose.ts) in the slot check-burrow-boundary.ts
 * used to hold, rather than registered as its own gate: `scripts/check-all.ts`
 * is byte-identical to the l5-toolkit template and its gate vocabulary is
 * frozen, so a repo-specific assertion folds into an existing gate. Also
 * runnable directly: `bun run check:layers`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

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

const FROM_RE = /\bfrom\s*["']([^"']+)["']/;
const BARE_IMPORT_RE = /^import\s*["']([^"']+)["']/;

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

/** The module specifier a line imports from, or undefined for comments. */
export function importSpec(line: string): string | undefined {
	const trimmed = line.trim();
	if (isCommentLine(trimmed)) return undefined;
	const bare = BARE_IMPORT_RE.exec(trimmed);
	if (bare?.[1] !== undefined) return bare[1];
	// `from "X"` covers single-line imports, the closing line of a multi-line
	// import, and every `export … from "X"` re-export form.
	return FROM_RE.exec(line)?.[1];
}

/**
 * The repo-relative target a specifier names. Relative specifiers resolve
 * against the importing file so a prefix rule compares like with like; bare
 * package specifiers pass through untouched.
 */
export function resolveSpec(rel: string, spec: string): string {
	if (!spec.startsWith(".")) return spec;
	return join(dirname(rel), spec).split("\\").join("/");
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

/** True when `line` imports a target the rule forbids and does not except. */
function forbidsImportOn(rule: LayerRule, rel: string, line: string): string | undefined {
	if (rule.forbidImports === undefined) return undefined;
	const spec = importSpec(line);
	if (spec === undefined) return undefined;
	const target = resolveSpec(rel, spec);
	if (!matchesTarget(target, rule.forbidImports)) return undefined;
	if (matchesTarget(target, rule.exceptImports ?? [])) return undefined;
	return `imports "${spec}"`;
}

/** Violations of one rule inside one file's text. */
export function scanText(rule: LayerRule, rel: string, text: string): Violation[] {
	const violations: Violation[] = [];
	const pattern = rule.forbidPattern !== undefined ? new RegExp(rule.forbidPattern) : undefined;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const imported = forbidsImportOn(rule, rel, line);
		if (imported !== undefined) {
			violations.push({ rule: rule.name, file: rel, line: i + 1, reason: imported });
		}
		if (pattern !== undefined && !isCommentLine(line.trim()) && pattern.test(line)) {
			violations.push({
				rule: rule.name,
				file: rel,
				line: i + 1,
				reason: `matches /${rule.forbidPattern}/`,
			});
		}
	}
	return violations;
}

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
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
export const WALK_ROOTS = ["src", "extensions"] as const;

/** Walk every WALK_ROOTS tree under `repoRoot` and collect every violation. */
export function scan(
	repoRoot: string = REPO_ROOT,
	rules: readonly LayerRule[] = loadRules(),
): Violation[] {
	const violations: Violation[] = [];
	for (const root of WALK_ROOTS) {
		const rootAbs = resolve(repoRoot, root);
		if (!existsSync(rootAbs)) continue;
		for (const abs of walk(rootAbs)) {
			const rel = relative(repoRoot, abs).split("\\").join("/");
			if (isTestFile(rel)) continue;
			violations.push(...scanFile(rel, readFileSync(abs, "utf8"), rules));
		}
	}
	return violations;
}

/** Every violation of every applicable rule inside one file. */
function scanFile(rel: string, text: string, rules: readonly LayerRule[]): Violation[] {
	const violations: Violation[] = [];
	for (const rule of rules) {
		if (!matchesPath(rel, rule.from)) continue;
		if (
			matchesPath(
				rel,
				(rule.allow ?? []).map((a) => a.path),
			)
		)
			continue;
		violations.push(...scanText(rule, rel, text));
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
