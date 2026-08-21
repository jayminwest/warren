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
