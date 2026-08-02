# Runtime, Supervisor & Event Durability

> **Salvage provenance:** lifted from the retired top-level spec §3.3 (the seams that
> matter), §5.1–5.3 (process model / burrow-as-separate-process /
> sandbox nesting), §9 (event-durability rationale — the
> `MAX(seq)+1` restart contract only, not the stale column sketch),
> §10.3 (container layout), and §11.A (expertise capture: reap merge
> rules + why-not-bind-mount rationale) as part of the SPEC retirement
> plan `pl-1717` (step `warren-8184`). The wording below is the live
> contract, so edit it only in lockstep with the code it describes.
> Cross-references to other SPEC sections (§11.I, §4.3, §8.1, …) are
> repointed by the later sweep steps of `pl-1717`.

## The seams that matter

- **RuntimeProvider contract** (post-V1; `src/runtime/contract.ts`) —
  the load-bearing seam for *where* a run executes. Warren's domain
  (`src/runs/*`) speaks only this eight-method contract; the backend
  (burrow-backed `LocalProvider` or pod-per-run `K8sProvider`) is
  selected at boot by `WARREN_RUNTIME`. No burrow-id, pod name,
  socket, or host path crosses it. This generalizes the original
  "Burrow HTTP API" seam below into a provider abstraction.
- **Burrow HTTP API** (burrow's `pl-5b40` / `burrow-1d64`) — how the
  `local` runtime provider talks to its sandbox: warren never imports
  burrow as a library, HTTP only, so warren and burrow can be
  independent processes inside one container. Under the `k8s` provider
  this seam is absent (the pod boundary + K8s API replace it).
- **Canopy as agent source** — agents are not warren records, they are
  canopy prompts. Warren is a read-mostly consumer of canopy.
- **CLI shell-out for mulch/seeds/canopy** — these tools are
  git-native, file-locked, atomic. Warren does not embed their state;
  it shells out.
- **HTTP API for warren itself** — the UI is one consumer; ad-hoc
  scripts and future orchestrators are others.

## Process model

Three processes inside the container, supervised by a small Bun
parent (see "Container layout" below):

- **supervisor** — `src/supervisor/main.ts`, ~50–100 LOC. Spawns
  warren and burrow as children, forwards SIGTERM/SIGINT, restarts
  `burrow serve` on unexpected exit (with a budget), exits non-zero on
  warren crash.
- **`warren`** — Bun.serve, the platform process. HTTP API + UI +
  scheduler tick (single-flight in-process loop, §11.I). The V2
  webhook receiver will run in the same process.
- **`burrow serve`** — Bun.serve bound to a unix socket at
  `/var/run/burrow.sock`, the runtime substrate. Owns SQLite +
  sandboxes.

Plus short-lived shell-outs to `cn`, `sd`, `ml`, `git` invoked from
the warren process.

## Why burrow is a separate process

Warren restarts shouldn't kill in-flight agent runs. Burrow's SQLite +
run loop persist across warren deploys; the supervisor restarts only
the failing child. The unix socket is the seam — no TCP exposure, no
auth on the loopback, trust-the-socket posture matches burrow's
default (§7 of burrow's spec). Warren never imports burrow as a
library; only the typed `HttpClient` from `@os-eco/burrow` (§15.6 of
burrow's spec) crosses the boundary.

## Sandbox nesting

> **Scope: the `local` runtime provider only.** Nested bwrap and its
> four flags exist to let burrow's user-namespace sandboxes come up
> inside the outer container. The `k8s` provider has no nested
> sandbox — the pod boundary *is* the isolation, kubelet enforces
> resources via cgroups v2, and all four flags disappear
> (`runAsNonRoot`, `drop: [ALL]`, `seccompProfile: RuntimeDefault`
> instead). See [`docs/RUNBOOK-K8S.md`](../RUNBOOK-K8S.md) and
> [`docs/design/k8s-migration.md`](k8s-migration.md) §2.

Under the `local` provider, burrow runs `bwrap`-isolated agents inside
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

Burrow owns the canonical event log (its `events` table, NDJSON
archive on destroy). Warren persists a copy of every event it streams
from burrow because (a) the UI's "reload page, see history"
expectation requires server-side history, (b) warren restart shouldn't
lose events users were watching, and (c) decoupling warren's UI from
burrow's archive lifecycle keeps the seam clean. Warren's events
table is *not* the source of truth — it's a write-through cache of
what burrow streamed. On warren restart, the run's stream is
re-subscribed at `MAX(events.burrow_event_seq) + 1`. If warren's DB
is lost, runs continue (burrow has them); the UI loses scrollback for
terminated runs but not for running ones.

## Container layout

```dockerfile
FROM ghcr.io/jayminwest/burrow-base:0.2.0   # bun + bwrap + uidmap + burrow CLI
RUN bun install -g \
    @os-eco/seeds-cli@<v> \
    @os-eco/mulch-cli@<v> \
    @os-eco/sapling-cli@<v>
WORKDIR /app
COPY . /app
RUN bun install && bun run build:ui
ENV WARREN_DATA_DIR=/data
EXPOSE 8080
ENTRYPOINT ["bun", "run", "src/supervisor/main.ts"]
```

The entrypoint is the Bun supervisor (`src/supervisor/main.ts`), not
warren directly:

- Spawns `burrow serve --socket /var/run/burrow.sock` as a child via
  `Bun.spawn`.
- Waits for the socket file to appear (`fs.access` poll, 100 ms × 50 =
  5s timeout) before spawning warren.
- Spawns warren (`bun run src/server/main/index.ts`) as a child.
- Forwards `SIGTERM` and `SIGINT` to both children, then waits for
  clean exit (5s grace) before forcing.
- Restarts `burrow serve` if it exits non-zero, with an exponential
  backoff and a budget of 5 restarts in 60s; after exhaustion, the
  supervisor exits, the container restarts under Docker's (or the
  orchestrator's) restart policy.
- Crashes if warren exits non-zero (warren is the user-facing process;
  restart-by-orchestrator is preferred to mask warren bugs in-process).

Rationale: zero non-Bun deps; signal handling and lifecycle are
explicit in our code; warren restarts (the more frequent kind, e.g.,
on deploy) leave burrow's run loop and SQLite untouched.

## Expertise capture (mulch reap)

- **Per-run isolation.** Each burrow run gets its own `.mulch/`
  inside the burrow workspace — not shared across concurrent runs
  against the same project. This matches burrow's "one run at a time
  per burrow" default (§4.2 of burrow's spec) and avoids race
  conditions if that posture is later relaxed.
- **Seeding (run start, step 3 of §4.3).** Warren reads
  `expertise_seed` lines from the rendered agent JSON, groups them by
  `domain`, and emits one `HttpWorkspaceFile` entry per domain
  (`.mulch/expertise/<domain>.jsonl`, canonical mulch record JSONL —
  one record per line) alongside the `.canopy/` / `.seeds/` / `.pi/`
  drops. The whole list ships as the `seed.files` payload on
  `POST /burrows` via `HttpClient.burrows.up({ seed: { files } })`
  (burrow R-07, plan `bur-pl-2467`). Burrow validates and writes the
  files atomically with provisioning — a malformed record or a
  seed-side filesystem error rolls the burrow back on burrow's side
  before warren observes a `burrow_id`. This replaces the prior
  "shell out to `ml record` inside the burrow workspace via
  `burrow exec` (or equivalent)" sketch: warren never reaches past
  the HTTP seam onto disk, and the seed payload is the contract.
- **Reap (run end, step 6 of §4.3).** Warren reads
  `<burrow-workspace>/.mulch/expertise/*.jsonl` and merges each record
  into the project's persistent `.mulch/expertise/<domain>.jsonl`
  using the project's local clone path. The `seeds_close` sub-step has
  migrated to `HttpClient.files.read('.seeds/issues.jsonl')` (warren
  plan `pl-a31c` step 3, warren `0.2.0`); `mulch_merge` still reads
  off the shared `.mulch/expertise/` directory because burrow has no
  file-listing endpoint yet — once `burrow-18ca` lands, it flips to
  `HttpClient.files.list` + `.files.read` and the warren↔burrow seam
  is fully HTTP on the read side too. Merge rule: **last-write-wins
  by record `ts` field**. Conflict resolution:
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
  the sandbox would break burrow's isolation contract and risks
  corrupting the project's expertise log if the agent runs `ml`
  commands incorrectly. The reap step is the seam.
- **Why not "agent commits mulch as a branch artifact".** Requires
  every agent definition to know about persistence mechanics. The reap
  step is invisible to agents — they just call `ml record` as
  documented in canopy/mulch.
- **Why HTTP-and-not-shared-disk for seed + close.** Same reasoning
  that produced burrow's R-07: shared disk is an artifact of
  co-tenancy, not the contract. Warren's other warren↔burrow paths
  (spawn, dispatch, stream, steer, cancel) are typed HTTP; the seed +
  reap paths were the last consumers of the disk seam. Closing it
  makes a future remote-burrow topology possible without
  re-architecting the spawn path, and locks every workspace mutation
  behind a contract burrow's tests already pin (`bur-pl-2467`).
