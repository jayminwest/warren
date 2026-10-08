import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git/exec.ts";
import { fixtureGitOrThrow } from "./git/test-fixture.ts";
import { branchExists, initRepo, listWorktrees } from "./git/worktree.ts";
import { materializeProjectWorkspace, removeMaterializedWorkspace } from "./materialize.ts";

/**
 * warren-3c1e: `privateGitDir` materializes the checkout over a per-run git
 * dir that borrows the host clone's objects and never writes its refs.
 * Every inherited GIT_* var is dropped for the suite (cf. materialize.test.ts).
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

async function hostRef(repo: string, ref: string): Promise<string | null> {
	const res = await runGit(["rev-parse", "--verify", "--quiet", ref], { cwd: repo });
	return res.exitCode === 0 ? res.stdout.trim() : null;
}

describe("materializeProjectWorkspace with a private git dir (warren-3c1e)", () => {
	let root: string;
	let repo: string;
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "warren-ws-private-"));
		repo = join(root, "repo");
		await initRepo({ targetPath: repo, initialBranch: "main" });
		writeFileSync(join(repo, "README.md"), "# repo\n");
		await fixtureGitOrThrow(repo, ["add", "."]);
		await fixtureGitOrThrow(repo, [
			"-c",
			"user.name=Host",
			"-c",
			"user.email=host@example.com",
			"commit",
			"-m",
			"init",
		]);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("checks out the run branch privately and removes the git dir on teardown", async () => {
		const ws = join(root, "ws");
		const gitDir = join(root, "gitdirs", "p");
		writeFileSync(join(repo, ".git", "info", "exclude"), "local-only.txt\n");
		const result = await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "run/p",
			baseBranch: "main",
			projectRoot: repo,
			hostEnv: { GIT_CONFIG_NOSYSTEM: "1", HOME: root, PATH: process.env.PATH },
			privateGitDir: gitDir,
		});
		expect(result.source.kind).toBe("private");
		expect(result.source.gitDir?.endsWith("/gitdirs/p")).toBe(true);
		expect(result.source.gitCommonDir?.endsWith("/repo/.git")).toBe(true);
		expect(result.source.gitConfigSha256).toMatch(/^[0-9a-f]{64}$/);
		const head = await fixtureGitOrThrow(ws, ["symbolic-ref", "HEAD"]);
		expect(head.stdout.trim()).toBe("refs/heads/run/p");

		// The host's own excludes carry over and warren's run excludes apply.
		mkdirSync(join(ws, ".pi", "sessions"), { recursive: true });
		writeFileSync(join(ws, ".pi", "sessions", "s.jsonl"), "{}\n");
		writeFileSync(join(ws, "local-only.txt"), "x\n");
		writeFileSync(join(ws, "work.txt"), "real work\n");
		await fixtureGitOrThrow(ws, ["add", "-A"]);
		const staged = await fixtureGitOrThrow(ws, ["diff", "--cached", "--name-only"]);
		expect(staged.stdout.trim()).toBe("work.txt");

		// The host clone gained no branch and no worktree, only the GC keep-ref.
		expect(await branchExists(repo, "run/p")).toBe(false);
		const worktrees = await listWorktrees(repo);
		expect(worktrees.some((e) => e.worktree.endsWith("/ws"))).toBe(false);
		expect(result.source.hostKeepRef).toBe("refs/warren/runs/p");
		expect(await hostRef(repo, "refs/warren/runs/p")).toBe(await hostRef(repo, "main"));

		await removeMaterializedWorkspace({ workspacePath: ws, source: result.source });
		expect(existsSync(ws)).toBe(false);
		expect(existsSync(gitDir)).toBe(false);
		expect(await hostRef(repo, "refs/warren/runs/p")).toBeNull();
	});

	test("pins the files ref backend even when the environment defaults to reftable", async () => {
		const ws = join(root, "ws");
		const gitDir = join(root, "gitdirs", "r");
		process.env.GIT_DEFAULT_REF_FORMAT = "reftable";
		try {
			await materializeProjectWorkspace({
				workspacePath: ws,
				branch: "run/r",
				baseBranch: "main",
				projectRoot: repo,
				hostEnv: { GIT_CONFIG_NOSYSTEM: "1", HOME: root, PATH: process.env.PATH },
				privateGitDir: gitDir,
			});
		} finally {
			delete process.env.GIT_DEFAULT_REF_FORMAT;
		}
		expect(existsSync(join(gitDir, "reftable"))).toBe(false);
		expect(existsSync(join(gitDir, "packed-refs"))).toBe(true);
		expect(existsSync(join(gitDir, "refs", "heads", "run", "r"))).toBe(true);
		const format = await fixtureGitOrThrow(ws, ["rev-parse", "--show-object-format"]);
		expect(format.stdout.trim()).toBe("sha1");
		const main = await fixtureGitOrThrow(ws, ["rev-parse", "main"]);
		expect<string | null>(main.stdout.trim()).toBe(await hostRef(repo, "main"));
	});
});
