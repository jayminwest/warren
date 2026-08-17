/**
 * Workspace seed-file writer (warren-413d, plan pl-3007 phase 3).
 *
 * With the LocalProvider spawn path moved in-process, the context drops a
 * `RunSpec.seedFiles` carries (`.warren/agent.json`, `.mulch/`, `.seeds/`,
 * `.pi/` files) are written by WARREN at materialization time — previously
 * burrow applied them inside `POST /burrows` (`writeWorkspaceFiles` in
 * burrow's `src/server/workspace-files.ts`). This is the warren-owned
 * equivalent, lifted in spirit with the same safety invariants:
 *
 *   - Paths are workspace-RELATIVE. Absolute paths and any `..` segment that
 *     escapes the root are rejected before a single byte is written, so one
 *     bad entry aborts the batch with no partial state.
 *   - `.git` is off-limits: a seed drop must never rewrite the worktree's
 *     git plumbing.
 *   - `contents` decodes as UTF-8 by default, base64 when `encoding` says so.
 *   - `mode` defaults to `0o644`; parent directories are created as needed.
 *
 * Kept deliberately smaller than burrow's surface: no read-back, no listing,
 * no symlink stat reporting — warren only ever WRITES seed drops.
 */

import { mkdir, open } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { WorkspaceMaterializationError } from "./errors.ts";

export interface WorkspaceSeedFile {
	readonly path: string;
	readonly contents: string;
	readonly encoding?: string;
	readonly mode?: number;
}

const DEFAULT_SEED_FILE_MODE = 0o644;

/**
 * Validate a workspace-relative seed path and return its absolute target.
 * Throws `WorkspaceMaterializationError` on an absolute path, a `..` escape,
 * or a `.git` target.
 */
export function resolveSeedFilePath(workspaceRoot: string, relPath: string): string {
	if (relPath === "" || relPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relPath)) {
		throw new WorkspaceMaterializationError(
			`seed file path must be workspace-relative: ${relPath}`,
		);
	}
	const normalized = normalize(relPath);
	const segments = normalized.split("/");
	if (segments[0] === ".git" || segments.includes(".git")) {
		throw new WorkspaceMaterializationError(`seed file path may not target .git: ${relPath}`);
	}
	const root = normalize(workspaceRoot);
	const target = join(root, normalized);
	if (target !== root && !target.startsWith(`${root}/`)) {
		throw new WorkspaceMaterializationError(`seed file path escapes the workspace: ${relPath}`);
	}
	return target;
}

function decodeSeedContents(file: WorkspaceSeedFile): Uint8Array {
	if (file.encoding === "base64") {
		return new Uint8Array(Buffer.from(file.contents, "base64"));
	}
	if (file.encoding !== undefined && file.encoding !== "utf-8") {
		throw new WorkspaceMaterializationError(
			`seed file ${file.path}: unsupported encoding "${file.encoding}"`,
			{ recoveryHint: "supported encodings: utf-8 (default), base64" },
		);
	}
	return new TextEncoder().encode(file.contents);
}

/**
 * Write every seed file into the workspace. Validates ALL paths up front so a
 * rejected entry aborts the batch before any write (same all-or-nothing
 * posture as burrow's writer).
 */
export async function writeWorkspaceSeedFiles(
	workspaceRoot: string,
	files: readonly WorkspaceSeedFile[],
): Promise<void> {
	const resolved = files.map((file) => ({
		target: resolveSeedFilePath(workspaceRoot, file.path),
		data: decodeSeedContents(file),
		mode: file.mode ?? DEFAULT_SEED_FILE_MODE,
	}));
	for (const { target, data, mode } of resolved) {
		await mkdir(dirname(target), { recursive: true });
		const handle = await open(target, "w", mode);
		try {
			await handle.writeFile(data);
			await handle.chmod(mode);
		} finally {
			await handle.close();
		}
	}
}
