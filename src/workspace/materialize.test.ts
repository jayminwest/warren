import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceMaterializationError } from "./errors.ts";
import {
	assertFixtureHermetic,
	fixtureGitOrThrow,
	mkdtempOutsideRepo,
} from "./git/test-fixture.ts";
import { branchExists, discoverHostClone, initRepo, listWorktrees } from "./git/worktree.ts";
import {
	materializeProjectWorkspace,
	materializeTaskWorkspace,
	removeMaterializedWorkspace,
} from "./materialize.ts";

/**
 * The materialize entry points call git (discoverHostClone, addWorktree, ...)
 * without an explicit env, so they inherit `process.env`. The repo's pre-commit
 * hook exports GIT_DIR / GIT_INDEX_FILE; if those leak into a temp-dir git call
 * they redirect it at the REAL warren repo. Strip every GIT_* var from the test
 * process for the duration of this suite so the module functions operate purely
 * on their `cwd` temp repos, then restore afterwards (cf. worktree.test.ts).
 */
const savedGitEnv: Record<string, string | undefined> = {};

beforeAll(() => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GIT_")) {
			savedGitEnv[key] = process.env[key];
			delete process.env[key];
		}
	}
});

afterAll(() => {
	for (const [key, value] of Object.entries(savedGitEnv)) {
		if (value !== undefined) process.env[key] = value;
	}
});

async function bootstrapRepo(path: string): Promise<void> {
	await initRepo({ targetPath: path, initialBranch: "main" });
	writeFileSync(join(path, "README.md"), "# repo\n");
	// Repo-local identity only (never --global, never the warren repo) so the
	// temp repo can commit without inheriting host git config. Fixture git goes
	// through the hermetic helper (warren-cfa7).
	await fixtureGitOrThrow(path, ["config", "user.email", "host@example.com"]);
	await fixtureGitOrThrow(path, ["config", "user.name", "Host"]);
	await fixtureGitOrThrow(path, ["add", "."]);
	await fixtureGitOrThrow(path, ["commit", "-m", "init"]);
	// warren-cfa7 guard: the fixture resolves its git dir INSIDE itself.
	await assertFixtureHermetic(path);
}

/**
 * Pin git's host-identity read to a temp HOME so the test never depends on the
 * developer's real ~/.gitconfig, and disable system + xdg config sources that
 * could inject conflicting values on CI hosts. Passed as `hostEnv` (used
 * directly by resolveWorkspaceIdentity's runGit, not merged with process.env).
 * GIT_DIR pins git's repo discovery to an empty dir: `git config --get` runs
 * with cwd = the test process's cwd (the warren repo), so without this a
 * repo-LOCAL user.name/user.email — e.g. the identity a workflow configures
 * in its checkout to commit — would override the pinned global config and
 * leak the runner's identity in (warren-25bf).
 */
function isolatedEnv(home: string): Record<string, string | undefined> {
	return {
		HOME: home,
		GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_DIR: join(home, "not-a-repo"),
		XDG_CONFIG_HOME: join(home, ".config"),
		PATH: process.env.PATH,
	};
}

describe("materializeProjectWorkspace", () => {
	let root: string;
	let repo: string;
	let home: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "warren-ws-"));
		repo = join(root, "repo");
		home = mkdtempSync(join(tmpdir(), "warren-ws-home-"));
		writeFileSync(
			join(home, ".gitconfig"),
			"[user]\n\tname = Warren Tester\n\temail = warren@example.com\n",
		);
		await bootstrapRepo(repo);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	test("carves a per-run branch off main when host clone exists (default)", async () => {
		const ws = join(root, "ws");
		const result = await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "run/test",
			baseBranch: "main",
			projectRoot: repo,
			hostEnv: isolatedEnv(home),
		});
		expect(result.source.kind).toBe("worktree");
		expect(result.source.branch).toBe("run/test");
		expect(result.source.hostClonePath?.endsWith("/repo")).toBe(true);
		// gitCommonDir is the parent clone's `.git` — the host path the sandbox
		// must bind so the worktree's `.git` file pointer dereferences inside
		// the sandbox (burrow-7a80).
		expect(result.source.gitCommonDir?.endsWith("/repo/.git")).toBe(true);
		expect(await Bun.file(join(ws, "README.md")).exists()).toBe(true);
		expect(result.identity).toEqual({
			name: "Warren Tester",
			email: "warren@example.com",
		});
		expect(await Bun.file(join(ws, ".gitconfig.burrow")).exists()).toBe(true);

		const list = await listWorktrees(repo);
		const entry = list.find((e) => e.worktree.endsWith("/ws"));
		expect(entry?.branch).toBe("refs/heads/run/test");
	});

	test("checks out an existing branch when createBranch=false", async () => {
		// Pre-create a feature branch on the host clone (without checking it out).
		await fixtureGitOrThrow(repo, ["branch", "feature/x", "main"]);
		const ws = join(root, "ws-existing");
		const result = await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "feature/x",
			createBranch: false,
			projectRoot: repo,
			hostEnv: isolatedEnv(home),
		});
		expect(result.source.branch).toBe("feature/x");
		const list = await listWorktrees(repo);
		const entry = list.find((e) => e.worktree.endsWith("/ws-existing"));
		expect(entry?.branch).toBe("refs/heads/feature/x");
	});

	test("worktree's .git file pointer resolves to the host gitCommonDir (burrow-7a80)", async () => {
		// This is the actual repro for burrow-7a80: the worktree's `.git` *file*
		// has a `gitdir:` line whose absolute path must exist on the host (and,
		// downstream, inside the sandbox via a bind to source.gitCommonDir).
		const ws = join(root, "ws-pointer");
		const result = await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "run/pointer",
			baseBranch: "main",
			projectRoot: repo,
			hostEnv: isolatedEnv(home),
		});
		const dotGit = await Bun.file(join(ws, ".git")).text();
		const match = dotGit.match(/^gitdir:\s*(\S+)/m);
		expect(match).not.toBeNull();
		const gitdir = match?.[1] ?? "";
		const commonDir = result.source.gitCommonDir ?? "";
		expect(commonDir.length).toBeGreaterThan(0);
		expect(gitdir.startsWith(commonDir)).toBe(true);
	});

	test("falls back to git clone when no host clone is detected", async () => {
		const outside = mkdtempOutsideRepo("warren-outside-");
		try {
			const ws = join(outside, "ws");
			const result = await materializeProjectWorkspace({
				workspacePath: ws,
				branch: "main",
				projectRoot: outside,
				originUrl: repo,
				hostEnv: isolatedEnv(home),
			});
			expect(result.source.kind).toBe("clone");
			expect(result.source.originUrl).toBe(repo);
			expect(await Bun.file(join(ws, "README.md")).exists()).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("throws when neither a host clone nor an originUrl is available", async () => {
		const outside = mkdtempSync(join(tmpdir(), "warren-outside-empty-"));
		try {
			await expect(
				materializeProjectWorkspace({
					workspacePath: join(outside, "ws"),
					branch: "main",
					projectRoot: outside,
					hostEnv: isolatedEnv(home),
				}),
			).rejects.toBeInstanceOf(WorkspaceMaterializationError);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("identity is null when host config has no name + email", async () => {
		const blankHome = mkdtempSync(join(tmpdir(), "warren-blank-home-"));
		try {
			writeFileSync(join(blankHome, ".gitconfig"), "");
			const ws = join(root, "ws-no-id");
			const result = await materializeProjectWorkspace({
				workspacePath: ws,
				branch: "run/no_id",
				baseBranch: "main",
				projectRoot: repo,
				hostEnv: isolatedEnv(blankHome),
			});
			expect(result.identity).toBeNull();
			expect(await Bun.file(join(ws, ".gitconfig.burrow")).exists()).toBe(false);
		} finally {
			rmSync(blankHome, { recursive: true, force: true });
		}
	});
});

describe("materializeTaskWorkspace", () => {
	let root: string;
	let repo: string;
	let home: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "warren-task-"));
		repo = join(root, "repo");
		home = mkdtempSync(join(tmpdir(), "warren-task-home-"));
		writeFileSync(
			join(home, ".gitconfig"),
			"[user]\n\tname = Task Tester\n\temail = task@example.com\n",
		);
		await bootstrapRepo(repo);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	test("forks off the parent clone onto a new branch", async () => {
		const ws = join(root, "task-ws");
		const result = await materializeTaskWorkspace({
			workspacePath: ws,
			parentClonePath: repo,
			taskBranch: "task/abc",
			baseBranch: "main",
			hostEnv: isolatedEnv(home),
		});
		expect(result.source.kind).toBe("worktree");
		expect(result.source.branch).toBe("task/abc");
		expect(result.source.gitCommonDir?.endsWith("/repo/.git")).toBe(true);
		expect(result.identity).toEqual({ name: "Task Tester", email: "task@example.com" });

		const list = await listWorktrees(repo);
		const entry = list.find((e) => e.worktree.endsWith("/task-ws"));
		expect(entry?.branch).toBe("refs/heads/task/abc");
	});

	test("multiple sibling task workspaces fork independently from the same parent", async () => {
		const a = join(root, "task-a");
		const b = join(root, "task-b");
		await materializeTaskWorkspace({
			workspacePath: a,
			parentClonePath: repo,
			taskBranch: "task/a",
			baseBranch: "main",
			hostEnv: isolatedEnv(home),
		});
		await materializeTaskWorkspace({
			workspacePath: b,
			parentClonePath: repo,
			taskBranch: "task/b",
			baseBranch: "main",
			hostEnv: isolatedEnv(home),
		});
		const list = await listWorktrees(repo);
		const branches = list.map((e) => e.branch).filter(Boolean);
		expect(branches).toContain("refs/heads/task/a");
		expect(branches).toContain("refs/heads/task/b");
	});
});

describe("removeMaterializedWorkspace", () => {
	let root: string;
	let repo: string;
	let home: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "warren-rm-"));
		repo = join(root, "repo");
		home = mkdtempSync(join(tmpdir(), "warren-rm-home-"));
		writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Remover\n\temail = rm@example.com\n");
		await bootstrapRepo(repo);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	test("removes a worktree-backed workspace, drops the branch, and updates worktree list", async () => {
		const ws = join(root, "ws");
		const result = await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "run/remove",
			baseBranch: "main",
			projectRoot: repo,
			hostEnv: isolatedEnv(home),
		});
		expect(await branchExists(repo, "run/remove")).toBe(true);
		await removeMaterializedWorkspace({ workspacePath: ws, source: result.source });
		const list = await listWorktrees(repo);
		expect(list.find((e) => e.worktree.endsWith("/ws"))).toBeUndefined();
		expect(await Bun.file(join(ws, "README.md")).exists()).toBe(false);
		expect(await branchExists(repo, "run/remove")).toBe(false);
	});

	test("removes a clone-backed workspace by deleting the directory tree", async () => {
		const outside = mkdtempOutsideRepo("warren-rm-outside-");
		try {
			const ws = join(outside, "ws");
			const result = await materializeProjectWorkspace({
				workspacePath: ws,
				branch: "main",
				projectRoot: outside,
				originUrl: repo,
				hostEnv: isolatedEnv(home),
			});
			await removeMaterializedWorkspace({ workspacePath: ws, source: result.source });
			expect(await Bun.file(join(ws, "README.md")).exists()).toBe(false);
			// The host clone should be untouched.
			const probe = await discoverHostClone(repo);
			expect(probe).not.toBeNull();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("recovers when the workspace dir was already deleted out-of-band", async () => {
		const ws = join(root, "ws-stale");
		const result = await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "run/stale",
			baseBranch: "main",
			projectRoot: repo,
			hostEnv: isolatedEnv(home),
		});
		// Simulate the user (or a crash) yanking the workspace dir before stop().
		rmSync(ws, { recursive: true, force: true });
		await removeMaterializedWorkspace({ workspacePath: ws, source: result.source });
		const list = await listWorktrees(repo);
		expect(list.find((e) => e.worktree.endsWith("/ws-stale"))).toBeUndefined();
	});
});

describe("materializeProjectWorkspace: base-branch threading (warren-232d)", () => {
	let root: string;
	let repo: string;
	let home: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "warren-mat-"));
		repo = join(root, "repo");
		home = join(root, "home");
		await bootstrapRepo(repo);
		// A master-default repo: the default branch IS master, and a distinct
		// commit exists on master but not on main's tip... bootstrap uses
		// initialBranch 'main', so add a master branch with an extra commit.
		await fixtureGitOrThrow(repo, ["checkout", "-b", "master"]);
		writeFileSync(join(repo, "MASTER.md"), "# master\n");
		await fixtureGitOrThrow(repo, ["add", "."]);
		await fixtureGitOrThrow(repo, ["commit", "-m", "master commit"]);
		await fixtureGitOrThrow(repo, ["checkout", "main"]);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("carves the run branch off the project's actual default branch (master), not 'main'", async () => {
		const ws = join(root, "ws");
		await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "run/master-default",
			baseBranch: "master",
			projectRoot: repo,
			hostEnv: isolatedEnv(home),
		});

		// The run branch's tip is master's commit — the file only master
		// carries is present, and the host clone stays on main (untouched).
		expect(await Bun.file(join(ws, "MASTER.md")).exists()).toBe(true);
		const hostBranch = await fixtureGitOrThrow(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
		expect(hostBranch.stdout.trim()).toBe("main");
	});

	test("refuses to carve a run branch when baseBranch is absent (no 'main' hard-code)", async () => {
		const ws = join(root, "ws-no-base");
		await expect(
			materializeProjectWorkspace({
				workspacePath: ws,
				branch: "run/no-base",
				projectRoot: repo,
				hostEnv: isolatedEnv(home),
			}),
		).rejects.toBeInstanceOf(WorkspaceMaterializationError);
	});
});
