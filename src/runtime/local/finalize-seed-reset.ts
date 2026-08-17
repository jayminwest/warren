/**
 * warren-8d95: the `seed_reset` finalize stage for the burrow `LocalProvider`.
 *
 * Warren seeds the rendered agent envelope (`.warren/agent.json`), the `.pi/`
 * skill/prompt/extension drops, and `.seeds/workflow.txt` into every run
 * workspace. In a project that itself TRACKS a colliding path the seed
 * overwrites a tracked file, and a broad agent commit (`git add -A`) then
 * carries the seeded artifact into the run branch, tripping the auto-merge
 * workflow's Article IX protected-path guard. warren's own repo no longer
 * tracks the agent envelope (warren-5585), but this reset stays as a general
 * guard for any project that tracks a colliding seed path.
 *
 * This stage runs AFTER the bookkeeping commits and BEFORE `branch_push`
 * (matching reap's commit-then-push order): it restores each seeded path to
 * `baseBranch` — but only when the live workspace bytes still EQUAL what warren
 * seeded, so an intentional agent edit is preserved — and captures the net
 * change in one `chore(warren): reset seeded workspace artifacts` commit. It is
 * best-effort: a failure records the stage + a `reap_failed` and never blocks
 * the push.
 */

import { join } from "node:path";
import {
	gitRepoContextScrubEnv,
	warrenCommitIdentityArgs,
	warrenCommitIdentityEnv,
} from "../../bot-identity.ts";
import type { ReapExec, ReapFs, ReapStep } from "../../runs/reap/types.ts";
import type { FinalizeIntent, FinalizeStage } from "../contract.ts";

/** Structural view of finalize's `StageTrail` (no coupling to the class). */
interface StageRecorder {
	ok(stage: FinalizeStage): void;
	skipped(stage: FinalizeStage): void;
	failed(stage: FinalizeStage, err: unknown): void;
}

/** Structural view of finalize's `EventCollector`. */
interface EventSink {
	emit(kind: string, payload: unknown): Promise<unknown>;
	fail(step: ReapStep, err: unknown, path?: string): Promise<void>;
}

/**
 * Reset each warren-seeded pure-context artifact to `baseBranch` before the
 * push. Omitted / empty `resetSeededPaths` ⇒ no-op (existing callers unchanged);
 * a missing base ref skips the stage (nothing to restore against).
 */
export async function finalizeSeedReset(
	intent: FinalizeIntent,
	workspacePath: string,
	fs: ReapFs,
	exec: ReapExec,
	trail: StageRecorder,
	collector: EventSink,
): Promise<void> {
	const paths = intent.resetSeededPaths;
	if (paths === undefined || paths.length === 0) return;
	if (intent.baseBranch === undefined || intent.baseBranch === "") {
		trail.skipped("seed_reset");
		return;
	}
	try {
		const resetPaths: string[] = [];
		for (const seeded of paths) {
			if (await resetOneSeededPath(seeded, intent.baseBranch, workspacePath, fs, exec)) {
				resetPaths.push(seeded.path);
			}
		}
		if (resetPaths.length > 0 && (await hasStagedChanges(workspacePath, exec))) {
			await commitSeedReset(workspacePath, exec);
			await collector.emit("reap.seed_reset", {
				paths: resetPaths,
				message: "reset warren-seeded workspace artifacts to base before push",
			});
		}
		trail.ok("seed_reset");
	} catch (err) {
		trail.failed("seed_reset", err);
		await collector.fail("seed_reset", err, workspacePath);
	}
}

/**
 * Reset a single seeded path to base when the live workspace bytes still equal
 * what warren seeded. Returns `true` when a git operation ran, `false` when the
 * path was absent or the agent intentionally edited it.
 */
async function resetOneSeededPath(
	seeded: { path: string; contents: string },
	baseBranch: string,
	workspacePath: string,
	fs: ReapFs,
	exec: ReapExec,
): Promise<boolean> {
	const current = await fs.readFile(join(workspacePath, seeded.path));
	if (current === null || current !== seeded.contents) return false;
	const env = gitRepoContextScrubEnv();
	if (await pathExistsInRef(baseBranch, seeded.path, workspacePath, exec)) {
		// Restore the base blob into index + worktree (reverts a seed overwrite).
		await exec.run("git", ["checkout", baseBranch, "--", seeded.path], {
			cwd: workspacePath,
			timeoutMs: 10_000,
			env,
		});
	} else {
		// A seed drop absent from base: drop it from index + worktree so it never
		// rides into the PR. `--ignore-unmatch` no-ops when it was never committed.
		await exec.run("git", ["rm", "-f", "--ignore-unmatch", "--", seeded.path], {
			cwd: workspacePath,
			timeoutMs: 10_000,
			env,
		});
		// git-rm no-ops on a drop the index never knew (untracked in every ref),
		// so sweep the worktree bytes too — the live contents were verified equal
		// to what warren seeded above, so this deletes no agent work. Without the
		// sweep the residue reads as a dirty `.warren/` path at empty-push
		// classification and trips dropped_commit on a genuine no-op run
		// (warren-0f18's falsification assertion).
		await exec.run("git", ["clean", "-f", "--", seeded.path], {
			cwd: workspacePath,
			timeoutMs: 10_000,
			env,
		});
	}
	return true;
}

/** `git cat-file -e <ref>:<path>` — true iff the path exists in that ref. */
async function pathExistsInRef(
	ref: string,
	path: string,
	workspacePath: string,
	exec: ReapExec,
): Promise<boolean> {
	try {
		await exec.run("git", ["cat-file", "-e", `${ref}:${path}`], {
			cwd: workspacePath,
			timeoutMs: 10_000,
			env: gitRepoContextScrubEnv(),
		});
		return true;
	} catch {
		return false;
	}
}

/** True iff the index carries staged changes (`git diff --cached --quiet` fails). */
async function hasStagedChanges(workspacePath: string, exec: ReapExec): Promise<boolean> {
	try {
		await exec.run("git", ["diff", "--cached", "--quiet"], {
			cwd: workspacePath,
			timeoutMs: 10_000,
			env: gitRepoContextScrubEnv(),
		});
		return false;
	} catch {
		return true;
	}
}

/** Author the seed-reset bookkeeping commit with the pinned warren bot identity. */
async function commitSeedReset(workspacePath: string, exec: ReapExec): Promise<void> {
	await exec.run(
		"git",
		[
			...warrenCommitIdentityArgs(),
			"commit",
			// Internal bookkeeping commit: never gated by the project's git hooks.
			"--no-verify",
			"-m",
			"chore(warren): reset seeded workspace artifacts",
		],
		{
			cwd: workspacePath,
			timeoutMs: 10_000,
			env: { ...gitRepoContextScrubEnv(), ...warrenCommitIdentityEnv() },
		},
	);
}
