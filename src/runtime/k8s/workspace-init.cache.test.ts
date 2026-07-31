/**
 * End-to-end against REAL git (temp repos, no network) — exercises the actual
 * `clone --mirror` → mirror reuse (`git fetch`) → local-clone-into-workspace
 * mechanics the seam tests in workspace-init.test.ts stub out. Split out of
 * that file under the 500-line `check:size` budget. GIT_* is stripped for the
 * suite (the repo's pre-commit hook exports GIT_DIR/GIT_INDEX_FILE, which
 * would redirect a temp-dir git call at the real warren repo — see
 * worktree.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../workspace/git/exec.ts";
import {
	assertFixtureHermetic,
	fixtureGit,
	fixtureGitOrThrow,
	gitFixtureEnv,
} from "../../workspace/git/test-fixture.ts";
import { type InitGitRunner, mirrorPathFor, runWorkspaceInit } from "./workspace-init.ts";

describe("runWorkspaceInit repo-cache with real git (warren-e908)", () => {
	const savedGitEnv: Record<string, string | undefined> = {};
	// The default git seam inherits process.env; force the canonical hermetic
	// fixture env explicitly (warren-cfa7): inherited GIT_* severed, discovery
	// ceiling pinned to the operated-on path's parent so the hook's exported
	// GIT_DIR/GIT_INDEX_FILE can't redirect these calls at the real repo.
	const cleanGit: InitGitRunner = (args, opts) => {
		const anchor = opts?.cwd ?? [...args].reverse().find((a) => a.startsWith("/"));
		return runGit(args, { ...(opts ?? {}), env: gitFixtureEnv(anchor ?? "/") });
	};

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

	async function commitFile(repo: string, name: string, body: string): Promise<void> {
		writeFileSync(join(repo, name), body);
		await fixtureGitOrThrow(repo, ["add", "."]);
		await fixtureGitOrThrow(repo, ["commit", "-m", `add ${name}`]);
	}

	test("creates the mirror on first run, reuses+fetches it on the second", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-cache-"));
		try {
			const origin = join(root, "origin");
			const cacheDir = join(root, "cache");
			await fixtureGitOrThrow(root, ["init", "-q", "-b", "main", origin]);
			await fixtureGitOrThrow(origin, ["config", "user.email", "t@e.com"]);
			await fixtureGitOrThrow(origin, ["config", "user.name", "T"]);
			await commitFile(origin, "README.md", "# repo\n");
			// warren-cfa7 guard: the fixture resolves its git dir INSIDE itself.
			await assertFixtureHermetic(origin);

			// --- First run: mirror does not exist → clone --mirror, then materialize.
			const ws1 = join(root, "ws1");
			await runWorkspaceInit(
				{
					WARREN_REPO_URL: origin,
					WARREN_BRANCH: "warren/run_1",
					WARREN_BASE_BRANCH: "main",
					WARREN_WORKSPACE_PATH: ws1,
					WARREN_REPO_CACHE_DIR: cacheDir,
				},
				{ git: cleanGit, log: () => {} },
			);
			expect(existsSync(mirrorPathFor(cacheDir, origin))).toBe(true);
			expect(existsSync(join(ws1, "README.md"))).toBe(true);
			const branch1 = await fixtureGit(ws1, ["rev-parse", "--abbrev-ref", "HEAD"]);
			expect(branch1.stdout.trim()).toBe("warren/run_1");
			// Workspace origin points at the real remote, not the local mirror path.
			const originUrl = await fixtureGit(ws1, ["remote", "get-url", "origin"]);
			expect(originUrl.stdout.trim()).toBe(origin);

			// --- Second run after a new upstream commit: mirror reused + fetched.
			await commitFile(origin, "NEW.md", "new\n");
			const ws2 = join(root, "ws2");
			await runWorkspaceInit(
				{
					WARREN_REPO_URL: origin,
					WARREN_BRANCH: "warren/run_2",
					WARREN_BASE_BRANCH: "main",
					WARREN_WORKSPACE_PATH: ws2,
					WARREN_REPO_CACHE_DIR: cacheDir,
				},
				{ git: cleanGit, log: () => {} },
			);
			// The fetch pulled the new commit through the reused mirror.
			expect(existsSync(join(ws2, "NEW.md"))).toBe(true);
			const branch2 = await fixtureGit(ws2, ["rev-parse", "--abbrev-ref", "HEAD"]);
			expect(branch2.stdout.trim()).toBe("warren/run_2");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// warren-dac8: ref-dispatch repair run (branch === baseBranch, warren-709e)
	// where the target ref moved on origin AFTER the mirror last fetched. The
	// init-time mirror fetch must pull the new tip through so the materialized
	// workspace starts from it — otherwise finalize's push reaps
	// non-fast-forward (finalize_failed) and the run's work is discarded.
	test("target ref moved on origin after the mirror last fetched: workspace sees the new tip", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-dac8-"));
		try {
			const origin = join(root, "origin");
			const cacheDir = join(root, "cache");
			await fixtureGitOrThrow(root, ["init", "-q", "-b", "main", origin]);
			await fixtureGitOrThrow(origin, ["config", "user.email", "t@e.com"]);
			await fixtureGitOrThrow(origin, ["config", "user.name", "T"]);
			await commitFile(origin, "README.md", "# repo\n");
			await fixtureGitOrThrow(origin, ["branch", "fix/pr-head"]);
			await assertFixtureHermetic(origin);

			// First run populates the mirror with fix/pr-head at tip1.
			await runWorkspaceInit(
				{
					WARREN_REPO_URL: origin,
					WARREN_BRANCH: "warren/run_1",
					WARREN_BASE_BRANCH: "main",
					WARREN_WORKSPACE_PATH: join(root, "ws1"),
					WARREN_REPO_CACHE_DIR: cacheDir,
				},
				{ git: cleanGit, log: () => {} },
			);

			// The ref moves on origin after the mirror's last fetch — the
			// `gh pr update-branch` / external-push case from run_ghd091f288r8.
			await fixtureGitOrThrow(origin, ["checkout", "-q", "fix/pr-head"]);
			await commitFile(origin, "FIX.md", "fix\n");
			await fixtureGitOrThrow(origin, ["checkout", "-q", "main"]);
			const newTip = await fixtureGit(origin, ["rev-parse", "fix/pr-head"]);

			// Repair ref-dispatch: branch pinned to the target ref (warren-709e).
			const ws2 = join(root, "ws2");
			await runWorkspaceInit(
				{
					WARREN_REPO_URL: origin,
					WARREN_BRANCH: "fix/pr-head",
					WARREN_BASE_BRANCH: "fix/pr-head",
					WARREN_WORKSPACE_PATH: ws2,
					WARREN_REPO_CACHE_DIR: cacheDir,
				},
				{ git: cleanGit, log: () => {} },
			);
			expect(existsSync(join(ws2, "FIX.md"))).toBe(true);
			const head = await fixtureGit(ws2, ["rev-parse", "HEAD"]);
			expect(head.stdout.trim()).toBe(newTip.stdout.trim());
			const checkedOut = await fixtureGit(ws2, ["rev-parse", "--abbrev-ref", "HEAD"]);
			expect(checkedOut.stdout.trim()).toBe("fix/pr-head");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
