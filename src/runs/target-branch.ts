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
import type { SpawnFn, SpawnOptions } from "../projects/clone.ts";
import type { GitSpawnCredential } from "../workspace/git/credential-env.ts";
import { gitCredentialGitEnv } from "../workspace/git/credential-env.ts";

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

export interface ExistingBranchShapeInput {
	/** The dispatch-supplied `existingBranch` value. Empty/whitespace = not supplied. */
	readonly existingBranch: string | undefined;
	/** A dispatch-supplied `targetBranch`; mutually exclusive with `existingBranch`. */
	readonly targetBranch: string | undefined;
	/** A dispatch-supplied explicit `ref`; mutually exclusive with `existingBranch`. */
	readonly ref: string | undefined;
	/** The project's default branch (drives the same refusal as `targetBranch`). */
	readonly defaultBranch: string | undefined;
	/** The run continues another run; an existing-branch push-back would fork on the wrong base. */
	readonly parentRunId: string | undefined;
}

/**
 * Validate the SHAPE of an `existingBranch` dispatch (warren-326f): ref grammar,
 * default-branch refusal (same policy as `targetBranch`), and mutual exclusivity
 * with the other base-ref/push-target fields. Returns the normalized short
 * branch name, or `undefined` when the field was not supplied.
 *
 * This does NOT touch the network; the remote-existence check is
 * `assertBranchOnRemote`, which callers run before any side effect.
 */
export function validateExistingBranchShape(input: ExistingBranchShapeInput): string | undefined {
	const existing = input.existingBranch?.trim();
	if (existing === undefined || existing === "") return undefined;

	const conflicts = [
		...(input.ref !== undefined && input.ref.trim() !== "" ? ["ref"] : []),
		...(input.targetBranch !== undefined && input.targetBranch.trim() !== ""
			? ["targetBranch"]
			: []),
		...(input.parentRunId !== undefined && input.parentRunId !== "" ? ["parentRunId"] : []),
	];
	if (conflicts.length > 0) {
		throw new ValidationError(`existingBranch cannot be combined with: ${conflicts.join(", ")}`, {
			recoveryHint:
				"existingBranch pins BOTH the workspace base and the push target. Dispatch it " +
				"on its own, or drop it and use ref/targetBranch/parentRunId.",
		});
	}

	// Same grammar + default-branch policy as targetBranch; never null so the
	// empty-value fallback can't strand the spawn on a blank ref.
	const branch = validateTargetBranch(existing, input.defaultBranch);
	if (branch === undefined) {
		throw new ValidationError(
			`existingBranch is not a valid git branch name: '${input.existingBranch}'`,
			{
				recoveryHint:
					"Supply the branch you want the run to check out and push back to, e.g. fix/pr-head.",
			},
		);
	}
	return branch;
}

export interface BranchOnRemoteInput {
	/** The repository URL the push remote lives at. */
	readonly gitUrl: string;
	/** Normalized branch name to verify. */
	readonly branch: string;
	/** The child-process spawn used for git (tests inject a fake). */
	readonly spawn: SpawnFn;
	/** Credential env for a private remote (same minted credential the push uses). */
	readonly gitCredential?: GitSpawnCredential;
	/** Working directory for the git invocation; must exist. */
	readonly cwd: string;
	readonly timeoutMs?: number;
}

/**
 * Fail-closed existence check (warren-326f): the branch MUST already exist on
 * the push remote before the dispatch composes a workspace onto it. Runs
 * `git ls-remote --heads <gitUrl> refs/heads/<branch>` with the same credential
 * env the refresh/push use. Throws `ValidationError` (HTTP 400) with an
 * actionable message when the remote does not carry the branch or the probe
 * itself fails; a silent pass-through would strand the run at compose time.
 */
export async function assertBranchOnRemote(input: BranchOnRemoteInput): Promise<void> {
	const credEnv = gitCredentialGitEnv(input.gitCredential);
	const opts: SpawnOptions = {
		cwd: input.cwd,
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
		...(Object.keys(credEnv).length > 0 ? { env: credEnv } : {}),
	};
	let result: Awaited<ReturnType<typeof input.spawn>>;
	try {
		result = await input.spawn(
			["git", "ls-remote", "--heads", input.gitUrl, `refs/heads/${input.branch}`],
			opts,
		);
	} catch (err) {
		throw new ValidationError(
			`could not verify branch '${input.branch}' exists on the push remote: ${err instanceof Error ? err.message : String(err)}`,
			{
				recoveryHint:
					"existingBranch requires the branch to already exist on the remote. Check the " +
					"credential and the repository URL, or dispatch without existingBranch to cut a fresh branch.",
			},
		);
	}
	const exists = result.exitCode === 0 && result.stdout.includes(`refs/heads/${input.branch}`);
	if (!exists) {
		throw new ValidationError(
			result.exitCode !== 0
				? `could not verify branch '${input.branch}' exists on the push remote (git ls-remote exited ${result.exitCode})`
				: `branch '${input.branch}' does not exist on the push remote`,
			{
				recoveryHint:
					`existingBranch refuses to compose a workspace onto a branch the remote does not ` +
					`carry. Push '${input.branch}' first (or check the spelling), then re-dispatch.`,
			},
		);
	}
}
