/**
 * Host-side git hardening (warren-8926).
 *
 * Warren runs git on the host — outside any sandbox — against run
 * workspaces (finalize, reap push, salvage) and against project clones
 * (refresh, worktree add/remove). Invariant: host-side git never takes
 * hook or fsmonitor configuration from repository state, and git run
 * against a run workspace never discovers its repository through the
 * workspace's own `.git` file (the run can rewrite that file). Instead the
 * repository is pinned to the admin dir warren validated before the run
 * started.
 *
 *   - Every host-side git gets `-c core.hooksPath=/dev/null
 *     -c core.fsmonitor=false` (command-line config outranks every file).
 *   - A run workspace registered here gets `--git-dir=<git dir>
 *     --work-tree=<workspace>` plus `GIT_COMMON_DIR=<common dir>` in the
 *     environment, so neither the `.git` file nor a `commondir` file decides
 *     which repository (and config) host git uses. For a local run both are
 *     the run's private git dir (warren-3c1e). Until the dir is sealed the
 *     pin's `verify` hook refuses every call; after the seal there is none.
 *   - `requirePin` (reap/finalize) refuses an unregistered linked worktree
 *     — including a subdirectory of one — instead of falling back to
 *     `<cwd>/.git`.
 */

import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { WarrenError } from "../../core/errors.ts";

export const HOST_GIT_CONFIG_ARGS: readonly string[] = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
];

export class UnpinnedWorkspaceGitError extends WarrenError {
	readonly code = "unpinned_workspace_git";
}

export interface WorkspaceGitPin {
	/** Validated git dir (a run's private git dir, warren-3c1e). */
	readonly gitDir: string;
	/** Validated common dir (the git dir itself for a private git dir). */
	readonly commonDir: string;
	/**
	 * Runs before EVERY pinned host git invocation; throws to refuse it
	 * (warren-3c1e: refuses all calls until the run's git dir is sealed).
	 */
	readonly verify?: () => void;
}

const pins = new Map<string, WorkspaceGitPin>();

/** Pin `workspacePath`'s host-side git to the validated git dir. */
export function registerWorkspaceGitPin(workspacePath: string, pin: WorkspaceGitPin): void {
	pins.set(resolve(workspacePath), {
		gitDir: pin.gitDir,
		commonDir: pin.commonDir,
		...(pin.verify !== undefined ? { verify: pin.verify } : {}),
	});
}

export function unregisterWorkspaceGitPin(workspacePath: string): void {
	pins.delete(resolve(workspacePath));
}

export function workspaceGitPinFor(
	cwd: string,
): (WorkspaceGitPin & { readonly workTree: string }) | undefined {
	const abs = resolve(cwd);
	for (const [workTree, pin] of pins) {
		const rel = relative(workTree, abs);
		if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
			return { ...pin, workTree };
		}
	}
	return undefined;
}

/**
 * True when git started in `cwd` would discover its repository through a
 * `.git` FILE (a linked worktree or gitlink): walks up from `cwd` to the
 * first `.git` entry, the way git's own discovery does.
 */
export function isLinkedWorktree(cwd: string): boolean {
	let dir = resolve(cwd);
	for (;;) {
		try {
			return !lstatSync(join(dir, ".git")).isDirectory();
		} catch {
			// no .git here; keep walking
		}
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

/** True when `cmd` names a git binary (`git` or a path ending in `/git`). */
export function isGitCommand(cmd: string): boolean {
	return basename(cmd) === "git";
}

export interface HardenedHostGit {
	/** Full argv after the git binary. */
	readonly args: string[];
	/** Env entries to overlay on the spawn env (empty when unpinned). */
	readonly env: Record<string, string>;
}

/**
 * Prefix host-side git `args` with the hardening flags and, for a registered
 * run workspace, the pinned repository (argv + `GIT_COMMON_DIR`). With
 * `requirePin`, a linked worktree that was never registered is refused rather
 * than discovered via `.git`.
 */
export function hardenHostGit(
	args: readonly string[],
	cwd: string | undefined,
	opts: { requirePin?: boolean } = {},
): HardenedHostGit {
	const out = [...HOST_GIT_CONFIG_ARGS];
	const pin = cwd === undefined ? undefined : workspaceGitPinFor(cwd);
	if (pin !== undefined) {
		pin.verify?.();
		out.push(`--git-dir=${pin.gitDir}`, `--work-tree=${pin.workTree}`, ...args);
		return { args: out, env: { GIT_COMMON_DIR: pin.commonDir } };
	}
	if (opts.requirePin === true && cwd !== undefined && isLinkedWorktree(cwd)) {
		throw new UnpinnedWorkspaceGitError(
			`host git refused: ${cwd} is a worktree with no validated git dir pin`,
			{ recoveryHint: "the run workspace was not registered by the local engine" },
		);
	}
	out.push(...args);
	return { args: out, env: {} };
}
