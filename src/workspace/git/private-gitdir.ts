/**
 * Per-run private git metadata over a shared object store (warren-3c1e).
 *
 * A local run used to be a `git worktree` of the host clone, so every run
 * shared the clone's `refs/`, `logs/`, `packed-refs`, and object store. This
 * module materializes the run's checkout against a PRIVATE git dir instead:
 *
 *   - `git init --separate-git-dir=<gitDir> <workspace>` writes the
 *     workspace's `.git` file and a fresh, hook-free git dir. The init pins
 *     the host's object format and the `files` ref backend, so a user or
 *     system default (`init.defaultRefFormat=reftable`) cannot change the
 *     on-disk layout the sandbox mounts and the host check walk.
 *   - `objects/info/alternates` names the host clone's `objects/`, so every
 *     existing object is borrowed read-only and nothing is copied. Objects
 *     the run creates land in `<gitDir>/objects`.
 *   - The host clone's branches, remote-tracking refs, and tags are
 *     snapshotted through `git update-ref --stdin` and packed, so
 *     `git log origin/main` and `git diff main` keep working in the sandbox.
 *   - The run branch is a loose ref in the private dir only. A run moving
 *     any ref moves only its own copy.
 *   - The host clone gains exactly one ref, `refs/warren/runs/<id>`, at the
 *     base commit. It keeps host `gc --auto` from pruning the objects the
 *     private dir borrows. Teardown deletes it.
 *   - `config` carries only what warren copies in: the clone's `remote.*`
 *     entries (fetch/push) and its `core.hooksPath` (the warren-8f4c
 *     pre-commit gate). Local `http.*`, `credential.*`, `url.*.insteadOf`,
 *     and `lfs.*` settings are not carried over, and LFS objects are not
 *     shared. The sandbox keeps `config` read-only, and host-side git
 *     refuses to run if its digest changed (`src/sandbox/git-seal.ts`).
 *
 * Cost: one `git init`, one `for-each-ref`, one `update-ref --stdin`, one
 * `pack-refs`, a few `git config` writes, and the checkout itself.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { WorkspaceMaterializationError } from "../errors.ts";
import { runGit, runGitOrThrow } from "./exec.ts";
import type { HostClone } from "./worktree.ts";

export interface MaterializePrivateGitDirOptions {
	readonly hostClone: HostClone;
	/** Workspace (work tree) path. Must not exist yet. */
	readonly workspacePath: string;
	/** Private git dir path. Must not exist yet; its parent is created. */
	readonly gitDir: string;
	/** Branch the workspace checks out, created in the private dir only. */
	readonly branch: string;
	/** Host-clone ref the branch starts at (the base branch, or the branch itself). */
	readonly startPoint: string;
	/** Host-only ref pinned at the base commit for GC safety (`refs/warren/runs/<id>`). */
	readonly hostKeepRef?: string;
}

export interface PrivateGitDirResult {
	/** Canonical private git dir. */
	readonly gitDir: string;
	/** Canonical host clone common dir whose `objects/` is the alternate. */
	readonly hostGitDir: string;
	/** Commit the branch was created at. */
	readonly baseSha: string;
	/** sha256 of the warren-written `config`; host-side git re-checks it. */
	readonly configSha256: string;
}

/** The exact `objects/info/alternates` body warren writes for a host dir. */
export function privateAlternatesBody(hostGitDir: string): string {
	return `${join(hostGitDir, "objects")}\n`;
}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** `refs/warren/runs/<id>`: the host-only GC keep-ref for one run. */
export function hostKeepRefFor(runKey: string): string {
	return `refs/warren/runs/${runKey}`;
}

function fail(message: string): never {
	throw new WorkspaceMaterializationError(`private git dir: ${message}`, {
		recoveryHint: "check the host clone is a healthy, non-bare git repository and retry",
	});
}

/** Resolve the start point on the host clone to a commit id. */
async function resolveStartSha(hostTop: string, startPoint: string): Promise<string> {
	if (startPoint === "" || startPoint.startsWith("-")) fail(`invalid start point '${startPoint}'`);
	const res = await runGit(["rev-parse", "--verify", "--quiet", `${startPoint}^{commit}`], {
		cwd: hostTop,
	});
	const sha = res.stdout.trim();
	if (res.exitCode !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
		fail(`start point '${startPoint}' does not resolve to a commit in ${hostTop}`);
	}
	return sha;
}

async function hostObjectFormat(hostTop: string): Promise<string> {
	const res = await runGit(["rev-parse", "--show-object-format"], { cwd: hostTop });
	const format = res.stdout.trim();
	return res.exitCode === 0 && format !== "" ? format : "sha1";
}

let refFormatFlag: Promise<boolean> | undefined;

/** `git init --ref-format` exists from git 2.45; older git only has the files backend. */
function supportsRefFormatFlag(): Promise<boolean> {
	refFormatFlag ??= runGit(["version"]).then((res) => {
		const m = /git version (\d+)\.(\d+)/.exec(res.stdout);
		const major = Number(m?.[1] ?? 0);
		const minor = Number(m?.[2] ?? 0);
		return major > 2 || (major === 2 && minor >= 45);
	});
	return refFormatFlag;
}

/**
 * The host clone's branches, remote-tracking refs, and tags as
 * `update-ref --stdin` commands. Symbolic refs (`origin/HEAD`) and the run
 * branch itself are skipped.
 */
async function snapshotHostRefs(hostTop: string, branch: string): Promise<string> {
	const res = await runGitOrThrow(
		[
			"for-each-ref",
			"--format=%(objectname) %(refname) %(symref)",
			"refs/heads",
			"refs/remotes",
			"refs/tags",
		],
		{ cwd: hostTop },
	);
	const own = `refs/heads/${branch}`;
	const lines: string[] = [];
	for (const raw of res.stdout.split("\n")) {
		const [sha, ref, symref] = raw.split(" ");
		if (sha === undefined || ref === undefined || sha === "" || ref === own) continue;
		if (symref !== undefined && symref !== "") continue;
		lines.push(`create ${ref} ${sha}`);
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Copy the clone's `remote.*` config and `core.hooksPath` into the private config. */
async function copyHostConfig(hostTop: string, configPath: string): Promise<void> {
	const remotes = await runGit(["config", "--local", "-z", "--get-regexp", "^remote\\."], {
		cwd: hostTop,
	});
	const entries: Array<[string, string]> = [];
	for (const record of remotes.stdout.split("\0")) {
		const nl = record.indexOf("\n");
		if (nl > 0) entries.push([record.slice(0, nl), record.slice(nl + 1)]);
	}
	const hooks = await runGit(["config", "--local", "--get", "core.hooksPath"], { cwd: hostTop });
	if (hooks.exitCode === 0 && hooks.stdout.trim() !== "") {
		entries.push(["core.hooksPath", hooks.stdout.trim()]);
	}
	for (const [key, value] of entries) {
		await runGitOrThrow(["config", "--file", configPath, "--add", key, value]);
	}
}

/** Carry the clone's own `info/exclude` patterns over (worktrees shared them). */
function copyHostExclude(hostGitDir: string, gitDir: string): void {
	const source = join(hostGitDir, "info", "exclude");
	try {
		if (!lstatSync(source).isFile()) return;
	} catch {
		return;
	}
	mkdirSync(join(gitDir, "info"), { recursive: true });
	writeFileSync(join(gitDir, "info", "exclude"), readFileSync(source));
}

/**
 * Canonical path for a not-yet-existing dir: realpath the parent, keep the
 * name. The `.git` file and the sandbox mounts both carry this path, and
 * macOS Seatbelt matches canonical paths only.
 */
function canonicalNewPath(path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	return join(realpathSync(dirname(path)), basename(path));
}

/** `git init` the private dir with a pinned object format and the files ref backend. */
async function initPrivateDir(
	gitDir: string,
	workspacePath: string,
	branch: string,
	format: string,
): Promise<void> {
	const refFormat = (await supportsRefFormatFlag()) ? ["--ref-format=files"] : [];
	await runGitOrThrow(
		[
			"init",
			"--quiet",
			"--template=",
			`--object-format=${format}`,
			...refFormat,
			"--initial-branch",
			branch,
			`--separate-git-dir=${gitDir}`,
			workspacePath,
		],
		{ cwd: dirname(gitDir), env: { ...process.env, GIT_DEFAULT_REF_FORMAT: "files" } },
	);
}

export async function materializePrivateGitDir(
	options: MaterializePrivateGitDirOptions,
): Promise<PrivateGitDirResult> {
	const hostTop = options.hostClone.topLevel;
	const hostGitDir = realpathSync(options.hostClone.gitCommonDir);
	const hostObjects = join(hostGitDir, "objects");
	if (!lstatSync(hostObjects).isDirectory()) fail(`${hostObjects} is not a directory`);
	const check = await runGit(["check-ref-format", `refs/heads/${options.branch}`]);
	if (check.exitCode !== 0) fail(`invalid branch name '${options.branch}'`);

	const baseSha = await resolveStartSha(hostTop, options.startPoint);
	const format = await hostObjectFormat(hostTop);
	const gitDir = canonicalNewPath(options.gitDir);
	const workspacePath = options.workspacePath;

	await initPrivateDir(gitDir, workspacePath, options.branch, format);
	mkdirSync(join(gitDir, "objects", "info"), { recursive: true });
	writeFileSync(join(gitDir, "objects", "info", "alternates"), privateAlternatesBody(hostGitDir));
	copyHostExclude(hostGitDir, gitDir);
	const configPath = join(gitDir, "config");
	await copyHostConfig(hostTop, configPath);

	if (options.hostKeepRef !== undefined) {
		await runGitOrThrow(["update-ref", options.hostKeepRef, baseSha], { cwd: hostTop });
	}
	const pinned = [`--git-dir=${gitDir}`, `--work-tree=${workspacePath}`];
	const snapshot = await snapshotHostRefs(hostTop, options.branch);
	if (snapshot !== "") {
		await runGitOrThrow([...pinned, "update-ref", "--stdin"], {
			cwd: workspacePath,
			stdin: snapshot,
		});
		await runGitOrThrow([...pinned, "pack-refs", "--all"], { cwd: workspacePath });
	}
	await runGitOrThrow([...pinned, "update-ref", `refs/heads/${options.branch}`, baseSha], {
		cwd: workspacePath,
	});
	await runGitOrThrow([...pinned, "reset", "--quiet", "--hard", baseSha], { cwd: workspacePath });
	return { gitDir, hostGitDir, baseSha, configSha256: sha256File(configPath) };
}
