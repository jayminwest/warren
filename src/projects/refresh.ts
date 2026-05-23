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

	// Probe `.plot/` BEFORE the working-tree-touching commands so the
	// preserve wrapper knows whether to snapshot. Must run before
	// `git checkout --force` (the next step) because checkout discards
	// uncommitted modifications to tracked files (warren-af97 / scenario
	// 31): the host-side Plot appender writes — `plan_run_dispatched` at
	// POST time, per-child `run_dispatched` from spawnRun, the
	// auto-`done` status_changed from autoTransitionPlotToDone — all
	// land in `.plot/<id>.events.jsonl` / `<id>.json` WITHOUT being
	// committed. If the snapshot/restore wrapper only spans `git reset
	// --hard` (the warren-fdd2 shape), the preceding `git checkout
	// --force` has already wiped those appends and the snapshot picks
	// up the committed state — every host-appender write before the
	// final spawn vanishes. Moving the probe + the wrapper above
	// `checkout` is the surgical fix.
	const hadPlotPreReset = exists(join(localPath, PROJECT_FEATURE_DIRS.plot));
	const preservePlot = input.preservePlot ?? defaultPreservePlot;

	await preservePlot(localPath, hadPlotPreReset, async () => {
		// `git checkout <ref>` moves HEAD onto the named ref (creating a
		// tracking branch when ref is a remote branch name). Without
		// this, `reset --hard origin/<ref>` would only move whatever
		// branch we happened to already be on — which on a fresh clone
		// is the default branch, but on a prior run might be something
		// else entirely.
		await runGit(spawn, [config.gitBinary, "checkout", "--force", ref], {
			cwd: localPath,
			timeoutMs,
		});

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
 * Default `.plot/` preservation wrapper (warren-fdd2, plan pl-d4d6,
 * warren-af9e merge fix).
 *
 * Snapshots the host-side-writable plot data files (`plot-*.json`,
 * `plot-*.events.jsonl`) to a tmpdir before the reset, then **merges**
 * them back into the post-reset tree rather than blindly overwriting.
 * This preserves remote changes (new attachments, intent edits, events
 * committed and pushed by users) while retaining host-appender writes
 * (status transitions, appended events).
 *
 * Merge strategy per file type:
 *   - `.events.jsonl` — dedup-append: remote lines kept, snapshot-only
 *     lines appended at the tail.
 *   - `.json` — field-level: remote is the base (attachments, intent,
 *     etc.); host-side `status` + `updated_at` overlay when status
 *     differs.
 *   - Files absent post-reset are restored from snapshot (host-created
 *     plots the remote hasn't seen yet).
 *
 * Only flat `plot-*` data files are captured; subdirectories, the
 * `.index.db*` SQLite index, and non-plot files are left for git.
 */
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
			await mergePlotSnapshot(snapshotDir, src);
		}
	} finally {
		if (snapshotDir !== null) {
			await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
		}
	}
};

/**
 * Copy plot data files (`plot-*.events.jsonl` and `plot-*.json`) from
 * `src` into `dst`. Only captures the flat file types the host-side
 * appenders write — subdirectories, `.index.db*` SQLite state, and
 * other files are left for git to manage via the reset. Returns the
 * number of files copied; 0 means the caller can skip the merge step.
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
		if (!entry.isFile()) continue;
		if (!isPlotDataFile(entry.name)) continue;
		const srcPath = join(src, entry.name);
		const dstPath = join(dst, entry.name);
		const buf = await readFile(srcPath);
		await writeFile(dstPath, buf);
		count += 1;
	}
	return count;
}

/**
 * Merge the snapshot back into `<localPath>/.plot/` instead of blindly
 * overwriting (warren-af9e). For each snapshotted file:
 *
 *   - **Not present post-reset** → restore from snapshot (host created it).
 *   - **`.events.jsonl`** → dedup-append: remote lines kept in order,
 *     snapshot-only lines appended at the tail.
 *   - **`.json`** → field-level merge: remote is the base (preserving
 *     attachments, intent, etc. fetched from origin); host-side
 *     `status` + `updated_at` overlay when status differs.
 *
 * Files present post-reset but absent from the snapshot are untouched —
 * they are new remote content the host never saw.
 */
async function mergePlotSnapshot(snapshotDir: string, plotDir: string): Promise<void> {
	await mkdir(plotDir, { recursive: true });
	const entries = await readdir(snapshotDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const snapshotPath = join(snapshotDir, entry.name);
		const plotPath = join(plotDir, entry.name);
		const snapshotContent = await readFile(snapshotPath, "utf8");

		let remoteContent: string | null = null;
		try {
			remoteContent = await readFile(plotPath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}

		if (remoteContent === null) {
			await writeFile(plotPath, snapshotContent);
			continue;
		}

		if (entry.name.endsWith(".events.jsonl")) {
			const merged = mergeEventsLines(remoteContent, snapshotContent);
			if (merged !== remoteContent) {
				await writeFile(plotPath, merged);
			}
		} else if (entry.name.endsWith(".json")) {
			const merged = mergePlotJsonForRefresh(remoteContent, snapshotContent);
			if (merged !== remoteContent) {
				await writeFile(plotPath, merged);
			}
		}
	}
}

function isPlotDataFile(name: string): boolean {
	return name.startsWith("plot-") && (name.endsWith(".events.jsonl") || name.endsWith(".json"));
}

/**
 * Dedup-append merge for `.events.jsonl`: keep all remote lines in
 * order, then append any snapshot lines not already present. Matches
 * the `mergePlotEventsFile` strategy in `src/runs/reap.ts`.
 */
export function mergeEventsLines(remote: string, snapshot: string): string {
	const remoteLines = splitNonEmpty(remote);
	const seen = new Set(remoteLines);
	const appended: string[] = [];
	for (const line of splitNonEmpty(snapshot)) {
		if (seen.has(line)) continue;
		seen.add(line);
		appended.push(line);
	}
	if (appended.length === 0) return remote;
	const all = [...remoteLines, ...appended];
	return all.length === 0 ? "" : `${all.join("\n")}\n`;
}

function splitNonEmpty(body: string): string[] {
	return body.split("\n").filter(Boolean);
}

/**
 * Field-level merge for `plot-*.json`: take the post-reset (remote)
 * copy as the base — it carries the latest attachments, intent, and
 * other fields fetched from origin. Overlay `status` (and `updated_at`)
 * from the snapshot only when the host-side appender changed status
 * (e.g. `autoTransitionPlotToDone`). When status is unchanged, the
 * remote version is returned as-is.
 */
export function mergePlotJsonForRefresh(remote: string, snapshot: string): string {
	if (remote === snapshot) return remote;
	try {
		const remoteObj = JSON.parse(remote) as Record<string, unknown>;
		const snapshotObj = JSON.parse(snapshot) as Record<string, unknown>;
		if (snapshotObj.status === remoteObj.status) {
			return remote;
		}
		remoteObj.status = snapshotObj.status;
		if (snapshotObj.updated_at !== undefined) {
			remoteObj.updated_at = snapshotObj.updated_at;
		}
		return `${JSON.stringify(sortKeys(remoteObj), null, 2)}\n`;
	} catch {
		return snapshot;
	}
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
	const sorted: Record<string, unknown> = {};
	for (const k of Object.keys(obj).sort()) {
		sorted[k] = obj[k];
	}
	return sorted;
}

function formatStderr(result: SpawnResult): string {
	const trimmed = result.stderr.trim();
	if (trimmed !== "") return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
	return "<no stderr>";
}
