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
 *   - `WARREN_REPO_URL`       — origin URL to clone (https or ssh).
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
 *
 * The pure helpers (`parseInitEnv`, `authenticatedCloneUrl`) are unit-tested
 * without a cluster or a real git; `runWorkspaceInit` takes injectable git/fs
 * seams so the orchestration is testable by recording the git argv.
 */

import {
	mkdir as nodeMkdir,
	readFile as nodeReadFile,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { WorkspaceMaterializationError } from "../../workspace/errors.ts";
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
	return {
		repoUrl: required(env, "WARREN_REPO_URL"),
		branch: required(env, "WARREN_BRANCH"),
		baseBranch: required(env, "WARREN_BASE_BRANCH"),
		workspacePath: nonEmpty(env.WARREN_WORKSPACE_PATH) ?? "/workspace",
		...(token !== undefined ? { token } : {}),
		...(seedManifestPath !== undefined ? { seedManifestPath } : {}),
	};
}

/**
 * Inject a git token into an https clone URL as `x-access-token:<token>@host`
 * (GitHub's app-token scheme, matching the supervisor's `insteadOf` credential).
 * Left untouched for ssh/other schemes or a URL that already carries credentials,
 * and when no token is supplied (public repos clone anonymously). Pure.
 */
export function authenticatedCloneUrl(repoUrl: string, token?: string): string {
	if (token === undefined || token === "") return repoUrl;
	const prefix = "https://";
	if (!repoUrl.startsWith(prefix)) return repoUrl;
	const rest = repoUrl.slice(prefix.length);
	// `@` before the first `/` means the authority already has userinfo.
	const authority = rest.split("/", 1)[0] ?? "";
	if (authority.includes("@")) return repoUrl;
	return `${prefix}x-access-token:${token}@${rest}`;
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
 * Materialize the workspace: clone the base branch fresh, carve the per-run
 * branch locally, strip any token from the remote, then drop the seed files.
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

	const cloneUrl = authenticatedCloneUrl(cfg.repoUrl, cfg.token);
	log(`workspace-init: cloning ${cfg.repoUrl} (${cfg.baseBranch}) into ${cfg.workspacePath}`);
	await gitOrThrow(git, ["clone", "--branch", cfg.baseBranch, cloneUrl, cfg.workspacePath]);
	await gitOrThrow(git, ["switch", "-c", cfg.branch], { cwd: cfg.workspacePath });
	// Strip the embedded token so it never persists in the workspace .git/config.
	if (cfg.token !== undefined) {
		await gitOrThrow(git, ["remote", "set-url", "origin", cfg.repoUrl], { cwd: cfg.workspacePath });
	}
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
