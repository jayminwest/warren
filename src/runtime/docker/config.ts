/**
 * Docker-topology configuration for the `DockerProvider` (warren-3732, plan
 * pl-3007 phase 4). Resolved once per provider construction from the server
 * env; every knob is operator-facing and documented in
 * `docs/design/runtime-docker-provider.md`.
 *
 * The sibling-container model: warren talks to the docker CLI over
 * `/var/run/docker.sock` (or `$DOCKER_HOST`) and runs each agent as a
 * sibling container. The workspace and per-run HOME stay HOST paths
 * materialized warren-side (`src/workspace/materialize.ts`, the same
 * worktree the LocalProvider builds) and are bind-mounted into the agent
 * container at the IDENTICAL path, so adapter-built commands that embed the
 * workspace path keep working untouched. Path parity holds in the two
 * supported deployments:
 *
 *   - warren runs directly on the docker host (paths are host paths), or
 *   - warren runs in a container whose data dir is bind-mounted at the SAME
 *     absolute path on the host (the compose file guarantees this).
 *
 * A named-volume data dir breaks path parity and fails loudly at spawn.
 */

/** Minimal env surface the resolver reads. */
export type DockerConfigEnv = Readonly<Record<string, string | undefined>>;

export interface DockerConfig {
	/** docker CLI binary the spawn seam invokes. */
	readonly bin: string;
	/** Agent image every run container starts from. */
	readonly image: string;
	/**
	 * Docker network a `network: "restricted"` run attaches to. Unset ⇒ the
	 * default bridge (the coarse v1 posture — no domain allowlist).
	 */
	readonly restrictedNetwork: string | null;
	/**
	 * Hostname the loopback callback URL rewrites to inside the container
	 * (`--add-host <name>:host-gateway`). See {@link rewriteLoopbackUrl}.
	 */
	readonly hostGatewayName: string;
}

/** Default agent image — operators override with WARREN_DOCKER_AGENT_IMAGE. */
export const DEFAULT_DOCKER_AGENT_IMAGE = "warren-agent:latest";

/** Host-gateway alias every run container gets for the callback rewrite. */
export const DOCKER_HOST_GATEWAY_NAME = "host.docker.internal";

/** Resolve the docker-topology config. Pure. */
export function resolveDockerConfig(env: DockerConfigEnv): DockerConfig {
	const bin = env.WARREN_DOCKER_BIN?.trim() || "docker";
	const image = env.WARREN_DOCKER_AGENT_IMAGE?.trim() || DEFAULT_DOCKER_AGENT_IMAGE;
	const restrictedNetwork = env.WARREN_DOCKER_RESTRICTED_NETWORK?.trim() || null;
	return { bin, image, restrictedNetwork, hostGatewayName: DOCKER_HOST_GATEWAY_NAME };
}

/**
 * Loopback host spellings the callback URL may carry. A sibling container
 * cannot reach warren over its own loopback, so these rewrite to the
 * host-gateway alias.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "0.0.0.0"]);

/**
 * Rewrite a loopback URL's host to the docker host-gateway alias so the
 * agent container reaches the warren API on the host. Non-loopback URLs
 * (an operator-advertised LAN URL) pass through unchanged. Returns `null`
 * for an unparseable URL — the caller then keeps the original value.
 */
export function rewriteLoopbackUrl(url: string, gatewayHost: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (!LOOPBACK_HOSTS.has(parsed.hostname)) return url;
	parsed.hostname = gatewayHost;
	return parsed.toString();
}
