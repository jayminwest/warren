/**
 * Pure builder of the `docker run` argv for one agent container
 * (warren-3732). Inputs are the same `SandboxProfile` + `SpawnCommand` the
 * LocalProvider's bwrap spawn consumes, so the drive loop
 * (`src/runtime/local/drive.ts`) never learns which boundary it crosses —
 * the container boundary IS the sandbox.
 *
 * Mapping from profile to container:
 *
 *   - `workspace`, `home`, `readOnlyMounts`, `workspaceGitdir` bind-mount at
 *     the IDENTICAL absolute path inside the container (path parity — see
 *     `./config.ts`), workspace + home read-write, the rest read-only.
 *   - `network` maps coarsely: `none` ⇒ `--network none`; `restricted` ⇒
 *     the configured restricted network (default bridge — the honest v1
 *     degradation, no domain allowlist); `open` ⇒ docker's default.
 *   - `memoryLimitMb` / `cpuLimit` map to `--memory` / `--cpus` (real cgroup
 *     enforcement by the docker daemon).
 *   - `setEnv` + the command's extra env render to an `--env-file` so
 *     secrets never ride the docker CLI argv (`docker inspect` shows env
 *     either way, but argv is world-readable via `ps`). `envPassthrough`
 *     names forward as bare `--env NAME` (docker copies the value from
 *     warren's own env).
 *   - `HOME` exports the run's real writable home (warren-c865 parity).
 *   - A loopback `WARREN_API_URL` rewrites to the host-gateway alias and
 *     the container gets `--add-host <alias>:host-gateway`.
 *   - `--user` forces a non-root identity (warren-3f32). claude-code refuses
 *     `--dangerously-skip-permissions` when `getuid()==0`; the K8s pod already
 *     runs uid 1000 with `runAsNonRoot`, and docker needs the same story. See
 *     `resolveDockerAgentUser` — root warren (compose default) → uid 1000 plus
 *     a host-side chown of the bind mounts; non-root warren → that host uid so
 *     the already-owned workspace/HOME stay writable without a privileged chown.
 *
 * The container is deliberately created WITHOUT `--rm`: the spawn seam must
 * `docker inspect` the dead container for the OOMKilled flag before
 * removing it (`./spawn.ts`).
 */

import { basename } from "node:path";
import { DEFAULT_SANDBOX_GID, DEFAULT_SANDBOX_UID } from "../../sandbox/bwrap.ts";
import type { SandboxProfile, SpawnCommand } from "../../sandbox/types.ts";
import { type DockerConfig, rewriteLoopbackUrl } from "./config.ts";

/**
 * Unprivileged uid/gid the agent container runs as when warren itself is
 * root (compose / bare Dockerfile default). Mirrors `WARREN_POD_UID` on the
 * K8s path and `DEFAULT_SANDBOX_UID` under bwrap (warren-3f32).
 */
export const DOCKER_AGENT_UID = DEFAULT_SANDBOX_UID;
export const DOCKER_AGENT_GID = DEFAULT_SANDBOX_GID;

export interface DockerAgentUser {
	readonly uid: number;
	readonly gid: number;
	/**
	 * True when the spawn seam must `chown` the bind-mounted workspace/HOME
	 * (and optional gitdir) to `uid:gid` before `docker run`. Only needed when
	 * warren created those dirs as root and the container will run as the
	 * fixed non-root agent uid.
	 */
	readonly chownMounts: boolean;
}

/**
 * Pick the container `--user` identity.
 *
 * - Host uid is a real non-root user → run as that uid/gid. The workspace and
 *   HOME were just materialized by the same user, so they are already writable
 *   and no chown is required (and would fail without CAP_CHOWN).
 * - Host is root (or uid unknown) → fall back to the K8s-parity uid 1000 and
 *   ask the spawn seam to chown the mounts. Fixed 1000 (not a random
 *   non-zero) keeps image `USER bun` / tooling that assumes uid 1000 aligned.
 * - `SandboxProfile.runAsUid` / `runAsGid` override both arms when set.
 */
export function resolveDockerAgentUser(
	profile: SandboxProfile,
	host: { uid?: number; gid?: number } = {},
): DockerAgentUser {
	if (profile.runAsUid !== undefined) {
		const uid = profile.runAsUid;
		const gid = profile.runAsGid ?? uid;
		return { uid, gid, chownMounts: host.uid === 0 || host.uid === undefined };
	}
	if (host.uid !== undefined && host.uid !== 0) {
		return {
			uid: host.uid,
			gid: host.gid !== undefined && host.gid !== 0 ? host.gid : host.uid,
			chownMounts: false,
		};
	}
	return { uid: DOCKER_AGENT_UID, gid: DOCKER_AGENT_GID, chownMounts: true };
}

/** Container name prefix — deterministic per run so cancel can target it. */
export const DOCKER_CONTAINER_PREFIX = "warren-run-";

/**
 * Derive the container name for a run. The workspace's basename IS the
 * sandbox id (`local-<runId>`, `src/runtime/local/paths.ts`), which is
 * already docker-name safe (`[a-zA-Z0-9_.-]`); a defensive scrub keeps an
 * exotic run id from producing an invalid name.
 */
export function containerNameForWorkspace(workspacePath: string): string {
	const id = basename(workspacePath).replace(/[^a-zA-Z0-9_.-]/g, "-");
	return `${DOCKER_CONTAINER_PREFIX}${id}`;
}

/** Network flag for a profile's intent — the coarse v1 mapping. */
export function dockerNetworkArgs(profile: SandboxProfile, config: DockerConfig): string[] {
	if (profile.network === "none") return ["--network", "none"];
	if (profile.network === "restricted") {
		return ["--network", config.restrictedNetwork ?? "bridge"];
	}
	return [];
}

/** Resource flags — docker daemon cgroup enforcement. */
export function dockerResourceArgs(profile: SandboxProfile): string[] {
	const args: string[] = [];
	if (profile.memoryLimitMb !== undefined) {
		args.push("--memory", `${Math.floor(profile.memoryLimitMb)}m`);
	}
	if (profile.cpuLimit !== undefined && profile.cpuLimit > 0) {
		args.push("--cpus", String(profile.cpuLimit));
	}
	return args;
}

/** Bind-mount flags — host-path parity, workspace + home read-write. */
export function dockerMountArgs(profile: SandboxProfile): string[] {
	const args: string[] = [
		"--mount",
		`type=bind,source=${profile.workspace},target=${profile.workspace}`,
		"--mount",
		`type=bind,source=${profile.home},target=${profile.home}`,
	];
	for (const mount of profile.readOnlyMounts) {
		args.push("--mount", `type=bind,source=${mount},target=${mount},readonly`);
	}
	if (profile.workspaceGitdir !== undefined) {
		args.push(
			"--mount",
			`type=bind,source=${profile.workspaceGitdir},target=${profile.workspaceGitdir}`,
		);
	}
	return args;
}

/**
 * Compose the container env: profile `setEnv` (loopback callback rewritten),
 * overlaid by the command's extra env, plus `HOME`. Passthrough names are
 * NOT rendered here — they forward as bare `--env NAME` argv entries.
 */
export function composeContainerEnv(
	profile: SandboxProfile,
	command: SpawnCommand,
	config: DockerConfig,
): Record<string, string> {
	const env: Record<string, string> = { ...profile.setEnv };
	const apiUrl = env.WARREN_API_URL;
	if (apiUrl !== undefined) {
		const rewritten = rewriteLoopbackUrl(apiUrl, config.hostGatewayName);
		if (rewritten !== null) env.WARREN_API_URL = rewritten;
	}
	Object.assign(env, command.env ?? {});
	env.HOME = profile.home;
	return env;
}

/**
 * Render env entries in docker's `--env-file` format: one `KEY=VALUE` per
 * line, value bytes verbatim (docker ≥1.9 treats everything after the first
 * `=` as the value). Keys are validated defensively — a malformed key would
 * corrupt the file.
 */
export function renderEnvFile(env: Record<string, string>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		lines.push(`${key}=${value.replace(/\n/g, "\\n")}`);
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Resolve the container working directory (mirrors sandbox.ts resolveCwd). */
function resolveContainerCwd(workspace: string, cwd: string | undefined): string {
	if (cwd === undefined || cwd === "") return workspace;
	if (cwd.startsWith("/")) return cwd;
	return `${workspace.replace(/\/$/, "")}/${cwd}`;
}

export interface DockerRunSpec {
	readonly argv: string[];
	/** Env entries the caller writes to the `--env-file` path in argv. */
	readonly envFileContents: string;
	/** Deterministic container name (cancel + OOM probe target). */
	readonly containerName: string;
}

/**
 * Build the full `docker run` invocation for one agent spawn. `envFilePath`
 * is the caller-chosen host path the env file lands at (the spawn seam owns
 * its lifecycle); the argv references it by `--env-file`.
 */
export function buildDockerRunSpec(
	profile: SandboxProfile,
	command: SpawnCommand,
	config: DockerConfig,
	envFilePath: string,
	hostIdentity: { uid?: number; gid?: number } = {},
): DockerRunSpec {
	const containerName = containerNameForWorkspace(profile.workspace);
	const agentUser = resolveDockerAgentUser(profile, hostIdentity);
	const argv: string[] = [
		config.bin,
		"run",
		"--name",
		containerName,
		"-i",
		// Non-root (warren-3f32) — image USER is defense in depth; --user wins.
		"--user",
		`${agentUser.uid}:${agentUser.gid}`,
		// warren-950d: the shared agent image bakes file capabilities on
		// setpriv (cap_setuid,cap_setgid — the K8s entrypoint/agent uid-split
		// primitive). Docker's default bounding set includes SETUID/SETGID and
		// leaves no_new_privs off, so without this flag the agent could exec
		// that binary and switch uid (including to 0). no-new-privileges makes
		// file caps and setuid bits inert for the whole container.
		"--security-opt",
		"no-new-privileges",
		"--workdir",
		resolveContainerCwd(profile.workspace, command.cwd),
		"--add-host",
		`${config.hostGatewayName}:host-gateway`,
		...dockerMountArgs(profile),
		...dockerNetworkArgs(profile, config),
		...dockerResourceArgs(profile),
		"--env-file",
		envFilePath,
	];
	for (const name of profile.envPassthrough) {
		argv.push("--env", name);
	}
	// warren-fabb: per-project agentImage override (SandboxProfile.agentImage,
	// from `.warren/config.yaml`) wins over the env-resolved default.
	// Precedence: project override > WARREN_DOCKER_AGENT_IMAGE > default.
	argv.push(profile.agentImage ?? config.image, ...command.argv);
	return {
		argv,
		envFileContents: renderEnvFile(composeContainerEnv(profile, command, config)),
		containerName,
	};
}
