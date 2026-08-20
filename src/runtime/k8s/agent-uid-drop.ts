/**
 * The in-pod entrypoint/agent UID split (warren-cb93 — closes the residual
 * provenance hole left by warren-6646). The warren-authored origin marker
 * (`./log-parse.ts` `WARREN_ORIGIN_MARKER`) is IN-BAND: any pod-log line that
 * reproduces the envelope reads as warren-authored. While the entrypoint and
 * the agent shared one uid, a deliberate agent write at the entrypoint's
 * stdout fd (`/proc/1/fd/1`) could forge exactly that. Opening another
 * process's `/proc/<pid>/fd/*` requires a uid match (or CAP_SYS_PTRACE), so
 * running the AGENT under a second uid — while the entrypoint keeps the pod's
 * uid — makes that write fail with EACCES and the marker unforgeable from the
 * agent's side of the split.
 *
 * The split is applied by the entrypoint (`./agent-entrypoint.ts`) wrapping
 * the adapter-rendered agent argv in `setpriv`:
 *
 *   setpriv --reuid=<uid> --regid=<gid> --clear-groups --no-new-privs \
 *           --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- <argv>
 *
 * The flags strip every privilege channel from the agent: no supplementary
 * groups, no_new_privs so execve can never gain anything back, and an emptied
 * inheritable/ambient/bounding capability set so the container's SETUID/
 * SETGID (held by the ENTRYPOINT so setpriv works at all, see
 * `./pod-spec.ts`) stop at the agent boundary. The agent also loses the
 * ability to SIGNAL the entrypoint (kill(2) requires a uid match) — a second
 * hardening win over the shared-uid layout.
 *
 * Why the agent MOVES to a second uid instead of the entrypoint: every
 * warren-fd08 single-uid assumption (workspace ownership, HOME, the bun
 * global store, git safe.directory) already targets the agent at uid 1000…
 * except the workspace is materialized uid-1000-owned, so the agent keeps gid
 * 1000 (the pod `fsGroup`) and the init container + entrypoint run with
 * `umask 002`, keeping the clone group-writable for the split-off agent. The
 * git safe.directory '*' fix (deploy/docker/Dockerfile.agent) is
 * uid-agnostic, so a uid-1001 agent in a uid-1000-owned checkout still
 * commits.
 *
 * Fail-closed contract: a malformed env value THROWS (never silently runs the
 * agent at the entrypoint's uid), and uid/gid 0 is refused — dropping "to
 * root" would invert the split.
 */

/** Agent-container env the pod-spec stamps (values: decimal uid/gid). */
export const ENV_AGENT_RUN_AS_UID = "WARREN_AGENT_RUN_AS_UID";
export const ENV_AGENT_RUN_AS_GID = "WARREN_AGENT_RUN_AS_GID";

/**
 * The uid the agent process drops to inside the pod (the entrypoint keeps
 * `WARREN_POD_UID` 1000). gid stays the pod gid so the fsGroup-governed,
 * group-writable workspace keeps working for the split-off agent.
 */
export const WARREN_POD_AGENT_UID = 1001;

/** The setpriv binary. Present in the agent image via util-linux (Debian base). */
export const SETPRIV_BIN = "setpriv";

/** The identity the agent process runs under inside the agent container. */
export interface AgentUidDrop {
	readonly uid: number;
	readonly gid: number;
}

export type AgentUidDropEnv = Readonly<Record<string, string | undefined>>;

function parsePositiveId(raw: string, key: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(
			`agent-uid-drop: ${key} must be a positive non-root integer, got ${JSON.stringify(raw)}`,
		);
	}
	return n;
}

/**
 * Parse the uid-drop request from the container env. Absent ⇒ `undefined`
 * (the entrypoint spawns the agent unwrapped — the standalone-image smoke-run
 * and DockerProvider shapes, where no entrypoint stdout fd exists to protect).
 * Present ⇒ both ids validated; a missing gid defaults to the uid. Throws on
 * anything malformed (fail closed — see the module header).
 */
export function parseAgentUidDrop(env: AgentUidDropEnv): AgentUidDrop | undefined {
	const rawUid = env[ENV_AGENT_RUN_AS_UID]?.trim();
	if (rawUid === undefined || rawUid === "") return undefined;
	const uid = parsePositiveId(rawUid, ENV_AGENT_RUN_AS_UID);
	const rawGid = env[ENV_AGENT_RUN_AS_GID]?.trim();
	const gid =
		rawGid === undefined || rawGid === "" ? uid : parsePositiveId(rawGid, ENV_AGENT_RUN_AS_GID);
	return { uid, gid };
}

/**
 * The setpriv prefix (without the `--` separator and target argv). Exported so
 * the entrypoint's preflight probe and the real spawn share one spelling.
 */
export function uidDropArgv(drop: AgentUidDrop): string[] {
	return [
		SETPRIV_BIN,
		`--reuid=${drop.uid}`,
		`--regid=${drop.gid}`,
		"--clear-groups",
		"--no-new-privs",
		"--inh-caps=-all",
		"--ambient-caps=-all",
		"--bounding-set=-all",
	];
}

/** Wrap an adapter-rendered agent argv in the setpriv uid drop. Pure. */
export function wrapArgvForUidDrop(argv: readonly string[], drop: AgentUidDrop): string[] {
	return [...uidDropArgv(drop), "--", ...argv];
}

/** The preflight probe argv: proves setpriv can perform the drop before the agent's run rides on it. */
export function uidDropPreflightArgv(drop: AgentUidDrop): string[] {
	return [...uidDropArgv(drop), "--", "true"];
}

/* -------------------------------------------------------------------------- */
/* Entrypoint orchestration (preflight + wrap)                                 */
/* -------------------------------------------------------------------------- */

/** Minimal spawn seam shape `applyAgentUidDrop` drives (structural twin of `AgentSpawn`). */
export interface UidDropSpawnProc {
	readonly exited: Promise<number>;
}
export type UidDropSpawn = (
	command: { argv: string[] },
	opts: { cwd: string },
) => UidDropSpawnProc | Promise<UidDropSpawnProc>;

export type UidDropResult<TCommand extends { readonly argv: string[] }> =
	| { readonly ok: true; readonly command: TCommand }
	| { readonly ok: false; readonly probeExit: number };

/**
 * Wrap an adapter-rendered agent command in the setpriv uid drop, PRE-FLIGHTING
 * the drop first (`setpriv … -- true`): a pod missing the ambient-cap
 * propagation (the container runtime must deliver SETUID/SETGID to the
 * non-root pid 1 — containerd/runc do; see `pod-spec.ts`) fails with a legible
 * `probeExit` the caller turns into a system event, instead of a cryptic agent
 * spawn error — and never runs the agent at the entrypoint's uid. The wrapped
 * command keeps every other field (stdin, env, holdStdin) untouched.
 */
export async function applyAgentUidDrop<TCommand extends { readonly argv: string[] }>(
	command: TCommand,
	drop: AgentUidDrop,
	deps: { spawn: UidDropSpawn; cwd: string; log: (m: string) => void },
): Promise<UidDropResult<TCommand>> {
	const probe = await deps.spawn({ argv: uidDropPreflightArgv(drop) }, { cwd: deps.cwd });
	const probeExit = await probe.exited;
	if (probeExit !== 0) return { ok: false, probeExit };
	deps.log(
		`agent-entrypoint: dropping agent to uid ${drop.uid}:gid ${drop.gid} via setpriv (warren-cb93)`,
	);
	const wrapped = { ...command, argv: wrapArgvForUidDrop(command.argv, drop) };
	return { ok: true, command: wrapped as TCommand };
}

/** The system-event message for a failed preflight (kept here so the wording stays next to the probe). */
export function uidDropPreflightErrorMessage(probeExit: number): string {
	return (
		`agent-entrypoint: uid-drop preflight failed (setpriv exited ${probeExit}) — ` +
		"the agent container needs SETUID/SETGID propagated to the entrypoint " +
		"(ambient caps); refusing to run the agent at the entrypoint's uid"
	);
}
