# Resumable Agent Environments

**Kind:** proposal
**Design state:** proposed
**Delivery:** unscheduled
**Arrived:** 2026-08-20
**Tracker:** `warren-59a3`
**Related:** [`runtime-provider-contract.md`](runtime-provider-contract.md),
[`runtime-docker-provider.md`](runtime-docker-provider.md),
[`k8s-migration.md`](k8s-migration.md), and
[`preview-environments.md`](preview-environments.md)

## Decision

Warren will model resumable heavyweight development state as an
**Environment** resource. An Environment owns durable repositories,
workspace files, declared service data, routes, and lifecycle policy. A
**Run** remains one immutable agent execution attempt and never returns to
`running` after reaching a terminal state.

Environment hibernation is reconstructive by default:

1. Quiesce and stop declared services.
2. Confirm that workspace and service data are durable.
3. Release agent and service compute.
4. Preserve the Environment identity and its durable state.
5. On resume, allocate new compute, mount or restore the state, inject fresh
   credentials, restart services, and wait for readiness.
6. Start a new Run when the user continues agent work.

The portable guarantee covers declared files and data. It does not promise
preservation of RAM, processes, PIDs, sockets, terminals, in-flight tool
calls, wall-clock continuity, or resolved secrets. Provider-specific
process freezing and memory checkpoints may later accelerate this flow, but
they are optional capabilities with a continuously tested reconstructive
fallback.

This record is a direction lock, not an implementation plan. It remains
unscheduled; repeated measured setup, service, or multi-repository continuity
friction from the external-repository mirror pilot is its roadmap promotion
trigger. Product and topology questions remain open in
[Open questions](#open-questions).

## Why this is a separate resource

Warren's current lifecycle is run-shaped:

```text
POST /runs
  → persist queued Run
  → RuntimeProvider.create
  → stream events and mark running
  → detect terminal outcome
  → finalize workspace
  → terminate runtime and reclaim workspace
```

The canonical Run states are deliberately small:

```text
queued → running → succeeded | failed | cancelled
```

That model serves batch execution, accounting, plan-run gates, retries,
analytics, and audit history. Adding `paused`, `hibernating`, or `resuming`
to `RUN_STATES` would redefine a Run as a reusable machine and spread that
change through recovery, watchdogs, admission, reap, plans, SDK types, UI,
and generated API documentation.

A heavyweight project has a different lifetime. Its repositories,
dependency installation, databases, language servers, and dev servers may
be useful across many agent attempts and long human review gaps. That state
needs an owner that can outlive any one Run.

The ownership rule is therefore:

```text
Session / Thread   durable conversation, intent, approvals, and Run lineage
Environment        durable workspace, service data, topology, and lifecycle
Run                immutable execution attempt, events, cost, and outcome
Compute session    replaceable process, container, Pod, or VM
```

A Session or Thread is included in the conceptual model because market
implementations consistently distinguish conversation continuity from both
workspace identity and execution attempts. Warren does not need to ship all
three resources in one release, but it must not force conversation
continuity into either Run state or Environment state.

## Terminology

| Term | Meaning |
|---|---|
| **Run** | One immutable invocation of an agent: prompt, model, events, cost, outcome, and finalization. |
| **Session / Thread** | Durable user intent, conversation, approvals, summaries, and lineage across Runs. |
| **Environment** | Durable repository set, workspace, declared data, services, routes, and lifecycle policy. |
| **Compute session** | One replaceable allocation that executes an agent or Environment services. |
| **Hibernate** | Quiesce services, remove routes, release compute, and preserve declared durable state. |
| **Resume** | Allocate compute, restore durable state, inject fresh credentials, start services, and verify readiness. |
| **Agent pause** | A short-lived cooperative or process freeze that retains live compute. Not durable hibernation. |
| **Checkpoint** | A provider artifact containing filesystem and possibly process or memory state. |
| **Cache** | Reusable derived or immutable data that can be discarded without losing user work. |
| **Purge** | Irreversible deletion of Environment state. |

The API and UI should avoid a generic **Suspend** action. That word does not
tell an operator whether Warren will keep billing for RAM, stop services,
preserve files, or take a memory checkpoint.

## Existing Warren foundations

The proposal builds on seams Warren already has:

- `src/runtime/contract.ts` keeps backend handles opaque and makes provider
  capabilities explicit.
- `src/runs/stream/recover.ts` resumes event consumption from Warren's
  durable event cursor.
- `src/runs/spawn/continuation.ts` can begin a new Run from a prior Run's
  pushed branch, although that is not Environment resume.
- `src/runtime/k8s/workspace-init.ts` has a narrow, token-free Git mirror
  cache with cold-clone fallback.
- `src/preview/` proves that a service process and workspace may outlive the
  agent process that created them.
- Pi session metadata is recoverable from `.pi/sessions`, but Warren does
  not currently provide a general harness-session restore contract.

Several current assumptions must change for Environment-attached Runs:

- `RuntimeProvider.terminate()` currently reclaims the run-owned workspace.
- Local and Docker execution state lives in the in-memory Local run store.
- K8s workspaces use Pod-scoped `emptyDir`, which disappears with the Pod.
- Current previews describe one setup command, one server command, and one
  exposed port rather than a service graph.
- The existing K8s repo-cache PVC is an init-only bare mirror, not a writable
  workspace or service-data volume.

Environment support must not silently make `terminate()` conditional. A
standalone Run and an Environment-attached Run have different teardown
obligations:

```text
standalone Run:             finalize → terminate and reclaim workspace
environment-attached Run:   finalize → detach Run compute
```

## Market validation

Research completed for this record found a consistent separation between
durable orchestration, durable workspace state, and replaceable compute.
Public behavior changes quickly, especially on beta services, so the linked
primary sources remain authoritative.

### Anthropic

Anthropic's Managed Agents architecture separates a durable append-only
**session**, a replaceable **harness**, and a replaceable **sandbox**. Its
engineering account describes the earlier coupled container as an
irreplaceable pet; after separation, a harness can wake an existing session
and a sandbox can be reprovisioned independently.

Managed Agents also separates reusable Environment configuration from
sessions. Public documentation does not promise portable RAM or process
restoration. The design instead keeps durable agent history outside the
execution sandbox and treats sandbox replacement as normal.

Sources:

- [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents)
- [Managed Agents environments](https://platform.claude.com/docs/en/managed-agents/environments)
- [Managed Agents sessions](https://platform.claude.com/docs/en/managed-agents/sessions)

### OpenAI

OpenAI's Sandbox Agents documentation distinguishes three forms of state:
agent `RunState`, serialized provider sandbox-session state, and workspace
snapshots used to seed fresh compute. Its recovery order prefers a live
session, then reconnectable session state, then a fresh session optionally
seeded by a manifest or snapshot.

Codex cloud environments cache container state for a bounded period and run
an optional maintenance script when an older environment is reused. Public
documentation does not guarantee restoration of arbitrary live processes.
This supports capability-based acceleration over a reconstructive baseline.

Sources:

- [OpenAI Sandbox Agents](https://developers.openai.com/api/docs/guides/agents/sandboxes)
- [Codex cloud environments](https://developers.openai.com/codex/cloud/environments)

### Vercel eve and Vercel Sandbox

The correct project name is **eve**. It is Vercel's durable agent framework,
not its sandbox product. Eve checkpoints workflow steps so a conversation
can wait for approval or survive a deployment without holding compute; its
sandbox adapter delegates execution to a separate sandbox implementation.

Vercel Sandbox distinguishes a durable named sandbox from one running VM
session. Stopping or timing out a sandbox snapshots its filesystem, and the
next operation starts a new session from that state. Vercel does not claim
that normal snapshot restore preserves RAM or running processes.

Vercel's snapshot engineering also validates an independent locality cache.
The published account reports that parallel restore plus a local cache of
decompressed images reduced p75 restore from more than 40 seconds to under
one second on cache hits, with a reported 95% hit rate.

Sources:

- [Introducing eve](https://vercel.com/blog/introducing-eve)
- [eve documentation](https://vercel.com/docs/eve)
- [Vercel Sandbox concepts](https://vercel.com/docs/sandbox/concepts)
- [Vercel Sandbox snapshots](https://vercel.com/docs/sandbox/concepts/snapshots)
- [Optimizing Vercel Sandbox snapshots](https://vercel.com/blog/optimizing-vercel-sandbox-snapshots)

### Other relevant systems

The broader market reinforces the same portable baseline:

| System | Durable baseline | Process or RAM continuation |
|---|---|---|
| GitHub Codespaces | Workspace survives stop; services restart | Not promised |
| Cursor Cloud Agents | Reusable Environment Builds and disk snapshots | Explicitly not preserved |
| Devin | Prepared environment snapshot copied into a fresh session | Not promised |
| Daytona containers | Filesystem survives stop/start | Not preserved |
| Kubernetes Agent Sandbox | Stable Sandbox object and volumes survive scale-to-zero | Separate snapshot extension |
| Modal filesystem snapshots | Differential filesystem image | Separate experimental memory snapshot |
| E2B | Filesystem-only or full-memory pause | Optional full-memory mode |
| Fly Machines | Volumes plus optional Firecracker suspend | Best-effort, cold fallback required |
| GKE Pod Snapshots | Persistent volume baseline plus optional Pod snapshot | Compatibility-bound full-Pod restore |

Primary references:

- [GitHub Codespaces lifecycle](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle)
- [Cursor Cloud Agent setup](https://cursor.com/docs/cloud-agent/setup)
- [Devin environments](https://docs.devin.ai/onboard-devin/environment)
- [Daytona persistence](https://www.daytona.io/docs/en/persistence/)
- [Kubernetes Agent Sandbox](https://agent-sandbox.sigs.k8s.io/docs/)
- [Modal Sandbox snapshots](https://modal.com/docs/guide/sandbox-snapshots)
- [E2B persistence](https://e2b.dev/docs/sandbox/persistence)
- [Fly Machine suspend and resume](https://fly.io/docs/reference/suspend-resume/)
- [GKE Pod snapshots](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/pod-snapshots)

### What memory snapshots change—and what they do not

E2B, Daytona VMs, Fly Machines, Modal, and GKE demonstrate real value from
memory restoration: processes and initialized services may return much
faster than a cold start. They also expose the limits of treating it as a
portable guarantee:

- Restore may require the same CPU architecture, machine class, kernel,
  runtime, gVisor, CRIU, or Firecracker version.
- TCP clients disconnect, peers expire old sockets, and restored workloads
  may receive a new IP or hostname.
- Secrets, certificates, leases, and environment values captured in memory
  may be stale when the process returns.
- Providers may expire, invalidate, reclaim, or fail to restore snapshots.
- Snapshot and transfer cost grows with resident memory.
- Multi-service or multi-volume snapshots are not necessarily atomic or
  application-consistent.

A provider may therefore report a process-checkpoint restore as an
acceleration result. It may not weaken Warren's obligation to reconstruct
the Environment correctly when that artifact is unavailable or
incompatible.

## Environment lifecycle

The proposed lifecycle is:

```text
provisioning → active
active → hibernating → hibernated
hibernated → resuming → active
active | hibernated | error | lost → deleting → deleted
transition failure → error
provider object missing → lost
```

Service health is orthogonal:

```text
starting | ready | degraded | unhealthy | stopped | unknown
```

The durable record should also hold:

- `desiredState`: `active | hibernated | deleted`
- A generation incremented on every accepted mutation
- The last stable lifecycle state
- The active operation and durable stage
- Whether compute is believed allocated
- A structured failure reason and provider detail
- Retriability and operator recovery guidance

### Hibernate invariants

Hibernation follows these rules:

1. No Run may be active on the Environment.
2. New Run attachment is disabled before quiescing begins.
3. Public routes stop serving the application and return an authenticated
   hibernated response.
4. Services stop in reverse dependency order.
5. Project-defined quiesce hooks flush declared durable data.
6. Warren confirms durable state before releasing source compute.
7. The Environment becomes `hibernated` only after provider confirmation.

The UI may offer **Stop agent, then hibernate**, but it represents two
visible operations. The first cancels and finalizes or otherwise settles the
Run; the second hibernates the now-idle Environment.

### Resume invariants

Resume reverses the dependency order:

1. Allocate compute and attach or restore durable storage.
2. Validate the Environment specification, image digest, and checkpoint.
3. Inject newly minted credentials and network identity.
4. Start dependencies before dependents.
5. Run reconciliation hooks for clock, host identity, Git, database, and
   network changes.
6. Wait for declared readiness probes.
7. Expose routes and mark the Environment `active`.
8. Start a new Run only after the Environment is ready.

Resume does not silently fetch, rebase, or update repositories. Updating
from upstream is an explicit operation because it changes the user's
working state.

## Persistence model

A later implementation should introduce three durable stores in SQLite and
Postgres.

### `environments`

The Environment row needs at least:

- ID, project ID, and display name
- Lifecycle, desired state, generation, and timestamps
- Provider kind, opaque provider ID, and provider format version
- Environment specification and normalized digest
- Resolved image digest and architecture
- Resolved repository manifest and primary branch/base commit
- Workspace, archive, or volume references and checksums
- Active Run ID, nullable
- Service-health summary
- Last meaningful activity and retention deadline
- Storage bytes and compute-allocation belief
- Last stable state and structured failure fields

### `environment_operations`

Lifecycle mutation must be restart-reconcilable rather than an in-memory
promise. Each operation records:

- Operation and Environment IDs
- Type: provision, resume, hibernate, or delete
- Idempotency key
- Expected and resulting Environment generation
- State and durable stage
- Requested, started, and settled timestamps
- Structured result or error

### `environment_events`

Environment lifecycle, service state, cache decisions, and automated policy
actions need their own monotonic event stream. They are not model events and
must not be mixed into a Run transcript.

Runs gain nullable `environmentId` and `environmentGeneration` fields. A
transactional claim or compare-and-swap enforces at most one active Run per
Environment; a process-local check is insufficient.

## Provider contract direction

Environment lifecycle should have a separate provider seam rather than
expanding the current run provider with ambiguous pause semantics:

```ts
interface EnvironmentProvider {
  readonly capabilities: EnvironmentCapabilities;

  provision(
    spec: EnvironmentSpec,
    generation: number,
  ): Promise<EnvironmentHandle>;

  status(handle: EnvironmentHandle): Promise<EnvironmentStatus>;

  hibernate(
    handle: EnvironmentHandle,
    intent: HibernateIntent,
  ): Promise<HibernateResult>;

  resume(
    handle: EnvironmentHandle,
    intent: ResumeIntent,
  ): Promise<ResumeResult>;

  destroy(
    handle: EnvironmentHandle,
    intent: DestroyIntent,
  ): Promise<DestroyResult>;

  prepareRun(
    handle: EnvironmentHandle,
    runId: string,
  ): Promise<RunWorkspaceAttachment>;
}
```

Capabilities describe semantics, not backend names:

```ts
interface EnvironmentCapabilities {
  hibernation: "none" | "reconstructive";
  workspacePersistence: "host-path" | "persistent-volume" | "archive";
  survivesControlPlaneRestart: boolean;
  survivesWorkerLoss: boolean;
  serviceTopology: "process-group" | "compose" | "pod" | "resource-set";
  processFreeze: "none" | "same-host-bounded";
  checkpoint: "none" | "filesystem" | "process";
  volumeSnapshots: boolean;
  warmPool: boolean;
}
```

Provider results must say whether resume used a warm live allocation, a
filesystem snapshot, a process checkpoint, or cold reconstruction. They
must also report any fallback reason.

## Provider mappings

### Local

The Local provider uses a durable host workspace and declared data
directories. Environment services run as supervised process groups.
Hibernation stops those processes and retains their files.

A same-host cgroup freeze may later be offered as a short bounded pause. It
is not durable across Warren restart, process loss, or host loss. External
archive or backup remains necessary for worker-loss survival.

### Docker

The Docker provider uses a per-Environment network, durable host workspace,
and named data volumes. A Compose-like service set maps naturally onto
stop/recreate semantics.

Correctness must not depend on retaining mutable container layers. Service
containers may be recreated from digest-pinned images; only the declared
workspace and volumes are durable.

### Kubernetes

The current K8s runtime cannot hibernate a workspace because it stores that
workspace in a run Pod's `emptyDir`. Environment support requires durable
per-Environment storage.

Two viable topologies need a later decision:

1. A resident Environment Pod with an RWO PVC, with services and attached
   execution sharing one Pod lifecycle.
2. Separate run and service resources using RWX workspace storage, or an
   explicit same-node attachment contract.

The first simplifies storage and resembles Kubernetes Agent Sandbox. The
second preserves stronger workload separation but increases scheduling,
reconciliation, and storage complexity. Warren must not claim K8s
hibernation until one topology and its storage requirements are explicit.

### Hosted and experimental accelerators

CRIU, Firecracker snapshots, E2B-style memory pause, and GKE Pod Snapshots
fit behind optional capabilities. Each needs a compatibility tuple,
encrypted artifact handling, expiry policy, and cold fallback.

A checkpoint compatibility tuple may include:

- Provider and checkpoint format version
- Image digest and architecture
- CPU and machine class
- Kernel, OCI runtime, and sandbox runtime versions
- Security profile and mount layout
- Network mode and service topology digest

## Multi-repository and multi-service specification

A new `.warren/environment.yaml` should be the canonical Warren format.
Dev Container and Compose import may compile into it later, but neither
external format should define Warren's provider-neutral contract.

A representative shape is:

```yaml
repositories:
  primary:
    path: .
    writable: true
  api:
    url: https://github.com/acme/api
    ref: main
    path: repos/api
    writable: false
  web:
    url: https://github.com/acme/web
    ref: main
    path: repos/web
    writable: false

setup:
  - command: bun install
    inputs:
      - package.json
      - bun.lock

services:
  postgres:
    image: postgres:17
    persistent_paths:
      - /var/lib/postgresql/data
    readiness:
      tcp_port: 5432

  api:
    command: bun run dev
    depends_on: [postgres]
    readiness:
      http: /healthz
      port: 3000

  web:
    command: bun run dev
    depends_on: [api]
    route:
      port: 5173

lifecycle:
  idle_after: 30m
  hibernate_after: 1h
  retain_for: 7d
  delete_after: 30d
```

The initial portable subset should model:

- Repository origin, revision, path, and read/write scope
- Service image or command, dependency order, and readiness probe
- Ports, routes, and visibility
- Durable volumes and paths
- Quiesce, startup, and resume hooks
- Environment variables versus secret references
- Resource and network policy
- Cache mounts and setup fingerprints
- Primary agent workspace

An escape hatch for provider-native fields is acceptable. It must not let an
opaque shell command bypass Warren's security, lifecycle, health, and
retention model without making that degradation visible.

## Cache model

Environment state is not a cache. It is private mutable user state whose
loss may destroy work. Shared caches are discardable optimizations with
independent trust boundaries and invalidation rules.

Warren should model these layers independently:

1. **OCI Environment image** — toolchains and stable system dependencies,
   keyed by digest, platform, and runtime class.
2. **BuildKit cache** — build graph and intermediate layers, scoped by
   project or trust domain.
3. **Git mirror cache** — source object data keyed by normalized origin and
   trust namespace; credential-free but still private.
4. **Package-manager stores** — keyed by image, platform, package-manager
   version, and lockfile digest.
5. **Prepared Environment build** — immutable, sanitized seed produced by
   setup, keyed by specification, repository commits, lockfiles, image, and
   schema version.
6. **Mutable Environment state** — private workspace and declared service
   data, keyed by Environment ID and generation; never treated as shared
   cache.
7. **Warm capacity** — preallocated clean compute keyed by image, resource
   class, architecture, and sandbox runtime.
8. **Optional process checkpoint** — compatibility-bound acceleration for
   one Environment generation.
9. **Locality cache** — node-local compressed or decompressed artifacts that
   reduce restore transfer and unpack time.

Invalidation follows content identity:

- Mutable branch names are not sufficient cache keys.
- A digest mismatch is a miss, not an in-place mutation.
- Secret values are neither cache inputs nor cache contents.
- Runtime and schema changes bump the key version.
- Population publishes atomically from a temporary entry.
- A corrupt or unavailable entry falls back to cold provisioning.
- Cache TTL, LRU, and size quotas are independent of Environment retention.

Metrics should identify the chosen path and cost: cache hit or miss, bytes
restored, image pull time, setup time, checkout time, service readiness,
checkpoint restore, cold fallback, and resume-to-ready duration.

## Secrets and security

Environment artifacts contain private source and may contain generated
credentials or sensitive service data. Treat archives and checkpoints as
secrets: encrypt them at rest, authenticate metadata, checksum content,
apply project/operator ACLs, and support secure retention and deletion.

Resolved credentials do not belong in Environment rows, shared images, or
cache layers. Resume must mint and inject fresh Git, provider, registry, and
tool credentials. Prefer short-lived workload identity, credential proxies,
scoped mounts, and brokered tool operations over static environment values.

A process checkpoint is more sensitive than a filesystem checkpoint because
it captures arbitrary memory. It may preserve expired tokens, encryption
keys, host identity, and random state that cannot be safely replaced after
restore. A provider that restores process memory must run explicit identity,
credential, network, and clock reconciliation before the Environment becomes
ready.

Shared warm pools contain only clean immutable template state. Tenant
credentials bind after assignment, and a tenant-mutated sandbox is destroyed
rather than returned to the pool.

## API direction

A future public API may take this shape:

```text
POST   /environments
GET    /environments
GET    /environments/:id
GET    /environments/:id/events
POST   /environments/:id/resume
POST   /environments/:id/hibernate
DELETE /environments/:id

POST   /runs { environmentId, ... }
```

Lifecycle operations are asynchronous and durable:

- Return `202` with an operation ID.
- Accept an idempotency key.
- Require an expected generation through `If-Match` or an explicit field.
- Persist requested, started, stage-completed, and settled events.
- Reconcile safely after Warren restarts.
- Surface provider detail, retriability, and compute-allocation belief.

Expected conflict and admission classes include:

```text
409 active_run
409 transition_in_progress
412 generation_mismatch
422 environment_hibernation_unsupported
429 environment_compute_quota
507 environment_storage_quota
```

Unauthenticated route traffic must never wake an Environment. A hibernated
route returns an authenticated sleeping page or structured unavailable
response until an operator resumes it.

## Lifecycle policy and garbage collection

Compute and storage have different limits. Warren needs separate quotas for
active Environments, active Runs, hibernated Environments, durable storage,
and concurrent provisioning or resume operations.

Lifecycle policy should distinguish:

- Idle active timeout
- Automatic hibernation delay
- Maximum uninterrupted active lifetime
- Hibernated retention
- Checkpoint retention count and TTL
- Hard deletion deadline
- Authenticated keep-awake lease

Meaningful activity includes active agent execution, steering, operator
actions, and real authenticated proxy traffic. Health probes, polling,
background logs, and open sockets do not reset idle time.

Pressure handling is conservative:

1. Reject admission when hard capacity is exhausted.
2. Hibernate the least-recently-used idle Environment with no active Run.
3. Purge only expired Environments that are clean, fully pushed, or durably
   archived.
4. Never silently purge dirty or unpushed work.

Automated actions record a reason such as `idle_ttl`, `max_lifetime`,
`compute_quota`, `storage_retention`, or `operator_request`.

## Preview convergence

Current run previews remain a compatibility path for standalone Runs. New
Environment services own their routes and health independently of Run state.

On hibernation, routes stop forwarding to services and expose Environment
status. Authenticated route traffic may count as activity, but it must not
auto-resume expensive compute without an explicit operator policy.

A later migration may project the existing preview UI onto Environment
services while preserving current public API and documentation paths. The
one-command preview configuration should not become the generic service
manager by incremental extension.

## Failure behavior

Lifecycle failures preserve recoverability over apparent success:

- **Crash during hibernation:** reconcile from the durable operation stage;
  never declare `hibernated` before durable state is confirmed.
- **Snapshot or archive failure:** retain source compute and workspace when
  possible; enter a retriable error state.
- **Unclean service shutdown:** force stop after grace, record the warning,
  and require recovery hooks on resume.
- **Readiness failure:** retain workspace and logs, expose diagnostics, and
  allow retry or safe re-hibernation.
- **Provider object missing:** mark the Environment `lost`; never silently
  create an empty workspace under the same ID.
- **Expired secrets:** mint fresh credentials; fail closed if refresh fails.
- **Concurrent lifecycle requests:** resolve through generation checks and
  idempotent operation records.
- **Partial multi-repository restore:** do not mark active until all required
  repositories and service prerequisites are satisfied.
- **Process-checkpoint incompatibility:** record the reason and reconstruct
  cold rather than failing the Environment when durable files are intact.

## Delivery sequence

A likely implementation sequence is:

1. **Design lock and benchmarks** — settle ownership, branch/PR semantics,
   detach behavior, and K8s topology; measure clone, setup, readiness,
   archive, and resume stages.
2. **Durable model and reconciler** — add Environment, operation, and event
   persistence with idempotency and generation handling.
3. **Local MVP** — durable host workspace, multi-repository materialization,
   supervised services, manual and idle hibernation, one attached Run.
4. **Docker provider** — per-Environment network, named volumes, service
   graph, and stop/recreate semantics.
5. **Portable cache layers** — OCI prebuild, BuildKit cache, package stores,
   setup fingerprints, metrics, and eviction.
6. **Preview and route convergence** — Environment service routes and UI,
   retaining legacy standalone previews.
7. **K8s beta** — only after selecting a storage topology and declaring its
   required storage class.
8. **Optional accelerators** — warm pools, CSI snapshots, image pre-pulls,
   lazy loading, and provider-specific process checkpoints.

## Rejected alternatives

### Add `paused` to Run state

Rejected because it conflates execution history with workspace lifetime and
weakens every current consumer of the queued/running/terminal state machine.
A terminal Run remains immutable.

### Add `RuntimeProvider.pause()` with provider-neutral semantics

Rejected because Local process stop, Docker freezer pause, K8s Pod deletion,
and memory checkpointing preserve different state and consume different
resources. One boolean capability would hide rather than normalize those
differences.

### Make CRIU or VM snapshots the default

Rejected because compatibility, secrets, network identity, and lifecycle
limitations make memory restoration unsuitable as Warren's portable
correctness contract. It may be an accelerator behind explicit capability
and fallback reporting.

### Reuse the K8s repo-cache PVC as Environment storage

Rejected because that volume contains shared bare Git mirrors, is mounted
only during init, and is intentionally optional due to RWO multi-attach
hazards. Mutable Environment data requires separate identity, isolation,
retention, and storage topology.

### Extend preview configuration into an Environment schema

Rejected because one setup command, one server command, and one port cannot
express multiple repositories, service dependencies, durable volumes,
quiesce hooks, secret references, or provider capabilities cleanly.

## Open questions

1. **Session resource:** Does Warren introduce an explicit Session/Thread in
   the first Environment release, or initially expose only Run continuation
   lineage?
2. **Branch and PR ownership:** Does one Environment own one long-lived
   branch and PR, or does every attached Run retain its current per-Run
   branch and finalization behavior?
3. **K8s topology:** Should an Environment be a resident singleton Pod with
   an RWO PVC, or a resource set whose Runs and services require RWX or
   same-node attachment?
4. **Canonical configuration:** Is `.warren/environment.yaml` native first,
   with Dev Container and Compose import later, or must one importer ship in
   the MVP?
5. **Database consistency:** Which quiesce hook and volume-group semantics
   are required before Warren may label a service-data snapshot clean?
6. **Worker-loss durability:** Which providers must archive Environment data
   off-host before claiming that an Environment survives worker loss?
7. **Automatic resume:** Are authenticated preview requests ever allowed to
   wake an Environment, or is explicit operator action always required?
8. **Multi-repository writes:** When, if ever, may auxiliary repositories be
   writable, and how are independent commits and PRs represented?

## Acceptance principles

Any eventual implementation must preserve these principles:

- Runs remain immutable audit records.
- Environment state and shared cache state have separate ownership and GC.
- Hibernation never reports success before durable state is confirmed.
- Resume injects fresh credentials and passes declared readiness checks.
- Process checkpoints are optional and always have a cold fallback.
- Provider capability differences are explicit in the contract and UI.
- Dirty or unpushed work is never silently purged.
- The control plane can reconcile every lifecycle transition after restart.
