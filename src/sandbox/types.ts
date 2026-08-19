/**
 * Sandbox + spawn contracts shared by the bwrap and sandbox-exec wrappers.
 * Lifted from burrow's `src/provider/types.ts` (plan pl-3007, warren-5af7).
 * These are the inputs to a one-shot sandboxed invocation; the
 * LocalProvider wiring that consumes them lands in warren-413d — this
 * module is dead code until then.
 */

export const NETWORK_POLICIES = ["none", "restricted", "open"] as const;
export type NetworkPolicy = (typeof NETWORK_POLICIES)[number];

export interface SandboxProfile {
	/** Workspace root, bound read-write inside the sandbox. */
	workspace: string;
	/**
	 * Host path of a real, writable HOME directory for the sandboxed
	 * process, bound read-write and exported as $HOME. REQUIRED and
	 * separate from `workspace` (warren-c865): harness state (.claude/,
	 * .pi/sessions/) must land outside the git worktree so zero-commit
	 * runs stop tripping the dropped_commit check. The caller creates and
	 * owns this directory per run.
	 */
	home: string;
	/** Additional host paths to mount read-only (e.g. toolchain shared libs). */
	readOnlyMounts: string[];
	network: NetworkPolicy;
	/** Domains permitted under `network: "restricted"`. */
	allowedDomains: string[];
	/** Names of host env vars to forward unchanged. */
	envPassthrough: string[];
	/** Env overrides that take precedence over passthrough. */
	setEnv: Record<string, string>;
	/** Resolved host paths to language toolchain binaries (mounted read-only). */
	toolchainPaths: string[];
	/** Host path of the SSH agent socket to forward, if any. */
	sshAuthSock?: string;
	timeoutMs?: number;
	memoryLimitMb?: number;
	cpuLimit?: number;
	/**
	 * Loopback endpoint of the per-run proxy that gates outbound traffic
	 * under `network = "restricted"`. Set by the run dispatcher right before
	 * `runSandboxed` (not persisted): the proxy is bound to a
	 * kernel-assigned port for each run, and the seatbelt/bwrap profile
	 * builders use this to allow only loopback to that exact endpoint.
	 */
	proxyAddress?: { host: string; port: number };
	/**
	 * Linux only: uid the sandboxed process runs as inside the userns
	 * (`bwrap --uid`). Defaults to a non-root constant (1000). The host's
	 * uid is remapped via `uid_map` so workspace files owned by the caller
	 * appear as this uid inside. Override only when the caller has a
	 * specific reason — e.g. matching the uid of an existing image's user.
	 *
	 * Required (in spirit): without `--uid`, the userns inherits the host's
	 * caller uid. When warren runs as root (e.g. inside a Docker container
	 * without an explicit USER), the agent sees `getuid() == 0` and tools
	 * like claude-code refuse to run.
	 */
	runAsUid?: number;
	/** Linux only: gid the sandboxed process runs as. Defaults to 1000. */
	runAsGid?: number;
	/**
	 * Host path of the parent clone's `.git` common dir, bound read-write at
	 * the same path inside the sandbox. Set when the workspace is a git
	 * worktree.
	 *
	 * `git worktree add` writes the worktree's `.git` *file* with an absolute
	 * `gitdir:` pointer at `<gitCommonDir>/worktrees/<id>`; that path lives
	 * outside the workspace bind, so without this mount every git invocation
	 * inside the sandbox fails with `fatal: not a git repository` and the
	 * agent can't commit or push its own work (burrow-7a80). It's read-write
	 * because git needs to update per-worktree HEAD/index plus write new
	 * objects into the shared object database when committing.
	 */
	workspaceGitdir?: string;
	/**
	 * OPTIONAL per-project agent image override from `.warren/config.yaml`
	 * `agentImage`, carried on the RunSpec (warren-fabb) and threaded here
	 * because the drive-loop spawn seam receives only the profile + command.
	 * Container runtimes consume it: DockerProvider picks it over the env
	 * default, K8s resolves it into the pod-spec image. The bwrap/
	 * sandbox-exec paths (LocalProvider) ignore it — the host toolchain is
	 * the sandbox there, so there is no image to pick.
	 */
	agentImage?: string;
	/**
	 * Per-run inbound loopback port-forwards. For each pair, traffic
	 * arriving at `127.0.0.1:hostPort` on the host is piped into
	 * `127.0.0.1:sandboxPort` inside the sandbox's network namespace.
	 *
	 * Caller allocates `hostPort`; the sandbox plumbs the forward. Bound to
	 * host loopback only — never `0.0.0.0`. On macOS the forward is
	 * implicit (sandbox-exec doesn't isolate the netns) so the field is
	 * documentational on that platform.
	 */
	inboundPortForwards?: ReadonlyArray<{
		readonly hostPort: number;
		readonly sandboxPort: number;
	}>;
}

export interface SpawnCommand {
	argv: string[];
	/** Working directory, relative to the workspace. Defaults to "/workspace". */
	cwd?: string;
	/** Extra env merged on top of the profile's resolved env. */
	env?: Record<string, string>;
	stdin?: ReadableStream<Uint8Array> | string;
	timeoutMs?: number;
	/**
	 * When true, the sandbox writes `stdin` (if a string) but does NOT close
	 * the write side. The caller drains stdout, then invokes
	 * `SpawnResult.closeStdin()` once it has observed whatever signal
	 * indicates the child is done consuming input. Runtimes whose CLI exits
	 * the instant stdin closes mid-inference must set this; runtimes that
	 * rely on stdin EOF to flush their final output (e.g. claude-code
	 * `--print`) must not. Default false (write+end at spawn time).
	 */
	holdStdin?: boolean;
}

export interface SpawnResult {
	pid: number;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	/** Resolves with the child's exit code once it terminates. */
	exited: Promise<number>;
	/** Kill the child and clean up sandbox-side temp state. Idempotent. */
	cancel(): void;
	/**
	 * Idempotent. Closes the child's stdin write side. Only meaningful when
	 * the command was sent with `holdStdin: true` — otherwise stdin was
	 * already ended at spawn time and this call is a no-op.
	 */
	closeStdin?: () => Promise<void>;
	/**
	 * Write more bytes to the child's stdin without closing the sink. Only
	 * meaningful when the command was sent with `holdStdin: true` —
	 * otherwise stdin was already ended at spawn time and calls reject.
	 * Rejects if the child has already closed stdin / exited.
	 */
	writeStdin?: (chunk: string) => Promise<void>;
	/**
	 * True when the kernel OOM-killed a process inside this sandbox's
	 * cgroup (burrow-2083). Only present on Linux when the spawn got a
	 * per-sandbox cgroup with `memory.max` applied; absent means limits
	 * were unenforced (macOS Seatbelt has no memory controller, or the
	 * host's cgroup v2 tree wasn't writable). Consult after `exited`
	 * resolves — dispatch uses it to fail the run with an explicit OOM
	 * reason instead of a bare exit code.
	 */
	oomKilled?: () => boolean;
}
