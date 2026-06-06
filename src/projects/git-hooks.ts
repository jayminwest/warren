/**
 * Workspace git-hooks arming for the project host clone (warren-8f4c).
 *
 * When burrow creates a worktree from `projectRoot`, the worktree shares
 * the clone's gitCommonDir (`.git/`). Any `core.hooksPath` set in the
 * clone's `.git/config` is therefore inherited by every agent workspace
 * spawned from that project — so we only need to arm it once per
 * refresh, not per-burrow.
 *
 * Detection strategy: read `package.json`, look for a `prepare` script
 * that calls `git config [--local] core.hooksPath <path>` (the npm/bun
 * convention). Anything that doesn't match is a no-op.
 *
 * All errors are swallowed — a missing/malformed `package.json` or a
 * failing `git config` call must never block a run.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpawnFn, SpawnResult } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";

export type ArmGitHooksReadFileFn = (path: string, encoding: "utf8") => Promise<string>;

/**
 * Detect the `core.hooksPath` value from a project's `package.json`
 * `prepare` script. Returns the path string when the prepare script
 * contains a `git config [--local] core.hooksPath <path>` call,
 * `undefined` otherwise. Only the first match is returned.
 *
 * Exported for isolated unit testing.
 */
export function detectHooksPathFromPackageJson(raw: unknown): string | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const scripts = (raw as Record<string, unknown>).scripts;
	if (typeof scripts !== "object" || scripts === null) return undefined;
	const prepare = (scripts as Record<string, unknown>).prepare;
	if (typeof prepare !== "string" || prepare === "") return undefined;
	// Match: git config [--local] core.hooksPath <path>
	const match = /git\s+config\s+(?:--local\s+)?core\.hooksPath\s+(\S+)/.exec(prepare);
	if (match === null) return undefined;
	return match[1];
}

export interface TryArmGitHooksInput {
	config: ProjectsConfig;
	localPath: string;
	spawn: SpawnFn;
	timeoutMs: number;
	readFileFn?: ArmGitHooksReadFileFn;
}

/** Needed by trySpawn to avoid a circular import on the shared helper. */
interface SpawnOptions {
	readonly cwd: string;
	readonly timeoutMs?: number;
}

async function trySpawnLocal(
	spawn: SpawnFn,
	cmd: readonly string[],
	opts: SpawnOptions,
): Promise<SpawnResult> {
	try {
		return await spawn(cmd, opts);
	} catch {
		return { stdout: "", stderr: "", exitCode: 1 };
	}
}

/**
 * Best-effort: read `package.json`, extract a `core.hooksPath` value,
 * and apply it to the project clone's `.git/config` so worktrees inherit
 * the project's pre-commit gate (warren-8f4c). Any error is silently
 * swallowed — hook arming must never block a run.
 */
export async function tryArmGitHooks(input: TryArmGitHooksInput): Promise<void> {
	const { config, localPath, spawn, timeoutMs } = input;
	const readFileFn = input.readFileFn ?? readFile;
	try {
		const raw = await readFileFn(join(localPath, "package.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		const hooksPath = detectHooksPathFromPackageJson(parsed);
		if (hooksPath === undefined) return;
		await trySpawnLocal(
			spawn,
			[config.gitBinary, "config", "--local", "core.hooksPath", hooksPath],
			{
				cwd: localPath,
				timeoutMs,
			},
		);
	} catch {
		// Missing package.json, malformed JSON, or a failing git-config
		// call are all acceptable — the agent still gets a workspace.
	}
}
