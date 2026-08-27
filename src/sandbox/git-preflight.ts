/**
 * Sandbox git preflight (warren-1219, plan pl-26f3 step 6).
 *
 * Verifies that the git binary a run would use actually EXECUTES inside the
 * composed sandbox profile — the same toolchain mounts and hardened PATH a
 * real LocalProvider run gets — by running `git --version` through
 * `runSandboxed` and checking the exit code.
 *
 * Why: on macOS a nix-provided git resolved first on the server PATH but
 * its dylibs sat outside the sandbox profile's readable paths, so every
 * git invocation inside the run died with a dyld "Library not loaded"
 * error, the agent still completed, and the run reaped failed/dropped_commit
 * — $0.16 spent to discover a config problem. This probe surfaces that at
 * project-add time and `warren doctor --local` instead, as a typed error
 * naming the resolved binary (never a console.log).
 *
 * macOS resilience (issue part 3): when the PATH-resolved git fails the
 * probe but /usr/bin/git passes, /usr/bin/git is preferred for the sandbox
 * toolchain going forward — exported through `WARREN_SANDBOX_GIT`, which
 * `resolveToolchainPaths` (src/runtime/local/profile.ts) honors — so a
 * fresh Mac with an exotic nix/homebrew git is not broken by default.
 *
 * Only the LocalProvider topology sandboxes on the host: docker/k8s callers
 * simply never invoke this probe.
 */

import { existsSync, mkdirSync as fsMkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WarrenError } from "../core/errors.ts";
import { type RunSandboxedOptions, runSandboxed } from "./sandbox.ts";
import type { SandboxProfile, SpawnCommand } from "./types.ts";

/** Env knob: force the git binary the sandbox toolchain resolves + mounts. */
export const WARREN_SANDBOX_GIT_ENV = "WARREN_SANDBOX_GIT";

export const SANDBOX_GIT_PREFLIGHT_TIMEOUT_MS = 10_000;

const INSTALL_HINT =
	"this git cannot run inside the sandbox; install a system git " +
	"(/usr/bin/git on macOS) or adjust PATH before booting warren, or set " +
	`${WARREN_SANDBOX_GIT_ENV}=/path/to/git to pin a working binary`;

/**
 * Typed preflight failure (issue part 2): carries the resolved binary path
 * and the underlying exec/dyld detail. Maps to HTTP 503 at the server
 * boundary — the fix is on the host, not in the request.
 */
export class SandboxGitPreflightError extends WarrenError {
	readonly code = "sandbox_git_preflight";
	/** The PATH-resolved git binary that failed to execute. */
	readonly gitPath: string;
	/** Raw exec/dyld detail from inside the sandbox. */
	readonly detail: string;

	constructor(gitPath: string, detail: string) {
		super(
			`sandbox git preflight failed: ${gitPath} does not execute inside the sandbox: ${detail}`,
			{
				recoveryHint: INSTALL_HINT,
			},
		);
		this.gitPath = gitPath;
		this.detail = detail;
		this.name = "SandboxGitPreflightError";
	}
}

export interface SandboxGitPreflightResult {
	readonly ok: boolean;
	/** The PATH-resolved (or env-pinned) git that was probed. */
	readonly gitPath: string;
	/** The git the sandbox toolchain should use going forward. */
	readonly effectiveGit: string;
	/** True when the PATH-resolved git failed but /usr/bin/git was substituted. */
	readonly substituted: boolean;
	/** Human-facing outcome: success message or the failure detail. */
	readonly message: string;
	readonly hint?: string;
}

export interface SandboxGitPreflightDeps {
	/** Test seam for binary resolution. Defaults to `Bun.which`. */
	readonly which?: (name: string) => string | null;
	/** Env to read `WARREN_SANDBOX_GIT` from. Defaults to `process.env`. */
	readonly env?: Record<string, string | undefined>;
	/** Override the host platform (testing the darwin fallback on Linux). */
	readonly platform?: NodeJS.Platform;
	readonly timeoutMs?: number;
	/** Defaults to `os.tmpdir()`. */
	readonly tmpRoot?: string;
	/** Test seam for filesystem existence checks. Defaults to `existsSync`. */
	readonly exists?: (path: string) => boolean;
	/** Test seam replacing the real sandboxed spawn. */
	readonly spawnSandbox?: typeof runSandboxed;
	/** Seams forwarded to `runSandboxed` (tests pin the wrapper binaries). */
	readonly sandboxOptions?: RunSandboxedOptions;
}

interface GitProbeOutcome {
	readonly ok: boolean;
	readonly output: string;
}

/**
 * Probe that one git binary executes inside the composed sandbox profile.
 * Composes a minimal `SandboxProfile` with the same toolchain-mount shape
 * `buildLocalSandboxProfile` produces for git (bin dir + realpath dir +
 * the bun install root), then runs bare-name `git --version` so the
 * hardened PATH resolution a real run uses is exercised too.
 */
/** Resolve the git binary to probe: env pin first, then PATH. */
function resolveProbedGit(
	env: Record<string, string | undefined>,
	which: (name: string) => string | null,
): string | null {
	const pinned = env[WARREN_SANDBOX_GIT_ENV];
	if (typeof pinned === "string" && pinned !== "") return pinned;
	const found = which("git");
	return found !== null && found !== "" ? found : null;
}

/**
 * macOS resilience (warren-1219 part 3): a PATH-resolved git whose dylibs
 * sit outside the seatbelt-readable paths is the exact spike failure. When
 * /usr/bin/git passes, prefer it for the sandbox toolchain and record the
 * substitution on the process env so subsequent profile compositions
 * (`resolveToolchainPaths`) pick it up.
 */
async function tryDarwinSystemGitSubstitution(
	gitPath: string,
	primary: GitProbeOutcome,
	deps: SandboxGitPreflightDeps,
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): Promise<SandboxGitPreflightResult | null> {
	const systemGit = "/usr/bin/git";
	if (platform !== "darwin" || gitPath === systemGit) return null;
	if (!(deps.exists ?? existsSync)(systemGit)) return null;
	const fallback = await runGitProbe(systemGit, deps);
	if (!fallback.ok) return null;
	if (env === process.env) process.env[WARREN_SANDBOX_GIT_ENV] = systemGit;
	return {
		ok: true,
		gitPath,
		effectiveGit: systemGit,
		substituted: true,
		message:
			`resolved git ${gitPath} failed inside the sandbox (${primary.output.trim()}); ` +
			`substituted ${systemGit} for the sandbox toolchain`,
		hint: `set ${WARREN_SANDBOX_GIT_ENV}=${systemGit} at boot to make this permanent`,
	};
}

export async function probeSandboxGit(
	deps: SandboxGitPreflightDeps = {},
): Promise<SandboxGitPreflightResult> {
	const env = deps.env ?? process.env;
	const which = deps.which ?? ((name: string) => Bun.which(name));
	const platform = deps.platform ?? process.platform;

	const gitPath = resolveProbedGit(env, which);
	if (gitPath === null) {
		return {
			ok: false,
			gitPath: "git",
			effectiveGit: "git",
			substituted: false,
			message: "no git binary found on PATH — the sandbox has nothing to probe",
			hint: "install git (e.g. /usr/bin/git) before dispatching local runs",
		};
	}

	// A missing sandbox wrapper (bwrap / sandbox-exec) is its own doctor
	// check's failure — blaming git for it would be misleading. Degrade to
	// an ok "skipped" line so the wrapper check stays the single signal.
	const wrapper = platform === "linux" ? "bwrap" : platform === "darwin" ? "sandbox-exec" : null;
	if (wrapper !== null && which(wrapper) === null) {
		return {
			ok: true,
			gitPath,
			effectiveGit: gitPath,
			substituted: false,
			message: `skipped: no ${wrapper} sandbox wrapper on PATH — see the ${wrapper} check`,
		};
	}

	const primary = await runGitProbe(gitPath, deps);
	if (primary.ok) {
		return {
			ok: true,
			gitPath,
			effectiveGit: gitPath,
			substituted: false,
			message: `${gitPath} executes inside the sandbox profile (git --version ok)`,
		};
	}

	const substituted = await tryDarwinSystemGitSubstitution(gitPath, primary, deps, env, platform);
	if (substituted !== null) return substituted;

	return {
		ok: false,
		gitPath,
		effectiveGit: gitPath,
		substituted: false,
		message: `${gitPath} does not execute inside the sandbox: ${primary.output.trim()}`,
		hint: INSTALL_HINT,
	};
}

/** Throw the typed error when the result failed; return it otherwise. */
export function assertSandboxGit(result: SandboxGitPreflightResult): SandboxGitPreflightResult {
	if (!result.ok) throw new SandboxGitPreflightError(result.gitPath, result.message);
	return result;
}

let cachedPreflight: Promise<SandboxGitPreflightResult> | undefined;

/**
 * Boot-cached wrapper: the probe shells out through a real sandbox, so
 * project registration reuses the first result for the process lifetime
 * (the issue asks for "cheap, cached per boot").
 */
export function sandboxGitPreflightCached(
	deps: SandboxGitPreflightDeps = {},
): Promise<SandboxGitPreflightResult> {
	cachedPreflight ??= probeSandboxGit(deps);
	return cachedPreflight;
}

/** Test seam: drop the per-boot cache. */
export function resetSandboxGitPreflightCache(): void {
	cachedPreflight = undefined;
}

async function runGitProbe(
	gitBin: string,
	deps: SandboxGitPreflightDeps,
): Promise<GitProbeOutcome> {
	const spawnSandbox = deps.spawnSandbox ?? runSandboxed;
	const timeoutMs = deps.timeoutMs ?? SANDBOX_GIT_PREFLIGHT_TIMEOUT_MS;
	const tmpRoot = deps.tmpRoot ?? tmpdir();

	const root = mkdtempSync(join(tmpRoot, "warren-git-preflight-"));
	const workspace = join(root, "workspace");
	const home = join(root, "home");
	mkdir(workspace);
	mkdir(home);
	try {
		const profile: SandboxProfile = {
			workspace,
			home,
			readOnlyMounts: [],
			network: "none",
			allowedDomains: [],
			envPassthrough: [],
			setEnv: {},
			toolchainPaths: gitToolchainPaths(gitBin, deps.exists ?? existsSync),
		};
		const command: SpawnCommand = { argv: ["git", "--version"], timeoutMs };
		const child = await spawnSandbox(profile, command, deps.sandboxOptions ?? {});
		const output = await drainWithTimeout(child, timeoutMs);
		return { ok: output.exitCode === 0, output: output.text };
	} catch (err) {
		return { ok: false, output: err instanceof Error ? err.message : String(err) };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

interface DrainedProbe {
	readonly exitCode: number;
	readonly text: string;
}

async function drainWithTimeout(
	child: Awaited<ReturnType<typeof runSandboxed>>,
	timeoutMs: number,
): Promise<DrainedProbe> {
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.cancel();
	}, timeoutMs);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			streamText(child.stdout),
			streamText(child.stderr),
		]);
		const text = `${stderr.trim()}\n${stdout.trim()}`.trim();
		if (timedOut) {
			return { exitCode: -1, text: text === "" ? `probe timed out after ${timeoutMs}ms` : text };
		}
		return { exitCode, text: text === "" ? `(no output, exit ${exitCode})` : text };
	} finally {
		clearTimeout(timer);
	}
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
	try {
		return await new Response(stream).text();
	} catch {
		return "";
	}
}

/**
 * Host paths the profile must mount + PATH-prepend for the probed git:
 * the bin dir carrying the name, the realpath target's dir (nix/nix store
 * symlinks), and the bun install root — the same shape
 * `resolveToolchainPaths` produces for git in a real run.
 */
function gitToolchainPaths(gitBin: string, exists: (path: string) => boolean): string[] {
	const dirs: string[] = [];
	const seen = new Set<string>();
	const add = (dir: string): void => {
		if (dir === "" || dir === "." || seen.has(dir)) return;
		seen.add(dir);
		dirs.push(dir);
	};
	add(dirname(gitBin));
	try {
		const target = realpathSync(gitBin);
		if (target !== gitBin) add(dirname(target));
	} catch {
		// unresolvable symlink — the name dir above is the best we can do
	}
	const bunInstall = process.env.BUN_INSTALL;
	const installRoot =
		bunInstall !== undefined && bunInstall !== "" ? bunInstall : join(homedir(), ".bun");
	if (exists(installRoot)) add(installRoot);
	return dirs;
}

function mkdir(path: string): void {
	fsMkdirSync(path, { recursive: true });
}
