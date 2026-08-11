import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readHostGitIdentity,
	renderWorkspaceGitconfig,
	resolveWorkspaceIdentity,
	WORKSPACE_GITCONFIG_FILENAME,
	writeWorkspaceGitconfig,
} from "./identity.ts";

describe("identity helpers", () => {
	let home: string;
	let workspace: string;
	let configPath: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "warren-identity-home-"));
		workspace = mkdtempSync(join(tmpdir(), "warren-identity-ws-"));
		configPath = join(home, ".gitconfig");
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	});

	/**
	 * Env for git commands that must act on `repo` and nothing else (warren-8664).
	 *
	 * `cwd` does not pin git's repo discovery: an inherited `GIT_DIR` outranks
	 * it, so `git config user.name X` with `cwd: repo` writes to whatever
	 * `GIT_DIR` names. Git exports `GIT_DIR` to every hook it runs, and the
	 * pre-commit hook runs `check:all`, which runs this suite — so under a hook
	 * these writes landed in the developer's own `.git/config` and every later
	 * local commit was authored `Local Bot <bot@local>`.
	 *
	 * Dropping every inherited `GIT_*` var (`GIT_INDEX_FILE` and `GIT_WORK_TREE`
	 * mislead the same way) and naming the target explicitly closes it.
	 */
	function repoScopedGitEnv(repo: string): Record<string, string | undefined> {
		const env: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("GIT_")) env[key] = value;
		}
		env.GIT_DIR = join(repo, ".git");
		env.GIT_WORK_TREE = repo;
		return env;
	}

	function isolatedEnv(): Record<string, string | undefined> {
		// Pin git to the temp HOME so the test doesn't depend on the developer's
		// real ~/.gitconfig — and disable system + xdg config sources that could
		// inject conflicting values on CI hosts. Because runGit uses this env
		// directly (not merged with process.env), the pre-commit hook's exported
		// GIT_* vars never leak in, so a `git config --get` here can only ever
		// read from the temp GIT_CONFIG_GLOBAL below.
		// GIT_DIR pins git's repo discovery to an empty dir: `git config --get`
		// runs with cwd = the test process's cwd (the warren repo), so without
		// this a repo-LOCAL user.name/user.email — e.g. the identity a workflow
		// configures in its checkout to commit — would override the pinned
		// global config and leak the runner's identity in (warren-25bf).
		return {
			HOME: home,
			GIT_CONFIG_GLOBAL: configPath,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_DIR: join(home, "not-a-repo"),
			XDG_CONFIG_HOME: join(home, ".config"),
			PATH: process.env.PATH,
		};
	}

	test("readHostGitIdentity returns the host name + email when both are set", async () => {
		writeFileSync(configPath, "[user]\n\tname = Alice Example\n\temail = alice@example.com\n");
		const identity = await readHostGitIdentity({ hostEnv: isolatedEnv() });
		expect(identity).toEqual({ name: "Alice Example", email: "alice@example.com" });
	});

	test("readHostGitIdentity returns null when only one half is configured", async () => {
		writeFileSync(configPath, "[user]\n\tname = OnlyName\n");
		const identity = await readHostGitIdentity({ hostEnv: isolatedEnv() });
		expect(identity).toBeNull();
	});

	test("readHostGitIdentity ignores a repo-LOCAL identity at the process cwd (warren-25bf)", async () => {
		// Repro of the autoheal-runner failure: the workflow configures
		// user.name/user.email in its checkout (repo-local) to commit, and
		// `git config --get` from that cwd prefers local over the pinned global.
		// GIT_DIR in isolatedEnv must sever that.
		const cwd = process.cwd();
		const repo = mkdtempSync(join(tmpdir(), "warren-identity-repo-"));
		const env = repoScopedGitEnv(repo);
		try {
			await Bun.spawn(["git", "init", "-q"], { cwd: repo, env }).exited;
			await Bun.spawn(["git", "config", "user.name", "Local Bot"], { cwd: repo, env }).exited;
			await Bun.spawn(["git", "config", "user.email", "bot@local"], { cwd: repo, env }).exited;
			process.chdir(repo);
			writeFileSync(configPath, "[user]\n\tname = Alice Example\n\temail = alice@example.com\n");
			const identity = await readHostGitIdentity({ hostEnv: isolatedEnv() });
			expect(identity).toEqual({ name: "Alice Example", email: "alice@example.com" });
		} finally {
			process.chdir(cwd);
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("resolveWorkspaceIdentity('bot') ignores host config and returns the supplied pair", async () => {
		writeFileSync(configPath, "[user]\n\tname = Should Not Win\n\temail = no@example.com\n");
		const identity = await resolveWorkspaceIdentity(
			{ mode: "bot", name: "Bot", email: "bot@example.com" },
			{ hostEnv: isolatedEnv() },
		);
		expect(identity).toEqual({ name: "Bot", email: "bot@example.com" });
	});

	test("renderWorkspaceGitconfig emits a [user] section parseable by git", () => {
		const body = renderWorkspaceGitconfig({ name: "Alice", email: "alice@example.com" });
		expect(body).toBe("[user]\n\tname = Alice\n\temail = alice@example.com\n");
	});

	test("writeWorkspaceGitconfig drops the gitconfig file inside the workspace", async () => {
		const result = await writeWorkspaceGitconfig(workspace, {
			name: "Alice",
			email: "alice@example.com",
		});
		expect(result.configPath).toBe(join(workspace, WORKSPACE_GITCONFIG_FILENAME));
		const text = await Bun.file(result.configPath).text();
		expect(text).toContain("name = Alice");
		expect(text).toContain("email = alice@example.com");
	});
});
