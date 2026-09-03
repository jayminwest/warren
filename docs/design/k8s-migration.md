# Warren → Kubernetes Migration Design

**Kind:** architecture-decision
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-07-07
**Shipped:** v0.10.0
**Current truth:** [`docs/RUNBOOK-K8S.md`](../RUNBOOK-K8S.md) and `src/runtime/k8s/`

> **HISTORICAL — shipped in v0.10.0.** This document is a design record, not a plan in flight. The K8s runtime it argues for now runs in production — see [`docs/RUNBOOK-K8S.md`](../RUNBOOK-K8S.md) for how warren behaves today.
>
> **Decisions #2 and #3 below changed during the work (2026-07-09).** Warren keeps burrow rather than archiving it: burrow became one provider (`LocalProvider`) behind the `RuntimeProvider` contract, and K8s became the scale backend. See [`runtime-provider-contract.md`](./runtime-provider-contract.md) for that seam. The rest of this document's architecture reasoning — pod-per-run, init container, pod-log streaming, `run_inbox` — still describes the shipped system.

**Date:** 2026-07-07  
**Author:** derived from postmortem `notes/2026-07-07-warren-deployed-oom-crash-loop-postmortem.md`  
**Scope:** Warren control plane + run dispatch

---

## Motivation

The 2026-07-05..07 OOM crash loop (postmortem above) was the second consecutive
deployment blocker caused by warren + burrow + N sandboxes sharing one kernel,
one memory pool, and one failure domain on a single Fly Machine.

Root cause: `burrow.toml`'s `sandbox.memory_limit_mb` and `cpu_limit` fields are
config theater — parsed in
`burrow/src/schemas/burrow-toml.ts:SandboxSchema` and stored on
`SandboxProfile.memoryLimitMb` (`burrow/src/provider/types.ts:27`), but never
consumed by `buildBwrapArgv` / `spawnLinux`
(`burrow/src/provider/local/bwrap.ts`). Three concurrent `bun run check:all`
runs aggregated 6–12 GB demand on an 8 GB zero-swap Machine; the kernel OOM-killed
`burrow serve` (exit 137), dropped all three bridges simultaneously, and left the
warren run rows in `state='running'` for up to 45 minutes while plan-runs stalled.

The immediate fix (burrow v0.3.15, action item #1) applies cgroup v2 limits via
`memory.max`/`cpu.max`. That fix is **not the destination** — it patches bwrap's
resource model on top of a co-tenancy architecture that will produce the same
class of incident at a higher concurrency ceiling. The strategic fix is
**pod-per-run on Kubernetes**, where kubelet enforces resources natively and a
runaway run kills its own pod, not the control plane.

---

## Decisions Already Made

These are not open questions in this doc:

1. **Migrate warren to Kubernetes.** The Fly single-Machine model is retired.
2. **`burrow serve` is eliminated.** No socket API, no bwrap/seatbelt, no
   per-burrow network proxy. The pod boundary replaces all three.
3. **Burrow repo is archived.** Surviving domain logic folded into warren as
   internal packages (detailed in §4).
4. **Pod-per-run.** Each warren agent run = one Kubernetes Pod with
   `resources.requests/limits` enforced by kubelet.

---

## 1. Target Architecture

### 1.1 Warren control plane

Warren (the HTTP API + scheduler + bridge + plan-run coordinator) runs as a
`Deployment` with `replicas: 1` today; scale to replicas > 1 later when sticky
SSE sessions are replaced by a shared event broker. The Deployment is
purpose-built — no co-resident `burrow serve` child process. The supervisor
(`src/supervisor/main.ts`) is deleted; the warren server boots directly as the
pod's entrypoint.

The `workers` table and `BurrowClientPool`
(`src/burrow-client/pool.ts`) become vestigial. Keep the table rows as an audit
log of pod dispatches if desired, but `placeForProject` / `placeForBurrow`
(`src/runs/placement.ts`) are replaced by a thin K8s pod-create call. The
`LOCAL_WORKER_NAME = "local"` synthetic worker disappears entirely.

### 1.2 Bare Pods vs. Jobs — verdict: **bare Pods**

| Dimension | K8s Job | Bare Pod |
|---|---|---|
| Restart on failure | configurable (BackoffLimit) | Never (restartPolicy: Never) |
| TTL after completion | `ttlSecondsAfterFinished` | Manual delete |
| Status surface | `.status.conditions`, `.status.succeeded/failed` | `.status.phase` + container state |
| Streaming logs | yes | yes |
| Mid-run messaging (steer) | awkward — no stable pod name until it starts | natural — pod name = `run-<run-id>`, created before dispatch |

**Use bare Pods with `restartPolicy: Never`.** The reason: warren's run
lifecycle is already a state machine that owns `queued → running → succeeded /
failed / cancelled`. K8s Jobs add a redundant controller loop that conflicts.
More importantly, a Job's restart-on-failure semantics would re-execute the
agent from scratch if the pod OOMs, which is wrong — warren wants to know the
run failed and surface that immediately, not retry blindly. `restartPolicy: Never`
means an OOMKilled container ends the pod in `Failed` phase; warren's pod-watcher
sees `.status.containerStatuses[].state.terminated.reason == "OOMKilled"` and
marks the run `failed` with `failureReason: "oom_killed"` immediately.

Pod naming: `run-<run-id>` (e.g. `run-run_01tdf3a0wg5e`). The run id is
generated before the pod is created (`src/runs/spawn/dispatch.ts:spawnRun` line
that calls `repos.runs.create`); this pattern survives unchanged.

### 1.3 Run state machine ↔ pod lifecycle

```
warren run state    pod phase / container state
─────────────────   ──────────────────────────────────────────────────────
queued              Pod does not exist yet (warren row created, pod pending)
queued (pending)    Pod phase=Pending (image pull, scheduling)
running             Pod phase=Running, container running
succeeded           Pod phase=Succeeded (exitCode=0)
failed (oom_killed) Pod phase=Failed, reason=OOMKilled
failed (timed_out)  Pod phase=Failed (warren cancelled via delete after watchdog)
failed (other)      Pod phase=Failed, exitCode≠0
cancelled           Pod deleted by warren on cancel request
```

Warren runs a **pod-watcher** (`src/runs/pod-watcher.ts`, new): a
`@kubernetes/client-node` informer watching pods in the `warren-runs` namespace
with `labelSelector: warren.io/run-id`. On each watch event it reconciles the
pod's phase/container state against the warren run row. This replaces:
- `src/runs/stream/bridge.ts` — bridgeRunStream, which polled burrow's SSE
  stream; NDJSON events now come via pod logs (§5).
- `src/runs/watchdog.ts` — the 45-min heartbeat watchdog as the *only* backstop
  (postmortem item #4). The watcher fires within seconds of pod termination
  (Kubernetes watch latency ~1–2s), making 45-minute heartbeat timeouts
  obsolete. Keep the watchdog as a backstop for pods that disappear from the
  API (node failure without graceful termination), but reduce its timeout to
  5 minutes.

### 1.4 Steering / inbox messages to in-pod agents

Currently `steerRun` (`src/runs/steer.ts`) calls
`client.http.inbox.send({burrowId, body})` against the burrow socket API. With
pod-per-run there is no socket API.

**Use a warren-side inbox table + agent poll.** Warren writes the steering
message to a `run_inbox` Postgres table (new, one row per message). The agent
binary inside the pod polls `GET /runs/:id/inbox` against warren's HTTP API
using the `WARREN_API_TOKEN` already injected via env (`src/runs/spawn/callback-env.ts`).
The agent's polling interval is 5s; steering latency is ~5s, acceptable.

Alternative (pod stdin) was rejected: it requires a running `exec` session to
the pod, which is stateful and breaks on pod restart or warren restart. The HTTP
poll is stateless and naturally handles reconnects.

#### The two-inbox split (warren-3305)

Two steering stores exist. Do not conflate them.

- **The burrow per-burrow inbox** — the LocalProvider path. `steerRun` calls `runtimeProvider.sendMessage`. Under `local` that posts to the burrow `POST /burrows/:id/inbox` over the unix socket. The scope is per-BURROW, not per-run, so the returned message carries `runId: null`. The burrow dispatcher drains it. Warren never sees delivery.
- **The warren `run_inbox` table** — the K8s path. `K8sProvider.sendMessage` persists the message under the warren run id. The in-pod agent harness (`agent-stdin-hold.ts`) polls `GET /runs/:id/inbox` and drains it.

Operational rules:

- **`GET /runs/:id/inbox` reads only the `run_inbox` store.** Under the local topology it knows nothing of the burrow inbox. `{"messages":[]}` after a steer is not proof of delivery. A non-empty read is not proof the agent acted, either.
- **A bare poll consumes.** It claims every unread row at once and flips it to `delivered`. Any reader other than the pod, such as an operator curl, steals the message before the pod polls.
- **Use `?peek=1` to inspect.** `GET /runs/:id/inbox?peek=1` (warren-3305) lists the unread queue without claiming. The pod never peeks, so claiming stays exactly-once.
- **`steer.sent` vs `steer.delivered`.** `steerRun` emits `steer.sent` when warren accepts the message. The poll emits one `steer.delivered` per claimed message (warren-3305). Delivered means the harness took the message, not that the agent acted on it. A steer with `steer.sent` but no `steer.delivered` is the observable non-delivery signature.
- **Declare the harness capability, never assume it.** `frontmatter.steering` (see `STEERING_CAPABILITIES` in `src/core/wire.ts`) records what the agent runtime consumes. `"mid-run"` means a live stdin channel. No builtin has one today.
- **All eight builtins are `"spawn-only"`.** The harness folds the message into the prompt at spawn and never reads mid-run. `"none"` rejects every steer. `POST /runs/:id/steer` returns 409 when the declared harness cannot consume the steer. Agents that predate the flag stay fail-open.

---

## 2. Sandbox Model

### 2.1 Current posture

`docker-compose.yml` applies four flags to satisfy nested bwrap:
```yaml
security_opt:
  - apparmor=unconfined
  - seccomp=unconfined
  - systempaths=unconfined
cap_add:
  - SYS_ADMIN
```

The `fly.toml` comment notes that "a managed K8s cluster would refuse" these.
Fly Machines are Firecracker VMs so they don't need the flags at all — the
compose flags only matter for local Docker dev.

### 2.2 Verdict: **runc (default), no privileged flags, no gVisor/Kata in v1**

With pod-per-run, there is no nested bwrap. The agent binary runs directly in
the pod container as an unprivileged process (uid 1000, same as today's
`DEFAULT_SANDBOX_UID` in `burrow/src/provider/local/bwrap.ts`). All four
`security_opt` / `cap_add` flags disappear permanently — they existed solely
to allow bwrap's userns nesting, which no longer exists.

The pod boundary is the sandbox: process isolation via Linux namespaces (pid,
net, mnt, uts, ipc — standard runc), combined with `resources.limits` enforced
by cgroups v2 without any userland wrapper.

**gVisor (runsc):** strong syscall interception via a user-space kernel, ~10–20%
overhead on I/O-heavy workloads (large `bun install`, `git clone`). For
agent workloads that are mostly LLM API calls and file reads, the overhead is
significant relative to the safety gain. The agent code is first-party; the
threat model is accidental runaway, not adversarial exploit. Defer gVisor to
a future security hardening pass.

**Kata Containers:** VM-level isolation. Requires nested virtualization support
on host nodes; eliminates the syscall-interception overhead of gVisor but adds
~300ms cold-start latency per pod. The operator is running on bare metal
(Hetzner, see §7), so nested virt is available but the cold-start penalty
matters for short runs. Defer.

**runc v1 posture:**
- `runAsNonRoot: true`, `runAsUser: 1000` in the pod SecurityContext
- `allowPrivilegeEscalation: false`
- `seccompProfile: type: RuntimeDefault` (drop to restricted defaults without
  the custom bwrap syscall overrides)
- `capabilities: drop: [ALL]`

This is stricter than the current Fly posture (which didn't need the compose
flags but also didn't explicitly drop caps).

**Entrypoint/agent uid split (warren-cb93, amendment):** the agent container
adds back `capabilities: [SETUID, SETGID, KILL]` for warren's in-pod
entrypoint only (still uid 1000), never for the agent.

The entrypoint wraps the agent argv in `setpriv` with a full privilege
drop: `--reuid=1001 --regid=1000 --clear-groups --no-new-privs
--inh-caps=-all --ambient-caps=-all --bounding-set=-all`
(`src/runtime/k8s/agent-uid-drop.ts`). The agent process then runs under a
different uid than the process whose stdout IS the pod log.

That closes the warren-6646 residual. A forged write at `/proc/1/fd/1` from
the agent now fails EACCES (cross-uid), so the agent cannot reproduce the
in-band provenance marker.

The split-off agent also cannot SIGNAL the entrypoint. The watchdog's own
cross-uid kill routes through the same setpriv drop (`withCrossUidKill`),
because the entrypoint's effective capability set is empty on containerd 2.x.

Two prerequisites apply. First, setpriv must be able to gain
CAP_SETUID/CAP_SETGID (warren-950d amendment). containerd 2.x grants a
non-root pid 1 its `capabilities.add` in the bounding set only.

So the agent image bakes file caps on setpriv
(`setcap cap_setuid,cap_setgid+ep`) and the agent container sets
`allowPrivilegeEscalation: true` while the split is on.

`no_new_privs` off is what lets the file caps take effect for the
entrypoint. The agent stays sealed by setpriv's own
`--no-new-privs --bounding-set=-all`.

The entrypoint preflights the drop and the run fails legibly
(`spawn_failed`) when the caps never arrive. The deploy workflow gates on
the same probe via `scripts/k8s-uid-drop-canary.ts` (RUNBOOK-K8S.md §4.2).

Second, the workspace stays group-writable (pod `fsGroup` 1000 plus
`umask 002` in the init container and the entrypoint), so the uid-1001 agent
can write its uid-1000-owned checkout.

`WARREN_K8S_AGENT_UID_DROP=0` restores the legacy shared-uid shape. The
DockerProvider spawns the agent argv directly as the container's pid 1, so
no entrypoint fd exists to protect and no split applies.

The shared agent image now ships a file-caps setpriv, so the docker run
pins `--security-opt no-new-privileges` to keep those caps (and any setuid
bit) inert there (warren-950d).

---

## 3. Resource Model

### 3.1 Per-run defaults

Based on the incident: three concurrent `bun run check:all` runs each consumed
2–4 GB RSS. A reasonable per-run default:

```yaml
resources:
  requests:
    cpu: "1"
    memory: "2Gi"
  limits:
    cpu: "4"
    memory: "4Gi"
```

The `requests` govern scheduling (cluster must have 1 CPU / 2 Gi available to
place the pod); the `limits` are the hard caps kubelet enforces via cgroup v2
`memory.max` and `cpu.max`. On the incident Machine, three pods × 4 Gi limit =
12 Gi would have been rejected at scheduling time if the cluster had only one
8 Gi node — the scheduler would have queued the third pod instead of all three
running concurrently and racing to OOM.

The `memory_limit_mb` from `burrow.toml`'s `SandboxSchema` is the natural
precursor: expose it as a warren-side per-agent config field (`.warren/defaults.json`
already supports `defaultModel`, `defaultProvider`, `qualityGate` — add
`memoryLimitMi`, `cpuLimitMillicores`), and pass those values into the pod spec
at dispatch time. Default to the cluster-wide values above when absent.

### 3.2 OOMKilled as fast failure — replacing the 45-min watchdog as sole backstop

Postmortem item #4: the only finalizer for a bridge-fatal run was the 45-min
heartbeat watchdog (`src/runs/watchdog.ts`, `DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS
= 2_700_000`). With K8s:

- kubelet kills the container the moment it crosses `memory.limit`, sets
  `terminationReason: OOMKilled`
- The pod-watcher (§1.3) picks this up via watch event within 1–2s
- Warren marks the run `failed(oom_killed)` immediately

The watchdog is **not removed** — it covers the case where the pod disappears
from the API without a clean termination event (node failure, API server
partition). Reduce its timeout from 45 minutes to 5 minutes and wire it to
the pod-watcher reconcile loop so it only fires when the watch confirms the
pod is gone but the run row is still `running`.

### 3.3 Residual admission control in warren

The scheduler owns capacity (postmortem item #3). Warren no longer needs a
least-loaded heuristic (`leastLoaded` in `src/runs/placement.ts`). What warren
keeps (implemented in `src/runtime/k8s/admission.ts`, gated in
`K8sProvider.create()` before any pod write — warren-b6f2):

The three caps are evaluated against pod counts the K8s API / pod-watcher
already exposes — in the pod-per-run model the **pods are the queue**, so there
is no separate `state='queued'` runs-table read. `create()` reads counts off a
wired pod-watcher snapshot (`PodWatcher.admissionSnapshot`), or a cache-cold
`list`-by-label when the watcher isn't wired. A rejection throws
`RuntimeAdmissionError`, mapped to **429** + a `Retry-After: 30` header in
`src/server/errors.ts`, with a `reason` naming which cap tripped. The
`warren_run_admission_rejections_total{reason}` counter makes rejections
observable. Every cap counts inclusively (count ≥ cap rejects).

**Queue depth limit:** refuse when total **non-terminal** run pods in the
`warren-runs` namespace reach a threshold (default 50, `WARREN_K8S_MAX_QUEUE_DEPTH`;
`0` disables). Bounds the work queue when the cluster is oversubscribed. Reason
`queue_depth_exceeded`.

**Max pending pods:** refuse when run pods in `Pending` phase reach a threshold
(default 20, `WARREN_K8S_MAX_PENDING_PODS`; `0` disables). A large `Pending`
count means the cluster can't schedule what it already has; adding more just
extends the wait. Reason `cluster_pending_saturated`.

**Per-project concurrency cap:** optional per-project limit on simultaneous
non-terminal run pods for one project (default unlimited). Configured per-project
in `.warren/config.yaml` under `admission.maxConcurrentRuns`, with a global
default via `WARREN_K8S_MAX_PROJECT_CONCURRENCY`; the resolved value rides the
`RunSpec` and the provider counts pods by the `warren.io/project` label
(stamped from `RunSpec.projectId`). Prevents one active project from starving
others. Reason `project_concurrency_exceeded` (checked first — the most specific
cap). Fail-fast on a stuck run is inherent to pod-per-run (the pod-watcher sees
`OOMKilled` in ~1-2s), so this **supersedes** the burrow-era postmortem items
warren-b01e (host-RAM-derived per-worker concurrency) and warren-ea4f
(bridge-fatal 45-min watchdog).

These are soft controls that sit in front of the scheduler, not instead of it;
the cluster-level `ResourceQuota` (manifests step) is the hard backstop. The
`workers` table, `placeForProject`, `placeForBurrow`, and `BurrowClientPool`
are all deleted.

---

## 4. Workspace / Git Model in Pods

### 4.1 Burrow domain logic retained as internal packages

Burrow's surviving logic (to be folded into warren as `src/workspace/`):

| Burrow file | Warren destination | Notes |
|---|---|---|
| `burrow/src/provider/local/workspace.ts` | `warren/src/workspace/materialize.ts` | `materializeProjectWorkspace`, `materializeTaskWorkspace`, `removeMaterializedWorkspace` |
| `burrow/src/git/worktree.ts` | `warren/src/workspace/git/worktree.ts` | `discoverHostClone`, `addWorktree`, `removeWorktree`, `cloneRepo` |
| `burrow/src/git/exec.ts` | `warren/src/workspace/git/exec.ts` | `runGit`, `runGitOrThrow` |
| `burrow/src/git/identity.ts` | `warren/src/workspace/git/identity.ts` | `resolveBurrowIdentity`, `writeBurrowGitconfig` |
| `burrow/src/secrets/env.ts` | `warren/src/workspace/env.ts` | env/secrets resolution |

The `MaterializedWorkspaceSource` type (`kind: "worktree" | "clone"`, `branch`,
`hostClonePath`, `gitCommonDir`, `originUrl`) and the `gitCommonDir` bind-mount
requirement (burrow-7a80) carry forward — they're valid concerns independent of
bwrap. However, with pod-per-run there is no sandbox bind-mount: the pod's
workspace is a volume (see §4.2), and `gitCommonDir` mounting is a non-issue
inside the pod's own filesystem.

### 4.2 Verdict: **init container for clone/worktree prep**

Two approaches:

**A. Entrypoint prep (single container):** the agent binary's entrypoint script
clones/checks out the repo, then execs the agent. Simple, but mixes workspace
setup into the agent image and makes the setup phase invisible (logs mixed with
agent output, no separate phase timing).

**B. Init container (recommended):** a `workspace-init` init container runs
before the agent container. It clones/materializes the workspace onto an
`emptyDir` volume shared with the agent container. The init container is a
lightweight image (`oven/bun:1.2-alpine` + git); it logs workspace setup
separately. The agent container mounts the same `emptyDir` at `/workspace`.

**Use init containers.** The separation makes clone failures visible as a
distinct pod condition (`Init:Error`), separately timed in metrics, and does not
pollute the agent's log stream. Warren sees the init container exit cleanly
before the agent starts; an init failure marks the pod `Failed` immediately
without the agent ever starting.

Init container receives:
- `WARREN_RUN_ID`, `WARREN_REPO_URL`, `WARREN_BRANCH`, `WARREN_BASE_BRANCH`,
  `WARREN_GIT_TOKEN` (from K8s Secret)
- Calls the materialization logic from `warren/src/workspace/materialize.ts`
  (compiled into the init image)

### 4.3 Repo / toolchain caching strategy

> **Superseded (warren-554f):** the repo-cache is now OPT-IN and off by
> default — the RWO claim deadlocks concurrent run pods (Multi-Attach), and
> RWX storage costs too much for what it saves. The design below stays as the
> historical record — see `deploy/k8s/README.md` "Repo cache (opt-in)" for the
> current operational story.

**Git repo cache:** PVC-backed `ReadWriteOnce` volume mounted by the init
container as the "host clone." The init container checks if a clone exists and
runs `git fetch` instead of a full clone when it does. This is equivalent to
burrow's `discoverHostClone` pattern from `burrow/src/git/worktree.ts` — the
init container probes the PVC mount for an existing `.git` dir and falls back to
`git clone` if absent. The worktree is checked out into the `emptyDir` volume
passed to the agent container. 

**Toolchain / image layer cache:** the current `Dockerfile` bakes bun 1.2,
Node.js 22, claude-code, pi, canopy, seeds, mulch, sapling, pnpm, and plot into
one image (2.x GB). This is the **agent image** (`warren-agent:latest`). Baking
these tools into the image is the right approach — toolchain layer cache hits
mean cold-start is dominated by image pull (mitigated by node-local image cache)
rather than `bun install` inside the pod.

**Do not use a PVC for toolchains** — that requires `ReadWriteMany` (expensive
on most storage backends) or careful per-node PVC allocation. Baked layers are
simpler and already work.

---

## 5. Event Streaming + Observability

### 5.1 NDJSON events pod → warren

Currently: burrow serves `GET /runs/:id/stream` as an SSE endpoint; the warren
bridge (`src/runs/stream/bridge.ts:bridgeRunStream`) consumes it and appends
rows to the `events` table.

With pod-per-run and no socket API, there are two options:

**A. Pod logs:** the agent binary writes NDJSON events to stdout/stderr. Warren's
pod-watcher streams logs via the K8s API (`GET /api/v1/namespaces/{ns}/pods/{name}/log?follow=true`)
and parses NDJSON from the stream, appending to the `events` table exactly as
the current bridge does. No extra network path; logs are durable in the K8s
API for the pod TTL.

**B. Direct HTTP push:** the agent binary POSTs NDJSON batches to
`POST /internal/runs/:id/events` on warren's HTTP API, authenticated via
`WARREN_API_TOKEN` (already injected per `src/runs/spawn/callback-env.ts:injectWarrenCallbackEnv`).

**Use pod logs (option A) for the initial migration.** Rationale:
- Zero new API surface on warren.
- Log streaming from the K8s API is battle-tested and handled by the same
  watcher goroutine already watching pod phase events.
- The existing bridge's NDJSON parsing logic (`src/runs/stream/bridge.ts`) is
  reusable against a pod log stream; the structural change is the source
  (K8s log stream vs. burrow SSE endpoint), not the parsing.

For live-stream fidelity, configure the K8s API log stream with `follow=true`
and no `since*`/`tailLines` — it replays the container's retained log then tails
immediately. NOTE (warren-245d): do NOT pass `sinceSeconds: 0`; the apiserver
validates `sinceSeconds > 0` and rejects `0` with HTTP 422, which silently wedges
the follow. Add option B (direct push) as a later optimization if log-stream
latency proves inadequate.

### 5.2 Prometheus

Warren already exposes `GET /metrics` (`src/server/handlers/metrics.ts`) with
run/cost/token gauges. Add:
- `warren_run_pod_phase{phase}` counter
- `warren_run_oom_killed_total` counter
- `warren_pod_pending_duration_seconds` histogram (scheduling latency)
- `warren_workspace_init_duration_seconds` histogram (clone time)

Deploy a `ServiceMonitor` for Prometheus Operator scrape (or configure static
scrape if running standalone Prometheus on Hetzner).

---

## 6. State

### 6.1 Supabase Postgres stays

The `WARREN_DB_URL` pointing at Supabase Postgres is unchanged. All migrations
under `src/db/migrations/postgres/` apply as-is. No data migration required.

New tables added in migration:
- `run_inbox` — steering messages (`id`, `run_id`, `body`, `priority`, `created_at`,
  `delivered_at`, `from_actor`)
- Drop `workers` table or repurpose as a pod audit log (drop preferred — cleaner).
- Drop `burrows` table (burrow IDs no longer exist).
- Columns `runs.burrow_id`, `runs.burrow_run_id`, `runs.worker_id` — nullified
  by migration, kept for historical rows, eventually dropped.

### 6.2 What replaces BURROW_DATA_DIR

`BURROW_DATA_DIR=/data/burrow` (`fly.toml`, `Dockerfile`) held burrow's SQLite,
`archive/`, and `projects/` across deploys. With burrow gone:

- **Warren's SQLite / project clones / canopy clone:** still in
  `WARREN_DATA_DIR=/data` on a `PersistentVolumeClaim` mounted by the warren
  Deployment. The project clone PVC is separate (§4.3).
- **Burrow's SQLite:** gone. Run events persist in Postgres. No other
  equivalent needed.
- **`BURROW_DATA_DIR` env var:** removed from the Deployment manifest.

The warren Deployment needs two PVCs (superseded — warren-554f made the
repo-cache opt-in and dropped it from the base. Kept here as history):
1. `warren-data` (5 Gi, `ReadWriteOnce`) — warren config, canopy clone.
2. `warren-repo-cache` (50 Gi, `ReadWriteOnce`) — project clones for workspace
   init (the "host clone" from `discoverHostClone`). Mounted by init containers,
   not by the warren Deployment pod directly (handled via job-level volume
   mounts referencing the same PVC when nodes allow; or use a NFS-backed
   `ReadWriteMany` PVC for true multi-node access — see §7 tradeoffs).

### 6.3 K8s Secrets

Map the current Fly secrets to K8s Secrets:

| Fly secret | K8s Secret key | Consumed by |
|---|---|---|
| `WARREN_API_TOKEN` | `warren-api-token` | Warren Deployment env |
| `ANTHROPIC_API_KEY` | `anthropic-api-key` | Run pod env (agent) |
| `GITHUB_TOKEN` | `github-token` | Warren Deployment + init container |
| `SENTRY_DSN` | `sentry-dsn` | Warren Deployment env (optional) |
| `WARREN_DB_URL` | `warren-db-url` | Warren Deployment env |

`BURROW_API_TOKEN` / `WARREN_BURROW_TOKEN` — deleted, not needed.

Agent pods receive only what they need: `ANTHROPIC_API_KEY`, `WARREN_API_TOKEN`
(for callback), `GITHUB_TOKEN` (for git push). NOT the DB URL. Minimize the
blast radius of a compromised pod.

---

## 7. Cluster Choice

### 7.1 Options

**Managed (GKE/EKS):** production-grade control plane, SLA, managed node
upgrades, native integration with cloud load balancers and storage classes.
GKE Autopilot: fully managed, pay-per-pod, good fit for bursty agent workloads.
EKS on Spot: cheap compute, but Spot interruptions require handling (pods evicted
mid-run). Cost: ~$150–300/month for a realistic agent workload (2–5 concurrent
runs, 8 Gi nodes, managed control plane fee ~$73/month GKE).

**K3s on Hetzner bare metal:** operator-managed control plane, Hetzner CX52
(8-core, 32 Gi, NVMe, €36/month) or AX41-NVMe (6-core, 64 Gi, €52/month).
K3s is a single-binary K8s distribution designed for single-operator clusters.
Compute cost is 5–10x cheaper than managed cloud. Operator must handle control
plane updates, etcd backups, and node failure recovery.

### 7.2 Verdict: **K3s on Hetzner bare metal**

Rationale:
1. **Cost:** one AX41-NVMe at €52/month comfortably runs the warren Deployment
   + 10 concurrent agent pods (10 × 4 Gi = 40 Gi, 10 × 4 CPU = 40 cores on a
   6-core box means CPU time-sharing, which is fine for mostly-waiting agent
   workloads). GKE/EKS equivalent is $300–500/month.
2. **Non-default runtime classes:** gVisor and Kata (§2) require node-level
   installation. On Hetzner bare metal with K3s, installing `containerd`
   shims for gVisor/Kata is straightforward. GKE Autopilot doesn't support
   custom runtime classes; GKE Standard supports gVisor as a node pool option
   but at standard cloud prices.
3. **Operator skill:** the operator is actively learning K8s. K3s reduces the
   surface area (single binary, built-in Traefik, built-in containerd, simple
   config) compared to a full K8s install. The K3s docs are explicit about
   single-node and small multi-node topologies.
4. **Storage:** Hetzner's NVMe-backed local storage is fast. For the project
   clone PVC, start with local-path provisioner (K3s default); upgrade to
   Longhorn (Hetzner-supported) for replication if a second node is added.

**Single-node K3s to start** (one Hetzner AX41-NVMe). Add a second node as a
worker (not control plane) when burst demand requires it. Hetzner's CX22
(€5/month) works as a dedicated worker for overflow; the control plane stays on
the AX41.

**Risk:** single node = single point of failure for the cluster. Mitigated by:
- Supabase Postgres is external — DB survives node failure.
- Warren Deployment restarts automatically when the node reboots (K3s auto-start
  via systemd).
- Agent pods that were running during a node failure have their runs marked
  `failed` by the watchdog (5-min timeout post-migration, §3.2) when they don't
  appear in the watch stream after recovery.

---

## 8. Migration Path

Each step is independently shippable with a defined rollback. `fly.toml` and
`docker-compose.yml` survive until step 5.

### Step 1: Extract workspace logic from burrow into warren (no deploy)

**What:** copy `burrow/src/provider/local/workspace.ts`,
`burrow/src/git/worktree.ts`, `burrow/src/git/exec.ts`, `burrow/src/git/identity.ts`,
`burrow/src/secrets/env.ts` into `warren/src/workspace/`. Adapt imports; add
tests. No production behavior changes — this is a dead code addition until step 4.

**Rollback:** `git revert`. Nothing deployed.

### Step 2: Provision K3s cluster on Hetzner + warren Deployment

**What:** install K3s on AX41-NVMe. Write warren `Deployment.yaml`,
`Service.yaml`, `Ingress.yaml` (Traefik). Configure K8s Secrets from current Fly
secrets. Deploy warren to K3s pointing at the existing Supabase Postgres. Warren
still dispatches to the Fly-resident burrow worker (`WARREN_BURROW_SOCKET` /
`WARREN_BURROW_*` env pointing at Fly internal network).

**Verify:** warren UI accessible via K3s node IP / domain. `GET /healthz` passes.
Run dispatch still works (goes to Fly burrow).

**Rollback:** DNS stays pointed at Fly; K3s cluster is idle.

### Step 3: Write K8s pod-dispatch path in warren (feature-flagged off)

**What:** implement `src/runs/pod-dispatcher.ts` — creates run pods via
`@kubernetes/client-node`. Implement `src/runs/pod-watcher.ts` — informer loop
reconciling pod phase → run state. Guard both behind `WARREN_K8S_DISPATCH=false`
env flag. Implement the init container image (clone/materialize workspace).
Write `src/workspace/materialize.ts` using the extracted burrow logic.

**Verify:** unit tests for pod spec builder, pod-watcher state machine, init
container materialization.

**Rollback:** flag stays `false`, no behavior change.

### Step 4: Enable K8s dispatch on K3s cluster; run in parallel with Fly burrow

**What:** set `WARREN_K8S_DISPATCH=true` on the K3s warren Deployment. New runs
dispatch to K8s pods. Old Fly burrow worker stays registered; in-flight runs on
Fly drain naturally (no new dispatch after the flag flip). Both code paths active
simultaneously. Monitor for 48 hours.

**Verify:** agent runs complete end-to-end on K3s. OOMKill test: dispatch a run
with a low memory limit; verify it fails fast with `failureReason: oom_killed`.
Steer test: send a steering message via `POST /runs/:id/steer`; verify the agent
receives it within 5s.

**Rollback:** set `WARREN_K8S_DISPATCH=false`. All new dispatch returns to Fly
burrow. K8s pods from the parallel phase are cleaned up by the pod-watcher GC.

### Step 5: Cut over DNS; retire Fly deployment

**What:** update DNS to point at the Hetzner/K3s node. Fly deployment set to
`auto_stop_machines = "on"` / `min_machines_running = 0` (idle). Delete `fly.toml`
from the repo. Mark `docker-compose.yml` as dev-only (it no longer needs the
four bwrap flags — replace with a simple `warren` service + no security_opt).

**Verify:** all traffic through K3s. Fly Machine scaled to 0 (cost goes to $0).

**Rollback:** flip DNS back to Fly. 1-minute RTO.

### Step 6: Archive burrow repo

**What:** remove `@os-eco/burrow-cli` from `warren/package.json`. Remove all
`BurrowClientPool`, `BurrowClient`, `placeForProject`, `placeForBurrow`,
`workers` table, `burrows` table code. File archival notice on the burrow repo.
Remove `src/supervisor/main.ts`.

**Verify:** `bun run check:all` passes without burrow-cli dep.

**Rollback:** not applicable — this is a cleanup step after the cutover is stable.

---

## 9. Risks and Open Questions

### Risks

**R1 — Single-node K3s availability.** A kernel panic or hardware failure on the
AX41 takes down the control plane and all run pods simultaneously. Mitigation:
Supabase Postgres is external; warren restarts via K3s systemd unit on reboot.
In-flight runs are failed by the 5-min watchdog after recovery. Tolerable for a
one-operator deployment; upgrade to 3-node etcd HA when uptime SLA requires it.

**R2 — Project clone PVC contention.** The `warren-repo-cache` PVC is
`ReadWriteOnce` on a single node — fine until a second worker node is added.
At that point, init containers may schedule on a node that can't mount the PVC.
Mitigation: start with local-path provisioner (single-node) and migrate to
Longhorn / Filestore `ReadWriteMany` before adding a second worker node.

*Status (warren-e908):* the cache is now WIRED *(superseded by warren-554f:
the cache is opt-in and off by default — this R2 Multi-Attach risk is exactly
why. See §4.3's superseded note)* — — the init container mounts the
claim at `/repo-cache` when `WARREN_K8S_REPO_CACHE_PVC` names it, keeps a
per-repo bare mirror (`<sha256(url)>.git`, `git clone --mirror` then `git fetch`
on re-use), and local-clones the run workspace out of the mirror onto the
`emptyDir` (see `src/runtime/k8s/workspace-init.ts`). Any cache failure falls
back to a direct network clone, so a wedged mirror never blocks a run. The RWX
storage-class migration above is still OUTSTANDING and gates going multi-node.
Note (warren-afb3): the live cluster ran a Filestore RWX cache from 2026-08-27
to 2026-09 and deleted it on cost (~$200/mo, 1 TiB Basic HDD minimum, against a
2.9 GB repo). The default init path is now a blobless partial clone
(warren-3b44). The mirror cache stays opt-in for single-node clusters only.

**R3 — Cold-start latency.** A fresh pod + image pull + git clone adds 10–60s
to run start time (depending on image cache hit and repo size). Currently burrow
pre-provisions a workspace before dispatch; the new init container runs in
series with scheduling. Mitigation: keep the agent image in a local registry on
the K3s node (Hetzner's private registry or a local Docker registry pod) so
image pull is local-network speed. Warm the repo cache PVC so clones become
`git fetch` (seconds, not minutes).

**R4 — Steering latency regression.** Current steer is near-real-time (unix
socket → bwrap stdin). New steer is HTTP-poll, 5s max latency. Acceptable for
most use cases; reduce poll interval to 1s if needed. The `run_inbox` table
approach is more reliable than the previous socket approach (survives pod
restart, warren restart) so this is a reliability gain at a latency cost.

**R5 — K3s learning curve.** The operator is actively learning K8s. Specific
risks: misconfigured RBAC (warren Deployment must have `pods` create/delete/watch
permissions in `warren-runs` namespace), misconfigured resource quotas blocking
pod creation, Traefik Ingress misconfiguration. Mitigation: use a dedicated
`warren-runs` namespace for run pods with a `ResourceQuota` (max 50 pods, 100
CPU, 200 Gi memory). Warren Deployment gets a `ServiceAccount` with a
`Role`/`RoleBinding` scoped to that namespace only.

**R6 — Log retention.** Pod logs are retained until the pod is deleted. Warren
must delete completed pods within a bounded time (30 minutes after terminal state)
to avoid accumulating thousands of dead pods. Implement a GC loop in the
pod-watcher: delete pods older than 30 minutes in `Succeeded` or `Failed` phase.

### Open Questions

**Q1 — Multi-project clone sharing.** The current project clone is a single
directory on the warren server's disk, shared across all runs for a given
project. With pod-per-run, the init container clones into a per-run `emptyDir`.
If two concurrent runs of the same project start simultaneously, both do a
`git fetch` on the same PVC-backed host clone (as per the worktree model from
`burrow/src/git/worktree.ts:discoverHostClone`). Is concurrent `git fetch` on
the same clone safe? Yes — git fetch is read/write to the object DB and reflog
but is safe under concurrent readers. One fetch per project per minute is
sufficient; implement a lock file or a simple `lastFetchedAt` DB check.

**Q2 — Preview sidecars.** Warren's preview launch (`src/preview/launch/`) boots
a per-run dev server sidecar (R-19 / [preview-environments.md](preview-environments.md)). With pod-per-run, the sidecar
becomes a second container in the same pod (sidecar container pattern, GA in K8s
1.29). The `inboundPortForwards` mechanism from
`burrow/src/provider/types.ts:SandboxProfile` is replaced by a K8s `Service` of
type `ClusterIP` exposing the sidecar port, and warren's preview proxy routes to
that Service. Design this separately — it doesn't block the initial migration.

**Q3 — Conversation runs.** `run.mode === 'conversation'` runs are explicitly
excluded from the watchdog (`src/runs/watchdog.ts`: `if (run.mode === "conversation") continue;`)
because they are long-lived across turns. With pod-per-run, a conversation run's
pod must also be long-lived (the agent process persists between turns, reading
from the inbox). This conflicts with the `restartPolicy: Never` posture (a
crashed conversation pod cannot be restarted). Design: conversation runs get a
separate pod template with `restartPolicy: OnFailure` and a shorter pod TTL;
the pi-chat runtime's stdin-hold approach (`SpawnCommand.holdStdin: true` in
`burrow/src/provider/types.ts`) translates to keeping the agent process alive
while polling the inbox. Design this separately — conversation mode is a small
fraction of current runs.

**Q4 — RBAC for the K8s API from warren.** Warren needs to call the K8s API to
create/delete/watch pods. The `@kubernetes/client-node` library reads in-cluster
credentials from the pod's service account token. Scope: `pods`
get/list/watch/create/delete in `warren-runs` namespace. `pods/log`
get/watch for log streaming. No cluster-level permissions needed.

---

## Summary of Key Decisions

| Topic | Decision |
|---|---|
| Run isolation | Bare pods, `restartPolicy: Never`, pod-per-run |
| Warren topology | `Deployment`, no supervisor, no burrow child |
| Sandbox | runc default, no bwrap, no gVisor/Kata in v1 |
| Security flags | All four docker-compose flags deleted |
| Resource enforcement | `resources.limits` kubelet-enforced via cgroup v2 |
| OOM failure | Pod-watcher detects OOMKilled within 1–2s; watchdog timeout → 5 min |
| Watchdog | Retained but shortened; not removed |
| Placement | K8s scheduler; `workers` table + `BurrowClientPool` + `placement.ts` deleted |
| Warren admission | Queue depth limit + max pending pods + per-project cap |
| Workspace prep | Init container on `emptyDir` shared with agent container |
| Git cache | PVC-backed host clone; `git fetch` on re-use |
| Toolchain cache | Baked image layers (unchanged from current Dockerfile) |
| Event streaming | Pod log stream → warren bridge (same NDJSON parsing) |
| Steering | `run_inbox` Postgres table + agent HTTP poll (5s latency) |
| Cluster | K3s on Hetzner AX41-NVMe bare metal (€52/month) |
| State DB | Supabase Postgres (unchanged) |
| Burrow repo | Archived after step 6 |
| Fly deployment | Retired at step 5 |
| Fly secrets | Migrated to K8s Secrets at step 2 |
