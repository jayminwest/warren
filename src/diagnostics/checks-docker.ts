/**
 * Docker-topology readiness check (warren-5c42), the `WARREN_RUNTIME=docker`
 * counterpart of the local backend's bwrap probe (`./checks-sandbox.ts`) and
 * the k8s backend's informer-sync probe.
 *
 * Under the docker runtime warren runs every agent as a sibling container
 * over the docker CLI (`src/runtime/docker/spawn.ts`). Before this check, a
 * control plane with no usable CLI booted GREEN and only failed at the first
 * dispatch, with the run dying on `Executable not found in $PATH: "docker"`.
 * A readiness probe that never execs the one binary the topology cannot run
 * without asserts nothing about it, so this probe runs the configured CLI
 * for real and fails readyz when the binary is missing, is not executable,
 * or cannot reach a daemon.
 *
 * Scoped to the docker topology by the callers, the same way the bwrap probe
 * is scoped to local (warren-c128) — on the other backends there is no docker
 * CLI to find and the probe would only ever degrade a healthy control plane.
 */

import type { SpawnFn } from "../projects/clone.ts";
import type { DiagnosticCheck } from "./checks.ts";

export const DOCKER_CLI_PROBE_TIMEOUT_MS = 10_000;

/**
 * The operator hint. Two distinct failures land here, so the hint names both
 * halves: the CLI has to exist AND the daemon has to answer.
 *
 * The macOS Docker Desktop sentence is the one that cost the most to
 * diagnose (warren-5c42). The README quickstart mounts the host CLI with
 * `-v "$(command -v docker)":/usr/bin/docker:ro`. On Docker Desktop the CLI
 * lives outside Desktop's shared-paths set, so the mount resolves to nothing
 * and the daemon materializes an EMPTY DIRECTORY at the target instead. The
 * container then has a `/usr/bin/docker` that stats fine and can never exec,
 * which reads like a PATH problem and is not one. The fix is to put a static
 * Linux docker CLI on the data volume (which IS shared) and point
 * `WARREN_DOCKER_BIN` at it.
 */
export const DOCKER_CLI_HINT =
	"install a docker CLI the warren container can exec and give it a reachable daemon " +
	"(mount /var/run/docker.sock, or set DOCKER_HOST); " +
	'on macOS Docker Desktop the quickstart\'s `-v "$(command -v docker)":/usr/bin/docker:ro` ' +
	"mount silently becomes an EMPTY DIRECTORY, because the host CLI path is outside " +
	"Desktop's shared paths — instead place a static linux docker CLI on the data volume " +
	"and point WARREN_DOCKER_BIN at it";

/** The probe argv. `docker version` needs the CLI AND a live daemon. */
export function dockerCliProbeArgv(binary: string): string[] {
	return [binary, "version"];
}

/**
 * Functionally probe the docker CLI: exec `<bin> version` and require exit 0.
 *
 * `version` is the right argv because it exercises both halves of what a
 * dispatch needs. A missing or unexecutable binary throws at the spawn; a
 * present CLI that cannot reach the daemon prints its client block and exits
 * non-zero. Either way the run that would have followed was going to fail,
 * so readiness reports it up front.
 */
export async function checkDockerCli(deps: {
	readonly spawn: SpawnFn;
	readonly dockerBin?: string;
	readonly timeoutMs?: number;
}): Promise<DiagnosticCheck> {
	const binary = deps.dockerBin?.trim() || "docker";
	const timeoutMs = deps.timeoutMs ?? DOCKER_CLI_PROBE_TIMEOUT_MS;
	try {
		const result = await deps.spawn(dockerCliProbeArgv(binary), {
			cwd: process.cwd(),
			timeoutMs,
		});
		if (result.exitCode !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim();
			return {
				name: "docker_cli",
				ok: false,
				message: `\`${binary} version\` exited ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`,
				hint: DOCKER_CLI_HINT,
			};
		}
		return {
			name: "docker_cli",
			ok: true,
			message: `\`${binary} version\` reached the docker daemon`,
		};
	} catch (err) {
		return {
			name: "docker_cli",
			ok: false,
			message: `could not exec \`${binary} version\`: ${err instanceof Error ? err.message : String(err)}`,
			hint: DOCKER_CLI_HINT,
		};
	}
}
