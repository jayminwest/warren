/**
 * `PlotSyncer` — Core plot sync to GitHub (pl-5a6c).
 *
 * Scans `.plot/` in the project's local clone. If there are dirty files,
 * creates a git worktree based on the configured targetBranch (falling back to
 * defaultBranch), stages and commits the `.plot/` changes, pushes a unique
 * branch, opens a GitHub PR, and optionally merges it immediately depending on
 * the mergeStrategy.
 */

import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { refreshProjectClone } from "../projects/refresh.ts";
import { parseGitHubUrl } from "../projects/url.ts";
import { mergePullRequest, openPullRequest, parsePullRequestUrl } from "../runs/pr.ts";
import { loadWarrenConfig } from "../warren-config/index.ts";

export interface SyncPlotRequest {
	readonly projectId: string;
	readonly localPath: string;
	readonly gitUrl: string;
	readonly defaultBranch: string;
	readonly projectsConfig: ProjectsConfig;
	readonly spawn: SpawnFn;
	readonly token: string;
	readonly fetch?: typeof fetch;
}

export type SyncPlotResult =
	| { readonly kind: "noop"; readonly reason: "no_changes" }
	| { readonly kind: "noop"; readonly reason: "missing_token" }
	| {
			readonly kind: "synced";
			readonly branch: string;
			readonly prUrl: string;
			readonly merged: boolean;
	  };

export interface PlotSyncer {
	sync(input: SyncPlotRequest): Promise<SyncPlotResult>;
}

export const defaultPlotSyncer: PlotSyncer = {
	async sync(input) {
		const { localPath, gitUrl, defaultBranch, projectsConfig, spawn, token, fetch } = input;

		// 1. Check if GITHUB_TOKEN is present
		if (token === "") {
			return { kind: "noop", reason: "missing_token" };
		}

		// 2. Check if .plot/ directory actually has any uncommitted changes
		const gitBinary = projectsConfig.gitBinary;
		const statusResult = await trySpawn(
			spawn,
			[gitBinary, "status", "--porcelain", "--", ".plot/"],
			{
				cwd: localPath,
			},
		);
		if (statusResult.exitCode !== 0) {
			throw new Error(
				`git status --porcelain -- .plot/ failed with exit ${statusResult.exitCode}: ${statusResult.stderr}`,
			);
		}
		if (statusResult.stdout.trim() === "") {
			return { kind: "noop", reason: "no_changes" };
		}

		// 3. Load warren configuration to find targetBranch and mergeStrategy
		const config = await loadWarrenConfig({ projectPath: localPath });
		const plotSync = config.defaults?.plotSync;
		const targetBranch = plotSync?.targetBranch ?? defaultBranch;
		const mergeStrategy = plotSync?.mergeStrategy ?? "manual";

		// 4. Set up temporary worktree
		const hash = Math.random().toString(16).substring(2, 10);
		const branchName = `warren/plot-sync-${hash}`;
		const worktreeDir = join(tmpdir(), `warren-worktree-${hash}`);

		// Fetch target branch to make sure it's present and up-to-date
		await trySpawn(spawn, [gitBinary, "fetch", "origin", targetBranch], {
			cwd: localPath,
		});

		// Create the git worktree with the new branch
		const worktreeResult = await trySpawn(
			spawn,
			[gitBinary, "worktree", "add", "-b", branchName, worktreeDir, `origin/${targetBranch}`],
			{ cwd: localPath },
		);
		if (worktreeResult.exitCode !== 0) {
			throw new Error(
				`git worktree add failed with exit ${worktreeResult.exitCode}: ${worktreeResult.stderr}`,
			);
		}

		try {
			// Copy dirty .plot/ files to the worktree
			const srcPlotDir = join(localPath, ".plot");
			const destPlotDir = join(worktreeDir, ".plot");
			await mkdir(destPlotDir, { recursive: true });

			const files = await readdir(srcPlotDir);
			for (const file of files) {
				if (
					file.startsWith("plot-") &&
					(file.endsWith(".json") || file.endsWith(".events.jsonl"))
				) {
					await copyFile(join(srcPlotDir, file), join(destPlotDir, file));
				}
			}

			// Stage changes
			const addResult = await trySpawn(spawn, [gitBinary, "add", "--", ".plot/"], {
				cwd: worktreeDir,
			});
			if (addResult.exitCode !== 0) {
				throw new Error(`git add in worktree failed: ${addResult.stderr}`);
			}

			// Double check cached diff before commit
			const diffResult = await trySpawn(
				spawn,
				[gitBinary, "diff", "--cached", "--quiet", "--", ".plot/"],
				{ cwd: worktreeDir },
			);

			if (diffResult.exitCode !== 0) {
				// We have changes to commit
				const commitResult = await trySpawn(
					spawn,
					[
						gitBinary,
						"-c",
						"user.name=warren",
						"-c",
						"user.email=warren@os-eco.dev",
						"commit",
						"-m",
						"chore(warren): plot state",
					],
					{ cwd: worktreeDir },
				);
				if (commitResult.exitCode !== 0) {
					throw new Error(`git commit in worktree failed: ${commitResult.stderr}`);
				}
			}

			// Push to origin
			const pushResult = await trySpawn(spawn, [gitBinary, "push", "origin", branchName], {
				cwd: worktreeDir,
			});
			if (pushResult.exitCode !== 0) {
				throw new Error(`git push origin ${branchName} failed: ${pushResult.stderr}`);
			}
		} finally {
			// Clean up worktree from git tracking and disk
			await trySpawn(spawn, [gitBinary, "worktree", "remove", "--force", worktreeDir], {
				cwd: localPath,
			}).catch(() => undefined);
			await rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
		}

		// 5. Open pull request
		const parsed = parseGitHubUrl(gitUrl);
		const prResult = await openPullRequest(
			{
				owner: parsed.owner,
				repo: parsed.name,
				head: branchName,
				base: targetBranch,
				title: "chore(warren): sync plot state",
				body: "Synced plot state to GitHub via Warren.",
				token,
			},
			{ fetch: fetch ?? globalThis.fetch },
		);

		if (!prResult.ok) {
			throw new Error(`failed to open pull request: ${prResult.message}`);
		}

		let merged = false;
		if (mergeStrategy === "immediate" || mergeStrategy === "auto") {
			const prRef = parsePullRequestUrl(prResult.url);
			if (prRef === null) {
				throw new Error(`failed to parse pull request URL: ${prResult.url}`);
			}
			const mergeResult = await mergePullRequest({
				owner: prRef.owner,
				repo: prRef.repo,
				number: prRef.number,
				token,
				fetch: fetch ?? globalThis.fetch,
			});
			merged = mergeResult.kind === "merged" || mergeResult.kind === "already_merged";

			// Refresh the project clone so the changes are integrated locally
			if (merged) {
				await refreshProjectClone({
					config: projectsConfig,
					localPath,
					ref: targetBranch,
					spawn,
				});
			}
		}

		return {
			kind: "synced",
			branch: branchName,
			prUrl: prResult.url,
			merged,
		};
	},
};

async function trySpawn(
	spawn: SpawnFn,
	cmd: readonly string[],
	opts: SpawnOptions,
): Promise<SpawnResult> {
	try {
		return await spawn(cmd, opts);
	} catch (err) {
		return {
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			exitCode: -1,
		};
	}
}
