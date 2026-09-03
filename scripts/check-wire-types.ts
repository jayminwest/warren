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
 * The DOMAIN_STEMS narrowing carries one hard rule, added by warren-7483:
 * SILENCE IS NOT ALLOWED. A canonical export whose name carries no stem is no
 * longer skipped quietly — the gate fails with an "unguarded export: <name>"
 * error telling the author to widen DOMAIN_STEMS (making the name enforced) or
 * to add the name to UNGUARDED_ALLOW with a reason. Before warren-7483 such
 * an export was silently unenforced: the failure mode this gate exists to
 * prevent, recreated one name at a time.
 *
 * Known blind spot (warren-7b7a): the guard matches on NAMES, so a parallel
 * copy spelled differently is invisible to it — `src/runtime/contract.ts` once
 * declared `RunPhase` (a hand-listed `RUN_STATES`), `MessagePriority` (an
 * `INBOX_PRIORITIES` copy), an inline `Message.state` union (`INBOX_STATES`),
 * and both stream adapters carried a private `NORMALIZED_STREAMS`
 * (`EVENT_STREAMS`). Those are now type aliases over the canonical names, which
 * is the convention for a seam that wants its own vocabulary word: alias, never
 * re-list. Widening DOMAIN_STEMS would not have caught them — the drift was a
 * DIFFERENT name, not a stem-less one — so the defence against an aliased
 * re-list stays review plus this note. The companion invariant "every
 * canonical export carries a stem" that this paragraph once asserted by
 * observation is now mechanical (warren-7483): the unguarded-export check
 * below fails the gate the day a stem-less export lands.
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

/** The one home, repo-relative POSIX. Everything else re-exports it. */
export const CANONICAL_HOME = "src/core/wire.ts";

/**
 * The home re-exports whole sibling modules that hold part of the
 * vocabulary, so the file-size ratchet on `wire.ts` can keep going down
 * (`./wire-inbox.ts`, `./wire-insight.ts`, `./wire-actor.ts`). Reading only
 * the home would drop every name those modules declare, since
 * `export * from` carries no declaration keyword to match.
 */
const STAR_REEXPORT_RE = /^export\s+\*\s+from\s+"\.\/([\w.-]+)"\s*;/;

/**
 * The home plus the modules it re-exports wholesale, repo-relative POSIX.
 * Derived from the home's own source, so a fourth split module joins the
 * guarded set the moment it is re-exported.
 */
export function canonicalSources(homeText: string): string[] {
	const sources = [CANONICAL_HOME];
	for (const line of homeText.split("\n")) {
		const found = STAR_REEXPORT_RE.exec(line.trim());
		if (found?.[1] !== undefined) sources.push(`src/core/${found[1]}`);
	}
	return sources;
}

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
	// warren-0993: the forge seam's wire vocabulary (PullRequestLifecycle,
	// ForgeErrorKind). NOT "pr" — stem matching is substring-based, and "pr"
	// would silently widen enforcement over Provider, Preview, Priority,
	// and Project (forge-contract.md §2.1).
	"pull",
	"forge",
	// warren-42f1: the HTTP response envelopes (ErrorEnvelope) now live in
	// the canonical home too — without this stem the guard would derive the
	// name but never enforce it, recreating the warren-5334 blindness.
	"envelope",
	// warren-3754: the actor vocabulary of GET /whoami (ActorKind,
	// ActorCapabilities, CapabilityName). Both stems are needed, since
	// "actor" alone misses CapabilityName. "capability" is safe next to the
	// warren-0993 warning because redeclaration matching is by exact name:
	// RuntimeCapabilities (src/runtime/contract.ts) is a different name and
	// never becomes canonical, since only src/core/wire.ts is read for the
	// enforced list.
	"actor",
	"capability",
	// warren-7483: three vocabularies were silently UNENFORCED before the
	// unguarded-export check existed — the runtime-id seam (RuntimeId,
	// KNOWN_RUNTIME_IDS), the insight-confidence seam (InsightConfidence,
	// INSIGHT_CONFIDENCES), and the salvage-trigger seam (SalvageTrigger,
	// SALVAGE_TRIGGERS). Their stems join the list so every canonical export
	// the home ships today is covered; any new stem-less export now fails the
	// gate instead of drifting.
	"runtime",
	"insight",
	"salvage",
	// Same warren-7483 sweep: STEERING_CAPABILITIES alone misses "capability"
	// (plural — substring matching never rejoins the singular), so the
	// steering-inbox constant needs its own stem. SteeringCapability the type
	// was already guarded by "capability".
	"steering",
	// warren-6c29 (plan pl-a37b Track B): the IssueTracker seam's wire
	// vocabulary (Issue, IssueStatus, Plan, PlanStatus, PlanSummary,
	// TrackerContext, TrackerError, ...) joins the guarded stems. All three
	// nouns are needed — "plan" alone misses Issue/Tracker names, and
	// "tracker" alone misses Plan/Issue names.
	"issue",
	"plan",
	"tracker",
	// warren-7194: the ops-overview window vocabulary (OpsWindow, OPS_WINDOWS,
	// OPS_WINDOW_MS) joins the guarded stems so a local copy in a handler or
	// the UI fails the gate instead of drifting.
	"ops",
] as const;

/**
 * Files (repo-relative POSIX) allowed to declare a canonical name anyway.
 * Empty on purpose — add an entry only with a comment saying why the copy is
 * deliberate and how it is kept in sync.
 */
const ALLOW: readonly string[] = [];

/**
 * Canonical export NAMES (not files) excused from the every-export-carries-a-
 * stem rule (warren-7483). Empty on purpose. Add an entry only when a new
 * export is genuinely generic vocabulary no stem fits — with a comment saying
 * why — accepting that the guard then cannot enforce that name.
 */
const UNGUARDED_ALLOW: readonly string[] = [];

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

/** Every top-level export the text declares, stems or not. */
export function allExportNames(text: string): string[] {
	const names = new Set<string>();
	for (const line of text.split("\n")) {
		const found = CANONICAL_EXPORT_RE.exec(line);
		if (found?.[1] !== undefined) names.add(found[1]);
	}
	return [...names].sort();
}

/** Canonical exports the guard would silently skip — the gate must fail. */
export function unguardedExports(repoRoot: string = REPO_ROOT): string[] {
	const homeText = readFileSync(resolve(repoRoot, CANONICAL_HOME), "utf8");
	const unguarded = new Set<string>();
	for (const rel of canonicalSources(homeText)) {
		for (const name of allExportNames(readFileSync(resolve(repoRoot, rel), "utf8"))) {
			if (!isDomainName(name) && !UNGUARDED_ALLOW.includes(name)) unguarded.add(name);
		}
	}
	return [...unguarded].sort();
}

/** Every name the home and its re-exported modules declare. */
export function enforcedNames(repoRoot: string = REPO_ROOT): {
	names: string[];
	sources: string[];
} {
	const homeText = readFileSync(resolve(repoRoot, CANONICAL_HOME), "utf8");
	const sources = canonicalSources(homeText);
	const names = new Set<string>();
	for (const rel of sources) {
		for (const name of canonicalNames(readFileSync(resolve(repoRoot, rel), "utf8"))) {
			names.add(name);
		}
	}
	return { names: [...names].sort(), sources };
}

/** Walk `<repoRoot>/src` and collect every redeclaration outside the home. */
export function scan(repoRoot: string = REPO_ROOT): Violation[] {
	const { names, sources } = enforcedNames(repoRoot);
	const enforced = new Set(names);
	const violations: Violation[] = [];
	for (const abs of walk(resolve(repoRoot, "src"))) {
		const rel = relative(repoRoot, abs).split("\\").join("/");
		if (sources.includes(rel) || isTestFile(rel) || ALLOW.includes(rel)) continue;
		violations.push(...scanText(rel, readFileSync(abs, "utf8"), enforced));
	}
	return violations;
}

function main(): void {
	const unguarded = unguardedExports();
	if (unguarded.length > 0) {
		console.error(
			`check:wire-types — ${unguarded.length} unguarded canonical export(s) in ${CANONICAL_HOME}:\n`,
		);
		for (const name of unguarded) {
			console.error(
				`  unguarded export: ${name} — widen DOMAIN_STEMS or add an explicit UNGUARDED_ALLOW entry`,
			);
		}
		console.error(
			"\nA canonical export whose name carries no domain stem is INVISIBLE to this guard,\n" +
				"recreating the silent-drift failure mode the gate exists to prevent (warren-7483).\n" +
				"Decide: add a stem to DOMAIN_STEMS in scripts/check-wire-types.ts so the name is\n" +
				"enforced, or list the name in UNGUARDED_ALLOW with a comment saying why a generic\n" +
				"export can never collide.",
		);
		process.exit(1);
	}

	const { names } = enforcedNames();
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
