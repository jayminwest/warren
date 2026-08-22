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
 * back the merged bodies as `FinalizeResult.artifacts` deltas (each carries the
 * full `files[]` bodies + clone-relative paths, per the contract). This module
 * writes those bodies into the control plane's project clone and authors a single
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
 * `stageSeedsForCommit` commit.
 *
 * A no-op merge contributes an empty `files[]` (warren-df3e), so nothing is
 * written for it and no commit is authored when every delta is empty.
 */

import { dirname, join } from "node:path";
import {
	gitRepoContextScrubEnv,
	warrenCommitIdentityArgs,
	warrenCommitIdentityEnv,
} from "../../bot-identity.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import type { FinalizeResult } from "../../runtime/contract.ts";
import { gitCredentialGitEnv } from "../../workspace/git/credential-env.ts";
import { isCommitSha } from "../base-commit.ts";
import { hasAutoPlanRunFrontmatter } from "./auto-plan-run.ts";
import type { ReapPipelineContext, ReapPipelineState } from "./pipeline.ts";

const COMMIT_MESSAGE = "chore(warren): mirror state";
/** Push timeout for the durability step — mirrors finalize's branch-push budget. */
const PUSH_TIMEOUT_MS = 60_000;

/** One clone-relative file to overwrite with the finalize-supplied merged body. */
interface CloneWrite {
	/** clone-relative (posix) path, e.g. `.mulch/expertise/build.jsonl` */
	relPath: string;
	body: string;
}

/**
 * Flatten every finalize artifact delta into the set of clone files to
 * overwrite (warren-df3e). Feature-neutral: each opaque artifact contributes its
 * `files[]` verbatim; a no-op merge carries an empty `files[]` and contributes
 * nothing.
 */
function collectCloneWrites(r: FinalizeResult): CloneWrite[] {
	const writes: CloneWrite[] = [];
	for (const delta of Object.values(r.artifacts)) {
		for (const file of delta.files) {
			writes.push({ relPath: file.path, body: file.mergedBody });
		}
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
			// Feature-neutral per-artifact file counts, keyed by the opaque delta key.
			artifacts: Object.fromEntries(
				Object.entries(r.artifacts).map(([key, delta]) => [key, delta.files.length]),
			),
		});
		return true;
	} catch (err) {
		await ctx.fail("clone_apply", err);
		return false;
	}
}

/**
 * Make the K8s mirror commit durable on origin (warren-486c).
 *
 * ## Why this exists
 *
 * `applyCloneDeltas` authors `chore(warren): mirror state` ONLY in the control
 * plane's host clone. Under K8s the pod already pushed its run branch; the merged
 * `.seeds/` rows (newly-created issues + plan rows) live nowhere on origin. When
 * reap then auto-dispatches a plan-run, the child pods clone `origin/<ref>` (the
 * plan-run ref, defaulting to the project's default branch) and 404 on their
 * seed ids — and the next host-clone refresh (`git reset --hard origin/<ref>`)
 * discards the only copy of the mirror commit. This step pushes the mirror
 * commit to that exact ref BEFORE the plan-run is created, so the rows are
 * reachable from the ref child pods clone and cannot be lost to a host reset.
 *
 * Fast-forward only (`HEAD:<ref>`, never forced): the host clone was reset to
 * `origin/<ref>` at dispatch and only carries the one bookkeeping commit on top,
 * so a clean origin fast-forwards. A non-fast-forward (origin moved) or auth
 * failure returns false — the caller then SUPPRESSES auto-dispatch rather than
 * creating a plan-run against host-only state (durability contract). Best-effort:
 * failures fold into reap's error trail via `ctx.fail` and never throw.
 *
 * K8s-only by construction: the caller runs it solely on the `workspacePath ===
 * null` path, so LocalProvider (which merges into the clone the child dispatch
 * reuses) is byte-identical.
 */
export async function pushCloneDeltasToOrigin(
	ctx: ReapPipelineContext,
	ref: string,
): Promise<boolean> {
	// warren-aaf7: a 40-hex ref is a commit SHA, not a push target — `git
	// push origin HEAD:<sha>` is rejected by the remote. Legacy rows dispatched
	// with a SHA `ref` (pre-split) can still reach here, so skip the push with
	// a logged reason rather than burning a `clone_apply_push` failure. The
	// caller suppresses auto-dispatch (return false): a SHA-pinned run must not
	// spawn a plan-run against host-only state either.
	if (isCommitSha(ref)) {
		await ctx.emit("reap.clone_deltas_push_skipped", {
			ref,
			reason: "ref is a commit sha; nothing to push to",
		});
		return false;
	}
	try {
		// warren-4e1c: per-spawn minted credential (forge-contract.md §4 —
		// minted HERE, immediately before the push spawn, never held). A mint
		// failure throws inside this try and degrades to `clone_apply_push` +
		// suppressed auto-dispatch, exactly like a rejected push.
		const secret =
			ctx.input.forge !== undefined
				? await mintGitCredential(ctx.input.forge, ctx.project.gitUrl)
				: undefined;
		await ctx.exec.run("git", ["push", "origin", `HEAD:${ref}`], {
			cwd: ctx.project.localPath,
			timeoutMs: PUSH_TIMEOUT_MS,
			env: { ...gitRepoContextScrubEnv(), ...gitCredentialGitEnv(secret) },
		});
		await ctx.emit("reap.clone_deltas_pushed", { ref });
		return true;
	} catch (err) {
		await ctx.fail("clone_apply_push", err);
		return false;
	}
}

/**
 * K8s clone-delta path (warren-e9e1 leg 2 + warren-486c durability): apply the
 * finalize mirror bodies to the host clone, then — when that commit will feed an
 * auto plan-run — push it to origin/<plan-run ref> BEFORE dispatch. The plan-run
 * ref defaults to the project default branch (see auto-plan-run's dispatchOnePlan),
 * which is the exact ref child pods clone. A failed push flags
 * `state.mirrorDurabilityFailed` so auto-dispatch is suppressed rather than
 * creating a plan-run against host-only state the next `git reset --hard
 * origin/<ref>` discards. Called only on the K8s branch (`workspacePath === null`).
 */
export async function applyK8sCloneDeltas(
	ctx: ReapPipelineContext,
	state: ReapPipelineState,
	r: FinalizeResult,
): Promise<void> {
	const applied = await applyCloneDeltas(ctx, state, r);
	if (applied && hasAutoPlanRunFrontmatter(ctx.run)) {
		const durable = await pushCloneDeltasToOrigin(ctx, ctx.project.defaultBranch);
		state.mirrorDurabilityFailed = !durable;
	}
}
