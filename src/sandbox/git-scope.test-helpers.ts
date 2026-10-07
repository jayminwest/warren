/**
 * Real git worktree fixtures for the warren-8926 git-scope tests: a host
 * clone with two linked worktrees (the run under test and a sibling).
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubbedGitEnv } from "../workspace/git/test-fixture.ts";

export const FIXTURE_GIT_ENV: Record<string, string> = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
	GIT_CONFIG_NOSYSTEM: "1",
};

/** Run fixture git with a scrubbed env (no inherited GIT_DIR etc.). */
export function fixtureGitCmd(cwd: string, ...args: string[]): string {
	const res = Bun.spawnSync(["git", ...args], {
		cwd,
		env: { ...scrubbedGitEnv(), ...FIXTURE_GIT_ENV },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (res.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
	}
	return res.stdout.toString().trim();
}

export interface WorktreeFixture {
	readonly root: string;
	readonly clone: string;
	readonly common: string;
	readonly ws: string;
	readonly sibling: string;
}

export function makeWorktreeFixture(): WorktreeFixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "warren-git-scope-")));
	const clone = join(root, "clone");
	mkdirSync(clone);
	fixtureGitCmd(clone, "init", "-q", "-b", "main");
	writeFileSync(join(clone, "README"), "hi\n");
	fixtureGitCmd(clone, "add", "README");
	fixtureGitCmd(clone, "commit", "-q", "-m", "init");
	const ws = join(root, "ws-run");
	const sibling = join(root, "ws-sibling");
	fixtureGitCmd(clone, "worktree", "add", "-q", "-b", "warren/run", ws);
	fixtureGitCmd(clone, "worktree", "add", "-q", "-b", "warren/sibling", sibling);
	return { root, clone, common: join(clone, ".git"), ws, sibling };
}

/** The realpath'd admin dir a workspace's `.git` file points at. */
export function adminDirOf(ws: string): string {
	const raw = readFileSync(join(ws, ".git"), "utf8")
		.replace(/^gitdir:\s*/, "")
		.trim();
	return realpathSync(raw);
}
