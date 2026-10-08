/**
 * Git-metadata scope for local runs (warren-8926, warren-3c1e).
 *
 * Each local run owns a PRIVATE git dir (`src/workspace/git/private-gitdir.ts`)
 * that shares only the host clone's object store, read-only, through
 * `objects/info/alternates`. The trust boundary this module defines:
 *
 *   - Inside the sandbox the run may write its private git dir: refs,
 *     packed-refs (and its lock), logs, HEAD, index, and its own objects.
 *     Ref updates and deletions therefore behave the same on Linux bwrap
 *     and macOS Seatbelt.
 *   - Two warren-written files stay read-only inside it: `config` (host-side
 *     git reads it) and `objects/info/alternates` (host-side git follows it).
 *   - The host clone's `objects/` is readable, never writable. The rest of
 *     the host clone's git dir (config, hooks, refs, packed-refs, logs,
 *     sibling metadata) is not exposed at all: bwrap and docker never mount
 *     it, and Seatbelt denies it.
 *
 * Host-side git (finalize, reap push, salvage) never runs while the agent
 * can still write the dir. Once the agent has exited, the local engine
 * SEALS the dir: it stops every agent process, moves the dir where no
 * sandbox grant reaches, and checks it once (`./git-seal.ts`). Only then
 * is host git pinned to it with `--git-dir`/`--work-tree`/`GIT_COMMON_DIR`
 * (`src/workspace/git/host-git.ts`). That host-side content check is the
 * boundary, including for `objects/info/alternates`; the sandbox
 * protections (read-only binds, Seatbelt denies) are defense in depth.
 *
 * `assertPrivateGitDirIntact` below is the create-time form of the same
 * rules, run once on the fresh dir before the agent starts.
 *
 * The run cannot touch any ref another run or base-branch resolution reads:
 * the host clone's refs are not mounted, and every run's refs are its own.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { WarrenError } from "../core/errors.ts";

/** Private-dir files re-protected read-only inside the writable git dir. */
export const PRIVATE_GIT_PROTECTED: readonly string[] = ["config", "objects/info/alternates"];

export class WorkspaceGitScopeError extends WarrenError {
	readonly code = "workspace_git_scope_invalid";
}

export interface PrivateGitScope {
	/** Canonical per-run private git dir, read-write in the sandbox. */
	readonly gitDir: string;
	/** Canonical host clone common dir; never exposed except `sharedObjects`. */
	readonly hostGitDir: string;
	/** `<hostGitDir>/objects`, read-only in the sandbox (the alternate). */
	readonly sharedObjects: string;
	/** Absolute paths inside `gitDir` kept read-only in the sandbox. */
	readonly protectedPaths: string[];
	/** sha256 of the warren-written `config`. */
	readonly configSha256: string;
}

export interface ResolvePrivateGitScopeInput {
	readonly workspacePath: string;
	readonly gitDir: string;
	readonly hostGitDir: string;
	readonly configSha256: string;
	/**
	 * Check the workspace `.git` pointer (default true). Only meaningful
	 * before the agent runs: host-side git never reads `.git`, so a re-pin
	 * after a restart skips it rather than failing on a run-rewritten file.
	 */
	readonly checkPointer?: boolean;
}

function fail(message: string, cause?: unknown): never {
	throw new WorkspaceGitScopeError(`git scope: ${message}`, {
		...(cause !== undefined ? { cause } : {}),
		recoveryHint:
			"the run's private git dir is not in the shape warren materialized; " +
			"salvage the workspace by hand and re-dispatch",
	});
}

/** `path` must be a real directory whose canonical path is `path` itself. */
function assertCanonicalDir(path: string, what: string): void {
	let stat: ReturnType<typeof lstatSync>;
	let real: string;
	try {
		stat = lstatSync(path);
		real = realpathSync(path);
	} catch (err) {
		fail(`${what} ${path} does not exist`, err);
	}
	if (!stat.isDirectory()) fail(`${what} ${path} must be a real directory, not a symlink`);
	if (real !== path) fail(`${what} ${path} resolves to ${real}`);
}

function readRegularFile(path: string): Buffer {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (err) {
		fail(`${path} is missing`, err);
	}
	if (!stat.isFile()) fail(`${path} must be a regular file`);
	return readFileSync(path);
}

/** The workspace `.git` must be a regular file pointing at exactly `gitDir`. */
function assertGitdirPointer(workspacePath: string, gitDir: string): void {
	const body = readRegularFile(join(workspacePath, ".git")).toString("utf8");
	const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(body);
	if (match?.[1] !== gitDir) fail(`${workspacePath}/.git does not point at ${gitDir}`);
}

/**
 * Walk the git dir without following anything: every entry must be a real
 * directory or a regular file with a single link.
 */
function assertNoLinks(dir: string): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const stat = lstatSync(path);
		if (stat.isDirectory()) {
			assertNoLinks(path);
			continue;
		}
		if (stat.isSymbolicLink()) fail(`${path} is a symlink`);
		if (!stat.isFile()) fail(`${path} is not a regular file`);
		if (stat.nlink !== 1) fail(`${path} is hard-linked (${stat.nlink} links)`);
	}
}

/**
 * Create-time check of a fresh private git dir. Throws
 * `WorkspaceGitScopeError` on any deviation. The post-run check is
 * `sealCheckPrivateGitDir` (`./git-seal.ts`).
 */
export function assertPrivateGitDirIntact(scope: PrivateGitScope): void {
	assertCanonicalDir(scope.gitDir, "private git dir");
	assertNoLinks(scope.gitDir);
	const digest = createHash("sha256")
		.update(readRegularFile(join(scope.gitDir, "config")))
		.digest("hex");
	if (digest !== scope.configSha256) fail(`${scope.gitDir}/config changed since materialization`);
	const alternates = readRegularFile(join(scope.gitDir, "objects", "info", "alternates"));
	if (alternates.toString("utf8") !== `${scope.sharedObjects}\n`) {
		fail(`${scope.gitDir}/objects/info/alternates changed since materialization`);
	}
	try {
		lstatSync(join(scope.gitDir, "commondir"));
	} catch {
		return;
	}
	fail(`${scope.gitDir}/commondir must not exist`);
}

/**
 * Resolve and validate a run's private git scope at create, before the
 * agent runs: the fresh dir is a handful of files, so a full walk is cheap.
 */
export function resolvePrivateGitScope(input: ResolvePrivateGitScopeInput): PrivateGitScope {
	const scope = privateGitScopeFor(input);
	if (input.checkPointer !== false) assertGitdirPointer(input.workspacePath, input.gitDir);
	assertPrivateGitDirIntact(scope);
	return scope;
}

/** Build a scope after checking only the host dirs (no walk of `gitDir`). */
export function privateGitScopeFor(
	input: Omit<ResolvePrivateGitScopeInput, "workspacePath" | "checkPointer">,
): PrivateGitScope {
	assertCanonicalDir(input.hostGitDir, "host git dir");
	const sharedObjects = join(input.hostGitDir, "objects");
	assertCanonicalDir(sharedObjects, "host object store");
	return {
		gitDir: input.gitDir,
		hostGitDir: input.hostGitDir,
		sharedObjects,
		protectedPaths: PRIVATE_GIT_PROTECTED.map((rel) => join(input.gitDir, rel)),
		configSha256: input.configSha256,
	};
}

export { assertCanonicalDir, fail as failGitScope };
