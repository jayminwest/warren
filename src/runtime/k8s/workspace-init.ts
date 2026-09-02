/**
 * The `workspace-init` init-container entrypoint (pl-829f step 15 / warren-2181,
 * design k8s-migration.md §4.2). Runs INSIDE the run pod's init container —
 * before the agent container starts — and materializes the git workspace onto
 * the shared `/workspace` emptyDir the agent then mounts.
 *
 * It is the K8s counterpart to burrow's internal worktree prep: with pod-per-run
 * there is no host clone to fork from, so the init container clones the repo
 * fresh off `WARREN_BASE_BRANCH` and carves the per-run `WARREN_BRANCH` locally
 * (never pushed until finalize, plan step 20). The clone reuses the extracted
 * `src/workspace/git/` primitives (`runGit`) so the git behavior matches the
 * LocalProvider path; only the orchestration (clone-then-branch vs. host-clone
 * worktree) differs, which is why this is a distinct entrypoint rather than a
 * call into `materializeProjectWorkspace` (whose clone path checks out the
 * *target* branch — wrong for a per-run branch that does not yet exist).
 *
 * Env contract (injected by `buildRunPod`, see `./pod-spec.ts`):
 *   - `WARREN_REPO_URL`       — origin URL to clone (https or ssh). The direct
 *     network clone is a blobless partial clone (`--filter=blob:none`,
 *     warren-3b44) so large repos initialize without a shared mirror cache.
 *   - `WARREN_BRANCH`         — per-run branch to create off the base.
 *   - `WARREN_BASE_BRANCH`    — branch the clone checks out + the per-run branch forks from.
 *   - `WARREN_WORKSPACE_PATH` — clone target (the emptyDir mount, default `/workspace`).
 *   - `WARREN_GIT_TOKEN`      — optional; from a K8s Secret. Injected into the
 *     clone URL as `x-access-token:<token>@…` (the same scheme the supervisor's
 *     git credential uses, see `.env.example`), then stripped from the remote so
 *     it never lingers in the workspace `.git/config`.
 *   - `WARREN_SEED_MANIFEST`  — optional; path to the JSON seed manifest mounted
 *     from the run's ConfigMap. When set, each entry is written into the
 *     workspace at its (posix) path after checkout.
 *   - `WARREN_REPO_CACHE_DIR` — optional; a PVC-backed dir (design §4.3, R2) the
 *     init container keeps a per-repo bare MIRROR under. When set, the workspace
 *     is materialized from a local clone of the mirror (`git fetch` on re-use,
 *     `git clone --mirror` on first sight) instead of a fresh network clone —
 *     turning cold-start clones into seconds-long local copies. Any failure in
 *     the cache path falls back to a direct network clone with a structured
 *     warning, so the cache is a pure optimization, never a hard dependency.
 *
 * The pure helpers (`parseInitEnv`, `mirrorPathFor`) are unit-tested without a
 * cluster or a real git (`authenticatedCloneUrl` now lives in
 * `src/workspace/git/clone-url.ts`); `runWorkspaceInit` takes
 * injectable git/fs seams so the orchestration is testable by recording the
 * git argv.
 *
 * ## Credential hygiene
 * The PVC mirror is shared across runs, so a token must NEVER persist in it or
 * in the run workspace: the mirror path is derived from the CLEAN (token-free)
 * repo URL; `git fetch` passes the authenticated URL as a positional argument
 * (never saved to `origin`); the mirror's saved `origin` is reset to the clean
 * URL right after `clone --mirror`; and the workspace clone's `origin` is reset
 * to the clean remote (the local mirror path is never a push target anyway).
 *
 * ## Concurrency
 * Two init containers may hit the same mirror at once. Concurrent `git fetch`
 * into one object DB is safe (git locks refs/packs). A first-sight race where
 * two pods both `clone --mirror` the same path is resolved by the loser's clone
 * failing on the non-empty dir → it falls through to a direct network clone. A
 * corrupt/partial mirror likewise fails the probe/fetch and falls back rather
 * than being blindly reused, so a bad cache entry never wedges a run.
 */

import { createHash } from "node:crypto";
import {
	mkdir as nodeMkdir,
	readFile as nodeReadFile,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { WorkspaceMaterializationError } from "../../workspace/errors.ts";
import { authenticatedCloneUrl, bareTokenCredential } from "../../workspace/git/clone-url.ts";
import { runGit } from "../../workspace/git/exec.ts";
import { parseSeedManifest } from "./seed-configmap.ts";

/** Parsed, validated view of the init container's env. */
export interface InitEnv {
	repoUrl: string;
	branch: string;
	baseBranch: string;
	workspacePath: string;
	token?: string;
	seedManifestPath?: string;
	repoCacheDir?: string;
}

/** Minimal env surface `parseInitEnv` reads. */
export type InitEnvSource = Readonly<Record<string, string | undefined>>;

function required(env: InitEnvSource, key: string): string {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") {
		throw new WorkspaceMaterializationError(`workspace-init: missing required env ${key}`, {
			recoveryHint:
				"buildRunPod injects WARREN_REPO_URL/BRANCH/BASE_BRANCH on the init container; a blank value means the RunSpec was incomplete.",
		});
	}
	return raw;
}

function nonEmpty(raw: string | undefined): string | undefined {
	const v = raw?.trim();
	return v === undefined || v === "" ? undefined : v;
}

/** Parse + validate the init container env. Pure. */
export function parseInitEnv(env: InitEnvSource): InitEnv {
	const token = nonEmpty(env.WARREN_GIT_TOKEN);
	const seedManifestPath = nonEmpty(env.WARREN_SEED_MANIFEST);
	const repoCacheDir = nonEmpty(env.WARREN_REPO_CACHE_DIR);
	return {
		repoUrl: required(env, "WARREN_REPO_URL"),
		branch: required(env, "WARREN_BRANCH"),
		baseBranch: required(env, "WARREN_BASE_BRANCH"),
		workspacePath: nonEmpty(env.WARREN_WORKSPACE_PATH) ?? "/workspace",
		...(token !== undefined ? { token } : {}),
		...(seedManifestPath !== undefined ? { seedManifestPath } : {}),
		...(repoCacheDir !== undefined ? { repoCacheDir } : {}),
	};
}

/**
 * Resolve the per-repo bare-mirror path under the PVC cache dir. Derived from a
 * SHA-256 of the CLEAN (token-free) repo URL so (a) an operator token never
 * lands in a filesystem path and (b) the same repo maps to one stable mirror
 * across runs regardless of which run's token authenticated the fetch. Pure.
 */
export function mirrorPathFor(cacheDir: string, repoUrl: string): string {
	const hash = createHash("sha256").update(repoUrl).digest("hex");
	return join(cacheDir, `${hash}.git`);
}

/** Injectable git runner — defaults to the real `runGit` over `src/workspace/git`. */
export type InitGitRunner = (
	args: string[],
	opts?: { cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Injectable fs seam so seed-file writing is testable without touching disk. */
export interface InitFs {
	mkdir: (path: string, opts: { recursive: true }) => Promise<unknown>;
	writeFile: (path: string, data: Uint8Array) => Promise<void>;
	readFile: (path: string) => Promise<string>;
}

export interface WorkspaceInitDeps {
	git?: InitGitRunner;
	fs?: InitFs;
	log?: (message: string) => void;
}

const defaultGit: InitGitRunner = (args, opts) => runGit(args, opts ?? {});
const defaultFs: InitFs = {
	mkdir: (path, opts) => nodeMkdir(path, opts),
	writeFile: (path, data) => nodeWriteFile(path, data),
	readFile: (path) => nodeReadFile(path, "utf8"),
};

async function gitOrThrow(
	git: InitGitRunner,
	args: string[],
	opts?: { cwd?: string },
): Promise<void> {
	const res = await git(args, opts);
	if (res.exitCode !== 0) {
		throw new WorkspaceMaterializationError(
			`workspace-init: git ${args.join(" ")} failed (exit ${res.exitCode}): ${
				res.stderr.trim() || res.stdout.trim()
			}`,
			{
				recoveryHint:
					"Check the init container logs; a clone failure marks the pod Init:Error before the agent starts.",
			},
		);
	}
}

/**
 * Probe whether `mirrorPath` is a usable bare git repo. Non-throwing: a missing
 * dir or corrupt/partial mirror returns `false` (git exits non-zero), so the
 * caller treats it as "absent" and re-clones rather than reusing a bad cache.
 */
async function mirrorIsUsable(git: InitGitRunner, mirrorPath: string): Promise<boolean> {
	// `--git-dir` (not `cwd`) so the probe runs from a valid working dir even when
	// the mirror path does not exist yet — a missing/corrupt mirror returns a
	// non-zero exit ("not a git repository") rather than throwing on a bad cwd.
	const res = await git(["--git-dir", mirrorPath, "rev-parse", "--is-bare-repository"]);
	return res.exitCode === 0 && res.stdout.trim() === "true";
}

/**
 * Bring the shared bare mirror at `mirrorPath` up to date, creating it on first
 * sight. Credential hygiene: `clone --mirror` embeds the auth URL in `origin`,
 * so we immediately reset it to the clean URL; subsequent `fetch` passes the
 * auth URL positionally and never persists it.
 *
 * warren-232d (accepted limit): the update refspec fetches ONLY
 * `refs/heads/*` + `refs/tags/*`, so a `baseCommit` SHA that is not reachable
 * from any branch or tag is absent from the mirror — `cloneBaseAndCarve`'s
 * `git checkout <sha>` then fails inside `materializeViaCache`, which catches
 * it and falls back to a DIRECT network clone (where the full object store
 * carries the SHA). That fallback is the documented behavior: correctness is
 * preserved at the cost of one uncached clone for unreachable-SHA replays.
 */
async function ensureMirror(
	git: InitGitRunner,
	fs: InitFs,
	cfg: InitEnv,
	mirrorPath: string,
	authUrl: string,
	log: (m: string) => void,
): Promise<void> {
	if (await mirrorIsUsable(git, mirrorPath)) {
		log(`workspace-init: updating repo-cache mirror ${mirrorPath}`);
		await gitOrThrow(
			git,
			["fetch", "--prune", authUrl, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"],
			{ cwd: mirrorPath },
		);
		return;
	}
	log(`workspace-init: creating repo-cache mirror ${mirrorPath}`);
	// `git clone` does not create missing parent dirs — ensure the cache root.
	await fs.mkdir(dirname(mirrorPath), { recursive: true });
	await gitOrThrow(git, ["clone", "--mirror", authUrl, mirrorPath]);
	if (cfg.token !== undefined) {
		// Strip the embedded token from the mirror's saved remote (shared PVC).
		await gitOrThrow(git, ["remote", "set-url", "origin", cfg.repoUrl], { cwd: mirrorPath });
	}
}

/**
 * Clone `url` into the workspace checked out at `cfg.baseBranch`, then carve
 * the per-run branch. warren-dac8: `baseBranch` may be ANY resolved ref — an
 * explicit `ref` (branch, tag, or SHA) or a ref-dispatch's `targetBranch`,
 * which ALSO pins the per-run branch (`branch === baseBranch`, warren-709e).
 * `git clone --branch` rejects a raw SHA, so fall back to a plain clone +
 * `git checkout`; and when the branch to carve IS the checked-out base, the
 * `switch -c` would collide with the clone's local branch, so skip it.
 */
async function cloneBaseAndCarve(
	git: InitGitRunner,
	cfg: InitEnv,
	url: string,
	extraCloneArgs: string[] = [],
): Promise<void> {
	const branched = await git([
		"clone",
		...extraCloneArgs,
		"--branch",
		cfg.baseBranch,
		url,
		cfg.workspacePath,
	]);
	if (branched.exitCode !== 0) {
		// SHA (or otherwise non-`--branch`-able) base ref: plain clone + checkout.
		await gitOrThrow(git, ["clone", ...extraCloneArgs, url, cfg.workspacePath]);
		await gitOrThrow(git, ["checkout", cfg.baseBranch], { cwd: cfg.workspacePath });
	}
	if (cfg.branch !== cfg.baseBranch) {
		await gitOrThrow(git, ["switch", "-c", cfg.branch], { cwd: cfg.workspacePath });
	}
}

/**
 * Materialize the workspace from the PVC-backed mirror: ensure/update the shared
 * bare mirror, then LOCAL-clone the base branch out of it into the emptyDir and
 * carve the per-run branch. The workspace `origin` is reset to the clean remote
 * so finalize pushes to GitHub, not the local mirror path. Returns `true` on
 * success; on ANY failure it logs a structured warning and returns `false` so
 * the caller falls back to a direct network clone (the cache is best-effort).
 */
async function materializeViaCache(
	git: InitGitRunner,
	fs: InitFs,
	cfg: InitEnv,
	log: (m: string) => void,
): Promise<boolean> {
	if (cfg.repoCacheDir === undefined) return false;
	const mirrorPath = mirrorPathFor(cfg.repoCacheDir, cfg.repoUrl);
	const authUrl = authenticatedCloneUrl(cfg.repoUrl, bareTokenCredential(cfg.token));
	try {
		await ensureMirror(git, fs, cfg, mirrorPath, authUrl, log);
		// Local clone from the mirror path — no network, no credentials.
		await cloneBaseAndCarve(git, cfg, mirrorPath);
		// Point origin at the real remote (the mirror path is never a push target).
		await gitOrThrow(git, ["remote", "set-url", "origin", cfg.repoUrl], { cwd: cfg.workspacePath });
		log(`workspace-init: materialized ${cfg.branch} from repo-cache mirror`);
		return true;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		log(
			`workspace-init: WARN repo-cache path failed (${reason}); falling back to a direct network clone`,
		);
		return false;
	}
}

/**
 * Direct network clone of the base branch into the workspace, carve the per-run
 * branch, and strip any embedded token from the saved remote. The original
 * (pre-cache) materialization path — also the fallback when the cache misses.
 *
 * warren-3b44: the direct clone is a BLOBLESS PARTIAL clone
 * (`--filter=blob:none` — history + trees present, blobs fetched on demand),
 * which is what lets a ~3 GB repo (openclaw) initialize in seconds-to-minutes
 * instead of the ~20-min full clone that justified the 1 TiB Filestore cache
 * (warren-8175). Deliberately NOT `--depth`: a shallow history breaks
 * base-commit pinning (warren-919a) and merge-base computation, while the
 * partial clone keeps every commit reachable and lazily fetches only the blobs
 * checkout/diff/push touch. The opt-in mirror-cache path is untouched — its
 * local clones copy from the full mirror and need no filter.
 */
async function directClone(
	git: InitGitRunner,
	cfg: InitEnv,
	log: (m: string) => void,
): Promise<void> {
	const cloneUrl = authenticatedCloneUrl(cfg.repoUrl, bareTokenCredential(cfg.token));
	log(
		`workspace-init: cloning ${cfg.repoUrl} (${cfg.baseBranch}, --filter=blob:none) into ${cfg.workspacePath}`,
	);
	await cloneBaseAndCarve(git, cfg, cloneUrl, ["--filter=blob:none"]);
	// Strip the embedded token so it never persists in the workspace .git/config.
	if (cfg.token !== undefined) {
		await gitOrThrow(git, ["remote", "set-url", "origin", cfg.repoUrl], { cwd: cfg.workspacePath });
	}
}

/**
 * Reject seed paths that would escape the workspace (absolute or `..`) — the
 * manifest is operator-authored but the pod is a trust boundary, so a
 * defensive check keeps a bad `.canopy` drop from writing outside `/workspace`.
 */
function resolveSeedTarget(workspacePath: string, seedPath: string): string {
	if (isAbsolute(seedPath) || seedPath.split("/").includes("..")) {
		throw new WorkspaceMaterializationError(
			`workspace-init: refusing seed file with unsafe path "${seedPath}"`,
			{
				recoveryHint: "seed file paths must be workspace-relative and may not traverse with '..'.",
			},
		);
	}
	return join(workspacePath, normalize(seedPath));
}

async function writeSeedFiles(cfg: InitEnv, fs: InitFs, log: (m: string) => void): Promise<void> {
	if (cfg.seedManifestPath === undefined) return;
	const raw = await fs.readFile(cfg.seedManifestPath);
	const entries = parseSeedManifest(raw);
	for (const entry of entries) {
		const target = resolveSeedTarget(cfg.workspacePath, entry.path);
		await fs.mkdir(dirname(target), { recursive: true });
		const data =
			entry.encoding === "base64"
				? Uint8Array.from(Buffer.from(entry.contents, "base64"))
				: new TextEncoder().encode(entry.contents);
		await fs.writeFile(target, data);
	}
	log(`workspace-init: wrote ${entries.length} seed file(s) into ${cfg.workspacePath}`);
}

/**
 * Materialize the workspace, then drop the seed files. When a PVC-backed repo
 * cache is configured (`WARREN_REPO_CACHE_DIR`), materialize from the shared
 * bare mirror (local clone, `git fetch` on re-use); otherwise — or if the cache
 * path fails — clone the base branch fresh over the network. Either way the
 * per-run branch is carved locally and no token persists in the workspace.
 * The workspace-touching seams (`git`, `fs`) are injectable for tests.
 */
export async function runWorkspaceInit(
	env: InitEnvSource,
	deps: WorkspaceInitDeps = {},
): Promise<InitEnv> {
	const git = deps.git ?? defaultGit;
	const fs = deps.fs ?? defaultFs;
	const log = deps.log ?? ((m: string) => console.log(m));
	const cfg = parseInitEnv(env);

	// warren-cb93: the agent process runs as a DIFFERENT uid than the entrypoint
	// (the entrypoint/agent uid split) and shares only the pod gid (fsGroup), so
	// the clone this init container materializes must be GROUP-writable —
	// otherwise the split-off agent cannot write its own workspace. Committed
	// modes are unaffected (git tracks only the exec bit).
	process.umask(0o002);

	const usedCache = await materializeViaCache(git, fs, cfg, log);
	if (!usedCache) await directClone(git, cfg, log);
	await writeSeedFiles(cfg, fs, log);
	log(`workspace-init: checked out ${cfg.branch} off ${cfg.baseBranch}`);
	return cfg;
}

if (import.meta.main) {
	runWorkspaceInit(process.env).catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
