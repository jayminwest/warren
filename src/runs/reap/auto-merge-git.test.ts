import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	createGitFixture,
	type GitFixture,
	gitFixtureEnv,
} from "../../workspace/git/test-fixture.ts";
import {
	computeAutoMergeChangedPaths,
	parseBaseAutoMergeConfig,
	readBaseAutoMergeConfig,
} from "./auto-merge-git.ts";
import { decideAutoMerge } from "./auto-merge-policy.ts";
import type { ReapExec } from "./types.ts";
import { defaultExec } from "./util.ts";

/**
 * Git reads for the auto-merge arming policy (warren-970a, plan pl-92a3
 * step 5), verified against real temp repos. The fixtures come from
 * `createGitFixture`, which sets its own repo-local user.name/user.email and
 * asserts hermeticity, so no spawn can touch (or read) the real repo's
 * config. Every spawn through `fixtureExec` additionally drops inherited
 * `GIT_*` discovery vars and pins the discovery ceiling to the fixture — the
 * warren-cfa7 posture at the spawn site.
 */

const UNSET_GIT_DISCOVERY: Record<string, string | undefined> = {
	GIT_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
	GIT_COMMON_DIR: undefined,
	GIT_PREFIX: undefined,
};

/** Hermetic `ReapExec` for these suites: scrubbed env + pinned ceiling per spawn. */
const fixtureExec: ReapExec = {
	run: (cmd, args, opts) =>
		defaultExec.run(cmd, args, {
			...opts,
			env: { ...gitFixtureEnv(opts.cwd), ...UNSET_GIT_DISCOVERY },
		}),
};

/** Test-side git: assert exit 0 so a setup failure fails the test loudly. */
async function git(fixture: GitFixture, ...args: string[]): Promise<string> {
	const res = await fixture.git(args);
	if (res.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr}`);
	}
	return res.stdout;
}

async function write(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents);
}

async function commitAll(fixture: GitFixture, message: string): Promise<void> {
	await git(fixture, "add", "-A");
	await git(fixture, "commit", "-q", "-m", message);
}

describe("computeAutoMergeChangedPaths", () => {
	let fixture: GitFixture;

	test("lists adds, modifies, and deletes across the three-dot range", async () => {
		fixture = await createGitFixture({ prefix: "warren-am-changed-", initCommit: "base" });
		await write(join(fixture.path, "a.ts"), "one\n");
		await write(join(fixture.path, "keep.ts"), "keep\n");
		await write(join(fixture.path, "drop.ts"), "drop\n");
		await commitAll(fixture, "base files");
		await git(fixture, "checkout", "-qb", "feature");
		await write(join(fixture.path, "a.ts"), "one\ntwo\n");
		await write(join(fixture.path, "new.ts"), "new\n");
		await git(fixture, "rm", "-q", "drop.ts");
		await commitAll(fixture, "change files");

		const result = await computeAutoMergeChangedPaths(fixtureExec, fixture.path, "main", "feature");
		expect(result.kind).toBe("changed");
		if (result.kind === "changed")
			expect([...result.paths].sort()).toEqual(["a.ts", "drop.ts", "new.ts"]);
	});

	test("lists both sides of a rename (the fail-closed no-renames read)", async () => {
		fixture = await createGitFixture({ prefix: "warren-am-rename-", initCommit: "base" });
		await write(join(fixture.path, "docs/CONSTITUTION.md"), "article\n");
		await commitAll(fixture, "constitution");
		await git(fixture, "checkout", "-qb", "feature");
		await git(fixture, "mv", "docs/CONSTITUTION.md", "docs/renamed.md");
		await commitAll(fixture, "move it away");

		const result = await computeAutoMergeChangedPaths(fixtureExec, fixture.path, "main", "feature");
		expect(result.kind).toBe("changed");
		if (result.kind === "changed") {
			// Rename detection would show only the destination and silently miss
			// the protected side of the move; --no-renames lists both.
			expect([...result.paths].sort()).toEqual(["docs/CONSTITUTION.md", "docs/renamed.md"]);
		}
	});

	test("excludes base-side drift after the branches diverge (merge-base semantics)", async () => {
		fixture = await createGitFixture({ prefix: "warren-am-mergebase-", initCommit: "base" });
		await git(fixture, "checkout", "-qb", "feature");
		await write(join(fixture.path, "feat.txt"), "from feature\n");
		await commitAll(fixture, "feature work");
		await git(fixture, "checkout", "main");
		await write(join(fixture.path, "drift.txt"), "landed on base\n");
		await commitAll(fixture, "base drift");

		const result = await computeAutoMergeChangedPaths(fixtureExec, fixture.path, "main", "feature");
		expect(result).toEqual({ kind: "changed", paths: ["feat.txt"] });
	});

	test("computes an empty list when head matches base", async () => {
		fixture = await createGitFixture({ prefix: "warren-am-empty-", initCommit: "base" });
		await write(join(fixture.path, "a.ts"), "one\n");
		await commitAll(fixture, "file");
		const result = await computeAutoMergeChangedPaths(fixtureExec, fixture.path, "main", "main");
		expect(result).toEqual({ kind: "changed", paths: [] });
	});

	test("returns paths with spaces and non-ASCII names literally", async () => {
		fixture = await createGitFixture({ prefix: "warren-am-unicode-", initCommit: "base" });
		await write(join(fixture.path, "dir with space/ünïcode.md"), "x\n");
		await commitAll(fixture, "base");
		await git(fixture, "checkout", "-qb", "feature");
		await write(join(fixture.path, "dir with space/ünïcode.md"), "x\ny\n");
		await commitAll(fixture, "edit");
		const result = await computeAutoMergeChangedPaths(fixtureExec, fixture.path, "main", "feature");
		expect(result).toEqual({ kind: "changed", paths: ["dir with space/ünïcode.md"] });
	});

	test("returns the unreadable marker when the base ref does not resolve", async () => {
		fixture = await createGitFixture({ prefix: "warren-am-badref-", initCommit: "base" });
		const result = await computeAutoMergeChangedPaths(
			fixtureExec,
			fixture.path,
			"refs/heads/does-not-exist",
			"main",
		);
		expect(result).toEqual({ kind: "unreadable" });
	});

	test("returns the unreadable marker when cwd is not a repository", async () => {
		fixture = await createGitFixture({ prefix: "warren-am-norepo-", initCommit: "base" });
		const result = await computeAutoMergeChangedPaths(fixtureExec, fixture.root, "main", "main");
		expect(result).toEqual({ kind: "unreadable" });
	});
});

describe("readBaseAutoMergeConfig", () => {
	const BASE_CONFIG = [
		"pr:",
		"  autoMerge:",
		"    method: merge",
		"    protectedPaths:",
		"      - docs/CONSTITUTION.md",
	].join("\n");

	test("loads pr.autoMerge from the base ref, not the run-branch working tree", async () => {
		const fixture = await createGitFixture({ prefix: "warren-am-base-", initCommit: "base" });
		try {
			await write(join(fixture.path, ".warren/config.yaml"), `${BASE_CONFIG}\n`);
			await commitAll(fixture, "opt in on base");
			await git(fixture, "checkout", "-qb", "feature");
			await write(join(fixture.path, ".warren/config.yaml"), "pr: {}\n");
			await commitAll(fixture, "run branch turns it off");

			// The base ref still carries the block even though the run branch
			// (and the checked-out working tree) removed it — the agent must
			// not be able to edit its own merge policy.
			await expect(readBaseAutoMergeConfig(fixtureExec, fixture.path, "main")).resolves.toEqual({
				method: "merge",
				protectedPaths: ["docs/CONSTITUTION.md"],
			});
			await expect(
				readBaseAutoMergeConfig(fixtureExec, fixture.path, "feature"),
			).resolves.toBeUndefined();
		} finally {
			fixture.cleanup();
		}
	});

	test("returns undefined when .warren/config.yaml is absent at the base ref", async () => {
		const fixture = await createGitFixture({ prefix: "warren-am-absent-", initCommit: "base" });
		try {
			await write(join(fixture.path, "src/a.ts"), "a\n");
			await commitAll(fixture, "no config");
			await expect(
				readBaseAutoMergeConfig(fixtureExec, fixture.path, "main"),
			).resolves.toBeUndefined();
		} finally {
			fixture.cleanup();
		}
	});

	test("returns undefined when the base ref does not resolve", async () => {
		const fixture = await createGitFixture({ prefix: "warren-am-badref2-", initCommit: "base" });
		try {
			await write(join(fixture.path, ".warren/config.yaml"), `${BASE_CONFIG}\n`);
			await commitAll(fixture, "config");
			await expect(
				readBaseAutoMergeConfig(fixtureExec, fixture.path, "refs/heads/missing"),
			).resolves.toBeUndefined();
		} finally {
			fixture.cleanup();
		}
	});

	test("applies the schema defaults to a bare block at the base ref", async () => {
		const fixture = await createGitFixture({ prefix: "warren-am-defaults-", initCommit: "base" });
		try {
			await write(join(fixture.path, ".warren/config.yaml"), "pr:\n  autoMerge: {}\n");
			await commitAll(fixture, "bare block");
			await expect(readBaseAutoMergeConfig(fixtureExec, fixture.path, "main")).resolves.toEqual({
				method: "squash",
				protectedPaths: [],
			});
		} finally {
			fixture.cleanup();
		}
	});
});

describe("parseBaseAutoMergeConfig", () => {
	interface ParseCase {
		readonly name: string;
		readonly raw: string;
		readonly expected:
			| undefined
			| { method: "squash" | "merge" | "rebase"; protectedPaths: string[] };
	}

	const CASES: readonly ParseCase[] = [
		{ name: "parses an empty document as off", raw: "", expected: undefined },
		{ name: "parses a comment-only document as off", raw: "# nothing here\n", expected: undefined },
		{ name: "parses a scalar document as off", raw: "just a string\n", expected: undefined },
		{
			name: "parses malformed YAML as off",
			raw: "pr: [unclosed\n",
			expected: undefined,
		},
		{
			name: "parses a document without a pr block as off",
			raw: "defaultRole: coder\n",
			expected: undefined,
		},
		{ name: "parses an empty pr block as off", raw: "pr: {}\n", expected: undefined },
		{
			name: "parses the bare-true shorthand operator as off (fail closed)",
			raw: "pr:\n  autoMerge: true\n",
			expected: undefined,
		},
		{
			name: "parses unknown keys inside autoMerge as off (strict block)",
			raw: "pr:\n  autoMerge:\n    method: squash\n    unexpected: yes\n",
			expected: undefined,
		},
		{
			name: "parses an out-of-vocabulary method as off",
			raw: "pr:\n  autoMerge:\n    method: explode\n",
			expected: undefined,
		},
		{
			name: "applies the squash and empty-list defaults to a bare block",
			raw: "pr:\n  autoMerge: {}\n",
			expected: { method: "squash", protectedPaths: [] },
		},
		{
			name: "round-trips an explicit method and protectedPaths",
			raw: [
				"pr:",
				"  autoMerge:",
				"    method: rebase",
				"    protectedPaths:",
				"      - docs/CONSTITUTION.md",
				"      - src/forge/**",
				"",
			].join("\n"),
			expected: {
				method: "rebase",
				protectedPaths: ["docs/CONSTITUTION.md", "src/forge/**"],
			},
		},
	];

	for (const { name, raw, expected } of CASES) {
		test(`returns ${expected === undefined ? "undefined" : "the block"} — ${name}`, () => {
			expect(parseBaseAutoMergeConfig(raw)).toEqual(expected);
		});
	}
});

describe("auto-merge policy against a real clone", () => {
	test("refuses to arm a diff that renames a protected file away", async () => {
		const fixture = await createGitFixture({ prefix: "warren-am-policy-", initCommit: "base" });
		try {
			await write(
				join(fixture.path, ".warren/config.yaml"),
				[
					"pr:",
					"  autoMerge:",
					"    method: squash",
					"    protectedPaths:",
					"      - docs/CONSTITUTION.md",
					"",
				].join("\n"),
			);
			await write(join(fixture.path, "docs/CONSTITUTION.md"), "article\n");
			await commitAll(fixture, "base");
			await git(fixture, "checkout", "-qb", "feature");
			await git(fixture, "mv", "docs/CONSTITUTION.md", "docs/renamed.md");
			await commitAll(fixture, "move it away");

			const config = await readBaseAutoMergeConfig(fixtureExec, fixture.path, "main");
			const changedPaths = await computeAutoMergeChangedPaths(
				fixtureExec,
				fixture.path,
				"main",
				"feature",
			);
			// The old, protected side of the rename still matches, so the PR
			// never arms — exactly the bypass --no-renames exists to close.
			expect(
				decideAutoMerge({ config, forgeCanArm: true, changedPaths, ciFixerRun: false }),
			).toEqual({
				decision: "skip",
				reason: "protected_path",
				paths: ["docs/CONSTITUTION.md"],
			});
		} finally {
			fixture.cleanup();
		}
	});

	test("refuses to arm a diff that edits .warren/config.yaml regardless of the list", async () => {
		const fixture = await createGitFixture({ prefix: "warren-am-config-", initCommit: "base" });
		try {
			await write(join(fixture.path, ".warren/config.yaml"), "pr:\n  autoMerge: {}\n");
			await write(join(fixture.path, "src/a.ts"), "a\n");
			await commitAll(fixture, "base");
			await git(fixture, "checkout", "-qb", "feature");
			await write(
				join(fixture.path, ".warren/config.yaml"),
				'pr:\n  autoMerge:\n    protectedPaths: ["docs/"]\n',
			);
			await write(join(fixture.path, "src/b.ts"), "b\n");
			await commitAll(fixture, "edit the policy");

			const config = await readBaseAutoMergeConfig(fixtureExec, fixture.path, "main");
			const changedPaths = await computeAutoMergeChangedPaths(
				fixtureExec,
				fixture.path,
				"main",
				"feature",
			);
			expect(
				decideAutoMerge({ config, forgeCanArm: true, changedPaths, ciFixerRun: false }),
			).toEqual({
				decision: "skip",
				reason: "config_changed",
				paths: [".warren/config.yaml"],
			});
		} finally {
			fixture.cleanup();
		}
	});

	test("arms a clean diff with the base-ref method", async () => {
		const fixture = await createGitFixture({ prefix: "warren-am-arm-", initCommit: "base" });
		try {
			await write(
				join(fixture.path, ".warren/config.yaml"),
				"pr:\n  autoMerge:\n    method: rebase\n",
			);
			await commitAll(fixture, "base");
			await git(fixture, "checkout", "-qb", "feature");
			await write(join(fixture.path, "src/a.ts"), "a\n");
			await commitAll(fixture, "clean work");

			const config = await readBaseAutoMergeConfig(fixtureExec, fixture.path, "main");
			const changedPaths = await computeAutoMergeChangedPaths(
				fixtureExec,
				fixture.path,
				"main",
				"feature",
			);
			expect(
				decideAutoMerge({ config, forgeCanArm: true, changedPaths, ciFixerRun: false }),
			).toEqual({ decision: "arm", method: "rebase" });
		} finally {
			fixture.cleanup();
		}
	});
});
