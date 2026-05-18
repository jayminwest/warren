/**
 * Refresh a project clone — fetch from origin and hard-reset to a ref.
 *
 * Project clones are working trees agents will run against, but the row
 * is registered once and re-used for every run (operators don't want a
 * new project per PR). Without this module, /data/projects/<id>/ stays
 * frozen at registration-time forever and every run sees stale code
 * (warren-1bb6).
 *
 * The semantics mirror src/registry/clone.ts's "fast-forward to remote"
 * contract: `git fetch --prune origin`, then `git checkout <ref>` (so
 * branch HEAD moves with the working tree), then `git reset --hard
 * origin/<ref>`. Any local mutations from a previous run get thrown
 * away — warren never preserves agent-side state across runs; that's
 * burrow's job.
 *
 * The default ref is the project's tracked default branch
 * (`projects.default_branch`). Callers can pass a branch name, tag, or
 * SHA via `ref` to point a run at something specific.
 *
 * Returns the post-reset HEAD sha so the caller can stamp it onto the
 * row alongside the fetch timestamp. Spawn + filesystem are injected so
 * tests don't shell out to git or touch disk.
 */

import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn, SpawnOptions, SpawnResult } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * Feature directories warren probes for at clone refresh time (warren-4e20).
 * The seed plan (pl-2047 step 2) leaves room for the existing opt-in
 * integrations (`.mulch/`, `.canopy/`, `.pi/`) to start surfacing the same
 * way without changing the probe shape. `.seeds/` joined in warren-9990
 * to gate plan-run dispatch.
 */
export const PROJECT_FEATURE_DIRS = {
	plot: ".plot",
	seeds: ".seeds",
} as const;

/**
 * Result of probing a project clone for opt-in feature directories. One
 * boolean per gated integration; addProject / refreshProject persist the
 * fields to the corresponding `projects` row columns.
 */
export interface ProjectFeatureFlags {
	readonly hasPlot: boolean;
	readonly hasSeeds: boolean;
}

/**
 * Synchronous probe of the on-disk clone for the directories that gate
 * warren's opt-in integrations. Returns booleans; never throws. The
 * `exists` probe is injectable so tests don't touch disk and so a future
 * git-tree reader can swap to a non-checked-out ref.
 *
 * Called from `refreshProjectClone` after the post-fetch reset and from
 * `addProject` immediately after the initial clone so the row reflects
 * the feature shape of the freshly-checked-out tree. The detection is
 * read-only and stateless on its own — persistence is the caller's job.
 */
export function detectProjectFeatures(
	localPath: string,
	exists: (path: string) => boolean = existsSync,
): ProjectFeatureFlags {
	return {
		hasPlot: exists(join(localPath, PROJECT_FEATURE_DIRS.plot)),
		hasSeeds: exists(join(localPath, PROJECT_FEATURE_DIRS.seeds)),
	};
}

export interface RefreshProjectCloneInput {
	readonly config: ProjectsConfig;
	readonly localPath: string;
	/** Branch, tag, or SHA. Defaults to the project's tracked default branch. */
	readonly ref: string;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
	readonly exists?: (path: string) => boolean;
	/**
	 * Override the snapshot/restore wrapper that preserves `.plot/`
	 * across the post-fetch `git reset --hard` (warren-fdd2, plan
	 * pl-d4d6). The default snapshots `.plot/` event/status files to
	 * `os.tmpdir()` before the reset and restores them after, so the
	 * host-side Plot appenders' uncommitted writes survive across
	 * spawnRun→refreshProjectClone cycles (SPEC §11.O). Tests that
	 * don't care about Plot preservation can pass a wrapper that just
	 * runs `fn()` directly.
	 */
	readonly preservePlot?: PreservePlotFn;
}

/**
 * Wraps the `git reset --hard` portion of a refresh so a caller can
 * snapshot `.plot/` before the reset and restore it after. `hasPlot`
 * reflects the on-disk probe at refresh entry; when false the wrapper
 * should be a pass-through.
 */
export type PreservePlotFn = (
	localPath: string,
	hasPlot: boolean,
	fn: () => Promise<void>,
) => Promise<void>;

export interface RefreshProjectCloneResult {
	readonly headSha: string;
	/** Echo of the resolved ref the caller asked for. */
	readonly ref: string;
	/**
	 * Feature-directory probe taken after the hard-reset to origin/<ref>
	 * (warren-4e20, warren-9990). Reflects the on-disk shape of the
	 * freshly-checked-out tree, so a `.plot/` or `.seeds/` added (or
	 * removed) on the remote since the last refresh flips the
	 * corresponding flag on the next call. `addProject` runs the same
	 * probe right after the initial clone.
	 */
	readonly features: ProjectFeatureFlags;
}

export async function refreshProjectClone(
	input: RefreshProjectCloneInput,
): Promise<RefreshProjectCloneResult> {
	const { config, localPath, ref, spawn } = input;
	const timeoutMs = input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const exists = input.exists ?? existsSync;

	if (!exists(localPath)) {
		// A registered project whose on-disk clone vanished is a data-integrity
		// issue, not something a refresh should silently re-clone. Surface a
		// clear error and let the operator delete + re-add.
		throw new ProjectUnavailableError(`project clone missing on disk: ${localPath}`, {
			recoveryHint: "DELETE /projects/:id and POST /projects to re-clone",
		});
	}

	await runGit(spawn, [config.gitBinary, "fetch", "--prune", "origin"], {
		cwd: localPath,
		timeoutMs,
	});

	// `git checkout <ref>` moves HEAD onto the named ref (creating a
	// tracking branch when ref is a remote branch name). Without this,
	// `reset --hard origin/<ref>` would only move whatever branch we
	// happened to already be on — which on a fresh clone is the default
	// branch, but on a prior run might be something else entirely.
	await runGit(spawn, [config.gitBinary, "checkout", "--force", ref], {
		cwd: localPath,
		timeoutMs,
	});

	// Probe `.plot/` BEFORE the reset so the preserve wrapper knows
	// whether to snapshot — the post-reset features probe runs again
	// below and is what we return. Decoupling these two probes means
	// `.plot/` appears+disappears across the reset still get reflected
	// correctly in the result (e.g. a remote that just added `.plot/`
	// produces hasPlot=true even though we had nothing to snapshot).
	const hadPlotPreReset = exists(join(localPath, PROJECT_FEATURE_DIRS.plot));
	const preservePlot = input.preservePlot ?? defaultPreservePlot;

	await preservePlot(localPath, hadPlotPreReset, async () => {
		// Hard-reset to origin/<ref> so any uncommitted detritus from a
		// prior run is wiped and the working tree matches what's on the
		// remote. If `ref` is a SHA or tag, `origin/<ref>` won't resolve;
		// fall back to a plain `reset --hard <ref>` in that case.
		const resetToRemote = await trySpawn(
			spawn,
			[config.gitBinary, "reset", "--hard", `origin/${ref}`],
			{ cwd: localPath, timeoutMs },
		);
		if (resetToRemote.exitCode !== 0) {
			await runGit(spawn, [config.gitBinary, "reset", "--hard", ref], {
				cwd: localPath,
				timeoutMs,
			});
		}
	});

	// Drop any stale user.name / user.email from the local .git/config
	// (warren-9f70). Warren never writes either itself; if one is here
	// it came from a prior tool (the acceptance harness used to ship
	// `[user]` in GIT_CONFIG_GLOBAL) and would silently leak that
	// identity into the agent's commits. Best-effort: `--unset-all`
	// exits 5 when the key is absent, which is the normal case.
	for (const key of ["user.name", "user.email"] as const) {
		await trySpawn(spawn, [config.gitBinary, "config", "--local", "--unset-all", key], {
			cwd: localPath,
			timeoutMs,
		});
	}

	const headSha = await readHead(spawn, config.gitBinary, localPath, timeoutMs);
	const features = detectProjectFeatures(localPath, exists);
	return { headSha, ref, features };
}

async function readHead(
	spawn: SpawnFn,
	gitBinary: string,
	cwd: string,
	timeoutMs: number,
): Promise<string> {
	const result = await runGit(spawn, [gitBinary, "rev-parse", "HEAD"], { cwd, timeoutMs });
	const sha = result.stdout.trim();
	if (sha.length === 0) {
		throw new ProjectUnavailableError("git rev-parse HEAD returned empty output");
	}
	return sha;
}

async function runGit(
	spawn: SpawnFn,
	cmd: readonly string[],
	opts: SpawnOptions & { timeoutMs: number },
): Promise<SpawnResult> {
	const result = await trySpawn(spawn, cmd, opts);
	if (result.exitCode !== 0) {
		throw new ProjectUnavailableError(
			`${cmd.join(" ")} exited ${result.exitCode}: ${formatStderr(result)}`,
		);
	}
	return result;
}

async function trySpawn(
	spawn: SpawnFn,
	cmd: readonly string[],
	opts: SpawnOptions,
): Promise<SpawnResult> {
	try {
		return await spawn(cmd, opts);
	} catch (err) {
		throw new ProjectUnavailableError(
			`failed to spawn ${cmd.join(" ")}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
}

/**
 * Default `.plot/` preservation wrapper (warren-fdd2, plan pl-d4d6).
 *
 * Snapshot shape (b): keep the post-fetch `git reset --hard` correct for
 * the agent-workspace invariant (clean tree per child run) while not
 * wiping warren-managed coordination state. Warren's host-side Plot
 * appenders (defaultPlotAppender in src/runs/spawn.ts,
 * defaultPlanRunPlotAppender, autoTransitionPlotToDone) write to
 * `<localPath>/.plot/<id>.events.jsonl` and `<id>.json` WITHOUT
 * committing. Without this wrapper, those writes would survive only
 * until the next spawnRun's refresh — the symptom that motivated
 * scenario 27 (warren-97a3) and this seed.
 *
 * Strategy: copy every regular file under `.plot/` (recursively) to an
 * out-of-tree tmpdir before the reset, then copy them back after.
 * Snapshot wins on conflict — a host-appender write is strictly newer
 * than anything committed into the project repo's `.plot/` (the
 * appended file content is append-only, and a `status_changed` to
 * `done` supersedes an older `active`). The SQLite index
 * (`.plot/.index.db` + `.index.db-wal` + `.index.db-shm`) is derived
 * state per ../plot/README.md; we skip those files so the index
 * rebuilds via Plot's existing retry-once path (mx-239786) rather than
 * carrying stale rows across the reset.
 *
 * Best-effort on cleanup: a failure to remove the tmp dir doesn't fail
 * the refresh, but we always attempt removal in a finally so 100
 * consecutive refreshes don't leak under os.tmpdir().
 */
const PLOT_INDEX_SKIP_PREFIX = ".index.db";

export const defaultPreservePlot: PreservePlotFn = async (localPath, hasPlot, fn) => {
	if (!hasPlot) {
		await fn();
		return;
	}
	const src = join(localPath, PROJECT_FEATURE_DIRS.plot);
	let snapshotDir: string | null = null;
	try {
		snapshotDir = await mkdtemp(join(tmpdir(), "warren-plot-snapshot-"));
		const copied = await snapshotPlotDir(src, snapshotDir);
		await fn();
		if (copied > 0) {
			await restorePlotDir(snapshotDir, src);
		}
	} finally {
		if (snapshotDir !== null) {
			await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
		}
	}
};

/**
 * Recursively copy every regular file under `src` into `dst`, skipping
 * the Plot SQLite index files. Returns the number of files copied.
 * Tolerates `src` not existing or being empty — returns 0, lets the
 * caller skip the restore step.
 */
async function snapshotPlotDir(src: string, dst: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await readdir(src, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw err;
	}
	let count = 0;
	for (const entry of entries) {
		if (entry.name.startsWith(PLOT_INDEX_SKIP_PREFIX)) continue;
		const srcPath = join(src, entry.name);
		const dstPath = join(dst, entry.name);
		if (entry.isDirectory()) {
			await mkdir(dstPath, { recursive: true });
			count += await snapshotPlotDir(srcPath, dstPath);
		} else if (entry.isFile()) {
			const buf = await readFile(srcPath);
			await writeFile(dstPath, buf);
			count += 1;
		}
		// Symlinks, sockets, etc. are intentionally skipped — Plot only
		// writes regular files under `.plot/`.
	}
	return count;
}

/**
 * Restore the snapshot back into `<localPath>/.plot/`. Snapshot wins on
 * conflict: a path present in both the freshly-reset tree and the
 * snapshot gets overwritten with the snapshot's bytes. The `.plot/`
 * root is recreated when the reset removed it entirely (the typical
 * case when the project never committed `.plot/` to origin).
 */
async function restorePlotDir(src: string, dst: string): Promise<void> {
	await mkdir(dst, { recursive: true });
	const entries = await readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const dstPath = join(dst, entry.name);
		if (entry.isDirectory()) {
			await restorePlotDir(srcPath, dstPath);
		} else if (entry.isFile()) {
			const buf = await readFile(srcPath);
			await writeFile(dstPath, buf);
		}
	}
}

function formatStderr(result: SpawnResult): string {
	const trimmed = result.stderr.trim();
	if (trimmed !== "") return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
	return "<no stderr>";
}
