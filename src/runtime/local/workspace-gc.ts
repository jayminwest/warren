/**
 * Stranded-workspace destroyer for the in-process LocalProvider
 * (warren-413d, plan pl-3007 phase 3 — replaces the burrow-backed
 * `DELETE /burrows/:id` destroyer from warren-e24d).
 *
 * The fallback workspace-GC sweep (`src/runs/reap/gc.ts`) is provider-neutral:
 * it derives stranded sandbox ids from the `runs` table and calls a
 * {@link WorkspaceDestroyer} seam per candidate. With the daemon off the
 * spawn path, a sandbox id resolves through the on-disk MANIFEST the engine
 * wrote at create time (`./manifest.ts`) — the worktree/clone is removed via
 * the materializer's removal seam, the per-run HOME is reclaimed, and the
 * manifest is dropped. A missing manifest means the workspace is already
 * gone (or predates the in-process backend — a legacy `bur_*` id burrow
 * owned) and reports `already-gone` so the sweep stops churning on it.
 *
 * The K8s backend reports `workspaceGc: false` (its pod-GC loop reclaims
 * terminal pods + their emptyDir), so the boot wiring never builds one of
 * these under `WARREN_RUNTIME=k8s`.
 */

import { rm } from "node:fs/promises";
import type { WorkspaceDestroyer, WorkspaceDestroyOutcome } from "../../runs/reap/gc.ts";
import { removeMaterializedWorkspace } from "../../workspace/materialize.ts";
import { readLocalRunManifest, removeLocalRunManifest } from "./manifest.ts";
import { type LocalPathsEnv, resolveLocalStateRoots } from "./paths.ts";

/**
 * Build the manifest-backed workspace destroyer. Never throws: a missing
 * manifest is `already-gone`, any removal error is `failed` so one bad
 * candidate can't stall the sweep.
 */
export function createLocalWorkspaceDestroyer(env: LocalPathsEnv): WorkspaceDestroyer {
	const roots = resolveLocalStateRoots(env);
	return async (sandboxId: string): Promise<WorkspaceDestroyOutcome> => {
		const manifest = await readLocalRunManifest(roots, sandboxId);
		if (manifest === null) return { status: "already-gone" };
		try {
			await removeMaterializedWorkspace({
				workspacePath: manifest.workspacePath,
				source: manifest.source,
			});
		} catch (err) {
			// Best-effort dir reclaim still runs below; only a genuine removal
			// failure surfaces as `failed` after the fallback had its chance.
			await rm(manifest.workspacePath, { recursive: true, force: true }).catch(() => {});
			await rm(manifest.homePath, { recursive: true, force: true }).catch(() => {});
			await removeLocalRunManifest(roots, sandboxId).catch(() => {});
			return { status: "failed", error: err instanceof Error ? err.message : String(err) };
		}
		await rm(manifest.homePath, { recursive: true, force: true }).catch(() => {});
		await removeLocalRunManifest(roots, sandboxId).catch(() => {});
		// No archive + no ephemeral-store rows: the durable event copy lives in
		// warren's own events table (written by the domain bridge), so the
		// counts a burrow destroy used to report are zero here.
		return { status: "destroyed", archived: false, deletedEvents: 0, deletedRuns: 0 };
	};
}
