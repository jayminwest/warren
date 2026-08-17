/**
 * On-disk state roots for the in-process LocalProvider backend (warren-413d).
 *
 * Everything the backend materializes lives under `<dataDir>/local/` so the
 * layout is deterministic from the sandbox id alone — which is exactly what
 * the stranded-workspace GC sweep needs (it holds only a sandbox id off the
 * `runs` table):
 *
 *   <dataDir>/local/workspaces/<sandboxId>   — the run's git worktree/clone
 *   <dataDir>/local/homes/<sandboxId>        — the run's private writable HOME
 *                                               (warren-c865: harness state
 *                                               never lands in the worktree)
 *   <dataDir>/local/manifests/<sandboxId>.json — the workspace manifest the
 *                                               GC destroyer + teardown read
 *
 * `dataDir` resolves from `WARREN_DATA_DIR` (default `/data`, the deploy's
 * persistent volume) so workspaces survive a process restart for GC even
 * though the in-memory run store does not.
 */

import { join } from "node:path";

/** Minimal env surface the resolver reads. */
export type LocalPathsEnv = Readonly<Record<string, string | undefined>>;

/** Mirrors `DEFAULT_DATA_DIR` in `src/server/config.ts` (kept dependency-free). */
export const DEFAULT_LOCAL_DATA_DIR = "/data";

export interface LocalStateRoots {
	readonly dataDir: string;
	readonly workspaces: string;
	readonly homes: string;
	readonly manifests: string;
}

export function resolveLocalStateRoots(env: LocalPathsEnv): LocalStateRoots {
	const dataDir = env.WARREN_DATA_DIR?.trim() || DEFAULT_LOCAL_DATA_DIR;
	const base = join(dataDir, "local");
	return {
		dataDir,
		workspaces: join(base, "workspaces"),
		homes: join(base, "homes"),
		manifests: join(base, "manifests"),
	};
}

/** The provider workspace id for a run — also the workspace/home dir name. */
export function localSandboxId(runId: string): string {
	return `local-${runId}`;
}

export function localWorkspacePath(roots: LocalStateRoots, sandboxId: string): string {
	return join(roots.workspaces, sandboxId);
}

export function localHomePath(roots: LocalStateRoots, sandboxId: string): string {
	return join(roots.homes, sandboxId);
}

export function localManifestPath(roots: LocalStateRoots, sandboxId: string): string {
	return join(roots.manifests, `${sandboxId}.json`);
}
