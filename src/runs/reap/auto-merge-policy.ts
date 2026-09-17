/**
 * The auto-merge arming policy (warren-970a, plan pl-92a3 step 5): one pure
 * function deciding whether a given pull request may be armed for auto-merge.
 * It is the executable form of Article IX, generalized per project — the
 * design record is docs/design/forge-auto-merge.md §4 (the reason vocabulary,
 * the evaluation order, and the fail-closed posture all live there and are
 * settled there; this module does not re-decide them).
 *
 * Purity: no I/O anywhere in this module. The caller (the reap PR-open arm
 * sub-step, warren-14d6) resolves the three inputs that need git or the forge
 * — the base-ref `pr.autoMerge` config, the forge capability flag, and the
 * changed-path list — and hands them in as plain values. That keeps the
 * decision table-testable and keeps this module free of forge types: the
 * capability arrives as a plain boolean precisely so this file does not
 * import `src/forge/**` (the seam step warren-8a74 may not have merged yet).
 *
 * Fail-closed by construction: every way the inputs can be missing, empty,
 * or unreadable lands on `skip`, never on `arm`. `empty_diff` is the
 * warren-7b2f lesson — a PR always changes at least one file, so an empty
 * changed-path list means the source was unreliable, not that nothing
 * changed (see the long comment in the Article IX step of
 * `.github/workflows/auto-merge.yml`; this module never arms blind).
 *
 * Evaluation order (design record §4, mirrored exactly — see `decideAutoMerge`):
 *
 *   1. ci_fixer_run     — the CI-fixer pushes onto an existing PR head
 *   2. off              — the base ref carries no `pr.autoMerge` block
 *   3. unsupported_forge — the forge reports `autoMergeArm: false`
 *   4. diff rules: empty_diff, diff_unreadable, protected_path, config_changed
 *
 * Nothing calls this yet — the wiring into reap is warren-14d6.
 */

import { warrenConfigRelativePath } from "../../warren-config/config.ts";
import type { AutoMergeConfig, AutoMergeMethod } from "../../warren-config/pr-config.ts";

/* ----------------------------------------------------------------------- */
/* Vocabulary                                                               */
/* ----------------------------------------------------------------------- */

/** Every reason arming can be skipped before it starts (design record §5). */
export type AutoMergeSkipReason =
	| "off"
	| "unsupported_forge"
	| "protected_path"
	| "config_changed"
	| "empty_diff"
	| "diff_unreadable"
	| "ci_fixer_run";

/**
 * The changed-file list a three-dot diff produced, or the marker that it
 * could not be computed. An empty `paths` array is a *computed* empty list —
 * a distinct fact from `unreadable`, and one the policy refuses to arm on.
 */
export type ChangedPaths =
	| { readonly kind: "changed"; readonly paths: readonly string[] }
	| { readonly kind: "unreadable" };

/** The policy's answer: arm with the resolved method, or skip with a reason. */
export type AutoMergeDecision =
	| { readonly decision: "arm"; readonly method: AutoMergeMethod }
	| {
			readonly decision: "skip";
			readonly reason: AutoMergeSkipReason;
			/** Matching changed files — present on `protected_path` / `config_changed`. */
			readonly paths?: readonly string[];
	  };

/**
 * `.warren/config.yaml` is ALWAYS implicitly protected (design record §3):
 * the operator's `protectedPaths` list does not carry it and cannot remove
 * it. A PR that edits the config can never arm, so a config change cannot
 * ride an armed PR into the next chained child's base ref.
 */
export const ALWAYS_PROTECTED_CONFIG_PATH = warrenConfigRelativePath("config");

/** Policy inputs — every value the decision needs, none of the I/O. */
export interface AutoMergePolicyInput {
	/**
	 * The `pr.autoMerge` block resolved from the PR's BASE ref (design record
	 * §3.1), never from the run-branch working tree — the agent authors the
	 * run branch, and a policy the agent can edit in the same PR is not a
	 * policy. `undefined` means the block is absent (or unreadable/invalid)
	 * at the base ref, which is `off`.
	 */
	readonly config: AutoMergeConfig | undefined;
	/**
	 * The forge's `autoMergeArm` capability, threaded as a plain boolean so
	 * this module stays free of forge types. `false` ⇒ `unsupported_forge`;
	 * the caller never invokes `armAutoMerge` past a false flag.
	 */
	readonly forgeCanArm: boolean;
	/** The three-dot changed-path list, or the unreadable marker. */
	readonly changedPaths: ChangedPaths;
	/**
	 * True when the run is a CI-fixer run (`run.trigger === CI_FIXER_TRIGGER`,
	 * the same fact that self-skips PR opening in `pr-open.ts`). A CI-fixer
	 * push rides an existing armed PR head, so there is nothing new to arm.
	 */
	readonly ciFixerRun: boolean;
}

/* ----------------------------------------------------------------------- */
/* The decision                                                             */
/* ----------------------------------------------------------------------- */

/**
 * Decide whether the pull request reap just opened may be armed. Pure and
 * total: it never throws, never reads, and never arms on an input it could
 * not fully evaluate. Order mirrors design record §4 exactly — the earliest
 * matching rule wins, so `ci_fixer_run` outranks everything and `off`
 * outranks `unsupported_forge`. The empty/unreadable pair is checked before
 * the path rules: an unreadable or empty diff never arms, even when the
 * visible fragment of it happens to look clean (warren-7b2f).
 */
export function decideAutoMerge(input: AutoMergePolicyInput): AutoMergeDecision {
	// §4.1 — mirrors the `reap.pr_open_skipped` self-skip for CI-fixer runs.
	if (input.ciFixerRun) return { decision: "skip", reason: "ci_fixer_run" };
	// §4.2 — the base-ref block IS the switch; absent (or unreadable) = off.
	const config = input.config;
	if (config === undefined) return { decision: "skip", reason: "off" };
	// §4.3 — the domain never calls past a false capability flag.
	if (!input.forgeCanArm) return { decision: "skip", reason: "unsupported_forge" };
	// §4.4 — diff policy, in record order. The list is read from git in the
	// project clone (base ref against the pushed run branch), never from the
	// forge files API: the warren-7b2f bypass was one wrong API field name
	// away from a silent permit, and a git read cannot key the wrong field.
	const changed = input.changedPaths;
	if (changed.kind === "unreadable") return { decision: "skip", reason: "diff_unreadable" };
	if (changed.paths.length === 0) return { decision: "skip", reason: "empty_diff" };
	const matched = changed.paths.filter((path) =>
		pathMatchesProtectedEntry(path, config.protectedPaths),
	);
	if (matched.length > 0) {
		return { decision: "skip", reason: "protected_path", paths: matched };
	}
	if (changed.paths.includes(ALWAYS_PROTECTED_CONFIG_PATH)) {
		// A diff that touches `.warren/config.yaml` never arms, regardless of
		// the list — the base-ref rule alone cannot cover a chained child
		// that edits the config its own policy resolves from.
		return {
			decision: "skip",
			reason: "config_changed",
			paths: [ALWAYS_PROTECTED_CONFIG_PATH],
		};
	}
	return { decision: "arm", method: config.method };
}

/* ----------------------------------------------------------------------- */
/* Protected-path matching (design record §3)                               */
/* ----------------------------------------------------------------------- */

/**
 * Does any `protectedPaths` entry match the changed path? Entry semantics
 * (design record §3): a plain entry matches as a path PREFIX —
 * `src/registry/builtins/` covers the directory and `docs/CONSTITUTION.md`
 * covers the file and anything named after it (failing closed on a near
 * match is correct here). An entry carrying glob metacharacters matches as
 * a GLOB: `*` and `?` stay within one path segment, a lone `**` segment
 * crosses segments (`src/forge/**` covers the subtree), `?` is one
 * character, and `[abc]` is a character class.
 */
function pathMatchesProtectedEntry(changedPath: string, entries: readonly string[]): boolean {
	for (const entry of entries) {
		if (matchesProtectedPath(changedPath, entry)) return true;
	}
	return false;
}

/** Does ONE protectedPaths entry match the changed path? */
export function matchesProtectedPath(changedPath: string, entry: string): boolean {
	if (!hasGlobMetacharacters(entry)) return changedPath.startsWith(entry);
	const compiled = compileGlob(entry);
	return compiled === null ? true : compiled.test(changedPath);
}

/** Characters that make an entry a glob rather than a plain prefix. */
const GLOB_METACHARACTERS = ["*", "?", "["] as const;

function hasGlobMetacharacters(entry: string): boolean {
	return GLOB_METACHARACTERS.some((ch) => entry.includes(ch));
}

/**
 * Compile a glob entry to a regexp, or `null` when the entry cannot be
 * parsed (an unterminated or empty character class, or a class that does not
 * compile, like `[z-a]`). A `null` compile makes the entry match EVERY
 * changed path — fail closed. An unreadable pattern must refuse arming,
 * not quietly protect nothing; the skip event the operator then sees names
 * the entry's matches and surfaces the typo.
 */
function compileGlob(pattern: string): RegExp | null {
	const segments = pattern.split("/");
	let source = "^";
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (segment === undefined) continue;
		const last = index === segments.length - 1;
		if (segment === "**") {
			// A lone `**` segment crosses path segments; a trailing one covers
			// everything below the prefix; an interior one may cover none.
			source += last ? ".*" : "(?:.+/)?";
			continue;
		}
		const translated = segmentToRegExpSource(segment);
		if (translated === null) return null;
		source += translated;
		if (!last) source += "/";
	}
	try {
		return new RegExp(`${source}$`);
	} catch {
		return null;
	}
}

const REGEX_METACHARACTER = /[.*+?^${}()|[\]\\]/;

/** Escape one literal character for a `new RegExp` source string. */
function escapeChar(ch: string): string {
	return REGEX_METACHARACTER.test(ch) ? `\\${ch}` : ch;
}

/**
 * Translate one path segment: `*` → within-segment wildcard, `?` → one
 * character, `[...]` → character class, everything else literal. `null`
 * when the segment carries an unterminated or empty character class — the
 * caller then treats the whole entry as unparseable (fail closed).
 */
function segmentToRegExpSource(segment: string): string | null {
	let source = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === undefined) continue;
		if (ch === "*") {
			source += "[^/]*";
		} else if (ch === "?") {
			source += "[^/]";
		} else if (ch === "[") {
			const parsed = parseCharClass(segment, i);
			if (parsed === null) return null;
			source += parsed.source;
			i = parsed.end;
		} else {
			source += escapeChar(ch);
		}
	}
	return source;
}

interface CharClassParse {
	/** The class source (`[abc]`, or `[^abc]` for a `!` negation). */
	readonly source: string;
	/** Index of the closing `]`; the caller resumes after it. */
	readonly end: number;
}

/** Parse the `[...]` class starting at `start`; null when it is not a class. */
function parseCharClass(segment: string, start: number): CharClassParse | null {
	const close = segment.indexOf("]", start + 1);
	if (close === -1) return null;
	let body = segment.slice(start + 1, close);
	if (body === "") return null;
	if (body.startsWith("!")) body = `^${body.slice(1)}`;
	return { source: `[${body}]`, end: close };
}
