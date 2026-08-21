# Docker runtime provider (warren-3732)

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-17
**Shipped:** v0.17.0
**Current truth:** `src/runtime/docker/`

`WARREN_RUNTIME=docker` runs each agent as a sibling container over the
docker socket. The container boundary is the sandbox. Self-hosters who pick
this topology no longer need nested bwrap or the four compose security
flags.

This record amends [runtime-provider-contract.md](runtime-provider-contract.md).
The contract itself does not change. Only a third backend joins the
selector.

## Topology

Warren talks to the docker CLI over `/var/run/docker.sock`. Each run starts
one container from the agent image. The workspace and the per-run HOME stay
host paths. Warren bind-mounts both into the container at the identical
absolute path. Adapter-built commands embed the workspace path, so path
parity keeps them working unchanged.

Path parity holds in two deployments.

- Warren runs directly on the docker host.
- Warren runs in a container whose data dir bind-mounts at the same
  absolute path on the host.

A named-volume data dir breaks path parity. The spawn fails loudly there.

## Workspace materialization

The docker backend reuses the local materializer. `create` carves a git
worktree off the host clone and writes the seed drops warren-side. This
mirrors the K8s init container (`src/runtime/k8s/workspace-init.ts`) with
one difference. K8s clones in-pod because the control plane has no host
clone. The docker host always has the clone, so the worktree path wins.
`finalize` then runs the same host-side reap merge functions the local
backend runs. No in-container round trip is necessary.

## Execution

The provider wraps the in-process local engine. The only substituted seam
is the drive loop spawn. `src/runtime/docker/spawn.ts` maps the sandbox
profile and the spawn command onto `docker run`. Stdin pipes through the
CLI, so batch prompts and live mid-run steering keep their local semantics.
The phase-2 adapters and parsers run unchanged host-side.

The container starts without `--rm`. After exit the seam inspects the dead
container for the OOMKilled flag, then force-removes it. `cancel` targets
the deterministic container name with `docker rm -f`.

Secrets reach the container through an `--env-file` in a private tmp dir.
They never ride the CLI argv.

## Non-root agent identity (warren-3f32)

claude-code refuses `--dangerously-skip-permissions` when `getuid()==0`.
The K8s pod already runs uid 1000 with `runAsNonRoot`; docker mirrors that.

- `deploy/docker/Dockerfile.agent` ends with `USER bun` (oven/bun's uid 1000).
- `buildDockerRunSpec` always passes `--user <uid>:<gid>`. When warren itself
  is root (compose default) the fixed agent uid is 1000
  (`DOCKER_AGENT_UID`, same value as `WARREN_POD_UID` / `DEFAULT_SANDBOX_UID`).
  When warren is already a non-root host user the container runs as that uid
  so the just-materialized workspace and HOME stay writable without a chown.
- `SandboxProfile.runAsUid` / `runAsGid` override both arms when set.
- Before `docker run`, the spawn seam recursively chowns the bind-mounted
  workspace, HOME, and optional worktree gitdir onto the agent uid whenever
  warren created them as root. Without that step uid 1000 hits EACCES on
  every git write and every agent config write under HOME. The shared clone
  `.git` is included because worktree commits write objects there; under the
  root-warren topology that chown is idempotent across concurrent runs (all
  target uid 1000).

## Networking and the callback URL

`network: "none"` maps to `--network none`. `network: "restricted"` maps to
a docker network. `WARREN_DOCKER_RESTRICTED_NETWORK` names it, and the
default bridge applies otherwise. `network: "open"` uses the docker
default.

A loopback `WARREN_API_URL` cannot reach the host from a sibling container.
The env composer rewrites loopback hosts to `host.docker.internal`. Every
run container gets that alias through `--add-host ...:host-gateway`.

## Capability degradations

The provider declares its flags honestly per contract §5.

- `previewPorts: false` — preview sidecars spawn through bwrap profiles.
- `networkPolicy: "coarse"` — no domain allowlist at v1.
- `longLived: true` and `midRunSteering: true` — stdin pipes through.
- `enforcedResourceLimits: true` — `--memory` and `--cpus` are real cgroup
  limits, plus the OOMKilled probe.
- `workspaceArchive: false` — terminate returns no archive handle.
- `workspaceGc: true` — workspaces are host dirs under the local state
  roots, so the fallback sweep reclaims them.

## Operator knobs

- `WARREN_DOCKER_AGENT_IMAGE` — the agent image. Default
  `warren-agent:latest`. A project can pin its own image with the
  `agentImage` key in `.warren/config.yaml` (warren-fabb) — precedence:
  project `agentImage` > `WARREN_DOCKER_AGENT_IMAGE` > default. The agent
  image bakes bun, node, git, python3 + uv (warren-fabb), and the agent
  CLIs; a stack needing a different toolchain pins a dedicated image
  instead of redeploying warren.
- `WARREN_DOCKER_BIN` — the docker CLI path. Default `docker`. Under this
  runtime `GET /readyz` execs `<bin> version` as the `docker_cli` check
  (warren-5c42) and reports 503 while the CLI is missing, is not executable,
  or cannot reach a daemon. On macOS Docker Desktop a bind-mounted host CLI
  resolves to an empty directory, because the host CLI path sits outside
  Desktop's shared paths — put a static linux CLI on the data volume and
  point this knob at it.
- `WARREN_DOCKER_RESTRICTED_NETWORK` — the restricted network name.

An unknown `WARREN_RUNTIME` value still fails loudly at boot.
