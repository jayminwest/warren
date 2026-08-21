import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceMaterializationError } from "../errors.ts";
import { assertFixtureHermetic, fixtureGitOrThrow, mkdtempOutsideRepo } from "./test-fixture.ts";
import {
	addWorktree,
	branchExists,
	cloneRepo,
	deleteBranch,
	discoverHostClone,
	initRepo,
	listWorktrees,
	removeWorktree,
} from "./worktree.ts";

/**
 * The functions under test (addWorktree, cloneRepo, ...) call runGit without an
 * explicit env, so they inherit `process.env`. The repo's pre-commit hook
 * exports GIT_DIR / GIT_INDEX_FILE into the environment; if those leak into a
 * temp-dir git call they redirect it at the REAL warren repo (which is how a
 * prior run corrupted this repo's config). Strip every GIT_* var from the test
 * process for the duration of this suite so the module functions operate purely
 * on their `cwd` temp repos, then restore afterwards. Test-side git spawns
 * additionally go through the hermetic fixture helper (warren-cfa7), and every
 * bootstrapped repo passes the assertFixtureHermetic guard.
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
	await fixtureGitOrThrow(path, ["config", "user.email", "test@example.com"]);
	await fixtureGitOrThrow(path, ["config", "user.name", "Test"]);
	await fixtureGitOrThrow(path, ["add", "."]);
	await fixtureGitOrThrow(path, ["commit", "-m", "init", "--allow-empty"]);
	// Pre-create a non-checked-out branch the existing-branch worktree tests
	// can target. `main` is already claimed by the host clone itself, so a
	// second worktree on `main` would fail with "already used by worktree".
	await fixtureGitOrThrow(path, ["branch", "feature/wt", "main"]);
	// warren-cfa7 guard: the fixture resolves its git dir INSIDE itself.
	await assertFixtureHermetic(path);
}

describe("git worktree helpers", () => {
	let root: string;
	let repo: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "warren-wt-"));
		repo = join(root, "repo");
		await bootstrapRepo(repo);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("discoverHostClone returns top-level + git common dir for a real clone", async () => {
		const result = await discoverHostClone(repo);
		expect(result).not.toBeNull();
		// macOS resolves /var/folders/... to /private/var/folders/...; the
		// realpath form is what git emits and what callers must compare against.
		expect(result?.topLevel.endsWith("/repo")).toBe(true);
		expect(result?.gitCommonDir.endsWith("/.git")).toBe(true);
	});

	test("discoverHostClone returns null outside a git repo", async () => {
		const outside = mkdtempOutsideRepo("warren-non-git-");
		try {
			const result = await discoverHostClone(outside);
			expect(result).toBeNull();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("addWorktree creates a checkout on an existing branch", async () => {
		const ws = join(root, "ws");
		await addWorktree({ hostClonePath: repo, workspacePath: ws, branch: "feature/wt" });
		expect(await Bun.file(join(ws, "README.md")).exists()).toBe(true);
	});

	test("addWorktree with createBranch carves a new branch off the base", async () => {
		const ws = join(root, "ws-task");
		await addWorktree({
			hostClonePath: repo,
			workspacePath: ws,
			branch: "task/abc",
			createBranch: true,
			baseBranch: "main",
		});
		expect(await branchExists(repo, "task/abc")).toBe(true);
		const list = await listWorktrees(repo);
		const taskEntry = list.find((e) => e.worktree.endsWith("/ws-task"));
		expect(taskEntry?.branch).toBe("refs/heads/task/abc");
	});

	test("removeWorktree tears down a checkout cleanly", async () => {
		const ws = join(root, "ws-remove");
		await addWorktree({
			hostClonePath: repo,
			workspacePath: ws,
			branch: "run/rm",
			createBranch: true,
			baseBranch: "main",
		});
		await removeWorktree({ hostClonePath: repo, workspacePath: ws });
		const list = await listWorktrees(repo);
		expect(list.find((e) => e.worktree.endsWith("/ws-remove"))).toBeUndefined();
		expect(await Bun.file(join(ws, "README.md")).exists()).toBe(false);
	});

	test("addWorktree against a missing branch surfaces a WorkspaceMaterializationError", async () => {
		const ws = join(root, "ws-missing");
		await expect(
			addWorktree({ hostClonePath: repo, workspacePath: ws, branch: "does-not-exist" }),
		).rejects.toBeInstanceOf(WorkspaceMaterializationError);
		await expect(
			addWorktree({ hostClonePath: repo, workspacePath: ws, branch: "does-not-exist" }),
		).rejects.toThrow(/git worktree add .* failed/);
	});

	test("deleteBranch drops a non-checked-out branch", async () => {
		const ws = join(root, "ws-delbranch");
		await addWorktree({
			hostClonePath: repo,
			workspacePath: ws,
			branch: "run/delme",
			createBranch: true,
			baseBranch: "main",
		});
		await removeWorktree({ hostClonePath: repo, workspacePath: ws });
		expect(await branchExists(repo, "run/delme")).toBe(true);
		await deleteBranch({ hostClonePath: repo, branch: "run/delme" });
		expect(await branchExists(repo, "run/delme")).toBe(false);
	});

	test("deleteBranch throws when the branch does not exist", async () => {
		await expect(deleteBranch({ hostClonePath: repo, branch: "no-such-branch" })).rejects.toThrow(
			/git branch -D .* failed/,
		);
	});

	test("cloneRepo materializes a fresh clone from a local path origin", async () => {
		const cloneTarget = join(root, "fresh");
		await cloneRepo({ originUrl: repo, targetPath: cloneTarget, branch: "main" });
		expect(await Bun.file(join(cloneTarget, "README.md")).exists()).toBe(true);
		const result = await discoverHostClone(cloneTarget);
		expect(result?.topLevel.endsWith("/fresh")).toBe(true);
	});
});
