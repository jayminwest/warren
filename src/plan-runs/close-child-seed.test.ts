import { describe, expect, test } from "bun:test";
import { WARREN_BOT_IDENTITY } from "../bot-identity.ts";
import type { SpawnFn } from "../projects/index.ts";
import type { IssueTracker } from "../tracker/contract.ts";
import { closeMergedChildSeed } from "./close-child-seed.ts";

interface SpawnCall {
	cmd: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
}

/**
 * Stub git spawn. `dirtyAfterClose` controls whether `git status` reports a
 * pending change to `.seeds/issues.jsonl` (i.e. the seed was actually open on
 * the default branch), and `pushExit` lets a test force a push failure.
 */
function makeGitSpawn(opts: { dirtyAfterClose: boolean; pushExit?: number }): {
	spawn: SpawnFn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const spawn: SpawnFn = async (cmd, spawnOpts) => {
		calls.push({ cmd: cmd as string[], cwd: spawnOpts.cwd, env: spawnOpts.env });
		if (cmd.includes("status")) {
			return {
				stdout: opts.dirtyAfterClose ? " M .seeds/issues.jsonl\n" : "",
				stderr: "",
				exitCode: 0,
			};
		}
		if (cmd.includes("push")) {
			return { stdout: "", stderr: "denied", exitCode: opts.pushExit ?? 0 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { spawn, calls };
}

interface CloseCall {
	readonly seedId: string;
	readonly projectId: string;
	readonly localPath?: string;
}

function makeTracker(isGitNative = true): { issueTracker: IssueTracker; closeCalls: CloseCall[] } {
	const closeCalls: CloseCall[] = [];
	const issueTracker: IssueTracker = {
		capabilities: {
			supportsPlans: true,
			supportsMetadata: true,
			supportsScheduledIssues: true,
			isGitNative,
		},
		getIssue: async () => {
			throw new Error("unused");
		},
		listIssueStatuses: async () => new Map(),
		closeIssue: async (ctx, seedId) => {
			closeCalls.push({ seedId, projectId: ctx.projectId, localPath: ctx.localPath });
		},
	};
	return { issueTracker, closeCalls };
}

describe("closeMergedChildSeed", () => {
	test("closes an open seed on the default branch and pushes", async () => {
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: true });
		const { issueTracker, closeCalls } = makeTracker();
		const result = await closeMergedChildSeed({
			projectPath: "/data/projects/x/y",
			defaultBranch: "main",
			seedId: "warren-3f09",
			projectId: "prj_1",
			issueTracker,
			spawn,
			gitBinary: "git",
		});

		expect(result.kind).toBe("closed");
		if (result.kind === "closed") expect(result.branch).toBe("main");

		// The tracker close ran inside the throwaway worktree, not the project clone.
		expect(closeCalls).toEqual([
			{ seedId: "warren-3f09", projectId: "prj_1", localPath: closeCalls[0]?.localPath },
		]);
		expect(closeCalls[0]?.localPath).not.toBe("/data/projects/x/y");

		const has = (sub: string) => calls.some((c) => c.cmd.includes(sub));
		expect(has("fetch")).toBe(true);
		expect(has("worktree")).toBe(true);
		expect(has("commit")).toBe(true);
		expect(has("push")).toBe(true);

		// The commit pins the WARREN_BOT_IDENTITY (env + `-c` config) and skips hooks.
		const commit = calls.find((c) => c.cmd.includes("commit"));
		expect(commit?.cmd).toContain("--no-verify");
		expect(commit?.cmd.join(" ")).toContain("user.name=warren");
		expect(commit?.env?.GIT_AUTHOR_NAME).toBe("warren");
		expect(commit?.env?.GIT_COMMITTER_EMAIL).toBe(WARREN_BOT_IDENTITY.email);

		// The push targets the default branch directly.
		const push = calls.find((c) => c.cmd.includes("push"));
		expect(push?.cmd).toEqual(["git", "push", "origin", "HEAD:main"]);

		// The worktree is always cleaned up.
		expect(has("remove")).toBe(true);
	});

	test("githubToken → fetch + push carry the credential env; token stays out of argv", async () => {
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: true });
		const { issueTracker } = makeTracker();
		await closeMergedChildSeed({
			projectPath: "/data/projects/x/y",
			defaultBranch: "main",
			seedId: "warren-3f09",
			projectId: "prj_1",
			issueTracker,
			spawn,
			gitBinary: "git",
			gitCredential: { username: "x-access-token", secret: "ghp_secret", host: "github.com" },
		});

		const credKey = "url.https://x-access-token:ghp_secret@github.com/.insteadOf";
		const fetch = calls.find((c) => c.cmd.includes("fetch"));
		expect(fetch?.env?.GIT_CONFIG_KEY_0).toBe(credKey);
		const push = calls.find((c) => c.cmd.includes("push"));
		expect(push?.env?.GIT_CONFIG_KEY_0).toBe(credKey);
		// The scrub still composes under the credential (keys present-and-undefined).
		expect(push?.env).toHaveProperty("GIT_DIR");
		expect(push?.env?.GIT_DIR).toBeUndefined();
		// Local git ops (worktree/commit/status) never see the credential…
		const commit = calls.find((c) => c.cmd.includes("commit"));
		expect(commit?.env?.GIT_CONFIG_KEY_0).toBeUndefined();
		// …and the token never rides in argv.
		expect(calls.flatMap((c) => c.cmd).join(" ")).not.toContain("ghp_secret");
	});

	test("already-closed seed yields noop without a commit or push", async () => {
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: false });
		const { issueTracker } = makeTracker();
		const result = await closeMergedChildSeed({
			projectPath: "/data/projects/x/y",
			defaultBranch: "main",
			seedId: "warren-f854",
			projectId: "prj_1",
			issueTracker,
			spawn,
			gitBinary: "git",
		});

		expect(result.kind).toBe("noop");
		expect(calls.some((c) => c.cmd.includes("commit"))).toBe(false);
		expect(calls.some((c) => c.cmd.includes("push"))).toBe(false);
		// Worktree still torn down on the noop path.
		expect(calls.some((c) => c.cmd.includes("remove"))).toBe(true);
	});

	test("push failure throws and still removes the worktree", async () => {
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: true, pushExit: 1 });
		const { issueTracker } = makeTracker();
		await expect(
			closeMergedChildSeed({
				projectPath: "/data/projects/x/y",
				defaultBranch: "main",
				seedId: "warren-3f09",
				projectId: "prj_1",
				issueTracker,
				spawn,
				gitBinary: "git",
			}),
		).rejects.toThrow(/git push failed/);
		expect(calls.some((c) => c.cmd.includes("remove"))).toBe(true);
	});

	test("non-git-native tracker collapses to one tracker.closeIssue call (warren-6234)", async () => {
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: true });
		const { issueTracker, closeCalls } = makeTracker(false);
		const result = await closeMergedChildSeed({
			projectPath: "/data/projects/x/y",
			defaultBranch: "main",
			seedId: "warren-3f09",
			projectId: "prj_1",
			issueTracker,
			spawn,
			gitBinary: "git",
		});

		expect(result).toEqual({ kind: "closed", branch: "main" });
		expect(closeCalls).toEqual([
			{ seedId: "warren-3f09", projectId: "prj_1", localPath: "/data/projects/x/y" },
		]);
		// No git machinery ran — no worktree, no commit, no push.
		expect(calls).toHaveLength(0);
	});
});
