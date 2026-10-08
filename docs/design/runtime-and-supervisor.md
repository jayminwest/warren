# Runtime, Supervisor & Event Durability

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-01
**Shipped:** v0.17.0 reflects the warren-owned runtime
**Current truth:** `src/runtime/`, `src/sandbox/`, and `src/supervisor/`

> **Provenance:** lifted from the retired top-level spec §3.3, §5.1–5.3,
> §9, §10.3, and §11.A as part of the SPEC retirement plan `pl-1717`
> (step `warren-8184`), then rewritten in warren-ea0a when plan pl-3007
> (the burrow absorption) deleted the co-tenanted daemon. The wording
> below is the live contract, so edit it only in lockstep with the code
> it describes.

## The seams that matter

- **RuntimeProvider contract** (`src/runtime/contract.ts`) — the
  load-bearing seam for *where* a run executes. Warren's domain
  (`src/runs/*`) speaks only this eight-method contract; the backend
  (in-process `LocalProvider` or pod-per-run `K8sProvider`) is
  selected at boot by `WARREN_RUNTIME`. No sandbox id, pod name, or
  host path crosses it beyond the contract's own fields.
- **Runtime adapters** (`src/runtime/adapters/`) — the per-harness
  half of the spawn path: `buildSpawnCommand`, stdout parsers, and
  steering encoders for `claude-code` and `pi`, source-lifted from
  burrow in warren-7933.
- **CLI shell-out for mulch/seeds** — these tools are git-native,
  file-locked, atomic. Warren does not embed their state; it shells
  out.
- **HTTP API for warren itself** — the UI is one consumer; ad-hoc
  scripts and future orchestrators are others.

## Process model

One long-lived process inside the container, plus short-lived
shell-outs:

- **supervisor** — `src/supervisor/main.ts`. Spawns warren as its only
  child, forwards SIGTERM/SIGINT, and exits when warren exits.
- **`warren`** — Bun.serve, the platform process. HTTP API + UI +
  scheduler tick (single-flight in-process loop). Under the `local`
  runtime it also owns the agent run loop: `LocalProvider`'s
  in-process engine (`src/runtime/local/engine.ts`) materializes the
  workspace (`src/workspace/materialize.ts`), composes the bwrap
  profile (`src/runtime/local/profile.ts` over `src/sandbox/`), and
  drives the agent child through the host-side drive loop
  (`src/runtime/local/drive.ts`).

Plus short-lived shell-outs to `sd`, `ml`, `git`, and the agent
children the drive loop spawns.

## Why the run loop is in-process now

Before the absorption, a co-tenanted burrow daemon owned the sandbox
so warren restarts would not kill in-flight runs. Plan pl-3007 traded
that isolation for one less process, one less socket, and one less
dependency: the engine persists run state in its in-process store
(`src/runtime/local/run-store.ts`), and a warren restart reconciles
live rows as lost — the same operator-visible outcome a daemon
restart produced, accepted as the local topology's posture. The `k8s`
runtime keeps the stronger guarantee: the pod outlives the control
plane, and the pod-watcher re-attaches on boot.

## Sandbox nesting

> **Scope: the `local` runtime provider only.** Nested bwrap and its
> four flags exist to let warren's user-namespace sandboxes come up
> inside the outer container. The `k8s` provider has no nested
> sandbox — the pod boundary *is* the isolation, kubelet enforces
> resources via cgroups v2, and all four flags disappear
> (`runAsNonRoot`, `drop: [ALL]`, `seccompProfile: RuntimeDefault`
> instead). See [`docs/RUNBOOK-K8S.md`](../RUNBOOK-K8S.md) and
> [`docs/design/k8s-migration.md`](k8s-migration.md) §2.

Under the `local` provider, warren runs `bwrap`-isolated agents inside
the warren container. The container needs the four flags from
`mulch:mx-94901b` / `mulch:mx-c085ba`:

```yaml
security_opt:
  - apparmor=unconfined
  - seccomp=unconfined
  - systempaths=unconfined
cap_add: [SYS_ADMIN]
```

Verified empirically on Docker 28.4 / Ubuntu 24.04. (These container
flags apply to the `local` topology only; the `k8s` runtime has no
bwrap — the pod boundary is the sandbox.)

## Run git metadata

> **Scope: the `local` and `docker` runtime providers** (warren-3c1e,
> after warren-8926). K8s pods clone into their own emptyDir and share
> nothing with a host clone.

Each run gets a private git dir at `<dataDir>/local/gitdirs/<sandboxId>`
(`src/workspace/git/private-gitdir.ts`). The run shares only the host
clone's object store with other runs.

- **Materialization.** `git init --separate-git-dir` makes the dir and
  the workspace `.git` pointer. The init pins the host clone's object
  format and the `files` ref backend (`--object-format`,
  `--ref-format=files` on git 2.45+, and `GIT_DEFAULT_REF_FORMAT=files`),
  so a user or system `init.defaultRefFormat=reftable` cannot change the
  layout the sandbox mounts and the seal check walks.
  `objects/info/alternates` names the host clone's `objects/`.
  `git update-ref --stdin` plus `pack-refs` snapshots the host's
  branches, remote-tracking refs, and tags. The run branch exists only
  in the private dir. No objects are copied, so a materialization costs
  a few small files.
- **Config.** The private config carries only the host clone's
  `remote.*` entries and `core.hooksPath`, and warren records its
  sha256. Local `http.*`, `credential.*`, `url.<base>.insteadOf`, and
  `lfs.*` settings in the host clone's `.git/config` are not carried
  over, and LFS objects are not shared. A project that needs them sets
  them globally or in the run environment.
- **GC keep-ref.** The host clone gains one ref per run,
  `refs/warren/runs/<sandboxId>`, at the base commit. It stops a host
  `git gc` from pruning objects the private dir borrows. The run's own
  commits live only in the private dir, so the keep-ref never points at
  them. Teardown and the workspace GC delete it.
- **Sandbox.** The private dir is read-write, so ref updates, ref
  deletions, and `packed-refs.lock` work the same under bwrap, Seatbelt,
  and docker. Its `config` and `objects/info/alternates` stay
  read-only. The host clone's `objects/` is read-only. Nothing else of
  the host clone's `.git` is reachable: bwrap and docker do not mount
  it, and Seatbelt denies it together with the `gitdirs/` and
  `gitdirs-sealed/` roots. A run can thus never move the host's base
  branch or another run's refs. The read-only mounts are defense in
  depth. The boundary that host git relies on is the seal check below,
  which also covers the alternates file.
- **Seal.** At create, host git is pinned to the private dir but every
  call is refused. Reap calls `workspaceInfo` first, and for a local run
  that seals the dir (`src/runtime/local/git-pin.ts`):
  1. It stops every agent process and waits for the exit. On macOS the
     agent leads its own process group and cancel kills the group. Under
     bwrap the pid namespace dies with the agent. Under docker the
     container is force-removed before `exited` settles.
  2. It moves the dir to `<dataDir>/local/gitdirs-sealed/<sandboxId>`,
     which no sandbox grant reaches.
  3. It checks the dir once, asynchronously, with entry and depth caps
     (`src/sandbox/git-seal.ts`). Symlinks and special files are
     unlinked, and hard links are copied to fresh inodes. A changed
     config, a changed alternates file, or a `commondir` file refuses the
     run, and so does a walk past its caps.
  4. It re-pins host git to the sealed dir with no per-call check.
     Finalize, reap, and salvage then run with hooks and fsmonitor off.
  The seal is single-flight and idempotent, and a restarted server
  re-runs it from the run manifest.
- **Teardown.** `terminate` and the workspace GC remove the live and
  sealed dirs with the workspace, and delete the keep-ref. The host clone
  keeps no per-run branch or worktree.

Known limits:

- `git branch -D` inside the run prints a config-write warning, because
  git tries to drop a `branch.<name>` section from the read-only
  config. The ref is still deleted.
- Commits-ahead, PR context, and the seeds reset resolve `baseBranch`
  from the run's private snapshot. A run that moves its copy of the
  base can only skew its own outcome. It cannot affect the host or
  other runs.
- bwrap bind mounts follow the moved dir. The seal relies on the agent's
  pid namespace being gone before the move, which the stop step waits
  for.
- On macOS a process that calls `setsid` leaves the agent's process
  group and survives cancel. Seatbelt still denies it the sealed root.
  After a warren restart the old process group is not known, so only
  that deny applies.
- A manifest from before warren-3c1e (a shared-clone worktree) fails
  reap with the `legacy_worktree_workspace` code in the `reap_failed`
  event. The workspace is preserved, and the recovery hint names the
  branch to push by hand from the host clone. Automatic salvage of
  those runs is not carried over.

## Event durability rationale

The engine's run store holds the live event log; warren's bridge
persists a copy of every event into warren's own `events` table as it
streams (a) the UI's "reload page, see history" expectation requires
server-side history, and (b) decoupling the UI from the engine's
in-process store keeps the seam clean. Warren's events table is the
durable record — a warren restart wipes the engine store, live rows
reconcile as lost, and the terminated scrollback survives in the
table.

## Container layout

```dockerfile
FROM oven/bun:1.2   # plus bwrap + uidmap + git + node (see Dockerfile)
RUN bun install -g \
    @os-eco/seeds-cli@<v> \
    @os-eco/mulch-cli@<v> \
    @anthropic-ai/claude-code@<v> \
    @earendil-works/pi-coding-agent@<v>
WORKDIR /app
COPY . /app
RUN bun install && bun run build:ui
ENV WARREN_DATA_DIR=/data
EXPOSE 8080
ENTRYPOINT ["bun", "run", "src/supervisor/main.ts"]
```

The entrypoint is the Bun supervisor (`src/supervisor/main.ts`), not
warren directly:

- Spawns warren (`bun run src/server/main/index.ts`) as a child.
- Forwards `SIGTERM` and `SIGINT` to the child, then waits for clean
  exit before forcing.
- Exits when warren exits; the container restarts under Docker's (or
  the orchestrator's) restart policy.

Rationale: zero non-Bun deps; signal handling and lifecycle are
explicit in our code; one process tree means one restart policy.

## Expertise capture (mulch reap)

- **Per-run isolation.** Each run gets its own `.mulch/` inside the
  run workspace — not shared across concurrent runs against the same
  project.
- **Seeding (run start).** Warren reads `expertise_seed` lines from
  the rendered agent JSON, groups them by `domain`, and emits one
  seed-file entry per domain (`.mulch/expertise/<domain>.jsonl`,
  canonical mulch record JSONL — one record per line) alongside the
  `.seeds/` / `.pi/` drops. The engine writes the files into the
  workspace during materialization, before the agent starts.
- **Reap (run end).** `finalize` reads
  `<workspace>/.mulch/expertise/*.jsonl` and merges each record into
  the project's persistent `.mulch/expertise/<domain>.jsonl` using the
  project's local clone path. The workspace is a host-side worktree,
  so the reads are plain host filesystem operations — no daemon file
  API remains. Merge rule: **last-write-wins by record `ts` field**.
  Conflict resolution:
  - Same `id` (named record), incoming `ts > existing ts` →
    overwrite, emit a warren event `mulch.record.updated`.
  - Same `id`, incoming `ts <= existing ts` → drop incoming, emit
    `mulch.record.skipped`.
  - No `id` (anonymous record) → append, no conflict possible.
- **Failure mode.** Reap errors (disk full, schema violation) do not
  fail the run — they are logged and surfaced as a `reap_failed`
  event on the run. The agent's work is preserved on the branch even
  if expertise capture fails.
- **Why not bind-mount.** Bind-mounting the project's `.mulch/` into
  the sandbox would break the sandbox's isolation contract and risks
  corrupting the project's expertise log if the agent runs `ml`
  commands incorrectly. The reap step is the seam.
- **Why not "agent commits mulch as a branch artifact".** Requires
  every agent definition to know about persistence mechanics. The reap
  step is invisible to agents — they just call `ml record` as
  documented in the agent guidance.
