/**
 * Per-run workspace manifest (warren-413d) — the on-disk record that lets the
 * stranded-workspace GC destroyer and `terminate` reclaim a run's workspace
 * + HOME after the in-memory run store is gone (warren restart mid-run).
 *
 * Written at `create()` time, read by `workspace-gc.ts`'s destroyer and as a
 * teardown fallback, removed by `terminate`. Burrow kept this state in its
 * `burrows` row (`providerState.workspaceSource`); with the daemon off the
 * spawn path the provider persists the equivalent itself.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MaterializedWorkspaceSource } from "../../workspace/materialize.ts";
import type { LocalStateRoots } from "./paths.ts";
import { localManifestPath } from "./paths.ts";

export interface LocalRunManifest {
	readonly version: 1;
	readonly sandboxId: string;
	readonly runId: string;
	readonly branch: string;
	readonly workspacePath: string;
	readonly homePath: string;
	/** The materialization result, so removal knows worktree vs clone. */
	readonly source: MaterializedWorkspaceSource;
	readonly createdAt: string;
}

export async function writeLocalRunManifest(
	roots: LocalStateRoots,
	manifest: LocalRunManifest,
): Promise<void> {
	const path = localManifestPath(roots, manifest.sandboxId);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Read the manifest for a sandbox id; `null` when absent or unparseable. */
export async function readLocalRunManifest(
	roots: LocalStateRoots,
	sandboxId: string,
): Promise<LocalRunManifest | null> {
	let body: string;
	try {
		body = await readFile(localManifestPath(roots, sandboxId), "utf8");
	} catch {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed === null || typeof parsed !== "object") return null;
		const candidate = parsed as Partial<LocalRunManifest>;
		if (
			typeof candidate.workspacePath !== "string" ||
			typeof candidate.homePath !== "string" ||
			typeof candidate.branch !== "string" ||
			candidate.source === null ||
			typeof candidate.source !== "object"
		) {
			return null;
		}
		return candidate as LocalRunManifest;
	} catch {
		return null;
	}
}

/** Remove the manifest for a sandbox id. Best-effort (idempotent). */
export async function removeLocalRunManifest(
	roots: LocalStateRoots,
	sandboxId: string,
): Promise<void> {
	await rm(localManifestPath(roots, sandboxId), { force: true });
}
