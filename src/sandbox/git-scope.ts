/**
 * Git-metadata scope for worktree-backed local runs (warren-8926).
 *
 * A worktree workspace carries a `.git` *file* whose `gitdir:` points at
 * `<gitCommonDir>/worktrees/<id>`. The sandbox must expose the common dir so
 * that pointer dereferences (burrow-7a80). The invariant this module defines:
 * a run may write only what committing on its own branch needs; everything
 * the host's own git reads as configuration stays read-only.
 *
 *   - The common dir is exposed READ-ONLY (config, hooks, info/, packed-refs,
 *     HEAD, sibling `worktrees/<other>/`).
 *   - Writable: the run's own `worktrees/<id>/` admin dir (HEAD, index,
 *     per-worktree logs), plus `objects/`, `refs/`, and `logs/` — the shared
 *     stores `git commit` must append to.
 *   - Inside the writable admin dir, the files that bind it to a repository
 *     or carry config (`commondir`, `gitdir`, `config.worktree`) are
 *     re-protected read-only, as is `objects/info/` inside `objects/`.
 *   - The writable roots themselves cannot be renamed or removed.
 *
 * Host-side git never relies on the admin dir's contents to find the
 * repository: it is pinned with `--git-dir`, `--work-tree`, and
 * `GIT_COMMON_DIR` (`src/workspace/git/host-git.ts`).
 *
 * Known limitations, tracked as follow-up (private per-run git metadata):
 *   - `refs/` and `logs/` are shared by every worktree of the clone, so a run
 *     can still move another branch's ref.
 *   - Symlinks created inside the writable carve-outs are not policed.
 *   - With the common-dir root read-only, git cannot create
 *     `<common>/packed-refs.lock`. macOS grants those two literal paths;
 *     Linux bind mounts cannot grant creating one file in a read-only dir, so
 *     there ref updates print a harmless lock error and ref DELETION fails.
 *
 * Every path is validated host-side before use: the `.git` pointer must be a
 * regular file whose gitdir resolves (realpath) to a direct child of
 * `<common>/worktrees/`, the admin dir's `gitdir` backlink must name this
 * workspace, its `commondir` must resolve back to the same common dir, and no
 * granted path may be a symlink.
 */

import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WarrenError } from "../core/errors.ts";

/** Shared common-dir stores a worktree commit writes into. */
export const SHARED_WRITABLE_GIT_DIRS: readonly string[] = ["objects", "refs", "logs"];

/** Admin-dir files re-protected read-only inside the writable admin dir. */
export const PROTECTED_ADMIN_FILES: readonly string[] = ["commondir", "gitdir", "config.worktree"];

export class WorkspaceGitScopeError extends WarrenError {
	readonly code = "workspace_git_scope_invalid";
}

export interface WorkspaceGitScope {
	/** Canonical common dir — exposed read-only. */
	readonly commonDir: string;
	/** Canonical `<common>/worktrees/<id>` admin dir of this workspace. */
	readonly gitDir: string;
	/** Canonical paths under `commonDir` exposed read-write. */
	readonly writable: string[];
	/** Files/dirs inside a writable path that must stay read-only. */
	readonly protectedPaths: string[];
}

function fail(message: string, cause?: unknown): never {
	throw new WorkspaceGitScopeError(`git scope: ${message}`, {
		...(cause !== undefined ? { cause } : {}),
		recoveryHint: "re-materialize the run workspace with `git worktree add` from the host clone",
	});
}

function realDir(path: string, what: string): string {
	let real: string;
	try {
		real = realpathSync(path);
	} catch (err) {
		fail(`${what} ${path} does not exist`, err);
	}
	if (!lstatSync(real).isDirectory()) fail(`${what} ${path} is not a directory`);
	return real;
}

/** Read the `gitdir:` pointer out of the workspace's `.git` file. */
function readGitdirPointer(workspacePath: string): string {
	const dotGit = join(workspacePath, ".git");
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(dotGit);
	} catch (err) {
		fail(`${dotGit} is missing`, err);
	}
	if (!stat.isFile()) fail(`${dotGit} must be a regular gitdir file, not a symlink or directory`);
	const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(dotGit, "utf8"));
	if (match?.[1] === undefined) fail(`${dotGit} carries no gitdir: pointer`);
	return resolve(workspacePath, match[1]);
}

/** Read a small admin-dir file that must be a regular file, not a symlink. */
function readAdminFile(gitDir: string, name: string): string {
	const path = join(gitDir, name);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (err) {
		fail(`${path} is missing`, err);
	}
	if (!stat.isFile()) fail(`${path} must be a regular file`);
	return readFileSync(path, "utf8").trim();
}

/** `<admin>/gitdir` holds the path of the worktree's `.git` file. */
function assertBacklink(gitDir: string, workspacePath: string): void {
	const raw = readAdminFile(gitDir, "gitdir");
	const owner = realDir(dirname(resolve(gitDir, raw)), "worktree backlink");
	if (owner !== realDir(workspacePath, "workspace")) {
		fail(`worktree gitdir ${gitDir} belongs to ${owner}, not ${workspacePath}`);
	}
}

function ensureProtectedFiles(gitDir: string): string[] {
	const out: string[] = [];
	for (const name of PROTECTED_ADMIN_FILES) {
		const path = join(gitDir, name);
		// config.worktree may not exist yet; an empty file is inert to git and
		// gives the read-only bind something to protect.
		if (name === "config.worktree") {
			try {
				lstatSync(path);
			} catch {
				writeFileSync(path, "");
			}
		}
		readAdminFile(gitDir, name);
		out.push(path);
	}
	return out;
}

/**
 * Resolve and validate the Git metadata a worktree-backed run may touch.
 * Throws `WorkspaceGitScopeError` on any pointer that escapes the clone's
 * common dir. Creates `<common>/logs` when absent so the read-only parent
 * never blocks the first reflog write.
 */
export function resolveWorkspaceGitScope(
	workspacePath: string,
	gitCommonDir: string,
): WorkspaceGitScope {
	const commonDir = realDir(gitCommonDir, "git common dir");
	const worktreesDir = join(commonDir, "worktrees");

	const gitDir = realDir(readGitdirPointer(workspacePath), "worktree gitdir");
	if (dirname(gitDir) !== worktreesDir) {
		fail(`worktree gitdir ${gitDir} is not a direct child of ${worktreesDir}`);
	}
	// The admin dir must point back at THIS workspace — a pointer at another
	// worktree's admin dir (directly or via a symlinked entry) is rejected.
	assertBacklink(gitDir, workspacePath);

	const commondirRaw = readAdminFile(gitDir, "commondir");
	if (realDir(resolve(gitDir, commondirRaw), "worktree commondir") !== commonDir) {
		fail(`worktree gitdir ${gitDir} points at a different common dir`);
	}

	const writable = [gitDir];
	for (const name of SHARED_WRITABLE_GIT_DIRS) {
		const path = join(commonDir, name);
		mkdirSync(path, { recursive: true });
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			fail(`${path} must be a real directory, not a symlink`);
		}
		writable.push(path);
	}
	const protectedPaths = ensureProtectedFiles(gitDir);
	// objects/info carries repository-wide pointers (alternates) that the
	// host's git follows; keep it read-only inside the writable objects/.
	const objectsInfo = join(commonDir, "objects", "info");
	mkdirSync(objectsInfo, { recursive: true });
	const infoStat = lstatSync(objectsInfo);
	if (!infoStat.isDirectory() || infoStat.isSymbolicLink()) {
		fail(`${objectsInfo} must be a real directory, not a symlink`);
	}
	protectedPaths.push(objectsInfo);
	return { commonDir, gitDir, writable, protectedPaths };
}
