import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	FIXTURE_GIT_ENV,
	fixtureGitCmd,
	makeWorktreeFixture,
	type WorktreeFixture,
} from "../../sandbox/git-scope.test-helpers.ts";
import { resolveWorkspaceGitScope } from "../../sandbox/git-scope.ts";
import {
	registerWorkspaceGitPin,
	unregisterWorkspaceGitPin,
} from "../../workspace/git/host-git.ts";
import { scrubbedGitEnv } from "../../workspace/git/test-fixture.ts";
import { defaultExec } from "./util.ts";

// GIT_* keys mapped to undefined so an inherited GIT_DIR cannot redirect.
function execEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...FIXTURE_GIT_ENV };
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
	}
	return env;
}

describe("defaultExec host-side git (warren-8926)", () => {
	let fx: WorktreeFixture;
	let marker: string;
	beforeEach(() => {
		fx = makeWorktreeFixture();
		marker = join(fx.root, "hook-ran");
		const hooks = join(fx.root, "hooks");
		mkdirSync(hooks);
		writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
		fixtureGitCmd(fx.clone, "config", "core.hooksPath", hooks);
	});
	afterEach(() => {
		unregisterWorkspaceGitPin(fx.ws);
		rmSync(fx.root, { recursive: true, force: true });
	});

	test("pins a registered workspace to its validated git dir, ignoring a rewritten .git", async () => {
		const scope = resolveWorkspaceGitScope(fx.ws, fx.common);
		registerWorkspaceGitPin(fx.ws, scope);
		// The run rewrites its .git pointer at a repository it controls.
		const other = join(fx.root, "other");
		mkdirSync(other);
		fixtureGitCmd(other, "init", "-q");
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${join(other, ".git")}\n`);
		const out = await defaultExec.run("git", ["rev-parse", "--absolute-git-dir"], {
			cwd: fx.ws,
			env: execEnv(),
		});
		expect(out.stdout.trim()).toBe(scope.gitDir);
	});

	test("never runs repository hooks on a host-side commit", async () => {
		const scope = resolveWorkspaceGitScope(fx.ws, fx.common);
		registerWorkspaceGitPin(fx.ws, scope);
		writeFileSync(join(fx.ws, "f"), "x\n");
		await defaultExec.run("git", ["add", "f"], { cwd: fx.ws, env: execEnv() });
		await defaultExec.run("git", ["commit", "-q", "-m", "reap"], { cwd: fx.ws, env: execEnv() });
		expect(fixtureGitCmd(fx.clone, "log", "-1", "--format=%s", "warren/run")).toBe("reap");
		expect(existsSync(marker)).toBe(false);
		// Control: the same hook DOES fire for unhardened git.
		Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", "ctl"], {
			cwd: fx.ws,
			env: { ...scrubbedGitEnv(), ...FIXTURE_GIT_ENV },
		});
		expect(existsSync(marker)).toBe(true);
	});

	test("a replaced admin dir cannot supply host git's repository config", async () => {
		const scope = resolveWorkspaceGitScope(fx.ws, fx.common);
		registerWorkspaceGitPin(fx.ws, scope);
		// End state of an admin dir swapped for a self-contained repository: no
		// commondir, its own config carrying a filter driver.
		const filterMarker = join(fx.root, "filter-ran");
		const filter = join(fx.root, "filter.sh");
		writeFileSync(filter, `#!/bin/sh\ntouch ${filterMarker}\ncat\n`, { mode: 0o755 });
		renameSync(scope.gitDir, `${scope.gitDir}.old`);
		for (const sub of ["objects", "refs"]) mkdirSync(join(scope.gitDir, sub), { recursive: true });
		writeFileSync(join(scope.gitDir, "HEAD"), "ref: refs/heads/warren/run\n");
		writeFileSync(
			join(scope.gitDir, "config"),
			`[core]\n\trepositoryformatversion = 0\n[filter "x"]\n\tclean = ${filter}\n`,
		);
		writeFileSync(join(fx.ws, ".gitattributes"), "* filter=x\n");
		writeFileSync(join(fx.ws, "f"), "x\n");
		await defaultExec.run("git", ["add", "-A"], { cwd: fx.ws, env: execEnv() });
		expect(existsSync(filterMarker)).toBe(false);
		// Control: without the GIT_COMMON_DIR pin the same argv runs the filter.
		writeFileSync(join(fx.ws, "g"), "y\n");
		Bun.spawnSync(["git", `--git-dir=${scope.gitDir}`, `--work-tree=${fx.ws}`, "add", "-A"], {
			cwd: fx.ws,
			env: { ...scrubbedGitEnv(), ...FIXTURE_GIT_ENV },
		});
		expect(existsSync(filterMarker)).toBe(true);
	});

	test("refuses an unregistered run worktree, from any subdirectory", async () => {
		await expect(
			defaultExec.run("git", ["status"], { cwd: fx.ws, env: execEnv() }),
		).rejects.toThrow(/no validated git dir pin/);
		const sub = join(fx.ws, "nested", "dir");
		mkdirSync(sub, { recursive: true });
		await expect(defaultExec.run("git", ["status"], { cwd: sub, env: execEnv() })).rejects.toThrow(
			/no validated git dir pin/,
		);
	});
});
