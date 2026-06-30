/**
 * Clone a project repo into `<projectsRoot>/<owner>/<name>` and detect
 * its default branch (SPEC §5, §9 `projects.default_branch`).
 *
 * Project clones are working trees that agents will run against — *not*
 * a cache like the canopy library clone. So the contract is the
 * canonical "first-time clone" only: if the target directory already
 * exists, we refuse rather than fast-forward (the caller surfaces this
 * as a 409-style conflict). Re-adding a project means deleting and
 * re-cloning, so the operator gets explicit control over destructive
 * resets.
 *
 * Default branch resolution: after clone, ask `git symbolic-ref
 * refs/remotes/origin/HEAD` (matches what the canopy registry uses for
 * the same purpose). On clone or detection failure we `rm -rf` the
 * partial clone so warren never leaves a half-populated dir on disk —
 * the next add attempt sees a clean slate.
 *
 * Spawn + filesystem are injected so tests don't shell out to git or
 * touch disk.
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatError } from "../core/errors.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export interface SpawnResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export interface SpawnOptions {
	readonly cwd: string;
	readonly timeoutMs?: number;
}

export type SpawnFn = (cmd: readonly string[], opts: SpawnOptions) => Promise<SpawnResult>;

export interface CloneProjectInput {
	readonly config: ProjectsConfig;
	readonly gitUrl: string;
	readonly owner: string;
	readonly name: string;
	/** Override default-branch detection. */
	readonly defaultBranch?: string;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
	/** Filesystem probes — overrideable for tests. */
	readonly exists?: (path: string) => boolean;
	readonly mkdirp?: (path: string) => Promise<void>;
	readonly rmrf?: (path: string) => Promise<void>;
}

export interface CloneProjectResult {
	readonly localPath: string;
	readonly defaultBranch: string;
}

export async function cloneProjectRepo(input: CloneProjectInput): Promise<CloneProjectResult> {
	const { config, gitUrl, owner, name, spawn } = input;
	const timeoutMs = input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const exists = input.exists ?? existsSync;
	const mkdirp = input.mkdirp ?? defaultMkdirp;
	const rmrf = input.rmrf ?? defaultRmrf;

	const localPath = join(config.root, owner, name);

	if (exists(localPath)) {
		throw new ProjectUnavailableError(`target path already exists: ${localPath}`, {
			recoveryHint: "delete the project first or remove the stranded directory",
		});
	}

	await ensureParentDir(mkdirp, dirname(localPath));

	const cloneCmd = [config.gitBinary, "clone", gitUrl, localPath];
	const cloneResult = await trySpawn(spawn, cloneCmd, { cwd: config.root, timeoutMs });
	if (cloneResult.exitCode !== 0) {
		// Best-effort cleanup: clone may have left a partial dir behind.
		await rmrf(localPath).catch(() => undefined);
		throw new ProjectUnavailableError(
			`git clone failed (exit ${cloneResult.exitCode}): ${formatStderr(cloneResult)}`,
			{
				recoveryHint:
					"verify the GitHub URL, your network, and that the repo is accessible to this host",
			},
		);
	}

	let defaultBranch: string;
	if (input.defaultBranch !== undefined && input.defaultBranch !== "") {
		defaultBranch = input.defaultBranch;
	} else {
		try {
			defaultBranch = await detectDefaultBranch(spawn, config.gitBinary, localPath, timeoutMs);
		} catch (err) {
			await rmrf(localPath).catch(() => undefined);
			throw err;
		}
	}

	return { localPath, defaultBranch };
}

async function detectDefaultBranch(
	spawn: SpawnFn,
	gitBinary: string,
	cwd: string,
	timeoutMs: number,
): Promise<string> {
	const result = await trySpawn(spawn, [gitBinary, "symbolic-ref", "refs/remotes/origin/HEAD"], {
		cwd,
		timeoutMs,
	});
	if (result.exitCode === 0) {
		const branch = parseSymbolicRef(result.stdout);
		if (branch !== undefined) return branch;
	}
	// Recover via remote set-head --auto + a second symbolic-ref read.
	const setHead = await trySpawn(spawn, [gitBinary, "remote", "set-head", "origin", "--auto"], {
		cwd,
		timeoutMs,
	});
	if (setHead.exitCode !== 0) {
		throw new ProjectUnavailableError(
			`could not determine origin's default branch: ${formatStderr(setHead)}`,
			{ recoveryHint: "pass defaultBranch explicitly when adding the project" },
		);
	}
	const retry = await trySpawn(spawn, [gitBinary, "symbolic-ref", "refs/remotes/origin/HEAD"], {
		cwd,
		timeoutMs,
	});
	if (retry.exitCode === 0) {
		const branch = parseSymbolicRef(retry.stdout);
		if (branch !== undefined) return branch;
	}
	throw new ProjectUnavailableError("could not determine origin's default branch after set-head", {
		recoveryHint: "pass defaultBranch explicitly when adding the project",
	});
}

function parseSymbolicRef(stdout: string): string | undefined {
	const ref = stdout.trim();
	const slash = ref.lastIndexOf("/");
	if (slash === -1 || slash + 1 >= ref.length) return undefined;
	return ref.slice(slash + 1);
}

async function ensureParentDir(
	mkdirp: (path: string) => Promise<void>,
	parent: string,
): Promise<void> {
	try {
		await mkdirp(parent);
	} catch (err) {
		throw new ProjectUnavailableError(
			`could not create parent directory ${parent}: ${formatError(err)}`,
			{ cause: err },
		);
	}
}

async function trySpawn(
	spawn: SpawnFn,
	cmd: readonly string[],
	opts: SpawnOptions,
): Promise<SpawnResult> {
	try {
		return await spawn(cmd, opts);
	} catch (err) {
		throw new ProjectUnavailableError(`failed to spawn ${cmd.join(" ")}: ${formatError(err)}`, {
			cause: err,
		});
	}
}

function formatStderr(result: SpawnResult): string {
	const trimmed = result.stderr.trim();
	if (trimmed !== "") return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
	return "<no stderr>";
}

const defaultMkdirp = async (path: string): Promise<void> => {
	await mkdir(path, { recursive: true });
};

const defaultRmrf = async (path: string): Promise<void> => {
	await rm(path, { recursive: true, force: true });
};
