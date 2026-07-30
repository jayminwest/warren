#!/usr/bin/env bun
/**
 * Canonical wire-vocabulary guard (warren-d371, plan pl-b82d step 27).
 *
 * `src/core/wire.ts` is the SINGLE SOURCE OF TRUTH for warren's enum-shaped
 * wire vocabulary — run / plan-run / preview lifecycle states, the
 * failure-cause discriminator, run mode, clone kind, event stream, agent
 * source, and the steering-inbox classes (warren-b229). The drizzle column
 * metadata (`src/db/schema/columns.ts`), the SDK (`src/client/types*.ts`) and
 * the browser UI (`src/ui/src/api/types.ts`) RE-EXPORT those names. None of
 * them may redeclare one.
 *
 * This guard enforces that mechanically: any file under `src/` that DECLARES
 * a name the canonical home exports fails the `lint` gate. The three drifts
 * warren-b229 had to repair were all of exactly this shape — `RunFailureReason`
 * lost `finalize_failed` + `evicted` in both hand-copies, the UI still typed
 * the deleted `interactive` run mode — and a grep that happens to be clean on
 * one day does not stop the fourth copy from landing next week.
 *
 * Re-export is ALLOWED, redeclaration is not. `export * from`,
 * `export { X } from`, `export type { X } from` and `import { X } from` all
 * pass; a second `export const RUN_STATES = [...]` or `type RunFailureReason =
 * ...` does not.
 *
 * Two false-positive controls:
 *
 *   1. The enforced name list is DERIVED from `src/core/wire.ts` at run time,
 *      never hand-copied — a second hard-coded list is itself the drift class
 *      this guard exists to prevent. It is then narrowed to names carrying one
 *      of the DOMAIN_STEMS below, so a future generic export (`Status`,
 *      `Limits`) can't fail the build on an accidental collision.
 *   2. `ALLOW` is an explicit, commented escape hatch for a deliberate local
 *      declaration. It is empty today; every entry needs a reason.
 *
 * Scope note: this guard walks ALL of `src/` INCLUDING `src/ui/`, which biome,
 * `check:size` and `check:debt` all exclude — the UI is a separate
 * `@os-eco/warren-ui` package, and it is also where two of the three
 * warren-b229 drifts lived. Test files and test helpers are exempt: a fixture
 * legitimately declares a narrowed local copy.
 *
 * Chained into `bun run lint` (alongside check-layers.ts and
 * check-version-sync.ts) rather than registered as its own gate:
 * `scripts/check-all.ts` is byte-identical to the l5-toolkit template and its
 * gate vocabulary is frozen, so a repo-specific assertion folds into an
 * existing gate. Also runnable directly: `bun run check:wire-types`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SRC_ROOT = resolve(REPO_ROOT, "src");

/** The one home, repo-relative POSIX. Everything else re-exports it. */
export const CANONICAL_HOME = "src/core/wire.ts";

/**
 * Domain nouns that make an exported name "wire vocabulary". A canonical
 * export whose name contains none of these is not enforced, so adding a
 * generically-named helper to the kernel can never fail an unrelated file.
 */
export const DOMAIN_STEMS = [
	"run",
	"inbox",
	"clone",
	"preview",
	"event",
	"agent",
	// warren-9bbc: seed + project join the guarded stems so wire vocabulary
	// for the IssueTracker seam (seeds) and the project domain can't drift
	// into hand-copied redeclarations the way run/preview names did.
	"seed",
	"project",
] as const;

/**
 * Files (repo-relative POSIX) allowed to declare a canonical name anyway.
 * Empty on purpose — add an entry only with a comment saying why the copy is
 * deliberate and how it is kept in sync.
 */
const ALLOW: readonly string[] = [];

/** `export const X` / `export type X` / … in the canonical home. */
const CANONICAL_EXPORT_RE =
	/^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|type|interface|class|enum|function)\s+([A-Za-z_$][\w$]*)/;

/**
 * Any value/type DECLARATION, exported or not.
 *
 * Two things keep re-export forms out. `export { X } from` and
 * `export * from` carry no declaration keyword, so they never match at all.
 * The trailing lookahead handles the specifier LINES of a multi-line
 * `export { type RunState, … } from "…"` block, which do read as
 * `type RunState,`: a real declaration is always followed by a body opener
 * (`=`, `<`, `(`, `{`, `:`, `extends`), never by a comma or an `as` rename.
 */
const DECLARATION_RE =
	/^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|type|interface|class|enum|function)\s+([A-Za-z_$][\w$]*)(?=\s*[=<({:]|\s+extends\b|\s+implements\b)/;

export interface Violation {
	readonly file: string;
	readonly line: number;
	readonly name: string;
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

/** True if `name` reads as wire vocabulary rather than a generic export. */
export function isDomainName(name: string): boolean {
	const lower = name.toLowerCase();
	return DOMAIN_STEMS.some((stem) => lower.includes(stem));
}

/**
 * The enforced name list, derived from the canonical home's own source: every
 * top-level export whose name carries a domain stem.
 */
export function canonicalNames(text: string): string[] {
	const names = new Set<string>();
	for (const line of text.split("\n")) {
		const found = CANONICAL_EXPORT_RE.exec(line);
		const name = found?.[1];
		if (name !== undefined && isDomainName(name)) names.add(name);
	}
	return [...names].sort();
}

/** The name a line declares, or undefined for comments and re-export forms. */
export function declaredName(line: string): string | undefined {
	const trimmed = line.trim();
	if (isCommentLine(trimmed)) return undefined;
	return DECLARATION_RE.exec(trimmed)?.[1];
}

/** Redeclarations of a canonical name inside one file's text. */
export function scanText(rel: string, text: string, names: ReadonlySet<string>): Violation[] {
	const violations: Violation[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const name = declaredName(lines[i] ?? "");
		if (name === undefined || !names.has(name)) continue;
		violations.push({ file: rel, line: i + 1, name });
	}
	return violations;
}

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) {
			if (entry === "node_modules" || entry === "dist" || entry === "__golden__") continue;
			yield* walk(abs);
		} else if (abs.endsWith(".ts") || abs.endsWith(".tsx")) {
			yield abs;
		}
	}
}

/** Walk `<repoRoot>/src` and collect every redeclaration outside the home. */
export function scan(repoRoot: string = REPO_ROOT): Violation[] {
	const home = resolve(repoRoot, CANONICAL_HOME);
	const names = new Set(canonicalNames(readFileSync(home, "utf8")));
	const violations: Violation[] = [];
	for (const abs of walk(resolve(repoRoot, "src"))) {
		const rel = relative(repoRoot, abs).split("\\").join("/");
		if (rel === CANONICAL_HOME || isTestFile(rel) || ALLOW.includes(rel)) continue;
		violations.push(...scanText(rel, readFileSync(abs, "utf8"), names));
	}
	return violations;
}

function main(): void {
	const names = canonicalNames(readFileSync(resolve(SRC_ROOT, "core/wire.ts"), "utf8"));
	const violations = scan();
	if (violations.length === 0) {
		console.log(`check:wire-types — ok (${names.length} canonical names, no redeclarations)`);
		return;
	}

	console.error(
		`check:wire-types — ${violations.length} redeclaration(s) of the canonical wire vocabulary:\n`,
	);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line} — declares "${v.name}"`);
	}
	console.error(
		`\nThese names are defined ONCE in ${CANONICAL_HOME} (warren-b229). Re-export\n` +
			`instead of redeclaring — \`export { type RunState } from ".../core/wire.ts"\` —\n` +
			"so the SDK, the UI and the drizzle columns can never disagree again. If a local\n" +
			"declaration is genuinely deliberate, add the file to ALLOW in\n" +
			"scripts/check-wire-types.ts with a comment saying why.",
	);
	process.exit(1);
}

if (import.meta.main) main();
