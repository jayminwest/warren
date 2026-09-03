/**
 * End-to-end against REAL git (temp repos, no network) for warren-3b44: the
 * no-cache direct clone is a blobless partial clone (`--filter=blob:none`),
 * and every finalize-side operation still works from the partial clone:
 *
 *   - the primary branch push (`collectFinalizeResult` via the entrypoint
 *     collection, faithful to reap's pushStep);
 *   - `git diff <base>..HEAD` / merge-base computation for the PR body;
 *   - the salvage path (`collectSalvage`): dirty-tree fold-in commit +
 *     `<base>..HEAD` bundle capture (the rescue push is skipped without a
 *     credential in the no_intent window, which this exercises directly).
 *
 * Deliberately NEVER `--depth`: a shallow clone breaks base-commit pinning
 * (warren-919a) and merge-base computation — the test pins the filter, not a
 * depth, and proves history/merge-base integrity post-clone.
 *
 * Same hermetic fixture posture as workspace-init.cache.test.ts: GIT_* is
 * stripped for the suite and every call runs under `gitFixtureEnv` (see
 * worktree.test.ts for why). Temp dirs are cleaned up in `finally`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGit } from "../../workspace/git/exec.ts";
import { fixtureGit, fixtureGitOrThrow, gitFixtureEnv } from "../../workspace/git/test-fixture.ts";
import { collectFinalizeResult, type FinalizeGitRunner } from "./finalize-collect.ts";
import type { InPodFinalizeIntent } from "./finalize-wire.ts";
import { collectSalvage } from "./salvage.ts";
import { runWorkspaceInit } from "./workspace-init.ts";

describe("workspace-init partial clone (warren-3b44) — finalize operations from a blobless clone", () => {
	const savedGitEnv: Record<string, string | undefined> = {};
	const cleanGit: FinalizeGitRunner = (args, opts) => {
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
		mkdirSync(join(repo, dirname(name)), { recursive: true });
		writeFileSync(join(repo, name), body);
		await fixtureGitOrThrow(repo, ["add", "."]);
		await fixtureGitOrThrow(repo, [
			"-c",
			"user.email=t@e.com",
			"-c",
			"user.name=T",
			"commit",
			"-m",
			`add ${name}`,
		]);
	}

	/** Bare origin over a local path (with uploadpack.allowFilter for the filter clone). */
	async function makeOrigin(root: string): Promise<string> {
		const seed = join(root, "seed");
		await fixtureGitOrThrow(root, ["init", "-q", "-b", "main", seed]);
		await fixtureGitOrThrow(seed, ["config", "user.email", "t@e.com"]);
		await fixtureGitOrThrow(seed, ["config", "user.name", "T"]);
		await commitFile(seed, "README.md", "# repo\n");
		await commitFile(seed, "src/app.ts", "export const app = 1;\n");
		const origin = join(root, "origin.git");
		await fixtureGitOrThrow(root, ["clone", "-q", "--bare", seed, origin]);
		await fixtureGitOrThrow(origin, ["config", "uploadpack.allowFilter", "true"]);
		return origin;
	}

	test("clone carries the blob:none filter (never --depth) and still merges + diffs against base", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-partial-"));
		try {
			const origin = await makeOrigin(root);
			const ws = join(root, "ws");
			await runWorkspaceInit(
				{
					WARREN_REPO_URL: origin,
					WARREN_BRANCH: "warren/run_1",
					WARREN_BASE_BRANCH: "main",
					WARREN_WORKSPACE_PATH: ws,
				},
				{ git: cleanGit, log: () => {} },
			);
			// The clone is partial: the filter is recorded on the remote config.
			const filter = await fixtureGit(ws, ["config", "remote.origin.partialclonefilter"]);
			expect(filter.stdout.trim()).toBe("blob:none");
			// History is present (NOT shallow) — base-commit pinning + merge-base
			// both need it (warren-919a).
			const shallow = await fixtureGit(ws, ["rev-parse", "--is-shallow-repository"]);
			expect(shallow.stdout.trim()).toBe("false");
			await fixtureGitOrThrow(origin, ["rev-parse", "main"]);
			const base = (await fixtureGit(ws, ["rev-parse", "origin/main"])).stdout.trim();
			const mb = await fixtureGit(ws, ["merge-base", base, "HEAD"]);
			expect(mb.exitCode).toBe(0);

			// The agent does work and commits it.
			await commitFile(ws, "feature.ts", "export const feature = true;\n");
			await fixtureGitOrThrow(ws, ["fetch", origin, "main:refs/remotes/origin/main"]);
			// `git diff base..HEAD` for the PR body resolves from the partial clone.
			const diff = await fixtureGit(ws, ["diff", "--name-only", `${base}..HEAD`]);
			expect(diff.exitCode).toBe(0);
			expect(diff.stdout).toContain("feature.ts");
			// The push of the workspace branch works from the partial clone.
			const push = await cleanGit(["push", "origin", "HEAD:refs/heads/warren/run_1"], {
				cwd: ws,
			});
			expect(push.exitCode).toBe(0);
			const pushed = await fixtureGit(origin, ["rev-parse", "warren/run_1"]);
			expect(pushed.stdout.trim()).toBe(
				(await fixtureGit(ws, ["rev-parse", "HEAD"])).stdout.trim(),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("finalize collection + salvage path work from the partial clone", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-partial-finalize-"));
		try {
			const origin = await makeOrigin(root);
			const ws = join(root, "ws");
			await runWorkspaceInit(
				{
					WARREN_REPO_URL: origin,
					WARREN_BRANCH: "warren/run_2",
					WARREN_BASE_BRANCH: "main",
					WARREN_WORKSPACE_PATH: ws,
				},
				{ git: cleanGit, log: () => {} },
			);
			await commitFile(ws, "fix.ts", "export const fix = 1;\n");

			// The full finalize collection (entrypoint's workspace half): the
			// branch push + commits-ahead count run against the partial clone.
			const intent = {
				version: 1,
				attemptId: "attempt_1",
				push: true,
				branch: "warren/run_2",
				baseBranch: "main",
				artifacts: [],
				commit: [],
			} as InPodFinalizeIntent;
			const result = await collectFinalizeResult(intent, ws, {
				fs: {
					// .seeds/plans.jsonl is absent in this fixture — readFileOrNull → null.
					readFile: () => Promise.reject(new Error("not needed")),
					readdir: () => Promise.resolve([]),
				},
				git: cleanGit,
			});
			expect(result.pushed).toBe(true);
			expect(result.commitsAhead).toBe(1);
			expect(result.prBranch).toBe("warren/run_2");

			// Salvage (no_intent window, no token): the dirty-tree fold-in +
			// `<base>..HEAD` bundle capture still work from the partial clone.
			writeFileSync(join(ws, "uncommitted.txt"), "lost work\n");
			const salvage = await collectSalvage(
				{ runId: "run_x1", workspacePath: ws, baseBranch: "main", gitToken: undefined },
				{
					git: cleanGit,
					readFileBytes: (p) => import("node:fs/promises").then((m) => m.readFile(p)),
					rm: (p) => import("node:fs/promises").then((m) => m.rm(p)),
				},
			);
			expect(salvage.rescueRef).toBeNull(); // no credential in this window
			expect(salvage.bundleBase64).not.toBeNull();
			expect(salvage.notes.join("\n")).toContain("folded into a warren bookkeeping commit");
			// The bundle carries the run's commits (base..HEAD) — decode + list heads.
			const bundlePath = join(root, "salvage.bundle");
			const { writeFile } = await import("node:fs/promises");
			const bytes = Buffer.from(salvage.bundleBase64 ?? "", "base64");
			await writeFile(bundlePath, bytes);
			const heads = await cleanGit(["bundle", "list-heads", bundlePath], { cwd: ws });
			expect(heads.exitCode).toBe(0);
			expect(heads.stdout.trim().endsWith("HEAD")).toBe(true);
			// The bundle's head verifies against the workspace (prereqs resolve).
			const verify = await cleanGit(["bundle", "verify", bundlePath], { cwd: ws });
			expect(verify.exitCode).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
