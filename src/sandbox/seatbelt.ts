/**
 * macOS: render a sandbox-exec (Seatbelt) profile and argv from a
 * SandboxProfile + SpawnCommand. Lifted from burrow's
 * `src/provider/local/seatbelt.ts` (warren-5af7).
 *
 * The .sb language is SBPL, a Scheme dialect. We start from `(deny default)`
 * and grant only what's needed: stable system reads (/usr, /System, /Library,
 * /bin, /sbin, /private/etc), a real writable HOME separate from the
 * workspace (warren-c865), the workspace (read+write), declared toolchain
 * paths (literal allow), and an optional SSH agent socket.
 *
 * Network policy:
 *   - "open"       — `(allow network*)`.
 *   - "none"       — no rule (default deny).
 *   - "restricted" — only loopback to `profile.proxyAddress` is permitted.
 *     A per-run userspace proxy runs host-side and enforces the
 *     `allowedDomains` allowlist. DNS happens host-side in the proxy, so
 *     the sandbox never needs mDNSResponder access. The run dispatcher sets
 *     `proxyAddress` per-run before rendering — when it's missing,
 *     restricted mode falls back to deny-everything.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile, SpawnCommand } from "./types.ts";

export const SYSTEM_READ_SUBPATHS: readonly string[] = [
	"/usr",
	"/System",
	"/Library",
	"/bin",
	"/sbin",
	"/private/etc",
	"/private/var/db",
	"/private/var/select",
	"/dev",
];

export interface BuildSeatbeltArgvOptions {
	/** Override the sandbox-exec binary (testing or non-PATH installs). */
	sandboxExecBin?: string;
}

export interface BuildSeatbeltProfileOptions {
	/**
	 * Active Xcode developer dir (`xcode-select -p`). `undefined` resolves it
	 * on the host (cached per process); `null` means the lookup failed. Tests
	 * inject it so they never shell out.
	 */
	developerDir?: string | null;
}

export function buildSeatbeltProfile(
	profile: SandboxProfile,
	options: BuildSeatbeltProfileOptions = {},
): string {
	const lines: string[] = [];
	lines.push(";; warren sandbox profile — lifted from burrow (warren-5af7)");
	lines.push("(version 1)");
	lines.push("(deny default)");

	lines.push("(allow process-fork)");
	lines.push("(allow process-exec)");
	lines.push("(allow signal (target self))");
	lines.push("(allow sysctl-read)");
	lines.push("(allow mach-lookup)");
	lines.push("(allow ipc-posix-shm)");
	lines.push("(allow iokit-open)");
	// stat / getcwd traversal must succeed across the host fs even when data
	// reads are denied — otherwise tools like /bin/sh fail to even resolve cwd.
	lines.push("(allow file-read-metadata)");
	// dyld stats `/` early in process bringup; without this, every spawn aborts.
	lines.push('(allow file-read* (literal "/"))');

	for (const path of SYSTEM_READ_SUBPATHS) {
		lines.push(`(allow file-read* (subpath ${sbString(path)}))`);
	}

	for (const path of profile.toolchainPaths) {
		lines.push(`(allow file-read* (subpath ${sbString(path)}))`);
	}

	for (const path of profile.readOnlyMounts) {
		lines.push(`(allow file-read* (subpath ${sbString(path)}))`);
	}

	// Host bun install root (warren-bea7). bun's `bun run` path and the
	// bun-shebang stubs under ~/.bun/bin resolve the real user's ~/.bun via
	// getpwuid, not $HOME — which the sandbox rewrites to profile.home. Without
	// a read grant here every `bun run <script>` fails with
	// CouldntReadCurrentDirectory and sd/ml (global bun installs) are unusable.
	// Keep the grant scoped to the install root, never the whole host home.
	// Canonicalize so seatbelt's path match doesn't miss a symlinked install.
	lines.push(`(allow file-read* (subpath ${sbString(realpathOrSelf(resolveHostBunInstall()))}))`);

	// Xcode developer bundle (warren-11e6, gh #1303). /usr/bin/git is an xcrun
	// shim that dlopens libxcrun from the active developer dir, then runs the
	// real git, which reads its gitconfig under Developer/ and frameworks under
	// SharedFrameworks/. With full Xcode that dir lives in /Applications, which
	// the system grants above do not cover, so git dies in-sandbox. Grant read
	// on the bundle's Contents only, never /Applications.
	const developerDir =
		options.developerDir === undefined ? resolveHostDeveloperDir() : options.developerDir;
	const xcodeContents = xcodeBundleContents(developerDir);
	if (xcodeContents !== null) {
		lines.push(`(allow file-read* (subpath ${sbString(xcodeContents)}))`);
	}

	lines.push(
		`(allow file-read-data file-read-metadata file-write* (subpath ${sbString(profile.workspace)}))`,
	);

	// Real writable HOME, separate from the workspace (warren-c865). Harness
	// state (.claude/, .pi/sessions/) lives here so it never lands in the git
	// worktree. $HOME is pointed at this path by resolveSandboxEnv.
	lines.push(
		`(allow file-read-data file-read-metadata file-write* (subpath ${sbString(profile.home)}))`,
	);

	// /private/tmp and /private/var/folders need read+write, not write-only.
	// claude-code's Bash tool writes command output under /tmp/claude-${uid}/...
	// (which resolves to /private/tmp via the /tmp symlink) and reads it back;
	// without file-read* the read-back fails with EPERM and claude misreports
	// it as a startup-cleanup race. /private/var/folders is the macOS per-user
	// temp dir — same asymmetry would bite anything that round-trips through
	// $TMPDIR (burrow-8452).
	lines.push('(allow file-read* file-write* (subpath "/private/tmp"))');
	lines.push('(allow file-read* file-write* (subpath "/private/var/folders"))');
	// /dev is read-allowed via SYSTEM_READ_SUBPATHS but writes are denied,
	// which breaks every shell redirect (zsh/bash `2>/dev/null`). Allow writes
	// to the universal sinks; do NOT broaden to /dev (would expose disk
	// devices and kernel entry points).
	lines.push('(allow file-write* (literal "/dev/null"))');
	lines.push('(allow file-write* (literal "/dev/dtracehelper"))');

	if (profile.sshAuthSock) {
		lines.push(`(allow file-read* file-write-data (literal ${sbString(profile.sshAuthSock)}))`);
	}

	// Emitted after every broad grant: SBPL applies the LAST matching rule, so
	// the git denies below hold even when the clone sits under /private/tmp.
	lines.push(...renderWorkspaceGitRules(profile));

	lines.push(...renderNetworkRules(profile));

	return `${lines.join("\n")}\n`;
}

/**
 * Worktree-backed workspaces carry a `.git` *file* whose `gitdir:` points at
 * `<gitCommonDir>/worktrees/<id>`, outside the workspace subpath. Read on the
 * common dir lets the pointer dereference so the agent can run `git commit`
 * in its workspace (burrow-7a80). Write is granted only on the validated
 * carve-outs (own admin dir, objects/refs/logs, plus the packed-refs literals
 * git locks during ref updates); the admin dir's binding/config files are
 * denied again (warren-8926). Seatbelt resolves symlinks and refuses hard
 * links and renames onto a denied path, so a carve-out cannot write through.
 */
function renderWorkspaceGitRules(profile: SandboxProfile): string[] {
	const common = profile.workspaceGitdir;
	if (!common) return [];
	const rw = "file-read-data file-read-metadata file-write*";
	const out = [
		`(allow file-read-data file-read-metadata (subpath ${sbString(common)}))`,
		`(deny file-write* (subpath ${sbString(common)}))`,
	];
	for (const name of ["packed-refs", "packed-refs.lock"]) {
		out.push(`(allow ${rw} (literal ${sbString(join(common, name))}))`);
	}
	for (const path of profile.workspaceGitWritable ?? []) {
		out.push(`(allow ${rw} (subpath ${sbString(path)}))`);
		// A subpath grant also matches the root itself: forbid renaming or
		// removing the carve-out root so it cannot be swapped for another dir
		// (bwrap/docker get this for free — each root is a mount point).
		out.push(`(deny file-write-unlink (literal ${sbString(path)}))`);
	}
	for (const path of profile.workspaceGitProtected ?? []) {
		out.push(`(deny file-write* (subpath ${sbString(path)}))`);
	}
	return out;
}

export function buildSeatbeltArgv(
	profilePath: string,
	command: SpawnCommand,
	options: BuildSeatbeltArgvOptions = {},
): string[] {
	const bin = options.sandboxExecBin ?? "sandbox-exec";
	return [bin, "-f", profilePath, ...command.argv];
}

function renderNetworkRules(profile: SandboxProfile): string[] {
	if (profile.network === "open") return ["(allow network*)"];
	if (profile.network === "none") return [];

	// network=restricted. The host-side userspace proxy enforces the
	// allowlist; sandbox-exec only needs to permit loopback to that endpoint.
	// Without a proxyAddress we leave the rules empty — the legacy hostname
	// regex was a no-op (sandbox-exec matches against the resolved IP, not
	// the hostname) and silently denied everything; explicit deny is at
	// least honest.
	//
	// `(remote tcp ...)` only accepts `localhost` or `*` as the host token in
	// sandbox-exec's grammar (numeric IPs raise `host must be * or localhost
	// in network address`). `localhost` covers both `127.0.0.1` and `::1`,
	// which is what client connections to the loopback proxy will resolve to.
	const proxy = profile.proxyAddress;
	if (!proxy) return [];
	return [`(allow network-outbound (remote tcp ${sbString(`localhost:${proxy.port}`)}))`];
}

/**
 * Host path of the invoking user's bun install root. Prefers `$BUN_INSTALL`,
 * otherwise `~/.bun`. Exported so tests can pin the same path the profile
 * renders without re-deriving the precedence.
 */
export function resolveHostBunInstall(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	const fromEnv = env.BUN_INSTALL;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return join(home, ".bun");
}

let cachedDeveloperDir: string | null | undefined;

/**
 * Host's active developer dir via `xcode-select -p`, or null off darwin or
 * when the lookup fails. Resolved once per process.
 */
export function resolveHostDeveloperDir(): string | null {
	if (cachedDeveloperDir !== undefined) return cachedDeveloperDir;
	cachedDeveloperDir = null;
	if (process.platform !== "darwin") return cachedDeveloperDir;
	try {
		const res = spawnSync("xcode-select", ["-p"], { encoding: "utf8", timeout: 5_000 });
		const out = res.status === 0 ? res.stdout.trim() : "";
		if (out.length > 0) cachedDeveloperDir = out;
	} catch {
		// xcode-select missing: no grant
	}
	return cachedDeveloperDir;
}

/**
 * The `<bundle>.app/Contents` dir to grant for an Xcode developer dir, or
 * null when there is nothing extra to grant: no dir, a Command Line Tools
 * dir (already under /Library), or a dir outside an app bundle.
 */
export function xcodeBundleContents(developerDir: string | null): string | null {
	if (developerDir === null || developerDir.length === 0) return null;
	const match = /^(\/.+\.app\/Contents)\/Developer\/?$/.exec(realpathOrSelf(developerDir));
	const contents = match?.[1];
	if (contents === undefined) return null;
	const covered = SYSTEM_READ_SUBPATHS.some((p) => contents.startsWith(`${p}/`));
	return covered ? null : contents;
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Quote a string for SBPL: escape backslash and double-quote. */
function sbString(value: string): string {
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}
