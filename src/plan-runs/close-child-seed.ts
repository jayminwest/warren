/**
 * Deterministic host-side close of a plan-run child's seed when the child
 * PR merges (warren-3806).
 *
 * Background: a plan-run child seed was only reliably closed when the agent
 * itself committed `sd close <id>` inside its run — the reap-time safety net
 * (`closeRunSeedId`) fired for single-run dispatches but proved unreliable
 * for plan-run children, so children whose PRs merged sometimes left their
 * seeds open (plnr_8g1crv7f47xp: warren-3f09 / warren-f854). This module
 * makes closure a coordinator-owned side effect: the instant a child
 * transitions to `merged`, warren authors a `chore(warren)` commit that
 * closes the seed on the project's default branch, using WARREN_BOT_IDENTITY
 * (Article VII) — no dependency on agent initiative.
 *
 * warren-6234: the close runs through the IssueTracker seam
 * (`tracker.closeIssue`). The worktree/commit/push machinery is
 * GIT-NATIVE-ONLY — fenced behind `capabilities.isGitNative`. A non-git-native
 * tracker (hosted issues) has no clone to commit to, so `closeMergedChildSeed`
 * collapses to a single `tracker.closeIssue` call and reports `closed`.
 *
 * Mechanics mirror `defaultPlotSyncer` in src/plots/sync.ts: fetch origin,
 * spin a throwaway worktree off `origin/<defaultBranch>`, run `sd close`
 * there, and — only when that actually changed `.seeds/issues.jsonl` — author
 * a warren-identity commit (`--no-verify`) and push it straight to the
 * default branch. An already-closed seed leaves the tree clean and yields a
 * `noop`, so the operation is idempotent.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	gitRepoContextScrubEnv,
	warrenCommitIdentityArgs,
	warrenCommitIdentityEnv,
} from "../bot-identity.ts";
import type { SpawnFn } from "../projects/index.ts";
import type { IssueTracker } from "../tracker/contract.ts";
import type { GitSpawnCredential } from "../workspace/git/credential-env.ts";
import { gitCredentialGitEnv } from "../workspace/git/credential-env.ts";

export interface CloseMergedChildSeedInput {
	/** Project clone whose origin carries the seed queue (coordination project). */
	readonly projectPath: string;
	/** Default branch the merged child PR landed on. */
	readonly defaultBranch: string;
	/** Seed id to close. */
	readonly seedId: string;
	/** warren-6234: the tracker seam — close runs through `tracker.closeIssue`. */
	readonly issueTracker: IssueTracker;
	/** Project id for the tracker context (warren-6234). */
	readonly projectId: string;
	/** git spawn seam (same shape used across projects/plots). */
	readonly spawn: SpawnFn;
	readonly gitBinary: string;
	/**
	 * Raw `GITHUB_TOKEN` for the fetch + push against a private origin,
	 * applied per-spawn via `gitCredentialGitEnv` (needed on the K8s
	 * control plane, where no supervisor-installed global insteadOf rule
	 * exists). Absent/empty → anonymous git, the old behavior.
	 */
	readonly gitCredential?: GitSpawnCredential;
}

export type CloseMergedChildSeedResult =
	/** A warren-identity commit closed the seed and was pushed to default. */
	| { readonly kind: "closed"; readonly branch: string }
	/** Seed was already closed on the default branch — nothing to commit. */
	| { readonly kind: "noop" };

const SEEDS_ISSUES_PATHSPEC = join(".seeds", "issues.jsonl");

async function runGit(
	input: CloseMergedChildSeedInput,
	args: readonly string[],
	cwd: string,
	env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		return await input.spawn([input.gitBinary, ...args], { cwd, timeoutMs: 30_000, env });
	} catch (err) {
		throw new Error(
			`failed to spawn git ${args.join(" ")}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Create the throwaway worktree off origin/<defaultBranch> (local fallback). */
async function addWorktree(
	input: CloseMergedChildSeedInput,
	worktreePath: string,
	branchName: string,
	scrub: Record<string, string | undefined>,
): Promise<void> {
	const { defaultBranch } = input;
	let res = await runGit(
		input,
		["worktree", "add", "-b", branchName, worktreePath, `origin/${defaultBranch}`],
		input.projectPath,
		scrub,
	);
	if (res.exitCode !== 0) {
		res = await runGit(
			input,
			["worktree", "add", "-b", branchName, worktreePath, defaultBranch],
			input.projectPath,
			scrub,
		);
	}
	if (res.exitCode !== 0) {
		throw new Error(`git worktree add failed (exit ${res.exitCode}): ${res.stderr}`);
	}
}

/**
 * Close a merged plan-run child's seed on the project's default branch.
 * Idempotent: an already-closed seed returns `{ kind: "noop" }` without
 * authoring a commit.
 */
export async function closeMergedChildSeed(
	input: CloseMergedChildSeedInput,
): Promise<CloseMergedChildSeedResult> {
	// warren-6234: non-git-native trackers close through the host API — no
	// worktree, no commit, no push. `branch` reports the tracked default
	// branch for logging symmetry with the git-native path.
	if (!input.issueTracker.capabilities.isGitNative) {
		await input.issueTracker.closeIssue(
			{ projectId: input.projectId, localPath: input.projectPath },
			input.seedId,
		);
		return { kind: "closed", branch: input.defaultBranch };
	}

	const scrub = gitRepoContextScrubEnv();
	// Credential env for the network-touching calls only (fetch + push).
	const cred = gitCredentialGitEnv(input.gitCredential);

	// Best-effort fetch so the worktree reflects the just-merged default branch.
	await runGit(input, ["fetch", "--prune", "origin"], input.projectPath, { ...scrub, ...cred });

	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const hash = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	const branchName = `warren/seed-close-${hash}`;
	const worktreePath = await mkdtemp(join(tmpdir(), `warren-seed-close-${hash}-`));

	try {
		await addWorktree(input, worktreePath, branchName, scrub);

		// The close is idempotent; it rewrites .seeds/issues.jsonl only when the
		// seed was open on this branch (seeds: `sd close` inside the worktree).
		await input.issueTracker.closeIssue(
			{ projectId: input.projectId, localPath: worktreePath },
			input.seedId,
		);

		const status = await runGit(
			input,
			["status", "--porcelain", "--", SEEDS_ISSUES_PATHSPEC],
			worktreePath,
			scrub,
		);
		if (status.stdout.trim() === "") {
			return { kind: "noop" };
		}

		await runGit(input, ["add", "--", SEEDS_ISSUES_PATHSPEC], worktreePath, scrub);
		const commit = await runGit(
			input,
			[
				...warrenCommitIdentityArgs(),
				"commit",
				// warren-27d3: never gate a warren bookkeeping commit on project hooks.
				"--no-verify",
				"--only",
				"-m",
				`chore(warren): close merged plan-run child seed ${input.seedId}`,
				"--",
				SEEDS_ISSUES_PATHSPEC,
			],
			worktreePath,
			{ ...scrub, ...warrenCommitIdentityEnv() },
		);
		if (commit.exitCode !== 0) {
			throw new Error(`git commit failed (exit ${commit.exitCode}): ${commit.stderr}`);
		}

		const push = await runGit(
			input,
			["push", "origin", `HEAD:${input.defaultBranch}`],
			worktreePath,
			{ ...scrub, ...cred },
		);
		if (push.exitCode !== 0) {
			throw new Error(`git push failed (exit ${push.exitCode}): ${push.stderr}`);
		}

		return { kind: "closed", branch: input.defaultBranch };
	} finally {
		await runGit(input, ["worktree", "remove", "--force", worktreePath], input.projectPath, scrub);
		await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
	}
}
