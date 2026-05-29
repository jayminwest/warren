import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn } from "../projects/index.ts";
import { parseGitHubUrl } from "../projects/url.ts";
import { mergePullRequest, openPullRequest, parsePullRequestRef } from "../runs/pr.ts";
import type { PlotSyncConfig } from "../warren-config/index.ts";

export interface PlotSyncRequest {
	readonly projectPath: string;
	readonly gitUrl: string;
	readonly defaultBranch: string;
	readonly token: string;
	readonly handle: string;
	readonly plotSyncConfig?: PlotSyncConfig;
	readonly spawn: SpawnFn;
	readonly fetch?: typeof fetch;
	readonly gitBinary: string;
}

export type PlotSyncResult =
	| { readonly kind: "no_op" }
	| {
			readonly kind: "synced";
			readonly branch: string;
			readonly prUrl: string;
			readonly prNumber?: number;
			readonly merged: boolean;
	  };

export interface PlotSyncer {
	sync(input: PlotSyncRequest): Promise<PlotSyncResult>;
}

async function trySpawn(
	spawn: SpawnFn,
	cmd: readonly string[],
	opts: { cwd: string; timeoutMs?: number },
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
	try {
		return await spawn(cmd, opts);
	} catch (err) {
		throw new Error(
			`failed to spawn ${cmd.join(" ")}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function copyPlotDir(src: string, dst: string): Promise<void> {
	await mkdir(dst, { recursive: true });
	const srcEntries = await readdir(src, { withFileTypes: true });
	const srcFileNames = new Set<string>();
	for (const entry of srcEntries) {
		if (!entry.isFile()) continue;
		if (
			entry.name.startsWith("plot-") &&
			(entry.name.endsWith(".events.jsonl") || entry.name.endsWith(".json"))
		) {
			srcFileNames.add(entry.name);
			const content = await readFile(join(src, entry.name));
			await writeFile(join(dst, entry.name), content);
		}
	}
	// Delete any files in dst that are not in src
	try {
		const dstEntries = await readdir(dst, { withFileTypes: true });
		for (const entry of dstEntries) {
			if (!entry.isFile()) continue;
			if (
				entry.name.startsWith("plot-") &&
				(entry.name.endsWith(".events.jsonl") || entry.name.endsWith(".json"))
			) {
				if (!srcFileNames.has(entry.name)) {
					await rm(join(dst, entry.name), { force: true });
				}
			}
		}
	} catch {
		// If dst/.plot didn't exist, readdir might fail, which is fine
	}
}

export const defaultPlotSyncer: PlotSyncer = {
	async sync(input) {
		const { projectPath, gitUrl, defaultBranch, token, handle, plotSyncConfig, spawn, gitBinary } =
			input;
		const fetchImpl = input.fetch ?? globalThis.fetch;

		// 1. Detect if .plot/ files are dirty
		const statusRes = await trySpawn(spawn, [gitBinary, "status", "--porcelain", "--", ".plot/"], {
			cwd: projectPath,
		});
		if (statusRes.exitCode !== 0) {
			throw new Error(`git status failed (exit ${statusRes.exitCode}): ${statusRes.stderr}`);
		}
		if (statusRes.stdout.trim() === "") {
			return { kind: "no_op" };
		}

		// 2. Resolve target branch and merge strategy
		const targetBranch = plotSyncConfig?.targetBranch ?? defaultBranch;
		const mergeStrategy = plotSyncConfig?.mergeStrategy ?? "manual";

		// 3. Fetch from origin to be up to date
		const fetchRes = await trySpawn(spawn, [gitBinary, "fetch", "--prune", "origin"], {
			cwd: projectPath,
		});
		if (fetchRes.exitCode !== 0) {
			// Best-effort in offline/test mode: warn but don't hard crash if it's local branch only
		}

		// 4. Generate unique branch name
		const bytes = new Uint8Array(4);
		crypto.getRandomValues(bytes);
		const branchHash = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
		const branchName = `warren/plot-sync-${branchHash}`;

		// 5. Create temporary worktree
		const worktreePath = await mkdtemp(join(tmpdir(), `warren-plot-sync-${branchHash}-`));

		try {
			// 6. Create worktree from origin/<targetBranch> falling back to local targetBranch
			let worktreeAddRes = await trySpawn(
				spawn,
				[gitBinary, "worktree", "add", "-b", branchName, worktreePath, `origin/${targetBranch}`],
				{ cwd: projectPath },
			);
			if (worktreeAddRes.exitCode !== 0) {
				worktreeAddRes = await trySpawn(
					spawn,
					[gitBinary, "worktree", "add", "-b", branchName, worktreePath, targetBranch],
					{ cwd: projectPath },
				);
			}
			if (worktreeAddRes.exitCode !== 0) {
				throw new Error(
					`Failed to create git worktree (exit ${worktreeAddRes.exitCode}): ${worktreeAddRes.stderr}`,
				);
			}

			// 7. Copy plot files to worktree
			await copyPlotDir(join(projectPath, ".plot"), join(worktreePath, ".plot"));

			// 8. Stage, commit, and push
			const addRes = await trySpawn(spawn, [gitBinary, "add", ".plot/"], { cwd: worktreePath });
			if (addRes.exitCode !== 0) {
				throw new Error(
					`Failed to stage changes in worktree (exit ${addRes.exitCode}): ${addRes.stderr}`,
				);
			}

			const commitRes = await trySpawn(
				spawn,
				[
					gitBinary,
					"-c",
					"user.name=warren",
					"-c",
					"user.email=warren@os-eco.dev",
					"commit",
					// warren-27d3: warren's plot-sync bookkeeping commit must not be
					// gated by the project's git hooks (e.g. a check:all pre-commit).
					"--no-verify",
					"-m",
					"plot sync: update plot metadata",
				],
				{ cwd: worktreePath },
			);
			if (commitRes.exitCode !== 0) {
				throw new Error(
					`Failed to commit changes in worktree (exit ${commitRes.exitCode}): ${commitRes.stderr}`,
				);
			}

			const pushRes = await trySpawn(spawn, [gitBinary, "push", "origin", branchName], {
				cwd: worktreePath,
			});
			if (pushRes.exitCode !== 0) {
				throw new Error(
					`Failed to push sync branch to origin (exit ${pushRes.exitCode}): ${pushRes.stderr}`,
				);
			}
		} finally {
			// 9. Clean up worktree definition and directory
			await trySpawn(spawn, [gitBinary, "worktree", "remove", "--force", worktreePath], {
				cwd: projectPath,
			});
			await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
		}

		// 10. Open Pull Request
		const parsedUrl = parseGitHubUrl(gitUrl);
		const prResult = await openPullRequest(
			{
				owner: parsedUrl.owner,
				repo: parsedUrl.name,
				head: branchName,
				base: targetBranch,
				title: "plot sync: update plot metadata",
				body: `This PR was auto-generated by Warren to sync plot metadata changes from workspace edits back to the repository.\n\nSynced changes:\n- Plot metadata and event logs in \`.plot/\` by @${handle}`,
				token,
			},
			{ fetch: fetchImpl },
		);

		if (!prResult.ok) {
			throw new Error(`Failed to open sync pull request: ${prResult.message}`);
		}

		const prParsed = parsePullRequestRef(prResult.url);
		const prNumber = prParsed?.number;

		// 11. Optionally Merge Pull Request
		if (mergeStrategy === "immediate" || mergeStrategy === "auto") {
			if (prNumber === undefined) {
				throw new Error(`Failed to parse PR number from URL: ${prResult.url}`);
			}
			const mergeResult = await mergePullRequest({
				owner: parsedUrl.owner,
				repo: parsedUrl.name,
				number: prNumber,
				token,
				fetch: fetchImpl,
			});
			const merged = mergeResult.kind === "merged" || mergeResult.kind === "already_merged";
			if (!merged) {
				throw new Error(
					`Failed to merge sync pull request: ${mergeResult.kind === "not_mergeable" ? mergeResult.message : mergeResult.kind}`,
				);
			}
			return {
				kind: "synced",
				branch: branchName,
				prUrl: prResult.url,
				prNumber,
				merged: true,
			};
		}

		return {
			kind: "synced",
			branch: branchName,
			prUrl: prResult.url,
			prNumber,
			merged: false,
		};
	},
};
