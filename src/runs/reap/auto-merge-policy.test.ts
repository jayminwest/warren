import { describe, expect, test } from "bun:test";
import type { AutoMergeConfig } from "../../warren-config/pr-config.ts";
import {
	ALWAYS_PROTECTED_CONFIG_PATH,
	type AutoMergeDecision,
	type AutoMergePolicyInput,
	type AutoMergeSkipReason,
	decideAutoMerge,
	matchesProtectedPath,
} from "./auto-merge-policy.ts";

/**
 * The auto-merge arming policy (warren-970a, plan pl-92a3 step 5): the pure
 * decision function plus the protected-path matcher, table-driven per the
 * issue. Every reason, the precedence between reasons, and the fail-closed
 * cases are pinned here; the design record (docs/design/forge-auto-merge.md
 * §3–§4) is the source for the order and the matching rule.
 */

function config(overrides: Partial<AutoMergeConfig> = {}): AutoMergeConfig {
	return { method: "squash", protectedPaths: [], ...overrides };
}

function changed(paths: readonly string[]): AutoMergePolicyInput["changedPaths"] {
	return { kind: "changed", paths };
}

const UNREADABLE: AutoMergePolicyInput["changedPaths"] = { kind: "unreadable" };

interface Case {
	readonly name: string;
	readonly input: AutoMergePolicyInput;
	readonly expected: AutoMergeDecision;
}

/**
 * The §4 table: each row pins one rule, and the precedence rows pin the
 * order between rules — the earliest matching rule must win.
 */
const CASES: readonly Case[] = [
	{
		name: "skips a CI-fixer run before every other rule",
		input: {
			config: config(),
			forgeCanArm: false,
			changedPaths: UNREADABLE,
			ciFixerRun: true,
		},
		expected: { decision: "skip", reason: "ci_fixer_run" },
	},
	{
		name: "skips ci_fixer_run even when the base ref carries no block",
		input: {
			config: undefined,
			forgeCanArm: true,
			changedPaths: changed(["src/a.ts"]),
			ciFixerRun: true,
		},
		expected: { decision: "skip", reason: "ci_fixer_run" },
	},
	{
		name: "skips off when the base ref carries no pr.autoMerge block",
		input: {
			config: undefined,
			forgeCanArm: true,
			changedPaths: changed(["src/a.ts"]),
			ciFixerRun: false,
		},
		expected: { decision: "skip", reason: "off" },
	},
	{
		name: "skips off before unsupported_forge (off outranks the capability)",
		input: {
			config: undefined,
			forgeCanArm: false,
			changedPaths: changed(["src/a.ts"]),
			ciFixerRun: false,
		},
		expected: { decision: "skip", reason: "off" },
	},
	{
		name: "skips unsupported_forge when the forge cannot arm",
		input: {
			config: config(),
			forgeCanArm: false,
			changedPaths: changed(["src/a.ts"]),
			ciFixerRun: false,
		},
		expected: { decision: "skip", reason: "unsupported_forge" },
	},
	{
		name: "skips unsupported_forge before the diff rules",
		input: {
			config: config(),
			forgeCanArm: false,
			changedPaths: UNREADABLE,
			ciFixerRun: false,
		},
		expected: { decision: "skip", reason: "unsupported_forge" },
	},
	{
		name: "skips diff_unreadable when the changed-path list could not be computed",
		input: {
			config: config(),
			forgeCanArm: true,
			changedPaths: UNREADABLE,
			ciFixerRun: false,
		},
		expected: { decision: "skip", reason: "diff_unreadable" },
	},
	{
		name: "skips empty_diff when the computed changed-path list is empty (warren-7b2f)",
		input: {
			config: config(),
			forgeCanArm: true,
			changedPaths: changed([]),
			ciFixerRun: false,
		},
		expected: { decision: "skip", reason: "empty_diff" },
	},
	{
		name: "skips empty_diff even for a config that arms everything else",
		input: {
			config: config({ protectedPaths: [] }),
			forgeCanArm: true,
			changedPaths: changed([]),
			ciFixerRun: false,
		},
		expected: { decision: "skip", reason: "empty_diff" },
	},
	{
		name: "skips protected_path naming the changed files that matched",
		input: {
			config: config({ protectedPaths: ["src/registry/builtins/"] }),
			forgeCanArm: true,
			changedPaths: changed(["src/a.ts", "src/registry/builtins/planner.ts"]),
			ciFixerRun: false,
		},
		expected: {
			decision: "skip",
			reason: "protected_path",
			paths: ["src/registry/builtins/planner.ts"],
		},
	},
	{
		name: "skips protected_path before config_changed when both rules hit",
		input: {
			config: config({ protectedPaths: ["docs/CONSTITUTION.md"] }),
			forgeCanArm: true,
			changedPaths: changed([ALWAYS_PROTECTED_CONFIG_PATH, "docs/CONSTITUTION.md"]),
			ciFixerRun: false,
		},
		expected: {
			decision: "skip",
			reason: "protected_path",
			paths: ["docs/CONSTITUTION.md"],
		},
	},
	{
		name: "skips config_changed when the diff touches .warren/config.yaml",
		input: {
			config: config({ protectedPaths: [] }),
			forgeCanArm: true,
			changedPaths: changed(["src/a.ts", ALWAYS_PROTECTED_CONFIG_PATH]),
			ciFixerRun: false,
		},
		expected: {
			decision: "skip",
			reason: "config_changed",
			paths: [ALWAYS_PROTECTED_CONFIG_PATH],
		},
	},
	{
		name: "skips config_changed with an empty protectedPaths list (the list cannot remove it)",
		input: {
			config: config(),
			forgeCanArm: true,
			changedPaths: changed([ALWAYS_PROTECTED_CONFIG_PATH]),
			ciFixerRun: false,
		},
		expected: {
			decision: "skip",
			reason: "config_changed",
			paths: [ALWAYS_PROTECTED_CONFIG_PATH],
		},
	},
	{
		name: "skips protected_path on the config file when the operator list covers it",
		input: {
			config: config({ protectedPaths: [".warren/"] }),
			forgeCanArm: true,
			changedPaths: changed([ALWAYS_PROTECTED_CONFIG_PATH]),
			ciFixerRun: false,
		},
		expected: {
			decision: "skip",
			reason: "protected_path",
			paths: [ALWAYS_PROTECTED_CONFIG_PATH],
		},
	},
	{
		name: "arms with the configured method when nothing protected changed",
		input: {
			config: config({ method: "merge", protectedPaths: ["docs/"] }),
			forgeCanArm: true,
			changedPaths: changed(["src/a.ts", "src/deep/b.ts"]),
			ciFixerRun: false,
		},
		expected: { decision: "arm", method: "merge" },
	},
	{
		name: "arms with the rebase method and ignores non-matching glob entries",
		input: {
			config: config({
				method: "rebase",
				protectedPaths: ["src/forge/**", "*.golden.md"],
			}),
			forgeCanArm: true,
			changedPaths: changed(["src/runs/a.ts", "docs/deep/b.md"]),
			ciFixerRun: false,
		},
		expected: { decision: "arm", method: "rebase" },
	},
];

describe("decideAutoMerge", () => {
	for (const testCase of CASES) {
		test(testCase.name, () => {
			expect(decideAutoMerge(testCase.input)).toEqual(testCase.expected);
		});
	}

	test("skips off even when the diff is unreadable (off outranks the diff rules)", () => {
		expect(
			decideAutoMerge({
				config: undefined,
				forgeCanArm: true,
				changedPaths: UNREADABLE,
				ciFixerRun: false,
			}),
		).toEqual({ decision: "skip", reason: "off" });
	});

	test("skips empty_diff before protected_path (an empty list never arms, warren-7b2f)", () => {
		expect(
			decideAutoMerge({
				config: config({ protectedPaths: ["docs/CONSTITUTION.md"] }),
				forgeCanArm: true,
				changedPaths: changed([]),
				ciFixerRun: false,
			}),
		).toEqual({ decision: "skip", reason: "empty_diff" });
	});

	test("arms for every merge method the config can carry", () => {
		for (const method of ["squash", "merge", "rebase"] as const) {
			expect(
				decideAutoMerge({
					config: config({ method }),
					forgeCanArm: true,
					changedPaths: changed(["src/a.ts"]),
					ciFixerRun: false,
				}),
			).toEqual({ decision: "arm", method });
		}
	});

	test("omits the paths field on every reason that names no files", () => {
		const flat: { input: AutoMergePolicyInput; reason: AutoMergeSkipReason }[] = [
			{
				input: {
					config: undefined,
					forgeCanArm: true,
					changedPaths: changed(["a.ts"]),
					ciFixerRun: false,
				},
				reason: "off",
			},
			{
				input: {
					config: config(),
					forgeCanArm: false,
					changedPaths: changed(["a.ts"]),
					ciFixerRun: false,
				},
				reason: "unsupported_forge",
			},
			{
				input: {
					config: config(),
					forgeCanArm: true,
					changedPaths: UNREADABLE,
					ciFixerRun: false,
				},
				reason: "diff_unreadable",
			},
			{
				input: {
					config: config(),
					forgeCanArm: true,
					changedPaths: changed([]),
					ciFixerRun: false,
				},
				reason: "empty_diff",
			},
			{
				input: {
					config: config(),
					forgeCanArm: true,
					changedPaths: changed(["a.ts"]),
					ciFixerRun: true,
				},
				reason: "ci_fixer_run",
			},
		];
		for (const { input, reason } of flat) {
			expect(decideAutoMerge(input)).toEqual({ decision: "skip", reason });
		}
	});
});

/* ----------------------------------------------------------------------- */
/* Protected-path matching (design record §3)                                */
/* ----------------------------------------------------------------------- */

interface MatchCase {
	readonly entry: string;
	readonly changedPath: string;
	readonly matches: boolean;
}

const MATCH_CASES: readonly MatchCase[] = [
	// Plain entries match as path prefixes.
	{ entry: "docs/CONSTITUTION.md", changedPath: "docs/CONSTITUTION.md", matches: true },
	// "covers the file and anything named after it" — fail closed on near matches.
	{ entry: "docs/CONSTITUTION.md", changedPath: "docs/CONSTITUTION.md.bak", matches: true },
	{ entry: "docs/CONSTITUTION.md", changedPath: "docs/other.md", matches: false },
	{ entry: "docs/CONSTITUTION.md", changedPath: "other/docs/CONSTITUTION.md", matches: false },
	// A directory entry covers everything under it.
	{
		entry: "src/registry/builtins/",
		changedPath: "src/registry/builtins/planner.ts",
		matches: true,
	},
	{
		entry: "src/registry/builtins",
		changedPath: "src/registry/builtins-extra/x.ts",
		matches: true,
	},
	{
		entry: "src/registry/builtins/",
		changedPath: "src/registry/other/x.ts",
		matches: false,
	},
	// Globs: a lone `**` segment crosses directories.
	{ entry: "src/forge/**", changedPath: "src/forge/github/provider.ts", matches: true },
	{ entry: "src/forge/**", changedPath: "src/forge/a.ts", matches: true },
	{ entry: "src/forge/**", changedPath: "src/forger/a.ts", matches: false },
	{ entry: "src/forge/**", changedPath: "src/runs/a.ts", matches: false },
	{ entry: "**/*.golden.md", changedPath: "x.golden.md", matches: true },
	{ entry: "**/*.golden.md", changedPath: "docs/deep/x.golden.md", matches: true },
	{ entry: "**/*.golden.md", changedPath: "docs/deep/x.md", matches: false },
	{ entry: "src/**/wire.ts", changedPath: "src/core/wire.ts", matches: true },
	{ entry: "src/**/wire.ts", changedPath: "src/wire.ts", matches: true },
	{ entry: "src/**/wire.ts", changedPath: "docs/wire.ts", matches: false },
	// A single `*` stays inside one path segment.
	{ entry: "docs/*.md", changedPath: "docs/a.md", matches: true },
	{ entry: "docs/*.md", changedPath: "docs/deep/a.md", matches: false },
	// `?` matches exactly one character.
	{ entry: "file?.ts", changedPath: "file1.ts", matches: true },
	{ entry: "file?.ts", changedPath: "file10.ts", matches: false },
	// `[abc]` is a character class; `!` negates it.
	{ entry: "file[ab].ts", changedPath: "filea.ts", matches: true },
	{ entry: "file[ab].ts", changedPath: "filec.ts", matches: false },
	{ entry: "file[!ab].ts", changedPath: "filec.ts", matches: true },
	{ entry: "file[!ab].ts", changedPath: "filea.ts", matches: false },
	// Regex metacharacters in an entry are literal, not a second glob syntax.
	{ entry: "file.v2.ts", changedPath: "fileXv2.ts", matches: false },
	{ entry: "a+b.ts", changedPath: "aXb.ts", matches: false },
	// A malformed glob entry fails closed: it matches everything, so arming
	// is refused and the skip event surfaces the operator's typo.
	{ entry: "file[z-a].ts", changedPath: "docs/anything.md", matches: true },
	{ entry: "[", changedPath: "docs/anything.md", matches: true },
];

describe("matchesProtectedPath", () => {
	for (const { entry, changedPath, matches } of MATCH_CASES) {
		test(`${matches ? "matches" : "does not match"} ${changedPath} against ${entry}`, () => {
			expect(matchesProtectedPath(changedPath, entry)).toBe(matches);
		});
	}
});
