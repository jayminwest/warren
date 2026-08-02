/**
 * `targetBranch` push-target policy (warren-3a75).
 *
 * A run dispatched with `targetBranch` pushes its workspace straight to that
 * ref at finalize (`src/runtime/k8s/finalize-collect.ts` builds the refspec
 * `HEAD:<branch>` from the intent). No PR is opened for that push, so the
 * Article IX auto-merge gate — a PR-time check — never runs. Before this
 * module the field was accepted on `POST /runs` as any non-empty string, which
 * made "push to `main`, bypassing review" a plain dispatch capability.
 *
 * Two rules, enforced once, in the domain layer:
 *
 *   1. Ref grammar. A subset of `git check-ref-format --branch` — slashes are
 *      allowed (a target is a full branch name like `fix/pr-head`, unlike
 *      `runBranchPrefix` which must stay a single segment), everything git
 *      itself rejects is rejected here too.
 *   2. Default-branch refusal. `targetBranch` may not resolve to the project's
 *      default branch. There is deliberately NO opt-in knob: a caller that
 *      wants code on the default branch opens a PR.
 *
 * The repair / CI-fixer flow (warren-709e/a993) dispatches with `targetBranch`
 * set to an EXISTING PR head branch so warren pushes back to it in place. That
 * branch is never the default branch, so it keeps working unchanged.
 */

import { ValidationError } from "../core/errors.ts";

/** Fully-qualified branch refs are accepted and compared on their short name. */
const HEADS_PREFIX = "refs/heads/";

/** Characters and sequences `git check-ref-format` rejects outright. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: git rejects control chars in refs
const INVALID_CHARS = /[\u0000-\u0020\u007f~^:?*[\\]/;

/**
 * Strip an optional `refs/heads/` qualifier so `refs/heads/main` and `main`
 * are the same push target for the default-branch comparison.
 */
export function normalizeBranchRef(branch: string): string {
	const trimmed = branch.trim();
	return trimmed.startsWith(HEADS_PREFIX) ? trimmed.slice(HEADS_PREFIX.length) : trimmed;
}

/**
 * True when `branch` is a well-formed git branch name. Mirrors the rules of
 * `git check-ref-format --branch` that matter for a push target.
 */
export function isValidBranchRef(branch: string): boolean {
	if (branch === "" || branch === "@") return false;
	if (INVALID_CHARS.test(branch)) return false;
	if (branch.includes("..") || branch.includes("@{")) return false;
	if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) return false;
	if (branch.startsWith("-") || branch.endsWith(".")) return false;
	return branch
		.split("/")
		.every((segment) => segment !== "" && !segment.startsWith(".") && !segment.endsWith(".lock"));
}

/**
 * Validate a dispatch-supplied `targetBranch` against the ref grammar and the
 * default-branch policy. Returns the normalized short branch name, or
 * `undefined` when no target was supplied (an empty / whitespace-only value is
 * "not supplied" — `composeRunBranch` already falls back to the composed
 * `${prefix}/${runId}` for it).
 *
 * Throws `ValidationError` (HTTP 400) on a malformed ref or on a target that
 * resolves to the project's default branch.
 */
export function validateTargetBranch(
	targetBranch: string | undefined,
	defaultBranch: string | undefined,
): string | undefined {
	if (targetBranch === undefined) return undefined;
	const branch = normalizeBranchRef(targetBranch);
	if (branch === "") return undefined;

	if (!isValidBranchRef(branch)) {
		throw new ValidationError(`targetBranch is not a valid git branch name: '${targetBranch}'`, {
			recoveryHint:
				"Use a branch name git accepts: no spaces, control characters, '..', '~^:?*[\\', " +
				"and no segment starting with '.' or ending in '.lock'.",
		});
	}

	const projectDefault = defaultBranch === undefined ? "" : normalizeBranchRef(defaultBranch);
	if (projectDefault !== "" && branch === projectDefault) {
		throw new ValidationError(
			`targetBranch '${branch}' is the project default branch; direct pushes to it are refused`,
			{
				recoveryHint:
					"Dispatch without targetBranch so the run lands on its own branch and opens a PR. " +
					"Pushing to the default branch would bypass PR review and the Article IX gate.",
			},
		);
	}

	return branch;
}
