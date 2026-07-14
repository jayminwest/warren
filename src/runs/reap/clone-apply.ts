/**
 * Host-side application of a `FinalizeResult`'s mirror deltas to the project
 * clone (warren-e9e1, leg 2) — the K8s counterpart to LocalProvider's host-side
 * merge.
 *
 * ## Why this exists
 *
 * LocalProvider's `finalize` merges each tracker (`mulch` / `seeds` / `plans`)
 * host-side, writing the merged bodies straight INTO the project clone
 * (`mergeMulch(workspacePath, clonePath)` etc.), so nothing is left to apply —
 * the clone already carries the union. Under K8s the merge happens INSIDE the
 * pod against a pod-local clone the control plane can't reach; `finalize` hands
 * back the merged bodies as `FinalizeResult.mirror` deltas (each carries a
 * `mergedBody` + clone-relative `path`, per the contract). This module writes
 * those bodies into the control plane's project clone and authors a single
 * `chore(warren): mirror state` bookkeeping commit so the clone's `.mulch/` and
 * `.seeds/` reflect what the agent produced (mulch is the cross-run memory
 * layer — the clone is the next run's materialization source).
 *
 * ## Gating (LocalProvider byte-identical)
 *
 * The caller runs this ONLY when there is no host workspace
 * (`ctx.workspacePath === null`, the K8s discriminator). On the LocalProvider
 * path the clone was already updated host-side by `finalize`, so re-applying is
 * skipped entirely and no new commit is authored — the local reap is unchanged.
 *
 * ## Commit identity
 *
 * Authored as the canonical warren bot (`warrenCommitIdentityArgs()` /
 * CLAUDE.md Article VII), `--no-verify` (bookkeeping commits never run project
 * hooks, warren-27d3), `--only` path-limited to the actually-written carriers so
 * a pre-staged unrelated file can't be swept in — the same posture as the local
 * `stage{Plot,Seeds}ForCommit` commits.
 *
 * `PlotDelta` carries no `mergedBody` (deliberately thin, contract) so it is not
 * applied here; the `.plot/` files ride to origin on the pod-pushed branch.
 */

import { dirname, join } from "node:path";
import { warrenCommitIdentityArgs, warrenCommitIdentityEnv } from "../../bot-identity.ts";
import type { FinalizeResult } from "../../runtime/contract.ts";
import type { ReapPipelineContext, ReapPipelineState } from "./pipeline.ts";

const COMMIT_MESSAGE = "chore(warren): mirror state";

/**
 * Git environment variables that pin repo discovery / index / object storage to
 * a specific worktree. A parent `git commit` exports these to its hooks
 * (`GIT_INDEX_FILE`, `GIT_PREFIX`, and — when the invocation was already inside
 * a git dir — `GIT_DIR`), so warren's OWN pre-commit gate, which runs the test
 * suite, carries them. If a git subprocess spawned below inherited them it would
 * ignore its `cwd` and read/write the PARENT repo instead of the project clone:
 * warren-fa84 saw a leaked repo-context env write a stray `chore(warren)` commit
 * into the real repo (and warren-e9e1 earlier saw it flip `core.bare`). We scrub
 * the whole dangerous family at every spawn so hermeticity never depends on the
 * caller's environment or on test-level env clearing.
 */
const GIT_REPO_CONTEXT_ENV_KEYS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
] as const;

/**
 * An `env` override map that unsets the repo-context `GIT_*` vars in the child
 * environment (the exec adaptor treats an `undefined` value as "remove this
 * key" — see `resolveSpawnEnv`). Merge identity/other entries OVER this to keep
 * them; the two families don't overlap.
 */
export function gitRepoContextScrubEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const key of GIT_REPO_CONTEXT_ENV_KEYS) env[key] = undefined;
	return env;
}

/** One clone-relative file to overwrite with the finalize-supplied merged body. */
interface CloneWrite {
	/** clone-relative (posix) path, e.g. `.mulch/expertise/build.jsonl` */
	relPath: string;
	body: string;
}

/**
 * Flatten the finalize mirror deltas into the set of clone files to overwrite.
 * `mulch` contributes one entry per expertise file; `seeds` / `plans` one each
 * when their `mergedBody` is non-null (a null body means the mirror was a no-op).
 */
function collectCloneWrites(r: FinalizeResult): CloneWrite[] {
	const writes: CloneWrite[] = [];
	for (const file of r.mirror.mulch?.files ?? []) {
		writes.push({ relPath: file.path, body: file.mergedBody });
	}
	if (r.mirror.seeds?.mergedBody != null) {
		writes.push({ relPath: r.mirror.seeds.path, body: r.mirror.seeds.mergedBody });
	}
	if (r.mirror.plans?.mergedBody != null) {
		writes.push({ relPath: r.mirror.plans.path, body: r.mirror.plans.mergedBody });
	}
	return writes;
}

/**
 * Apply a K8s finalize's mirror deltas to the project clone and commit them as
 * the warren bot. No-op (returns false) when there are no bodies to write or the
 * staged tree carries no delta. Best-effort: any failure is folded into reap's
 * error trail via `ctx.fail("clone_apply", …)` and never throws.
 *
 * Returns true when a bookkeeping commit landed.
 */
export async function applyCloneDeltas(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
	r: FinalizeResult,
): Promise<boolean> {
	const writes = collectCloneWrites(r);
	if (writes.length === 0) return false;
	const clonePath = ctx.project.localPath;
	try {
		for (const w of writes) {
			const abs = join(clonePath, w.relPath);
			await ctx.fs.mkdirp(dirname(abs));
			await ctx.fs.writeFile(abs, w.body);
		}
		const pathspecs = writes.map((w) => w.relPath);
		await ctx.exec.run("git", ["add", "--", ...pathspecs], {
			cwd: clonePath,
			timeoutMs: 10_000,
			env: gitRepoContextScrubEnv(),
		});
		// `git diff --cached --quiet` exits non-zero iff the add picked up a real
		// delta the clone didn't already have — the same staged-delta primitive the
		// local stage* commits use. No delta ⇒ nothing to commit (idempotent).
		let hasStagedDelta: boolean;
		try {
			await ctx.exec.run("git", ["diff", "--cached", "--quiet", "--", ...pathspecs], {
				cwd: clonePath,
				timeoutMs: 10_000,
				env: gitRepoContextScrubEnv(),
			});
			hasStagedDelta = false;
		} catch {
			hasStagedDelta = true;
		}
		if (!hasStagedDelta) return false;

		await ctx.exec.run(
			"git",
			[
				...warrenCommitIdentityArgs(),
				"commit",
				"--no-verify",
				"--only",
				"-m",
				COMMIT_MESSAGE,
				"--",
				...pathspecs,
			],
			// warren-035c: pin the bot identity in env so an inherited
			// GIT_AUTHOR_*/GIT_COMMITTER_* can't out-rank the `-c user.*` config.
			// warren-fa84: scrub the inherited repo-context GIT_* (GIT_DIR /
			// GIT_INDEX_FILE / …) so this commit can't escape `clonePath` into the
			// parent repo when a hook exported them. Identity wins over the scrub —
			// the two key families don't overlap.
			{
				cwd: clonePath,
				timeoutMs: 10_000,
				env: { ...gitRepoContextScrubEnv(), ...warrenCommitIdentityEnv() },
			},
		);
		state.cloneDeltasApplied = true;
		await ctx.emit("reap.clone_deltas_applied", {
			message: COMMIT_MESSAGE,
			filesWritten: pathspecs.length,
			mulchFiles: r.mirror.mulch?.files.length ?? 0,
			seeds: r.mirror.seeds?.mergedBody != null,
			plans: r.mirror.plans?.mergedBody != null,
		});
		return true;
	} catch (err) {
		await ctx.fail("clone_apply", err);
		return false;
	}
}
