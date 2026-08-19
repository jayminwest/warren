/**
 * Continuation base-ref resolution (warren-4b11, extracted from dispatch.ts
 * for the file-size budget in warren-232d).
 *
 * Resolves the git ref the project clone should be refreshed to before the
 * provider forks the new run branch.
 *
 * - No `parentRunId` → explicit `ref`, else the `targetBranch` push target
 *   (warren-709e), else undefined → refreshProject's project default branch.
 * - `parentRunId` set with `cloneKind: "replicate"` (warren-e96f) → the
 *   caller's explicit `ref` (or the project default branch). A replicate is a
 *   fresh re-dispatch of the parent's config, NOT a continuation, so it must
 *   NOT check out the parent's pushed branch — that branch may be stale or may
 *   never have been pushed (parent failed early).
 * - `parentRunId` set (default `cloneKind: "continue"`) → the parent run's
 *   pushed branch, recomposed from the same prefix precedence the parent's
 *   spawn used (`composeRunBranch(resolveRunBranchPrefix(...), parentRunId)`).
 *   We read the project defaults here (a lightweight pre-refresh peek) only to
 *   get the prefix; the working tree's `.warren/` is stable across a project's
 *   runs, so this matches the branch the parent actually pushed.
 *
 * The parent must belong to the same project — a continuation forks the
 * parent's branch on the same origin, so a cross-project parent would be a
 * meaningless base. We reject it with a typed ValidationError rather than
 * silently checking out a branch that doesn't exist on this origin.
 */

import { ValidationError } from "../../core/errors.ts";
import { composeRunBranch, resolveRunBranchPrefix } from "../branch.ts";
import { readProjectDefaults } from "./agent-cache.ts";
import type { SpawnRunInput } from "./types.ts";

export async function resolveContinuationRef(
	input: SpawnRunInput,
	project: { id: string; localPath: string },
	targetBranch: string | undefined,
): Promise<string | undefined> {
	if (!input.parentRunId) return input.ref ?? targetBranch; // warren-709e
	// Replicate (warren-e96f): fresh re-dispatch against the explicit ref /
	// project default base, not the parent's pushed branch. We still validate
	// the parent below (same-project guard), but the base ref is the caller's.
	if (input.cloneKind === "replicate") {
		const parent = await input.repos.runs.require(input.parentRunId);
		if (parent.projectId !== project.id) {
			throw new ValidationError(
				`parent run ${parent.id} belongs to a different project; a re-run must reuse the same project`,
				{ recoveryHint: "re-run with a cloneFromRunId from the same project, or omit it" },
			);
		}
		return input.ref;
	}
	const parent = await input.repos.runs.require(input.parentRunId);
	if (parent.projectId !== project.id) {
		throw new ValidationError(
			`parent run ${parent.id} belongs to a different project; a continuation must reuse the same project's branch`,
			{ recoveryHint: "re-run with a parentRunId from the same project, or omit it" },
		);
	}
	const defaults = await readProjectDefaults(input.warrenConfigs, project.id, project.localPath);
	const prefix = resolveRunBranchPrefix({
		projectDefault: defaults?.runBranchPrefix,
		envDefault: input.runBranchPrefixDefault,
	});
	return composeRunBranch(prefix, parent.id);
}
