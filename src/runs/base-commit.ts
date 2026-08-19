/**
 * Base-commit pinning: the `baseCommit` / `ref` split (warren-aaf7).
 *
 * `runs.ref` historically carried two meanings — the workspace cut point
 * AND the PR base. A SHA in `ref` materializes fine but blows up at reap:
 * `src/runs/reap/run.ts` resolves the PR base as `run.ref ?? defaultBranch`,
 * and a 40-hex PR base is a GitHub 422 that burns pr_open's retries.
 *
 * The split:
 *
 *   - `ref` stays BRANCH-SHAPED. It feeds the PR base and the branch cut.
 *   - `baseCommit` is a full 40-hex commit SHA. It overrides the workspace
 *     cut point only — the PR base never reads it.
 *
 * Validation lives at the HTTP boundary (`POST /runs`): a 40-hex value in
 * `ref` is rejected with a pointer to `baseCommit`; a malformed `baseCommit`
 * is rejected outright. The domain (`spawnRun`) trusts its callers.
 */

import { ValidationError } from "../core/errors.ts";
import { isValidBranchRef } from "./target-branch.ts";

/** Exactly 40 lowercase-or-uppercase hex characters (a full SHA-1 object id). */
const COMMIT_SHA_RE = /^[0-9a-fA-F]{40}$/;

/** True when `value` is a full 40-hex commit SHA. */
export function isCommitSha(value: string): boolean {
	return COMMIT_SHA_RE.test(value);
}

/**
 * Validate a dispatch-supplied `ref` (warren-aaf7). A `ref` must be a
 * well-formed branch name; a 40-hex value belongs in `baseCommit` and is
 * rejected with a pointer to it. Returns the value unchanged for threading.
 */
export function validateDispatchRef(ref: string | undefined): string | undefined {
	if (ref === undefined || ref.trim() === "") return undefined;
	if (isCommitSha(ref)) {
		throw new ValidationError(`ref must be a branch name, not a commit SHA: '${ref}'`, {
			recoveryHint:
				"To pin the workspace to a specific commit, dispatch with " +
				"baseCommit instead; ref stays a branch name so the PR base resolves.",
		});
	}
	if (!isValidBranchRef(ref)) {
		throw new ValidationError(`ref is not a valid git branch name: '${ref}'`, {
			recoveryHint:
				"Use a branch name git accepts: no spaces, control characters, '..', '~^:?*[\\', " +
				"and no segment starting with '.' or ending in '.lock'.",
		});
	}
	return ref;
}

/**
 * Validate a dispatch-supplied `baseCommit` (warren-aaf7): exactly 40 hex
 * characters. Returns the value unchanged for threading.
 */
export function validateBaseCommit(baseCommit: string | undefined): string | undefined {
	if (baseCommit === undefined || baseCommit.trim() === "") return undefined;
	if (!isCommitSha(baseCommit)) {
		throw new ValidationError(`baseCommit must be a full 40-hex commit SHA: '${baseCommit}'`, {
			recoveryHint: "Pass the full commit SHA (40 hex characters), not a short id or branch name.",
		});
	}
	return baseCommit;
}
