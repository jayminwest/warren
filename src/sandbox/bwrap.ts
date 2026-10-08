/**
 * Linux: render a `bwrap` argv from a SandboxProfile + SpawnCommand.
 * Lifted from burrow's `src/provider/local/bwrap.ts` (warren-5af7).
 *
 * The host file system is invisible by default (`--unshare-all`, no mounts);
 * we then explicitly admit the system directories needed for typical
 * toolchains, a real writable HOME (warren-c865), the workspace (read-write
 * at /workspace), declared toolchain paths, and an optional SSH agent
 * socket.
 *
 * Env is *not* placed on the argv. `--setenv NAME VALUE` is world-readable via
 * `/proc/<bwrap-pid>/cmdline`, so secrets like ANTHROPIC_API_KEY would leak to
 * any process that can stat the bwrap pid (burrow-ab95). Instead the caller
 * (spawnLinux in sandbox.ts) resolves env via `resolveSandboxEnv` and hands it
 * to `Bun.spawn`'s `env` option — bwrap inherits that env and execve()s the
 * child with it, so secrets only ever live in `/proc/<pid>/environ` (mode 400,
 * private to the running uid).
 *
 * Network policy:
 *   - "open"       — share the host net namespace (`--share-net`).
 *   - "none"       — no network at all (no `--share-net`).
 *   - "restricted" — share the host net namespace so the agent can reach the
 *     host-side userspace proxy on loopback (the proxy enforces the domain
 *     allowlist). The agent's HTTP_PROXY/HTTPS_PROXY env points at that
 *     proxy. This is honor-system enforcement — a non-HTTP-aware tool can
 *     still reach the host network. With `proxyAddress` unset we fall back
 *     to deny-all (no `--share-net`) so callers can declare intent today.
 */

import type { SandboxProfile, SpawnCommand } from "./types.ts";

export const SYSTEM_RO_MOUNTS: readonly string[] = [
	"/usr",
	"/etc",
	"/lib",
	"/lib64",
	"/bin",
	"/sbin",
	"/opt",
];

/**
 * Path the profile's `home` host directory is bound at inside the sandbox
 * (warren-c865). Constant so the env resolver can point $HOME at it without
 * knowing the host path. Deliberately outside /workspace: harness state
 * (.claude/, .pi/sessions/) must not land in the git worktree.
 */
export const SANDBOX_HOME_PATH = "/home/sandbox";

/**
 * Default uid/gid the sandboxed process runs as when `SandboxProfile.runAsUid`
 * / `runAsGid` aren't set. Anything non-zero would do — 1000 is the conventional
 * "first interactive user" id and what most distro images use, so workspace
 * tooling that hardcodes uid==1000 (e.g. /home/user paths) keeps working.
 */
export const DEFAULT_SANDBOX_UID = 1000;
export const DEFAULT_SANDBOX_GID = 1000;

export interface BuildBwrapOptions {
	/** Override the bwrap binary (testing or non-PATH installs). */
	bwrapBin?: string;
}

/**
 * Read-only shared object store, the writable private git dir, then its
 * re-protected files (warren-3c1e). The rest of the host clone's git dir is
 * never mounted.
 */
function workspaceGitBinds(profile: SandboxProfile): string[] {
	const git = profile.workspaceGit;
	if (git === undefined) return [];
	const out = ["--ro-bind", git.sharedObjects, git.sharedObjects, "--bind", git.gitDir, git.gitDir];
	for (const path of git.protectedPaths) out.push("--ro-bind", path, path);
	return out;
}

export function buildBwrapArgv(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: BuildBwrapOptions = {},
): string[] {
	const argv: string[] = [options.bwrapBin ?? "bwrap"];

	argv.push("--unshare-all");
	if (profile.network === "open") argv.push("--share-net");
	else if (profile.network === "restricted" && profile.proxyAddress) argv.push("--share-net");
	argv.push("--die-with-parent");

	// Force the sandboxed pid 1 to a non-root uid/gid inside the userns. Without
	// this the new userns inherits the caller's uid mapping; when warren runs
	// as host root (the Dockerized posture) the agent sees getuid()==0 and
	// tooling like claude-code refuses to run.
	argv.push("--uid", String(profile.runAsUid ?? DEFAULT_SANDBOX_UID));
	argv.push("--gid", String(profile.runAsGid ?? DEFAULT_SANDBOX_GID));

	argv.push("--proc", "/proc");
	argv.push("--dev", "/dev");
	argv.push("--tmpfs", "/tmp");

	for (const path of SYSTEM_RO_MOUNTS) {
		argv.push("--ro-bind-try", path, path);
	}

	for (const path of profile.toolchainPaths) {
		argv.push("--ro-bind", path, path);
	}

	if (profile.sshAuthSock) {
		argv.push("--ro-bind", profile.sshAuthSock, profile.sshAuthSock);
	}

	for (const path of profile.readOnlyMounts) {
		argv.push("--ro-bind", path, path);
	}

	// The workspace's `.git` file points at the run's private git dir, outside
	// the /workspace bind, so mount it at the same path (burrow-7a80). It is
	// the run's own (warren-3c1e): refs, packed-refs + its lock, logs, index,
	// and new objects are all writable, so ref updates and deletions work as
	// on macOS. Its `config` and `objects/info/alternates` are re-bound
	// read-only, and the host clone's `objects/` (the alternate) is read-only.
	// Order matters: nested binds follow the parent.
	argv.push(...workspaceGitBinds(profile));

	// Real writable HOME, separate from the workspace (warren-c865). Bound
	// before /workspace so a workspace nested under the host home path can
	// never shadow it. $HOME is pointed here by resolveSandboxEnv.
	argv.push("--bind", profile.home, SANDBOX_HOME_PATH);

	argv.push("--bind", profile.workspace, "/workspace");

	const cwd = resolveCwd(command.cwd);
	argv.push("--chdir", cwd);

	// Env is delivered via the bwrap process's own environment (set by
	// spawnLinux's Bun.spawn `env` option), not via `--setenv` argv. See the
	// module-level docstring + burrow-ab95.

	argv.push("--", ...command.argv);
	return argv;
}

function resolveCwd(cwd: string | undefined): string {
	if (!cwd) return "/workspace";
	if (cwd.startsWith("/")) return cwd;
	return `/workspace/${cwd}`;
}
