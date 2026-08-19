/**
 * Cross-platform entry point for one-shot sandboxed execution. Lifted from
 * burrow's `src/provider/local/sandbox.ts` (warren-5af7). Dead code until
 * warren-413d wires the LocalProvider spawn path onto it.
 *
 * macOS — write the rendered Seatbelt profile to a `0600` temp file under
 * the system tmp dir, invoke `sandbox-exec -f`, clean up the temp dir when
 * the child exits or is cancelled.
 * Linux — invoke `bwrap` directly. Env is delivered via Bun.spawn's `env`
 * option (which becomes bwrap's process env, then propagates to the child via
 * execve). Putting env on the bwrap argv via `--setenv` would leak secrets
 * through `/proc/<pid>/cmdline` (burrow-ab95).
 *
 * Both platforms export $HOME as the profile's real writable home directory
 * (warren-c865), separate from the workspace, so harness state never lands
 * in the git worktree.
 *
 * Returns once the child has been spawned, with live stdout/stderr streams
 * and `exited` for awaiting the exit code.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBwrapArgv, SANDBOX_HOME_PATH } from "./bwrap.ts";
import { prepareSandboxCgroup, resolveSandboxLimits, wrapArgvForCgroup } from "./cgroup.ts";
import { resolveSandboxEnv } from "./env.ts";
import { buildSeatbeltArgv, buildSeatbeltProfile } from "./seatbelt.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "./types.ts";

export interface RunSandboxedOptions {
	/** Override the host platform (testing). Defaults to `process.platform`. */
	plat?: NodeJS.Platform;
	bwrapBin?: string;
	sandboxExecBin?: string;
	/** Defaults to `os.tmpdir()`. Used to host the rendered .sb file on macOS. */
	tmpRoot?: string;
}

export async function runSandboxed(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: RunSandboxedOptions = {},
): Promise<SpawnResult> {
	const plat = options.plat ?? process.platform;
	if (plat === "darwin") return spawnDarwin(profile, command, options);
	if (plat === "linux") return spawnLinux(profile, command, options);
	throw new Error(`warren sandbox: unsupported platform ${plat}`);
}

async function spawnDarwin(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: RunSandboxedOptions,
): Promise<SpawnResult> {
	// Seatbelt matches against canonical paths — `/var/folders/...` resolves to
	// `/private/var/folders/...` and rules written against the un-resolved form
	// silently miss. Resolve every path the profile binds before rendering.
	const resolved = canonicalizeProfilePaths(profile);

	const tmpDir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "warren-sb-"));
	const profilePath = join(tmpDir, "profile.sb");
	writeFileSync(profilePath, buildSeatbeltProfile(resolved), { mode: 0o600 });

	const env = resolveSandboxEnv(resolved, command, {
		homePath: resolved.home,
		hostEnv: process.env,
	});
	const argv = buildSeatbeltArgv(profilePath, command, {
		sandboxExecBin: options.sandboxExecBin,
	});
	const cwd = resolveCwd(resolved.workspace, command.cwd);

	const wantsStdin = command.stdin !== undefined;
	const proc = Bun.spawn(argv, {
		cwd,
		env,
		stdin: wantsStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	await writeStringStdin(proc, command.stdin, command.holdStdin ?? false);

	let cleanedUp = false;
	const cleanup = (): void => {
		if (cleanedUp) return;
		cleanedUp = true;
		rmSync(tmpDir, { recursive: true, force: true });
	};
	const exited = proc.exited.finally(cleanup);

	return {
		pid: proc.pid,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited,
		cancel: () => {
			proc.kill();
			cleanup();
		},
		closeStdin: makeCloseStdin(proc),
		writeStdin: makeWriteStdin(proc),
	};
}

async function spawnLinux(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: RunSandboxedOptions,
): Promise<SpawnResult> {
	// Resource enforcement (burrow-2083): bwrap only namespaces, it does
	// not meter. Each spawn gets its own cgroup v2 leaf with memory.max
	// (default DEFAULT_SANDBOX_MEMORY_LIMIT_MB when the profile is silent)
	// so a runaway toolchain OOMs its own run instead of the host. Null
	// when the host tree isn't writable — degrade to the unlimited spawn
	// rather than refusing to run.
	const limits = resolveSandboxLimits(profile, process.env);
	const cgroup = limits ? prepareSandboxCgroup(limits) : null;

	// Resolve bwrap against the HOST process PATH before we replace env with
	// the sandbox's hardened PATH (warren-8a6e). Bun.spawn looks bare names
	// up in the spawn `env.PATH`, and the sandbox PATH is only toolchain dirs
	// + /usr/bin:/bin — it does not carry the host's acceptance bwrap shim
	// (or a non-system bwrap install). Pinning the absolute path keeps the
	// host tool resolvable without leaking the full host PATH into the child.
	const bwrapBin = options.bwrapBin ?? Bun.which("bwrap") ?? "bwrap";
	let argv = buildBwrapArgv(profile, command, { bwrapBin });
	if (cgroup) argv = wrapArgvForCgroup(argv, cgroup.procsPath);
	const env = resolveSandboxEnv(profile, command, {
		homePath: SANDBOX_HOME_PATH,
		hostEnv: process.env,
	});
	const wantsStdin = command.stdin !== undefined;
	// `env` here becomes bwrap's process env (replacing process.env entirely,
	// not merging with it). bwrap then execve()s the child with that same env,
	// so secrets reach the child via /proc/<pid>/environ (mode 400) instead of
	// /proc/<pid>/cmdline (world-readable). See burrow-ab95.
	const proc = Bun.spawn(argv, {
		env,
		stdin: wantsStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	await writeStringStdin(proc, command.stdin, command.holdStdin ?? false);

	// cleanup() snapshots the oom_kill counter before removing the leaf,
	// so oomKilled() stays truthful after teardown (dispatch reads it
	// after `exited` resolves).
	const exited = cgroup ? proc.exited.finally(() => cgroup.cleanup()) : proc.exited;

	return {
		pid: proc.pid,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited,
		cancel: () => proc.kill(),
		closeStdin: makeCloseStdin(proc),
		writeStdin: makeWriteStdin(proc),
		...(cgroup ? { oomKilled: () => cgroup.oomKilled() } : {}),
	};
}

async function writeStringStdin(
	proc: Bun.Subprocess,
	stdin: SpawnCommand["stdin"],
	holdStdin: boolean,
): Promise<void> {
	if (typeof stdin !== "string") return;
	const sink = proc.stdin;
	if (!sink || typeof sink === "number") return;
	sink.write(new TextEncoder().encode(stdin));
	// When holdStdin=true the else branch never runs, and sink.write() alone
	// only buffers in bun's userland — the bytes never reach the kernel pipe,
	// so the child blocks forever on its initial read (burrow-029d). Flush
	// explicitly to push the prompt through before we hand control back.
	if (holdStdin) await sink.flush();
	else await sink.end();
}

function makeCloseStdin(proc: Bun.Subprocess): () => Promise<void> {
	let closed = false;
	return async () => {
		if (closed) return;
		closed = true;
		const sink = proc.stdin;
		if (!sink || typeof sink === "number") return;
		await sink.end();
	};
}

function makeWriteStdin(proc: Bun.Subprocess): (chunk: string) => Promise<void> {
	const encoder = new TextEncoder();
	return async (chunk: string) => {
		const sink = proc.stdin;
		if (!sink || typeof sink === "number") {
			throw new Error("sandbox: child stdin is not writable");
		}
		sink.write(encoder.encode(chunk));
		// `flush()` returns a promise that resolves when the kernel buffer
		// has drained — guarantees the bytes reach the child before this
		// helper returns so callers can sequence subsequent writes against
		// observed output.
		await sink.flush();
	};
}

function resolveCwd(workspace: string, cwd: string | undefined): string {
	if (!cwd) return workspace;
	if (cwd.startsWith("/")) return cwd;
	return join(workspace, cwd);
}

function canonicalizeProfilePaths(profile: SandboxProfile): SandboxProfile {
	const out: SandboxProfile = {
		...profile,
		workspace: realpathOrSelf(profile.workspace),
		home: realpathOrSelf(profile.home),
		readOnlyMounts: profile.readOnlyMounts.map(realpathOrSelf),
		toolchainPaths: profile.toolchainPaths.map(realpathOrSelf),
		sshAuthSock: profile.sshAuthSock ? realpathOrSelf(profile.sshAuthSock) : profile.sshAuthSock,
	};
	if (profile.workspaceGitdir) out.workspaceGitdir = realpathOrSelf(profile.workspaceGitdir);
	return out;
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
