/**
 * Run-workspace git pinning for the local engine (warren-8926, warren-3c1e).
 *
 * Resolves the validated private git scope of a run workspace and registers
 * it as the host-side git pin (see `src/workspace/git/host-git.ts`), with
 * `assertPrivateGitDirIntact` as the pin's per-invocation check. Called at
 * create — before the agent has run, so the scope is computed from warren's
 * own materialization — and again from the on-disk manifest when a restarted
 * server finalizes a run it no longer holds in memory (the validation then
 * re-checks the whole git dir).
 */

import {
	assertPrivateGitDirIntact,
	type PrivateGitScope,
	resolvePrivateGitScope,
	WorkspaceGitScopeError,
} from "../../sandbox/git-scope.ts";
import {
	registerWorkspaceGitPin,
	unregisterWorkspaceGitPin,
	workspaceGitPinFor,
} from "../../workspace/git/host-git.ts";
import type { MaterializedWorkspaceSource } from "../../workspace/materialize.ts";

/**
 * Resolve + register. Only private-git-dir workspaces are accepted: a
 * clone-backed workspace keeps its whole `.git` inside the writable
 * workspace, and a legacy shared worktree (pre-warren-3c1e manifest) exposes
 * the clone's shared refs, so host-side git against either is refused.
 */
export function pinWorkspaceGit(
	workspacePath: string,
	source: MaterializedWorkspaceSource,
	opts: { checkPointer?: boolean } = {},
): PrivateGitScope {
	if (
		source.kind !== "private" ||
		source.gitDir === undefined ||
		source.gitCommonDir === undefined ||
		source.gitConfigSha256 === undefined
	) {
		throw new WorkspaceGitScopeError(
			`git scope: ${workspacePath} is a ${source.kind}-backed workspace; local runs require a private git dir over a host clone`,
			{ recoveryHint: "register the project so its host clone exists before dispatching" },
		);
	}
	const scope = resolvePrivateGitScope({
		workspacePath,
		gitDir: source.gitDir,
		hostGitDir: source.gitCommonDir,
		configSha256: source.gitConfigSha256,
		...(opts.checkPointer !== undefined ? { checkPointer: opts.checkPointer } : {}),
	});
	registerWorkspaceGitPin(workspacePath, {
		gitDir: scope.gitDir,
		commonDir: scope.gitDir,
		verify: () => assertPrivateGitDirIntact(scope),
	});
	return scope;
}

/**
 * Re-pin from the manifest when the in-memory registry lost the workspace.
 * A legacy `worktree` manifest is left unpinned, so host git refuses it.
 */
export function ensureWorkspaceGitPin(
	workspacePath: string,
	source: MaterializedWorkspaceSource | undefined,
): void {
	if (source?.kind !== "private" || workspaceGitPinFor(workspacePath) !== undefined) return;
	pinWorkspaceGit(workspacePath, source, { checkPointer: false });
}

export function unpinWorkspaceGit(workspacePath: string): void {
	unregisterWorkspaceGitPin(workspacePath);
}
