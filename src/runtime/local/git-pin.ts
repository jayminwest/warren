/**
 * Run-workspace git pinning and sealing for the local engine (warren-8926,
 * warren-3c1e).
 *
 * At create, before the agent runs, `pinWorkspaceGit` validates the fresh
 * private git dir and registers a host-git pin that REFUSES every call:
 * while the agent can write the dir, host git must not read it.
 *
 * Once the agent has exited, `sealWorkspaceGit`:
 *
 *   1. stops every agent process (`stopAgentProcess`: the macOS process
 *      group, the bwrap namespace, the docker container),
 *   2. moves the dir from `gitdirs/<id>` to `gitdirs-sealed/<id>`, which no
 *      sandbox grant reaches,
 *   3. checks and sanitizes it once (`src/sandbox/git-seal.ts`),
 *   4. re-pins host git to the sealed dir with no per-call check.
 *
 * The seal is idempotent and runs again from the on-disk manifest when a
 * restarted server reaps a run it no longer holds in memory.
 */

import { lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { WarrenError } from "../../core/errors.ts";
import {
	type PrivateGitScope,
	privateGitScopeFor,
	resolvePrivateGitScope,
	WorkspaceGitScopeError,
} from "../../sandbox/git-scope.ts";
import { type SealCheckReport, sealCheckPrivateGitDir } from "../../sandbox/git-seal.ts";
import type { SpawnResult } from "../../sandbox/types.ts";
import {
	registerWorkspaceGitPin,
	unregisterWorkspaceGitPin,
	workspaceGitPinFor,
} from "../../workspace/git/host-git.ts";
import type { MaterializedWorkspaceSource } from "../../workspace/materialize.ts";
import { type LocalStateRoots, localGitDirPath, localSealedGitDirPath } from "./paths.ts";

/**
 * A pre-warren-3c1e manifest: the run is a `git worktree` of the shared host
 * clone. Host git no longer runs against those, so reap names the reason.
 */
export class LegacyWorkspaceGitError extends WarrenError {
	readonly code = "legacy_worktree_workspace";
}

type PrivateSource = MaterializedWorkspaceSource & {
	gitDir: string;
	gitCommonDir: string;
	gitConfigSha256: string;
};

function requirePrivate(workspacePath: string, source: MaterializedWorkspaceSource): PrivateSource {
	if (source.kind === "worktree") {
		throw new LegacyWorkspaceGitError(
			`git scope: ${workspacePath} is a shared-clone worktree from before warren-3c1e; ` +
				"warren no longer runs host git against it",
			{
				recoveryHint:
					`its branch '${source.branch}' is still in the host clone` +
					`${source.hostClonePath !== undefined ? ` at ${source.hostClonePath}` : ""}; ` +
					"push it by hand to keep the work, then re-dispatch",
			},
		);
	}
	if (
		source.kind !== "private" ||
		source.gitDir === undefined ||
		source.gitCommonDir === undefined ||
		source.gitConfigSha256 === undefined
	) {
		throw new WorkspaceGitScopeError(
			`git scope: ${workspacePath} is a ${source.kind}-backed workspace; local runs require a private git dir over a host clone`,
			{ recoveryHint: "register the project so its host clone exists before dispatching" },
		);
	}
	return source as PrivateSource;
}

function refuseUnsealed(workspacePath: string): () => void {
	return () => {
		throw new WorkspaceGitScopeError(
			`git scope: host git refused for ${workspacePath}: the run's git dir is not sealed yet`,
			{ recoveryHint: "host git runs only after the agent has exited and the dir is sealed" },
		);
	};
}

/**
 * Validate the fresh private git dir (before the agent runs) and register a
 * pin that refuses host git until the dir is sealed.
 */
export function pinWorkspaceGit(
	workspacePath: string,
	source: MaterializedWorkspaceSource,
): PrivateGitScope {
	const src = requirePrivate(workspacePath, source);
	const scope = resolvePrivateGitScope({
		workspacePath,
		gitDir: src.gitDir,
		hostGitDir: src.gitCommonDir,
		configSha256: src.gitConfigSha256,
	});
	registerWorkspaceGitPin(workspacePath, {
		gitDir: scope.gitDir,
		commonDir: scope.gitDir,
		verify: refuseUnsealed(workspacePath),
	});
	return scope;
}

/**
 * Stop every process of a sandboxed child and wait for it: the spawn seam's
 * `cancel` kills the macOS process group, the bwrap namespace, or the docker
 * container, and `exited` settles once that teardown is done.
 */
export async function stopAgentProcess(
	proc: SpawnResult | null | undefined,
	timeoutMs = 30_000,
): Promise<void> {
	if (proc === undefined || proc === null) return;
	proc.cancel();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new WorkspaceGitScopeError("git scope: agent did not exit before the seal")),
			timeoutMs,
		);
	});
	try {
		await Promise.race([proc.exited.catch(() => 0), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export interface SealWorkspaceGitInput {
	readonly workspacePath: string;
	readonly source: MaterializedWorkspaceSource;
	/** Where the dir moves (`gitdirs-sealed/<id>`). */
	readonly sealedGitDir: string;
	/** Stop every agent process before the move. */
	readonly stopAgent?: () => Promise<void>;
}

function isRealDir(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

async function sealOnce(input: SealWorkspaceGitInput): Promise<SealCheckReport | null> {
	const { workspacePath } = input;
	if (input.source.kind === "clone") return null;
	const src = requirePrivate(workspacePath, input.source);
	// Canonical, like the live dir: the scope check and Seatbelt need real paths.
	mkdirSync(dirname(input.sealedGitDir), { recursive: true, mode: 0o700 });
	const sealedGitDir = join(
		realpathSync(dirname(input.sealedGitDir)),
		basename(input.sealedGitDir),
	);
	if (workspaceGitPinFor(workspacePath)?.gitDir === sealedGitDir) return null;
	await input.stopAgent?.();
	if (!isRealDir(sealedGitDir)) {
		if (!isRealDir(src.gitDir)) {
			throw new WorkspaceGitScopeError(`git scope: ${src.gitDir} is not a real directory`);
		}
		renameSync(src.gitDir, sealedGitDir);
	}
	const scope = privateGitScopeFor({
		gitDir: sealedGitDir,
		hostGitDir: src.gitCommonDir,
		configSha256: src.gitConfigSha256,
	});
	const report = await sealCheckPrivateGitDir(scope);
	registerWorkspaceGitPin(workspacePath, { gitDir: sealedGitDir, commonDir: sealedGitDir });
	return report;
}

const inFlight = new Map<string, Promise<SealCheckReport | null>>();

/**
 * Seal the run's private git dir and pin host git to it. Idempotent and
 * single-flight per workspace. Returns the seal-check report, or `null`
 * when the workspace was already sealed in this process (or is clone-backed).
 */
export function sealWorkspaceGit(input: SealWorkspaceGitInput): Promise<SealCheckReport | null> {
	const key = input.workspacePath;
	const running = inFlight.get(key);
	if (running !== undefined) return running;
	const next = sealOnce(input).finally(() => inFlight.delete(key));
	inFlight.set(key, next);
	return next;
}

/**
 * Seal a local run's git dir from its manifest: stop `proc` (when this
 * process still holds it), move the dir to `gitdirs-sealed/<id>`, check it.
 */
export function sealLocalRun(
	roots: LocalStateRoots,
	sandboxId: string,
	manifest: { readonly workspacePath: string; readonly source: MaterializedWorkspaceSource },
	proc: SpawnResult | null | undefined,
): Promise<SealCheckReport | null> {
	return sealWorkspaceGit({
		workspacePath: manifest.workspacePath,
		source: manifest.source,
		sealedGitDir: localSealedGitDirPath(roots, sandboxId),
		stopAgent: () => stopAgentProcess(proc),
	});
}

export function unpinWorkspaceGit(workspacePath: string): void {
	unregisterWorkspaceGitPin(workspacePath);
}

/** Best-effort removal of a run's private git dir, live and sealed. */
export async function removeRunGitDirs(roots: LocalStateRoots, sandboxId: string): Promise<void> {
	for (const dir of [localGitDirPath(roots, sandboxId), localSealedGitDirPath(roots, sandboxId)]) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
