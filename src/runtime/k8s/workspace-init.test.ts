import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceMaterializationError } from "../../workspace/errors.ts";
import { cleanGitEnv } from "../../workspace/git/exec.test.ts";
import { runGit } from "../../workspace/git/exec.ts";
import {
	type InitFs,
	type InitGitRunner,
	mirrorPathFor,
	parseInitEnv,
	runWorkspaceInit,
} from "./workspace-init.ts";

const ok = { exitCode: 0, stdout: "", stderr: "" };

/**
 * Recording git that lets a test steer the mirror probe + fail specific argv.
 * `bareRepoProbe` decides what `git rev-parse --is-bare-repository` reports
 * (default `false` ⇒ mirror treated as absent ⇒ create path).
 */
function cacheGit(overrides: {
	bareRepoProbe?: boolean;
	fail?: (args: string[], cwd?: string) => boolean;
}): { git: InitGitRunner; calls: Array<{ args: string[]; cwd?: string }> } {
	const calls: Array<{ args: string[]; cwd?: string }> = [];
	const git: InitGitRunner = (args, opts) => {
		calls.push({ args, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) });
		if (overrides.fail?.(args, opts?.cwd)) {
			return Promise.resolve({ exitCode: 1, stdout: "", stderr: "boom" });
		}
		if (args.includes("--is-bare-repository")) {
			return Promise.resolve({
				exitCode: overrides.bareRepoProbe ? 0 : 128,
				stdout: overrides.bareRepoProbe ? "true\n" : "",
				stderr: overrides.bareRepoProbe ? "" : "fatal: not a git repository",
			});
		}
		return Promise.resolve(ok);
	};
	return { git, calls };
}

const CACHE_ENV = {
	WARREN_REPO_URL: "https://github.com/o/r.git",
	WARREN_BRANCH: "warren/run_1",
	WARREN_BASE_BRANCH: "main",
	WARREN_WORKSPACE_PATH: "/ws",
	WARREN_GIT_TOKEN: "tok",
	WARREN_REPO_CACHE_DIR: "/repo-cache",
};
const MIRROR = mirrorPathFor("/repo-cache", "https://github.com/o/r.git");
const AUTH_URL = "https://x-access-token:tok@github.com/o/r.git";

/** No-op fs so the stubbed cache tests never touch the real disk (mkdir cache root). */
const noopFs: InitFs = {
	mkdir: () => Promise.resolve(),
	writeFile: () => Promise.resolve(),
	readFile: () => Promise.resolve("[]"),
};

describe("parseInitEnv", () => {
	test("parses the full env surface", () => {
		const cfg = parseInitEnv({
			WARREN_REPO_URL: "https://github.com/o/r.git",
			WARREN_BRANCH: "warren/run_1",
			WARREN_BASE_BRANCH: "main",
			WARREN_WORKSPACE_PATH: "/ws",
			WARREN_GIT_TOKEN: "tok",
			WARREN_SEED_MANIFEST: "/seeds/seeds.json",
			WARREN_REPO_CACHE_DIR: "/repo-cache",
		});
		expect(cfg).toEqual({
			repoUrl: "https://github.com/o/r.git",
			branch: "warren/run_1",
			baseBranch: "main",
			workspacePath: "/ws",
			token: "tok",
			seedManifestPath: "/seeds/seeds.json",
			repoCacheDir: "/repo-cache",
		});
	});

	test("omits repoCacheDir when the cache env is absent", () => {
		const cfg = parseInitEnv({
			WARREN_REPO_URL: "https://github.com/o/r.git",
			WARREN_BRANCH: "b",
			WARREN_BASE_BRANCH: "main",
		});
		expect(cfg.repoCacheDir).toBeUndefined();
	});

	test("defaults the workspace path and omits absent optionals", () => {
		const cfg = parseInitEnv({
			WARREN_REPO_URL: "https://github.com/o/r.git",
			WARREN_BRANCH: "b",
			WARREN_BASE_BRANCH: "main",
		});
		expect(cfg.workspacePath).toBe("/workspace");
		expect(cfg.token).toBeUndefined();
		expect(cfg.seedManifestPath).toBeUndefined();
	});

	test("throws on a missing required var", () => {
		expect(() => parseInitEnv({ WARREN_BRANCH: "b", WARREN_BASE_BRANCH: "main" })).toThrow(
			WorkspaceMaterializationError,
		);
		expect(() =>
			parseInitEnv({ WARREN_REPO_URL: "  ", WARREN_BRANCH: "b", WARREN_BASE_BRANCH: "main" }),
		).toThrow(/WARREN_REPO_URL/);
	});
});

/** Records the git argv (+ cwd) each call receives; returns success by default. */
function recordingGit(overrides: { fail?: (args: string[]) => boolean } = {}): {
	git: InitGitRunner;
	calls: Array<{ args: string[]; cwd?: string }>;
} {
	const calls: Array<{ args: string[]; cwd?: string }> = [];
	const git: InitGitRunner = (args, opts) => {
		calls.push({ args, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) });
		if (overrides.fail?.(args)) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "boom" });
		return Promise.resolve(ok);
	};
	return { git, calls };
}

describe("runWorkspaceInit", () => {
	test("clones the base branch, carves the per-run branch, strips the token", async () => {
		const { git, calls } = recordingGit();
		await runWorkspaceInit(
			{
				WARREN_REPO_URL: "https://github.com/o/r.git",
				WARREN_BRANCH: "warren/run_1",
				WARREN_BASE_BRANCH: "main",
				WARREN_WORKSPACE_PATH: "/ws",
				WARREN_GIT_TOKEN: "tok",
			},
			{ git, log: () => {} },
		);
		expect(calls[0]?.args).toEqual([
			"clone",
			"--branch",
			"main",
			"https://x-access-token:tok@github.com/o/r.git",
			"/ws",
		]);
		expect(calls[1]).toEqual({ args: ["switch", "-c", "warren/run_1"], cwd: "/ws" });
		// Token stripped from the remote so it never lands in .git/config.
		expect(calls[2]).toEqual({
			args: ["remote", "set-url", "origin", "https://github.com/o/r.git"],
			cwd: "/ws",
		});
	});

	test("skips the remote reset when no token is present", async () => {
		const { git, calls } = recordingGit();
		await runWorkspaceInit(
			{
				WARREN_REPO_URL: "https://github.com/o/r.git",
				WARREN_BRANCH: "b",
				WARREN_BASE_BRANCH: "main",
			},
			{ git, log: () => {} },
		);
		expect(calls.map((c) => c.args[0])).toEqual(["clone", "switch"]);
	});

	test("throws WorkspaceMaterializationError when a git step fails", async () => {
		const { git } = recordingGit({ fail: (args) => args[0] === "clone" });
		await expect(
			runWorkspaceInit(
				{
					WARREN_REPO_URL: "https://github.com/o/r.git",
					WARREN_BRANCH: "b",
					WARREN_BASE_BRANCH: "main",
				},
				{ git, log: () => {} },
			),
		).rejects.toThrow(/git clone .* failed/);
	});

	test("writes seed files (utf-8 + base64) from the manifest into the workspace", async () => {
		const { git } = recordingGit();
		const writes: Array<{ path: string; data: string }> = [];
		const mkdirs: string[] = [];
		const manifest = JSON.stringify([
			{ path: ".canopy/agent.json", contents: "{}" },
			{ path: ".mulch/x", contents: Buffer.from("hello").toString("base64"), encoding: "base64" },
		]);
		const fs: InitFs = {
			mkdir: (p) => {
				mkdirs.push(p);
				return Promise.resolve();
			},
			writeFile: (p, d) => {
				writes.push({ path: p, data: new TextDecoder().decode(d) });
				return Promise.resolve();
			},
			readFile: () => Promise.resolve(manifest),
		};
		await runWorkspaceInit(
			{
				WARREN_REPO_URL: "https://github.com/o/r.git",
				WARREN_BRANCH: "b",
				WARREN_BASE_BRANCH: "main",
				WARREN_WORKSPACE_PATH: "/ws",
				WARREN_SEED_MANIFEST: "/seeds/seeds.json",
			},
			{ git, fs, log: () => {} },
		);
		expect(writes).toEqual([
			{ path: "/ws/.canopy/agent.json", data: "{}" },
			{ path: "/ws/.mulch/x", data: "hello" },
		]);
		expect(mkdirs).toEqual(["/ws/.canopy", "/ws/.mulch"]);
	});

	test("refuses a seed path that escapes the workspace", async () => {
		const { git } = recordingGit();
		const fs: InitFs = {
			mkdir: () => Promise.resolve(),
			writeFile: () => Promise.resolve(),
			readFile: () => Promise.resolve(JSON.stringify([{ path: "../evil", contents: "x" }])),
		};
		await expect(
			runWorkspaceInit(
				{
					WARREN_REPO_URL: "https://github.com/o/r.git",
					WARREN_BRANCH: "b",
					WARREN_BASE_BRANCH: "main",
					WARREN_SEED_MANIFEST: "/seeds/seeds.json",
				},
				{ git, fs, log: () => {} },
			),
		).rejects.toThrow(/unsafe path/);
	});
});

describe("mirrorPathFor (warren-e908)", () => {
	test("is a stable per-repo path under the cache dir with a .git suffix", () => {
		const a = mirrorPathFor("/repo-cache", "https://github.com/o/r.git");
		expect(a).toBe(mirrorPathFor("/repo-cache", "https://github.com/o/r.git"));
		expect(a.startsWith("/repo-cache/")).toBe(true);
		expect(a.endsWith(".git")).toBe(true);
	});

	test("derives from the CLEAN url so no token ever lands in the path", () => {
		// The path is hashed off the token-free URL; an authenticated URL for the
		// same repo would map elsewhere, and neither contains the raw token.
		expect(mirrorPathFor("/repo-cache", "https://github.com/o/r.git")).not.toContain("tok");
		expect(mirrorPathFor("/repo-cache", "https://github.com/o/r.git")).not.toBe(
			mirrorPathFor("/repo-cache", AUTH_URL),
		);
	});
});

describe("runWorkspaceInit repo-cache path (warren-e908, §4.3/R2)", () => {
	test("first sight: clones the mirror, strips its token, then local-clones the workspace", async () => {
		const { git, calls } = cacheGit({ bareRepoProbe: false });
		await runWorkspaceInit(CACHE_ENV, { git, fs: noopFs, log: () => {} });
		const argv = calls.map((c) => c.args);
		// Probe reports absent ⇒ create the mirror with the authenticated URL.
		expect(argv).toContainEqual(["clone", "--mirror", AUTH_URL, MIRROR]);
		// Token stripped from the shared mirror's saved remote.
		expect(calls).toContainEqual({
			args: ["remote", "set-url", "origin", "https://github.com/o/r.git"],
			cwd: MIRROR,
		});
		// Workspace is a LOCAL clone from the mirror path (no network, no creds).
		expect(argv).toContainEqual(["clone", "--branch", "main", MIRROR, "/ws"]);
		// Workspace origin reset to the real remote so finalize pushes to GitHub.
		expect(calls).toContainEqual({
			args: ["remote", "set-url", "origin", "https://github.com/o/r.git"],
			cwd: "/ws",
		});
		expect(calls).toContainEqual({ args: ["switch", "-c", "warren/run_1"], cwd: "/ws" });
		// Never a direct network clone of the base branch into the workspace.
		expect(argv).not.toContainEqual(["clone", "--branch", "main", AUTH_URL, "/ws"]);
	});

	test("re-use: fetches the existing mirror (auth url positional, never saved)", async () => {
		const { git, calls } = cacheGit({ bareRepoProbe: true });
		await runWorkspaceInit(CACHE_ENV, { git, fs: noopFs, log: () => {} });
		const argv = calls.map((c) => c.args);
		expect(calls).toContainEqual({
			args: [
				"fetch",
				"--prune",
				AUTH_URL,
				"+refs/heads/*:refs/heads/*",
				"+refs/tags/*:refs/tags/*",
			],
			cwd: MIRROR,
		});
		// No re-clone of the mirror when it already exists.
		expect(argv).not.toContainEqual(["clone", "--mirror", AUTH_URL, MIRROR]);
		expect(argv).toContainEqual(["clone", "--branch", "main", MIRROR, "/ws"]);
	});

	test("corrupt/absent mirror: create failure falls back to a direct network clone", async () => {
		const { git, calls } = cacheGit({
			bareRepoProbe: false,
			fail: (args) => args[0] === "clone" && args[1] === "--mirror",
		});
		await runWorkspaceInit(CACHE_ENV, { git, fs: noopFs, log: () => {} });
		const argv = calls.map((c) => c.args);
		// Cache path bailed → fell back to the direct authenticated clone.
		expect(argv).toContainEqual(["clone", "--branch", "main", AUTH_URL, "/ws"]);
		// The workspace's token is stripped on the fallback path too.
		expect(calls).toContainEqual({
			args: ["remote", "set-url", "origin", "https://github.com/o/r.git"],
			cwd: "/ws",
		});
	});

	test("no cache env ⇒ direct clone, mirror is never touched", async () => {
		const { git, calls } = cacheGit({});
		await runWorkspaceInit(
			{
				WARREN_REPO_URL: "https://github.com/o/r.git",
				WARREN_BRANCH: "warren/run_1",
				WARREN_BASE_BRANCH: "main",
				WARREN_WORKSPACE_PATH: "/ws",
				WARREN_GIT_TOKEN: "tok",
			},
			{ git, log: () => {} },
		);
		const argv = calls.map((c) => c.args);
		expect(argv).toContainEqual(["clone", "--branch", "main", AUTH_URL, "/ws"]);
		expect(argv.some((a) => a[0] === "clone" && a[1] === "--mirror")).toBe(false);
		expect(argv.some((a) => a.includes("--is-bare-repository"))).toBe(false);
	});
});

/**
 * End-to-end against REAL git (temp repos, no network) — exercises the actual
 * `clone --mirror` → mirror reuse (`git fetch`) → local-clone-into-workspace
 * mechanics the seam tests above stub out. GIT_* is stripped for the suite (the
 * repo's pre-commit hook exports GIT_DIR/GIT_INDEX_FILE, which would redirect a
 * temp-dir git call at the real warren repo — see worktree.test.ts).
 */
describe("runWorkspaceInit repo-cache with real git (warren-e908)", () => {
	const savedGitEnv: Record<string, string | undefined> = {};
	// The default git seam inherits process.env; force the clean env explicitly.
	const cleanGit: InitGitRunner = (args, opts) =>
		runGit(args, { ...(opts ?? {}), env: cleanGitEnv() });

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
		await runGit(["add", "."], { cwd: repo, env: cleanGitEnv() });
		await runGit(["commit", "-m", `add ${name}`], { cwd: repo, env: cleanGitEnv() });
	}

	test("creates the mirror on first run, reuses+fetches it on the second", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-cache-"));
		try {
			const origin = join(root, "origin");
			const cacheDir = join(root, "cache");
			await runGit(["init", "-q", "-b", "main", origin], { cwd: root, env: cleanGitEnv() });
			await runGit(["config", "user.email", "t@e.com"], { cwd: origin, env: cleanGitEnv() });
			await runGit(["config", "user.name", "T"], { cwd: origin, env: cleanGitEnv() });
			await commitFile(origin, "README.md", "# repo\n");

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
			const branch1 = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
				cwd: ws1,
				env: cleanGitEnv(),
			});
			expect(branch1.stdout.trim()).toBe("warren/run_1");
			// Workspace origin points at the real remote, not the local mirror path.
			const originUrl = await runGit(["remote", "get-url", "origin"], {
				cwd: ws1,
				env: cleanGitEnv(),
			});
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
			const branch2 = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
				cwd: ws2,
				env: cleanGitEnv(),
			});
			expect(branch2.stdout.trim()).toBe("warren/run_2");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
