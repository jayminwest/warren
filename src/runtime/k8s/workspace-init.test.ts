import { describe, expect, test } from "bun:test";
import { WorkspaceMaterializationError } from "../../workspace/errors.ts";
import {
	authenticatedCloneUrl,
	type InitFs,
	type InitGitRunner,
	parseInitEnv,
	runWorkspaceInit,
} from "./workspace-init.ts";

const ok = { exitCode: 0, stdout: "", stderr: "" };

describe("parseInitEnv", () => {
	test("parses the full env surface", () => {
		const cfg = parseInitEnv({
			WARREN_REPO_URL: "https://github.com/o/r.git",
			WARREN_BRANCH: "warren/run_1",
			WARREN_BASE_BRANCH: "main",
			WARREN_WORKSPACE_PATH: "/ws",
			WARREN_GIT_TOKEN: "tok",
			WARREN_SEED_MANIFEST: "/seeds/seeds.json",
		});
		expect(cfg).toEqual({
			repoUrl: "https://github.com/o/r.git",
			branch: "warren/run_1",
			baseBranch: "main",
			workspacePath: "/ws",
			token: "tok",
			seedManifestPath: "/seeds/seeds.json",
		});
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

describe("authenticatedCloneUrl", () => {
	test("injects x-access-token for https URLs", () => {
		expect(authenticatedCloneUrl("https://github.com/o/r.git", "tok")).toBe(
			"https://x-access-token:tok@github.com/o/r.git",
		);
	});

	test("leaves the URL alone without a token", () => {
		expect(authenticatedCloneUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
	});

	test("does not touch ssh URLs", () => {
		expect(authenticatedCloneUrl("git@github.com:o/r.git", "tok")).toBe("git@github.com:o/r.git");
	});

	test("does not double-inject when the authority already has userinfo", () => {
		expect(authenticatedCloneUrl("https://user:pw@github.com/o/r.git", "tok")).toBe(
			"https://user:pw@github.com/o/r.git",
		);
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
