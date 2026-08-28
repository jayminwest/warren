/**
 * git worktree helpers (k8s-migration §5.A).
 *
 * Project workspaces materialize as `git worktree add <ws> <branch>` against an
 * existing host clone — fast (no copy), shared `.git/`, supports many
 * workspaces per clone. Fresh dispatches fork the same way against the parent
 * clone but carve a fresh `<prefix>/<id>` branch on the way in.
 *
 * These wrappers are intentionally thin: each function shells out to git and
 * returns parsed structured data. Higher-level orchestration (when to fall
 * back to `git clone`, how to name the workspace dir) lives in the workspace
 * materialization layer wired up later in the migration.
 *
 * Extracted verbatim from burrow's `src/git/worktree.ts` (k8s-migration §5.A);
 * both repos are Bun, so `Bun.spawn` (via `./exec.ts`) transplants as-is. The
 * only warren-native change is the error convention: `runGitOrThrow` raises
 * warren's `WorkspaceMaterializationError` (see `../errors.ts`).
 *
 * NOTE: intentionally unimported by the domain until a later migration step
 * wires the workspace materializer; the co-located tests keep knip satisfied.
 */

import { runGit, runGitOrThrow } from "./exec.ts";

export interface HostClone {
	/** Absolute path of the top-level work tree, normalized through git. */
	topLevel: string;
	/** Absolute path of the common `.git/` dir (shared by every worktree). */
	gitCommonDir: string;
}

/**
 * Probe `startPath` for an existing git clone. Returns null when the path is
 * not inside a repository (e.g. the caller materializes from a bare git URL in
 * `/tmp`), so callers can fall back to `git clone`.
 */
export async function discoverHostClone(startPath: string): Promise<HostClone | null> {
	const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: startPath });
	if (top.exitCode !== 0) return null;
	const common = await runGit(["rev-parse", "--git-common-dir"], { cwd: startPath });
	if (common.exitCode !== 0) return null;
	return {
		topLevel: top.stdout.trim(),
		gitCommonDir: resolveCommonDir(startPath, common.stdout.trim()),
	};
}

export interface WorktreeEntry {
	worktree: string;
	head?: string;
	branch?: string;
	bare: boolean;
	detached: boolean;
}

/** Parse `git worktree list --porcelain` output into structured entries. */
export async function listWorktrees(hostClonePath: string): Promise<WorktreeEntry[]> {
	const res = await runGitOrThrow(["worktree", "list", "--porcelain"], { cwd: hostClonePath });
	return parsePorcelain(res.stdout);
}

export interface AddWorktreeOptions {
	hostClonePath: string;
	workspacePath: string;
	branch: string;
	/** When true, create `branch` (passed via `-b`); otherwise check out existing. */
	createBranch?: boolean;
	/** Base ref for `--b`; defaults to HEAD when `createBranch` is true. */
	baseBranch?: string;
}

export async function addWorktree(opts: AddWorktreeOptions): Promise<void> {
	const args = ["worktree", "add"];
	if (opts.createBranch) {
		args.push("-b", opts.branch, opts.workspacePath);
		if (opts.baseBranch) args.push(opts.baseBranch);
	} else {
		args.push(opts.workspacePath, opts.branch);
	}
	await runGitOrThrow(args, { cwd: opts.hostClonePath });
}

/**
 * warren-326f: check out an EXISTING ref detached (`git worktree add --detach
 * <ws> <ref>`). Existing-branch dispatches cannot use `addWorktree`: `-b` fails
 * on a branch that already exists, and a non-detached checkout refuses when the
 * host clone's HEAD sits on the same branch. The workspace still commits onto
 * the ref — finalize pushes `HEAD:<branch>` from the detached HEAD.
 */
export async function addWorktreeDetached(opts: {
	hostClonePath: string;
	workspacePath: string;
	ref: string;
}): Promise<void> {
	await runGitOrThrow(["worktree", "add", "--detach", opts.workspacePath, opts.ref], {
		cwd: opts.hostClonePath,
	});
}

export interface RemoveWorktreeOptions {
	hostClonePath: string;
	workspacePath: string;
	force?: boolean;
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
	const args = ["worktree", "remove"];
	if (opts.force) args.push("--force");
	args.push(opts.workspacePath);
	await runGitOrThrow(args, { cwd: opts.hostClonePath });
}

export async function pruneWorktrees(hostClonePath: string): Promise<void> {
	await runGitOrThrow(["worktree", "prune"], { cwd: hostClonePath });
}

export interface DeleteBranchOptions {
	hostClonePath: string;
	branch: string;
	/** Default true: `-D` discards unmerged commits. `false` uses `-d`, which refuses unmerged history. */
	force?: boolean;
}

/**
 * Drop a local branch ref. `git worktree remove` only tears down the work
 * tree; the branch lingers until something deletes it. Workspaces carve a
 * fresh `<prefix>/<id>` branch per checkout, so teardown follows up with this
 * to keep `git branch` from accumulating dead refs.
 */
export async function deleteBranch(opts: DeleteBranchOptions): Promise<void> {
	const flag = opts.force === false ? "-d" : "-D";
	await runGitOrThrow(["branch", flag, opts.branch], { cwd: opts.hostClonePath });
}

export async function branchExists(hostClonePath: string, branch: string): Promise<boolean> {
	const res = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
		cwd: hostClonePath,
	});
	return res.exitCode === 0;
}

export interface CloneOptions {
	originUrl: string;
	targetPath: string;
	branch?: string;
	depth?: number;
}

export async function cloneRepo(opts: CloneOptions): Promise<void> {
	const args = ["clone"];
	if (opts.branch) args.push("--branch", opts.branch);
	if (opts.depth !== undefined) args.push("--depth", String(opts.depth));
	args.push(opts.originUrl, opts.targetPath);
	await runGitOrThrow(args);
}

export interface InitRepoOptions {
	targetPath: string;
	initialBranch?: string;
}

export async function initRepo(opts: InitRepoOptions): Promise<void> {
	const args = ["init"];
	if (opts.initialBranch) args.push("-b", opts.initialBranch);
	args.push(opts.targetPath);
	await runGitOrThrow(args);
}

/**
 * `git rev-parse --git-common-dir` returns "." when invoked at the top of a
 * non-worktree clone; resolve it against `cwd` so callers always receive an
 * absolute path.
 */
function resolveCommonDir(cwd: string, raw: string): string {
	if (raw.startsWith("/")) return raw;
	if (raw === "." || raw === "./") return `${cwd.replace(/\/$/, "")}/.git`;
	return `${cwd.replace(/\/$/, "")}/${raw}`;
}

function parsePorcelain(output: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: Partial<WorktreeEntry> | null = null;

	const flush = (): void => {
		if (current?.worktree) {
			entries.push({
				worktree: current.worktree,
				head: current.head,
				branch: current.branch,
				bare: current.bare ?? false,
				detached: current.detached ?? false,
			});
		}
		current = null;
	};

	for (const line of output.split("\n")) {
		if (line.length === 0) {
			flush();
			continue;
		}
		current ??= { bare: false, detached: false };
		if (line.startsWith("worktree ")) current.worktree = line.slice("worktree ".length);
		else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
		else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length);
		else if (line === "bare") current.bare = true;
		else if (line === "detached") current.detached = true;
	}
	flush();
	return entries;
}
