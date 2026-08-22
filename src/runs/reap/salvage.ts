/**
 * Local salvage-before-destroy (warren-cd3b) — the LocalProvider half of the
 * salvage step. Runs inside reap between a FAILED finalize (the branch push
 * never landed) and `runWorkspaceDestroy`, while the host-side workspace is
 * still reachable. Under K8s this step cannot run (the workspace is the pod's
 * `emptyDir`) — the pod salvages itself and POSTs to `/runs/:id/salvage`; see
 * `src/runtime/salvage.ts` for the shared vocabulary and the runtime split.
 *
 * Two capture forms, tried in order of operator convenience:
 *
 *   1. RESCUE REF — `git push origin HEAD:warren/rescue/<runId>` from the
 *      workspace. Rides the same push path that just failed, so a rejection
 *      (push protection, auth) is expected sometimes; the failure is noted,
 *      not thrown.
 *   2. BUNDLE — `git bundle create <salvageDir>/<runId>.bundle <base>..HEAD`
 *      written to durable warren-side storage. Survives a push-protection
 *      rejection because it never touches origin. Skipped when no salvageDir
 *      was threaded (tests).
 *
 * The outcome drives reap's destroy gating: a successful capture (either form)
 * means the work is safe and the workspace CAN be destroyed; a total failure
 * keeps the old preserve-the-workspace skip, now paired with an explicit
 * `reap.workspace_salvage_failed` event so the unrecoverable determination is
 * operator-visible instead of silent.
 */

import { rescueBranchFor, salvageBundlePath } from "../../runtime/salvage.ts";
import type { GitSpawnCredential } from "../../workspace/git/credential-env.ts";
import { gitCredentialGitEnv } from "../../workspace/git/credential-env.ts";
import type { ReapExec, ReapFs } from "./types.ts";

export interface WorkspaceSalvageInput {
	readonly runId: string;
	readonly workspacePath: string;
	/** Base ref for the bundle range; null ⇒ bundle the full `HEAD` history. */
	readonly baseBranch: string | null;
	/** Durable dir for the bundle capture; absent ⇒ only the rescue ref is tried. */
	readonly salvageDir?: string;
	/**
	 * Per-spawn minted git credential for the rescue-ref push (warren-4e1c,
	 * forge-contract.md §4 — minted by the caller immediately before this
	 * call via `mintGitCredential`, never held on a config object).
	 * Undefined ⇒ anonymous push, the pre-forge behavior for a forge that owns
	 * no credential for the URL.
	 */
	readonly gitCredential?: GitSpawnCredential;
	readonly exec: ReapExec;
	readonly fs: ReapFs;
}

/** What a salvage attempt captured. Both null ⇒ nothing was saved. */
export interface WorkspaceSalvageOutcome {
	/** The rescue branch on origin (`warren/rescue/<runId>`), when pushed. */
	readonly rescueRef: string | null;
	/** The durable bundle path, when captured. */
	readonly bundlePath: string | null;
	/** Per-attempt failure notes (never secret material — git stderr only). */
	readonly errors: string[];
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Attempt both capture forms against the live workspace. Never throws — every
 * failure lands in `errors` and the caller decides (via the two nulls) whether
 * the run's work is recoverable.
 */
export async function salvageWorkspace(
	input: WorkspaceSalvageInput,
): Promise<WorkspaceSalvageOutcome> {
	const errors: string[] = [];
	let rescueRef: string | null = null;
	let bundlePath: string | null = null;

	const branch = rescueBranchFor(input.runId);
	try {
		await input.exec.run("git", ["push", "origin", `HEAD:refs/heads/${branch}`], {
			cwd: input.workspacePath,
			timeoutMs: 60_000,
			env: gitCredentialGitEnv(input.gitCredential),
		});
		rescueRef = branch;
	} catch (err) {
		errors.push(`rescue push to ${branch} failed: ${errMessage(err)}`);
	}

	if (rescueRef === null && input.salvageDir !== undefined) {
		const range =
			input.baseBranch !== null && input.baseBranch !== "" ? `${input.baseBranch}..HEAD` : "HEAD";
		try {
			// Shared resolver, not a bare join (warren-7c1e): this run id comes
			// off a db row rather than a route param, but the containment check
			// belongs to the sink so every salvage writer inherits it. Inside the
			// try because this function reports through `errors` and never throws.
			const target = salvageBundlePath(input.salvageDir, input.runId);
			await input.fs.mkdirp(input.salvageDir);
			await input.exec.run("git", ["bundle", "create", target, range], {
				cwd: input.workspacePath,
				timeoutMs: 60_000,
			});
			bundlePath = target;
		} catch (err) {
			// An empty range (no commits ahead — nothing to lose) fails here with
			// "Refusing to create empty bundle"; that is a fine outcome too.
			errors.push(`bundle capture (${range}) failed: ${errMessage(err)}`);
		}
	}

	return { rescueRef, bundlePath, errors };
}
