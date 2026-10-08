/**
 * Post-run check of a SEALED private git dir (warren-3c1e).
 *
 * The local engine seals a run's private git dir once the agent has exited:
 * every agent process is stopped and the dir is moved where no sandbox grant
 * reaches (`src/runtime/local/git-pin.ts`). Nothing can change it after
 * that except warren itself, so it is checked ONCE, here, and never
 * re-walked before later host git calls.
 *
 * The check sanitizes rather than refuses wherever that loses no work:
 *
 *   - a symlink is unlinked (git never creates one in its own dir, and a
 *     benign `ln -s` in `hooks/` must not cost the run its push),
 *   - a FIFO, socket, or device node is unlinked,
 *   - a hard-linked regular file is copied to a fresh inode, so host git
 *     can never append through it to a file outside the dir.
 *
 * It refuses (throws `WorkspaceGitScopeError`) only when host git would
 * otherwise read state the run controls:
 *
 *   - `config` or `objects/info/alternates` differ from what warren wrote,
 *   - a `commondir` file exists (it would redirect git to another repo),
 *   - the dir is not a real, canonical directory,
 *   - the walk exceeds its entry or depth cap (fail closed).
 *
 * A transient ENOENT during the walk restarts it, up to `retries` times.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertCanonicalDir, failGitScope, type PrivateGitScope } from "./git-scope.ts";

export interface SealCheckLimits {
	readonly maxEntries: number;
	readonly maxDepth: number;
	readonly retries: number;
}

export const DEFAULT_SEAL_LIMITS: SealCheckLimits = {
	maxEntries: 1_000_000,
	maxDepth: 64,
	retries: 3,
};

export interface SealCheckReport {
	/** Entries visited on the successful walk. */
	readonly entries: number;
	/** Paths whose symlink, special file, or hard link was removed or broken. */
	readonly sanitized: readonly string[];
}

class WalkRaced extends Error {}

function isEnoent(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Copy `path` to a fresh inode and rename it into place. */
async function breakHardLink(path: string, mode: number): Promise<void> {
	const tmp = `${path}.warren-seal-${process.pid}`;
	await writeFile(tmp, await readFile(path), { mode: mode & 0o777, flag: "wx" });
	await rename(tmp, path);
}

interface WalkState {
	entries: number;
	readonly sanitized: string[];
	readonly limits: SealCheckLimits;
}

async function sanitizeEntry(path: string, state: WalkState): Promise<void> {
	const stat = await lstat(path);
	if (stat.isDirectory()) return;
	if (stat.isSymbolicLink() || !stat.isFile()) {
		await unlink(path);
		state.sanitized.push(path);
		return;
	}
	if (stat.nlink !== 1) {
		await breakHardLink(path, stat.mode);
		state.sanitized.push(path);
	}
}

async function walk(dir: string, depth: number, state: WalkState): Promise<void> {
	if (depth > state.limits.maxDepth) {
		failGitScope(`${dir} is nested deeper than ${state.limits.maxDepth} levels`);
	}
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) throw new WalkRaced();
		throw err;
	}
	for (const entry of entries) {
		state.entries += 1;
		if (state.entries > state.limits.maxEntries) {
			failGitScope(`private git dir holds more than ${state.limits.maxEntries} entries`);
		}
		const path = join(dir, entry.name);
		try {
			if (entry.isDirectory()) {
				await walk(path, depth + 1, state);
			} else {
				await sanitizeEntry(path, state);
			}
		} catch (err) {
			if (isEnoent(err)) throw new WalkRaced();
			throw err;
		}
	}
}

async function readRegular(path: string): Promise<Buffer> {
	let isFile = false;
	try {
		isFile = (await lstat(path)).isFile();
	} catch (err) {
		failGitScope(`${path} is missing`, err);
	}
	if (!isFile) failGitScope(`${path} must be a regular file`);
	return readFile(path);
}

async function assertWarrenFiles(scope: PrivateGitScope): Promise<void> {
	const config = await readRegular(join(scope.gitDir, "config"));
	if (createHash("sha256").update(config).digest("hex") !== scope.configSha256) {
		failGitScope(`${scope.gitDir}/config changed since materialization`);
	}
	const alternates = await readRegular(join(scope.gitDir, "objects", "info", "alternates"));
	if (alternates.toString("utf8") !== `${scope.sharedObjects}\n`) {
		failGitScope(`${scope.gitDir}/objects/info/alternates changed since materialization`);
	}
	try {
		await lstat(join(scope.gitDir, "commondir"));
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	failGitScope(`${scope.gitDir}/commondir must not exist`);
}

/**
 * Check and sanitize a sealed private git dir once. Throws
 * `WorkspaceGitScopeError` when host git must not run against it.
 */
export async function sealCheckPrivateGitDir(
	scope: PrivateGitScope,
	limits: SealCheckLimits = DEFAULT_SEAL_LIMITS,
): Promise<SealCheckReport> {
	assertCanonicalDir(scope.gitDir, "sealed git dir");
	for (let attempt = 0; ; attempt += 1) {
		const state: WalkState = { entries: 0, sanitized: [], limits };
		try {
			await walk(scope.gitDir, 0, state);
		} catch (err) {
			if (!(err instanceof WalkRaced)) throw err;
			if (attempt >= limits.retries) {
				failGitScope(`${scope.gitDir} kept changing during the seal check`);
			}
			continue;
		}
		await assertWarrenFiles(scope);
		return { entries: state.entries, sanitized: state.sanitized };
	}
}
