/**
 * Run-workspace git pinning for the local engine (warren-8926).
 *
 * Resolves the validated git scope of a worktree-backed workspace and
 * registers its admin dir as the host-side git pin (see
 * `src/workspace/git/host-git.ts`). Called at create — before the agent has
 * run, so the scope is computed from warren's own materialization — and
 * again from the on-disk manifest when a restarted server finalizes a run
 * it no longer holds in memory (the validation then re-checks every link).
 */

import {
	resolveWorkspaceGitScope,
	type WorkspaceGitScope,
	WorkspaceGitScopeError,
} from "../../sandbox/git-scope.ts";
import {
	registerWorkspaceGitPin,
	unregisterWorkspaceGitPin,
	workspaceGitPinFor,
} from "../../workspace/git/host-git.ts";
import type { MaterializedWorkspaceSource } from "../../workspace/materialize.ts";

/**
 * Resolve + register. Only worktree-backed workspaces are accepted: a
 * clone-backed workspace keeps its whole `.git` inside the writable
 * workspace, so host-side git against it could not be pinned to anything
 * the run cannot rewrite. The local and docker backends refuse it.
 */
export function pinWorkspaceGit(
	workspacePath: string,
	source: MaterializedWorkspaceSource,
): WorkspaceGitScope {
	if (source.kind !== "worktree" || source.gitCommonDir === undefined) {
		throw new WorkspaceGitScopeError(
			`git scope: ${workspacePath} is a ${source.kind}-backed workspace; local runs require a worktree of a host clone`,
			{ recoveryHint: "register the project so its host clone exists before dispatching" },
		);
	}
	const scope = resolveWorkspaceGitScope(workspacePath, source.gitCommonDir);
	registerWorkspaceGitPin(workspacePath, { gitDir: scope.gitDir, commonDir: scope.commonDir });
	return scope;
}

/** Re-pin from the manifest when the in-memory registry lost the workspace. */
export function ensureWorkspaceGitPin(
	workspacePath: string,
	source: MaterializedWorkspaceSource | undefined,
): void {
	if (source?.kind !== "worktree" || workspaceGitPinFor(workspacePath) !== undefined) return;
	pinWorkspaceGit(workspacePath, source);
}

export function unpinWorkspaceGit(workspacePath: string): void {
	unregisterWorkspaceGitPin(workspacePath);
}
