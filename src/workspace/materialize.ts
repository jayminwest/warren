/**
 * Workspace materialization (k8s-migration §5.A).
 *
 * The single source of truth for the K8s init container's workspace prep, and
 * neutral enough to serve the Local path too. Two strategies:
 *   - Project workspace → `git worktree add <ws> <branch>` against a host clone.
 *     Falls back to `git clone <originUrl>` when no host clone is available
 *     (e.g. materializing from a bare git URL outside any repo).
 *   - Task workspace    → `git worktree add -b <taskBranch> <ws> <baseBranch>`
 *     against the parent's host clone. O(1) — no copy.
 *
 * The `materializeProjectWorkspace` / `materializeTaskWorkspace` entry points
 * own the create + cleanup cycle so callers only handle the result handle.
 * The accompanying `removeMaterializedWorkspace` reverses whichever path was
 * taken; the result is recorded in `MaterializedWorkspace.source` so the
 * caller doesn't have to re-derive it.
 *
 * Extracted from burrow's `src/provider/local/workspace.ts` (k8s-migration
 * §5.A). Behavior is identical to burrow's; only two changes were made:
 *   1. The burrow-only `extractWorkspaceSource` helper — the sole function
 *      pulling burrow's Drizzle DB schema (`Burrow`) in — was dropped so this
 *      cluster has zero DB coupling (design correction: the extracted cluster
 *      must be DB-free).
 *   2. Burrow-prefixed identity symbols were renamed to neutral workspace names
 *      (`resolveWorkspaceIdentity` / `writeWorkspaceGitconfig`).
 * Per design correction C1, `MaterializedWorkspaceSource` lives here (not in a
 * provider types file).
 *
 * NOTE: intentionally unimported by the domain until a later migration step
 * wires the workspace materializer; the co-located tests keep knip satisfied.
 */

import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { WorkspaceMaterializationError } from "./errors.ts";
import { runGit } from "./git/exec.ts";
import {
	type GitIdentity,
	type IdentitySpec,
	resolveWorkspaceIdentity,
	writeWorkspaceGitconfig,
} from "./git/identity.ts";
import {
	addWorktree,
	addWorktreeDetached,
	cloneRepo,
	deleteBranch,
	discoverHostClone,
	type HostClone,
	pruneWorktrees,
	removeWorktree,
} from "./git/worktree.ts";

export type WorkspaceSourceKind = "worktree" | "clone";

export interface MaterializedWorkspaceSource {
	kind: WorkspaceSourceKind;
	/** Branch checked out in the workspace. */
	branch: string;
	/**
	 * warren-326f: false when the branch was checked out rather than carved
	 * (existing-branch dispatch); remove then keeps the branch ref.
	 */
	carvedBranch?: boolean;
	/** Host clone the worktree was added against. Absent when `kind === 'clone'`. */
	hostClonePath?: string;
	/**
	 * Absolute host path of the parent clone's `.git` common dir (the directory
	 * shared by every worktree of the same clone). Set when `kind === 'worktree'`.
	 *
	 * `git worktree add` writes the worktree's `.git` *file* with an absolute
	 * `gitdir:` pointer at `<gitCommonDir>/worktrees/<id>`; the sandbox bind
	 * for `/workspace` does not cover that path, so without an explicit
	 * mount of `gitCommonDir` every git invocation inside the sandbox fails
	 * with `fatal: not a git repository` (burrow-7a80). The sandbox profile
	 * builders mount this read-write at the same host path so the pointer
	 * dereferences and `git commit`/`git push` can write per-worktree HEAD,
	 * index, and shared objects.
	 */
	gitCommonDir?: string;
	/** Origin URL used for fresh clones. Absent for worktrees. */
	originUrl?: string;
}

export interface MaterializedWorkspace {
	workspacePath: string;
	source: MaterializedWorkspaceSource;
	identity: GitIdentity | null;
}

export interface MaterializeProjectOptions {
	/** Where to create the worktree / clone. Parent dir is created if missing. */
	workspacePath: string;
	/**
	 * Branch the workspace checks out. When `createBranch` is true this is the
	 * fresh branch name (typically per-run, e.g. `<prefix>/<id>`); when
	 * false, an existing branch that is not already checked out elsewhere.
	 */
	branch: string;
	/**
	 * When true (default), `branch` is created off `baseBranch`. When false,
	 * `branch` must already exist and not be checked out by another worktree.
	 * Project workspaces default to carving a per-run branch — git refuses to
	 * add two worktrees on the same branch, so a project that's currently
	 * checked out at `main` can't be re-used directly.
	 */
	/**
	 * When false (default true), `branch` must already exist and not be checked
	 * out by another worktree.
	 */
	createBranch?: boolean;
	/**
	 * warren-326f: when true, the workspace checks out the EXISTING `branch`
	 * detached (`git worktree add --detach <ws> <branch>`). An existing-branch
	 * dispatch cannot carve (`-b` fails: the branch exists) and cannot do a
	 * plain checkout (the host clone's HEAD sits on the same branch after the
	 * refresh). Finalize still pushes `HEAD:<branch>`, so the detached
	 * workspace's commits land on the branch. Implies `createBranch: false`.
	 */
	detached?: boolean;
	/**
	 * Base ref the per-run branch is carved from (warren-232d: no default —
	 * thread the project's actual default branch; a master-default repo must
	 * not silently cut off 'main'). Required when `createBranch` is true.
	 */
	baseBranch?: string;
	/**
	 * warren-326f: recorded on the source when the branch was NOT carved by
	 * materialization (existing-branch dispatch). Teardown must not delete the
	 * branch — it predates the run and lives on the remote. Absent/true keeps
	 * the delete-on-remove behavior of a freshly carved per-run branch.
	 */
	carvedBranch?: boolean;
	/** Path to start probing for an existing host clone (typically projectRoot). */
	projectRoot?: string;
	/** Explicit clone fallback (when no host clone is found). */
	originUrl?: string;
	identity?: IdentitySpec;
	/** Override host env (testing). */
	hostEnv?: Record<string, string | undefined>;
}

export async function materializeProjectWorkspace(
	options: MaterializeProjectOptions,
): Promise<MaterializedWorkspace> {
	await ensureParentDir(options.workspacePath);

	const hostClone = options.projectRoot ? await discoverHostClone(options.projectRoot) : null;

	const source = hostClone
		? await materializeViaWorktree(hostClone, options)
		: await materializeViaClone(options);

	const identity = await applyIdentity(options.workspacePath, options.identity, options.hostEnv);

	return { workspacePath: options.workspacePath, source, identity };
}

export interface MaterializeTaskOptions {
	workspacePath: string;
	/** Path to the parent's host clone — required (task workspaces fork). */
	parentClonePath: string;
	/** Branch carved by the fork, e.g. `task/<id>`. */
	taskBranch: string;
	/** Branch the new task branch is created from. */
	baseBranch: string;
	identity?: IdentitySpec;
	hostEnv?: Record<string, string | undefined>;
}

export async function materializeTaskWorkspace(
	options: MaterializeTaskOptions,
): Promise<MaterializedWorkspace> {
	await ensureParentDir(options.workspacePath);

	try {
		await addWorktree({
			hostClonePath: options.parentClonePath,
			workspacePath: options.workspacePath,
			branch: options.taskBranch,
			createBranch: true,
			baseBranch: options.baseBranch,
		});
	} catch (err) {
		throw wrapMaterializationError(
			`failed to fork task workspace into ${options.workspacePath}`,
			err,
		);
	}

	const identity = await applyIdentity(options.workspacePath, options.identity, options.hostEnv);
	const gitCommonDir = await discoverGitCommonDir(options.parentClonePath);

	const source: MaterializedWorkspaceSource = {
		kind: "worktree",
		branch: options.taskBranch,
		hostClonePath: options.parentClonePath,
	};
	if (gitCommonDir) source.gitCommonDir = gitCommonDir;
	return {
		workspacePath: options.workspacePath,
		source,
		identity,
	};
}

export interface RemoveWorkspaceOptions {
	workspacePath: string;
	source: MaterializedWorkspaceSource;
	force?: boolean;
}

export async function removeMaterializedWorkspace(opts: RemoveWorkspaceOptions): Promise<void> {
	if (opts.source.kind === "worktree") {
		const hostClonePath = opts.source.hostClonePath;
		if (!hostClonePath) {
			throw new WorkspaceMaterializationError(
				"cannot remove worktree: source.hostClonePath is missing",
			);
		}
		try {
			// Force is the right default: the workspace is always carrying
			// untracked files we put there ourselves (.gitconfig.burrow) plus
			// whatever the agent created. Callers can opt out by passing
			// `force: false` explicitly.
			await removeWorktree({
				hostClonePath,
				workspacePath: opts.workspacePath,
				force: opts.force ?? true,
			});
		} catch (err) {
			// Pruning rescues the case where the workspace dir was deleted out from
			// under git (rm -rf during a crash); the porcelain entry lingers until
			// pruned. We re-throw if the original error wasn't a stale-record one.
			await pruneWorktrees(hostClonePath).catch(() => {});
			await rm(opts.workspacePath, { recursive: true, force: true });
			if (!isStaleWorktreeError(err)) throw err;
		}
		// warren-326f: the branch was checked out, not carved — leave the ref
		// (it lives on the remote; deleting it would orphan follow-up runs).
		if (opts.source.carvedBranch !== false) {
			await deleteBranch({ hostClonePath, branch: opts.source.branch, force: true }).catch(
				() => {},
			);
		}
		return;
	}
	await rm(opts.workspacePath, { recursive: true, force: true });
}

async function materializeViaWorktree(
	hostClone: HostClone,
	options: MaterializeProjectOptions,
): Promise<MaterializedWorkspaceSource> {
	const createBranch = options.createBranch ?? true;
	if (createBranch && options.baseBranch === undefined) {
		// warren-232d: no hard-coded 'main' fallback — a master/develop-default
		// repo must cut its run branch off the project's actual default branch,
		// which the caller (the providers) threads from the project row.
		throw new WorkspaceMaterializationError(
			"materializeProjectWorkspace: baseBranch is required when createBranch is true",
			{
				recoveryHint:
					"Thread the project's default branch (RunSpec.baseBranch) so the run " +
					"branch is carved off the right base; never assume 'main'.",
			},
		);
	}
	try {
		if (options.detached === true) {
			await addWorktreeDetached({
				hostClonePath: hostClone.topLevel,
				workspacePath: options.workspacePath,
				ref: options.branch,
			});
		} else {
			await addWorktree({
				hostClonePath: hostClone.topLevel,
				workspacePath: options.workspacePath,
				branch: options.branch,
				createBranch,
				...(createBranch && options.baseBranch ? { baseBranch: options.baseBranch } : {}),
			});
		}
	} catch (err) {
		throw wrapMaterializationError(`failed to add worktree at ${options.workspacePath}`, err);
	}
	const source: MaterializedWorkspaceSource = {
		kind: "worktree",
		branch: options.branch,
		hostClonePath: hostClone.topLevel,
		gitCommonDir: canonicalize(hostClone.gitCommonDir),
	};
	if (options.detached === true) source.carvedBranch = false;
	return source;
}

async function materializeViaClone(
	options: MaterializeProjectOptions,
): Promise<MaterializedWorkspaceSource> {
	if (!options.originUrl) {
		throw new WorkspaceMaterializationError("no host clone detected and no originUrl provided", {
			recoveryHint:
				"Materialize inside an existing git clone, or pass an originUrl so the workspace can clone fresh.",
		});
	}
	try {
		await cloneRepo({
			originUrl: options.originUrl,
			targetPath: options.workspacePath,
			branch: options.branch,
		});
	} catch (err) {
		throw wrapMaterializationError(
			`failed to clone ${options.originUrl} into ${options.workspacePath}`,
			err,
		);
	}
	return {
		kind: "clone",
		branch: options.branch,
		originUrl: options.originUrl,
	};
}

async function applyIdentity(
	workspacePath: string,
	spec: IdentitySpec | undefined,
	hostEnv: Record<string, string | undefined> | undefined,
): Promise<GitIdentity | null> {
	const target: IdentitySpec = spec ?? { mode: "user" };
	const resolved = await resolveWorkspaceIdentity(target, hostEnv ? { hostEnv } : {});
	if (!resolved) return null;
	await writeWorkspaceGitconfig(workspacePath, resolved);
	return resolved;
}

async function ensureParentDir(workspacePath: string): Promise<void> {
	await mkdir(dirname(workspacePath), { recursive: true });
}

function wrapMaterializationError(prefix: string, err: unknown): WorkspaceMaterializationError {
	if (err instanceof WorkspaceMaterializationError) {
		return new WorkspaceMaterializationError(`${prefix}: ${err.message}`, {
			cause: err,
			...(err.recoveryHint ? { recoveryHint: err.recoveryHint } : {}),
		});
	}
	const message = err instanceof Error ? err.message : String(err);
	return new WorkspaceMaterializationError(`${prefix}: ${message}`, { cause: err });
}

function isStaleWorktreeError(err: unknown): boolean {
	if (err instanceof Error) return /not a working tree|does not exist/i.test(err.message);
	return false;
}

/**
 * Resolve `<clone>/.git` for a host clone, following the same rules as
 * `discoverHostClone`: `git rev-parse --git-common-dir` returns an absolute
 * path most of the time, "." when the clone is at its top-level, and
 * occasionally a path relative to `cwd`.
 *
 * Falls back to `null` on any git failure — callers (currently only
 * `materializeTaskWorkspace`) treat the absence as "no gitdir mount needed",
 * which is the right thing for clone-backed parents that don't have a
 * worktree pointer to dereference inside the sandbox.
 */
async function discoverGitCommonDir(clonePath: string): Promise<string | null> {
	const res = await runGit(["rev-parse", "--git-common-dir"], { cwd: clonePath });
	if (res.exitCode !== 0) return null;
	const raw = res.stdout.trim();
	if (raw.length === 0) return null;
	const joined = raw.startsWith("/")
		? raw
		: raw === "." || raw === "./"
			? `${clonePath.replace(/\/$/, "")}/.git`
			: `${clonePath.replace(/\/$/, "")}/${raw}`;
	return canonicalize(joined);
}

/**
 * Resolve symlinks in `path`, falling back to the input when the path doesn't
 * exist on disk. We canonicalize gitCommonDir specifically because:
 *   1. `git worktree add` writes the worktree's `.git` file with a `gitdir:`
 *      pointer that git itself resolved through any symlinks on the way in.
 *      The bind mount has to use that same resolved path or the pointer
 *      dangles inside the sandbox.
 *   2. macOS Seatbelt (sandbox-exec) matches against canonical paths only —
 *      `/var/folders/...` vs `/private/var/folders/...` etc.
 */
function canonicalize(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
