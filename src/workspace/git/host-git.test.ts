import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./exec.ts";
import {
	HOST_GIT_CONFIG_ARGS,
	hardenHostGit,
	isGitCommand,
	isLinkedWorktree,
	registerWorkspaceGitPin,
	UnpinnedWorkspaceGitError,
	unregisterWorkspaceGitPin,
	workspaceGitPinFor,
} from "./host-git.ts";
import { scrubbedGitEnv } from "./test-fixture.ts";

describe("hardenHostGit", () => {
	let dir: string;
	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "warren-host-git-")));
	});
	afterEach(() => {
		unregisterWorkspaceGitPin(join(dir, "ws"));
		rmSync(dir, { recursive: true, force: true });
	});

	test("prefixes the hook/fsmonitor overrides on every host git call", () => {
		expect(hardenHostGit(["status"], dir)).toEqual({
			args: [...HOST_GIT_CONFIG_ARGS, "status"],
			env: {},
		});
		expect(HOST_GIT_CONFIG_ARGS).toEqual([
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
		]);
	});

	test("pins a registered workspace (and its subdirs) to the validated git dir", () => {
		const ws = join(dir, "ws");
		registerWorkspaceGitPin(ws, { gitDir: "/clone/.git/worktrees/ws", commonDir: "/clone/.git" });
		const pin = ["--git-dir=/clone/.git/worktrees/ws", `--work-tree=${ws}`];
		expect(hardenHostGit(["push"], ws)).toEqual({
			args: [...HOST_GIT_CONFIG_ARGS, ...pin, "push"],
			env: { GIT_COMMON_DIR: "/clone/.git" },
		});
		expect(workspaceGitPinFor(join(ws, "sub"))?.workTree).toBe(ws);
		expect(workspaceGitPinFor(`${ws}-other`)).toBeUndefined();
		unregisterWorkspaceGitPin(ws);
		expect(workspaceGitPinFor(ws)).toBeUndefined();
	});

	test("requirePin refuses an unregistered linked worktree instead of reading its .git", () => {
		const ws = join(dir, "ws");
		mkdirSync(ws);
		writeFileSync(join(ws, ".git"), "gitdir: /somewhere\n");
		expect(() => hardenHostGit(["status"], ws, { requirePin: true })).toThrow(
			UnpinnedWorkspaceGitError,
		);
		mkdirSync(join(ws, "a", "b"), { recursive: true });
		expect(isLinkedWorktree(join(ws, "a", "b"))).toBe(true);
		expect(() => hardenHostGit(["status"], join(ws, "a", "b"), { requirePin: true })).toThrow(
			UnpinnedWorkspaceGitError,
		);
		// A plain repo (".git" directory) and a non-repo dir are not run worktrees.
		mkdirSync(join(dir, "repo", ".git"), { recursive: true });
		expect(() => hardenHostGit(["status"], join(dir, "repo"), { requirePin: true })).not.toThrow();
		expect(() => hardenHostGit(["status"], dir, { requirePin: true })).not.toThrow();
	});

	test("isGitCommand matches git by basename only", () => {
		expect(isGitCommand("git")).toBe(true);
		expect(isGitCommand("/opt/bin/git")).toBe(true);
		expect(isGitCommand("gh")).toBe(false);
		expect(isGitCommand("/bin/sh")).toBe(false);
	});
});

describe("runGit host hardening (warren-8926)", () => {
	let dir: string;
	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "warren-host-git-run-")));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("never runs a hook from repository config", async () => {
		const env = {
			...scrubbedGitEnv(),
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.invalid",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.invalid",
		};
		const repo = join(dir, "repo");
		mkdirSync(repo);
		await runGit(["init", "-q", "-b", "main"], { cwd: repo, env });
		const hooks = join(dir, "hooks");
		mkdirSync(hooks);
		const marker = join(dir, "hook-ran");
		writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
		await runGit(["config", "core.hooksPath", hooks], { cwd: repo, env });
		const res = await runGit(["commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo, env });
		expect(res.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});
});
