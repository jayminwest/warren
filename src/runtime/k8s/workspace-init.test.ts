import { describe, expect, test } from "bun:test";
import { WorkspaceMaterializationError } from "../../workspace/errors.ts";
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
			"--filter=blob:none",
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

	test("branch === baseBranch (ref-dispatch, warren-dac8) skips the colliding switch -c", async () => {
		const { git, calls } = recordingGit();
		await runWorkspaceInit(
			{
				WARREN_REPO_URL: "https://github.com/o/r.git",
				WARREN_BRANCH: "fix/pr-head",
				WARREN_BASE_BRANCH: "fix/pr-head",
				WARREN_WORKSPACE_PATH: "/ws",
			},
			{ git, log: () => {} },
		);
		expect(calls[0]?.args).toEqual([
			"clone",
			"--filter=blob:none",
			"--branch",
			"fix/pr-head",
			"https://github.com/o/r.git",
			"/ws",
		]);
		// The clone already checked out the pinned branch — no `switch -c`.
		expect(calls.some((c) => c.args[0] === "switch")).toBe(false);
	});

	test("falls back to plain clone + checkout when --branch rejects the base ref (SHA)", async () => {
		const sha = "deadbeef".repeat(5);
		const { git, calls } = recordingGit({ fail: (args) => args.includes("--branch") });
		await runWorkspaceInit(
			{
				WARREN_REPO_URL: "https://github.com/o/r.git",
				WARREN_BRANCH: "warren/run_1",
				WARREN_BASE_BRANCH: sha,
				WARREN_WORKSPACE_PATH: "/ws",
			},
			{ git, log: () => {} },
		);
		const argv = calls.map((c) => c.args);
		expect(argv[1]).toEqual(["clone", "--filter=blob:none", "https://github.com/o/r.git", "/ws"]);
		expect(calls[2]).toEqual({ args: ["checkout", sha], cwd: "/ws" });
		expect(calls[3]).toEqual({ args: ["switch", "-c", "warren/run_1"], cwd: "/ws" });
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
			{ path: ".warren/agent.json", contents: "{}" },
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
			{ path: "/ws/.warren/agent.json", data: "{}" },
			{ path: "/ws/.mulch/x", data: "hello" },
		]);
		expect(mkdirs).toEqual(["/ws/.warren", "/ws/.mulch"]);
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
		expect(argv).toContainEqual([
			"clone",
			"--filter=blob:none",
			"--branch",
			"main",
			AUTH_URL,
			"/ws",
		]);
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
		expect(argv).toContainEqual([
			"clone",
			"--filter=blob:none",
			"--branch",
			"main",
			AUTH_URL,
			"/ws",
		]);
		expect(argv.some((a) => a[0] === "clone" && a[1] === "--mirror")).toBe(false);
		expect(argv.some((a) => a.includes("--is-bare-repository"))).toBe(false);
	});
});
