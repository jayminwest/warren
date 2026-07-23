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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { githubCredentialGitEnv } from "../workspace/git/credential-env.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { type ArmGitHooksReadFileFn, tryArmGitHooks } from "./git-hooks.ts";

export { detectHooksPathFromPackageJson } from "./git-hooks.ts";

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * Feature directories warren probes for at clone refresh time (warren-4e20).
 * The seed plan (pl-2047 step 2) leaves room for the existing opt-in
 * integrations (`.mulch/`, `.canopy/`, `.pi/`) to start surfacing the same
 * way without changing the probe shape. `.seeds/` joined in warren-9990
 * to gate plan-run dispatch.
 */
export const PROJECT_FEATURE_DIRS = {
	seeds: ".seeds",
} as const;

/**
 * Result of probing a project clone for opt-in feature directories. One
 * boolean per gated integration; addProject / refreshProject persist the
 * fields to the corresponding `projects` row columns.
 */
export interface ProjectFeatureFlags {
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
		hasSeeds: exists(join(localPath, PROJECT_FEATURE_DIRS.seeds)),
	};
}

export interface RefreshProjectCloneInput {
	readonly config: ProjectsConfig;
	readonly localPath: string;
	/** Branch, tag, or SHA. Defaults to the project's tracked default branch. */
	readonly ref: string;
	/**
	 * GitHub token for private-repo access (`GITHUB_TOKEN` at the HTTP
	 * boundary). Applied to the `git fetch` spawn as a process-scoped
	 * `insteadOf` rewrite (`githubCredentialGitEnv`) so a bare `warren
	 * serve` (K8s pod, no supervisor-installed global rule) can refresh a
	 * private clone. Absent/empty → anonymous fetch, the old behavior.
	 */
	readonly token?: string;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
	readonly exists?: (path: string) => boolean;
	/**
	 * When true (default), warren detects a `core.hooksPath` convention in
	 * the project's `package.json` prepare script and applies it to the
	 * local `.git/config` so every worktree burrow creates from this clone
	 * inherits the project's pre-commit gate (warren-8f4c). Set to false
	 * when the operator opts out via `agent.skipGitHooks` in
	 * `.warren/config.yaml`.
	 */
	readonly armHooks?: boolean;
	/**
	 * Override the `readFile` implementation for `package.json` reads.
	 * Defaults to the Node.js `fs/promises` `readFile`; injectable for
	 * tests so they don't touch disk.
	 */
	readonly readFileFn?: ArmGitHooksReadFileFn;
}

export interface RefreshProjectCloneResult {
	readonly headSha: string;
	/** Echo of the resolved ref the caller asked for. */
	readonly ref: string;
	/**
	 * Feature-directory probe taken after the hard-reset to origin/<ref>
	 * (warren-4e20, warren-9990). Reflects the on-disk shape of the
	 * freshly-checked-out tree, so a `.seeds/` added (or removed) on the
	 * remote since the last refresh flips the corresponding flag on the
	 * next call. `addProject` runs the same probe right after the initial
	 * clone.
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

	// No token → no `env` key, plain inheritance (see CloneProjectInput.token).
	const credEnv = githubCredentialGitEnv(input.token);
	const netEnv = Object.keys(credEnv).length > 0 ? { env: credEnv } : {};

	await runGit(spawn, [config.gitBinary, "fetch", "--prune", "origin"], {
		cwd: localPath,
		timeoutMs,
		...netEnv,
	});

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

	// warren-8f4c: arm the project's pre-commit gate so every worktree
	// burrow creates from this clone inherits the hook. We detect
	// `core.hooksPath` from the `prepare` script in `package.json` and
	// apply it with `git config --local`. The config key lives in
	// `.git/config` (not the working tree), so it survives `git reset
	// --hard` and is shared across all worktrees via the gitCommonDir.
	// Best-effort: a missing or unreadable `package.json`, an unmatched
	// prepare script, or a failed git-config call are all silently skipped
	// so the hook setup never blocks a run.
	if (input.armHooks !== false) {
		await tryArmGitHooks({
			config,
			localPath,
			spawn,
			timeoutMs,
			readFileFn: input.readFileFn,
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

function formatStderr(result: SpawnResult): string {
	const trimmed = result.stderr.trim();
	if (trimmed !== "") return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
	return "<no stderr>";
}
