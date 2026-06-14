# Warren — Specification

> A network of interconnected burrows. The control plane and UI for cloud-based custom agents that operate in isolation, self-manage, self-repair, and self-improve.

**Status:** Design phase, V1 spec.
**Last updated:** 2026-05-13.
**CLI:** `warren` / `wr` (TBD).
**Package:** `@os-eco/warren` (TBD).

V1 scope is the **manual run path** plus the **cron half of the scheduler**: connect canopy, add project, spawn run, watch events, steer/cancel, and dispatch recurring runs from `.warren/triggers.yaml` + one-off seeds with `extensions.scheduledFor` (R-06, shipped 2026-05-11). Webhook triggers and library API exports are deferred to V2 — kept in this spec for context, marked **(V2)** where they appear.

**Post-V1 direction (2026-05-11).** Warren is being positioned as a self-hostable control plane for engineering organizations of 50+ ICs, not only a solo home-server appliance. V1 stays single-user / single-host as shipped; V2/V3 layer in multi-user identity (SSO), remote burrow workers, a bring-your-own-database backend, MCP support, audit logging, cost/concurrency guardrails, and a GitHub App auth path. See `ROADMAP.md` R-09 + R-12 through R-18, and §11.J below for the dated decision record.

---

## 1. TL;DR

Warren is a self-hostable control plane for ephemeral coding agents. A user points it at a GitHub repo, picks an agent, writes a prompt; warren spawns the agent inside a sandbox, streams events back to the UI, lets the user steer mid-run, then pushes the workspace branch. **One container, one volume, one HTTP API, one UI.**

The fresh-install path is standalone: the built-in `claude-code` agent ships inline, so a user with a GitHub URL and an Anthropic key can dispatch a run end-to-end with no other tooling. Two additional coding-agent runtimes ship inline alongside it — `sapling` (steerable harness) and `pi` (multi-provider, with per-run cost reporting). Warren also bundles a small set of [os-eco](https://github.com/jayminwest/os-eco) tools as opt-in built-in features — versioned prompt libraries via canopy, persistent agent memory via mulch, an integrated issue queue via seeds, and a shared coordination substrate via plot (§11.O) — each surfaced only when the project or operator opts in. The runtime substrate is [burrow](https://github.com/jayminwest/burrow), a sibling process inside the container that warren talks to over a unix socket.

V1 is single-user, single-host: clone warren, `docker compose up`, browser at `localhost:8080`. The same image runs on Fly.io with a volume and three secrets. No cross-tenant story, no SaaS, no auth beyond a bearer token.

---

## 2. Vision

### 2.1 The day-in-the-life

```
$ git clone https://github.com/jayminwest/warren && cd warren
$ cp .env.example .env && $EDITOR .env   # WARREN_API_TOKEN, BURROW_API_TOKEN, WARREN_BURROW_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN (CANOPY_REPO_URL optional)
$ docker compose up -d
$ open http://homeserver.local:8080
```

In the UI:
1. **Pick an agent** — Warren ships three built-in agents inline (`src/registry/builtins/`): `pi` (multi-provider harness with first-class cost reporting, and the default runtime when an agent pins none — warren-16f8), `claude-code` (single-provider Anthropic harness, opt-in via `frontmatter.runtime`), and `sapling` (alternative steerable harness). A fresh install can dispatch a run against any of them without further setup. Power users who want a custom prompt library set `CANOPY_REPO_URL`; warren clones the repo and every prompt tagged `agent` becomes a library-source agent that overrides any same-named built-in.
2. **Add project** — paste a GitHub URL. Warren clones it under `/data/projects/`.
3. **Spawn run** — pick agent + project + prompt. Warren provisions a sandbox, seeds the rendered agent into it, dispatches the run, streams events to the UI.
4. **Watch and steer** — live event tail, send steering messages, cancel cleanly. If the project opted into the agent-memory feature, the UI also surfaces mulch records the agent recorded; if it opted into the issue-queue feature, it surfaces seeds the agent filed or closed.
5. **Schedule** — "every 6 hours, run docs-bot against repo X" via `.warren/triggers.yaml`, or "dispatch this seed at 3am" via `extensions.scheduledFor`. Cron half shipped in V1 (R-06, §11.I); webhook/event-driven triggers (e.g. "on PR open, run reviewer-bot") remain V2.

### 2.2 What Warren is

- The **control plane**: one process, one HTTP API, one volume.
- The **agent registry**: built-in agents inline, plus optional canopy library on top, plus per-project `.canopy/` tier (R-03; precedence project > library > built-in).
- The **dispatcher**: provisions sandboxes via the runtime, streams events back, reaps results.
- The **UI**: web frontend served from the same process.
- The **scheduler**: in-process cron tick + scheduled-seed dispatch (V1, §11.I). Webhook/event-triggered runs deferred to V2.

Warren bundles five os-eco data-plane tools (canopy, mulch, seeds, sapling, plot) as built-in features, but a fresh install does not require a user to adopt any of them — `claude-code` ships inline and reads/writes nothing outside the sandbox. The integrations light up when the operator sets `CANOPY_REPO_URL`, or when a project contains `.mulch/` / `.seeds/` / `.plot/`.

### 2.3 What Warren is not

- Not a coding agent. The runtime runs them; sapling/claude-code are them; warren orchestrates.
- Not a sandbox. The runtime owns isolation.
- Not a hard dependency on the os-eco data-plane tools. They are bundled features, not required infrastructure — see §2.2 above.
- Not a multi-tenant SaaS. The deployment unit is one team / one org self-hosting one warren — never a shared hosted service. V1 ships single-user (one bearer token, one box); V2/V3 layer in SSO + per-user identity + remote workers so a team of 50 ICs can share one warren without sharing one credential or one machine (R-09, R-12, §11.J).

Warren is a thin coordinator — most of the value is in the runtime plus whichever data-plane features the project opts into. Warren's job is to compose them into a deployable system with a UI on top.

---

## 3. Goals & Non-Goals

### 3.1 V1 Goals

- Single-image deploy: `docker compose up` on a home server, `fly deploy` on Fly.io, same Dockerfile.
- Web UI for: agent registry, project list, run dispatch, live event tail, basic settings.
- HTTP API mirroring the UI's surface so external scripts can drive warren.
- Custom-agent-as-canopy-prompt: an agent is a single canopy prompt with required sections; warren auto-discovers from a connected canopy repo.
- Runs against project repos cloned into warren's data dir from GitHub URLs.
- Self-* loop: agents read seeds queue, write seeds for follow-ups, record mulch on success/failure, prime mulch on next spawn.
- Durable event log: every event burrow streams is persisted in warren's SQLite so reload-after-crash and post-hoc inspection both work.

**Deferred to V2** (kept in this spec for context, not built in V1):
- GitHub webhook receiver and signature verification (the event-driven half of the scheduler — cron half shipped in V1, §11.I).
- `@os-eco/warren` library API exports — internal-only `Client` is fine for V1.

### 3.2 V1 Non-Goals

- No multi-tenant auth, no per-user RBAC in V1. Single bearer token, one user. Multi-user identity via OIDC is a planned post-V1 addition (R-09).
- No agent marketplace. Agents come from your own canopy repo.
- No laptop-driven `burrow up` against warren. The home server is the canonical V1 deploy.
- No real-time collaboration. One UI, one user at a time.
- No payment, no usage metering, no quota in V1. Per-user / per-project cost and concurrency guardrails are planned post-V1 (R-17).
- Per-run spend caps are enforced (warren-a63d): a per-agent `frontmatter.maxCostUsd` or per-trigger `maxCostUsd` (triggers.yaml) cancels a run mid-stream once cumulative cost crosses the cap. Broader run-budget enforcement — concurrent-run caps, per-user / per-project rollups — is still planned post-V1 (R-17). V1 does *report* per-run cost + token usage for the `pi` and `claude-code` built-ins (`runs.cost_usd`, `runs.tokens_*`, §11.K) — reporting is observability; the per-user / per-project budget rollups remain the deferred half. `sapling` runs leave the columns null (no terminal cost emission yet).
- ~~No bring-your-own database in V1~~ — **shipped post-V1 (R-13, pl-f17e, 2026-05-14):** SQLite (default, `bun:sqlite`) and Postgres (`drizzle-orm/node-postgres`) are both first-class backends selected by `WARREN_DB_URL`. Burrow's own per-worker SQLite stays untouched — that's run-local sandbox state, not org truth.
- No MCP server configuration in V1. Canopy-frontmatter-driven MCP plus burrow-side credential mounts are planned post-V1 (R-15).
- No audit log in V1. Append-only dispatch/steer/cancel/secret-read ledger is planned post-V1 (R-16), and lands alongside R-09 since it depends on real user identity.
- No GitHub App auth in V1 — shared PAT via `GITHUB_TOKEN`. GitHub App with installation-scoped tokens and per-repo allowlists is planned post-V1 (R-18).

### 3.3 The seams that matter

- **Burrow HTTP API** (burrow's `pl-5b40` / `burrow-1d64`) — warren never imports burrow as a library. HTTP only, so warren and burrow can be independent processes inside one container.
- **Canopy as agent source** — agents are not warren records, they are canopy prompts. Warren is a read-mostly consumer of canopy.
- **CLI shell-out for mulch/seeds/canopy** — these tools are git-native, file-locked, atomic. Warren does not embed their state; it shells out.
- **HTTP API for warren itself** — the UI is one consumer; ad-hoc scripts and future orchestrators are others.

---

## 4. Mental Model

### 4.1 The four sides of a custom agent

| Side | Where it lives | Tool |
|---|---|---|
| **Mind** (persona, skills) | `.canopy/prompts.jsonl` (agent library repo) | canopy |
| **Memory** (expertise) | `.mulch/expertise/<domain>.jsonl` (per-project) | mulch |
| **Worklist** (tasks) | `.seeds/issues.jsonl` (per-project) | seeds |
| **Body** (loop, tools) | `sapling` or `claude-code` | sapling / claude-code |

Burrow is the cell the agent runs in. Warren is the operator that picks who runs where, when, and on what.

### 4.2 The bundle, expressed in canopy

An agent is a single canopy prompt with a schema-validated set of sections:

```yaml
name: refactor-bot
extends: base-coding-agent              # canopy inheritance
sections:
  system: |
    You are a refactor-focused agent. Prefer small, reviewable diffs...
  skills:                                # mixin'd from canopy children
    - run-tests
    - open-pr
    - investigate-flake
  expertise_seed: |
    {"type":"convention","domain":"refactor","content":"..."}
    {"type":"failure","domain":"refactor","description":"...","resolution":"..."}
  burrow_config: |
    [toolchain]
    bun = "1.1"
    [sandbox]
    network = "restricted"
    allowed_domains = ["api.anthropic.com", "github.com", "registry.npmjs.org"]
  workflow: |
    # seeds plan template name to use
    template: refactor
  pi_skills: |                           # pi-only — materialized into .pi/skills/<name>/SKILL.md
    {"name":"refactor-pass","body":"# Refactor pass\nIdentify dead code..."}
    {"name":"safe-rename","body":"# Safe rename\nUse the LSP rename..."}
  pi_prompts: |                          # pi-only — materialized into .pi/prompts/<name>.md
    {"name":"summarize-diff","body":"Summarize the diff in {{lines}} lines..."}
```

**Section enumeration (V1).** Generic sections shared by every runtime:
`system`, `skills`, `expertise_seed`, `burrow_config`, `workflow`. Pi-namespaced
sections (consumed only by the `pi` built-in; ignored by `claude-code` /
`sapling`): `pi_skills`, `pi_prompts`. Pi-section bodies are JSON-Lines envelopes
of `{name, body}` — one artifact per line — which `src/runs/seed.ts`
materializes into `.pi/skills/<name>/SKILL.md` and `.pi/prompts/<name>.md`
inside the burrow workspace before dispatch (§11.K). Malformed envelopes
(non-JSON, missing/empty `name`, non-string `body`, duplicate names, unsafe
names containing `/`, `\`, `.`, `..`) abort seeding with the same
`RunSpawnError` shape as `expertise_seed`.

Inheritance solves the "thousand repos" problem: `base-coding-agent` defines defaults, role-specific bots override only what differs. One PR to canopy updates every descendant.

### 4.3 The composition flow

When warren spawns a run:

1. **Resolve agent** — `cn render <agent-name>` against the canopy repo. Returns a single object with all sections expanded after inheritance/mixin resolution. The rendered JSON is persisted on the run row (`runs.rendered_agent_json`) and **frozen for the lifetime of the run** — mid-run edits to canopy do not affect in-flight runs. Run-time agent identity always reads from `runs.rendered_agent_json`, never from a re-render.
2. **Provision burrow** — `POST /burrows` to burrow with `{ projectRoot, branch?, baseBranch?, network?, ... }` derived from the agent's `burrow_config` and the project's local clone path. Burrow returns 201 + `Burrow` (id, workspace path, branch, state). Warren records `burrow_id` on the run. The `branch` field is composed by warren as `${prefix}/${run.id}` where the prefix resolves project default (`.warren/config.yaml.runBranchPrefix`, or the same field in legacy `.warren/defaults.json`) > `WARREN_RUN_BRANCH_PREFIX` env > built-in `"burrow"` (warren-9993; the legacy default preserves backward compatibility). The warren `run_xxx` suffix makes the branch back-reference the warren run row on `git log` / PR review without a separate lookup.
3. **Seed the burrow** — `buildSeedFiles(agent)` returns an `HttpWorkspaceFile[]` covering the five workspace drops (`.canopy/agent.json`, `.mulch/expertise/<domain>.jsonl` from `expertise_seed`, `.seeds/workflow.txt`, `.pi/skills/<name>/SKILL.md` from `pi_skills`, `.pi/prompts/<name>.md` from `pi_prompts`). The list rides along on the step-2 `POST /burrows` as `seed.files`, so provision-and-seed is a single atomic round-trip — burrow rolls the burrow back on its side if any file fails validation, and warren never observes a half-seeded workspace (R-07; see §11.A).
4. **Dispatch** — `POST /burrows/:burrow_id/runs` with `{ agentId, prompt, metadata? }`. Burrow returns 201 + `Run` in `state='queued'`; its run loop picks it up. Warren records the burrow run id in `runs.burrow_run_id`.
5. **Stream** — `GET /runs/:burrow_run_id/stream?follow=1` (NDJSON, chunked HTTP). Warren persists every event into its own `events` table (see §9) keyed by warren run id, then fans out to UI subscribers. UI clients hit warren's own `/runs/:id/events?follow=1`, which serves history from the warren log + tails the live stream concurrently. If warren restarts mid-run, on boot it re-subscribes to burrow's stream from `MAX(events.burrow_event_seq)+1` to backfill anything missed.
6. **Reap** — on run terminal state, copy the burrow's `.mulch/expertise/*.jsonl` back to the project's persistent `.mulch/` with **last-write-wins by record `ts`** (§11.A); close any seeds the agent marked done by reading the burrow's `.seeds/issues.jsonl` via `HttpClient.files.read` (R-07); push the workspace branch. The `mulch_merge` sub-step still reads off shared disk pending burrow's file-listing endpoint (`burrow-18ca`, tracked by `warren-7f7c`) — once shipped, that read flips to `HttpClient.files.list` + `.files.read` and warren's reap goes fully HTTP. **Commit/push contract:** the agent commits inside the sandbox; reap pushes from the host. Sandboxed agents have **no GitHub auth path** in V1 (`warren-1a09`: the supervisor's `insteadOf` rewrite lives in `/root/.gitconfig`, which burrow's bwrap profile does not bind), so agent-side `git push` is structurally broken — the canopy `claude-code` prompt instructs commit-only and warren reap is the actual push mechanism. After push, reap counts commits ahead of `baseBranch` (`git rev-list --count <baseBranch>..HEAD`) and surfaces `commitsAhead` on the reap summary; `commitsAhead: 0` fires a `reap.empty_push` event so a push that landed nothing (the `warren-f3bb` shape: agent never committed, push exit-0'd against unchanged HEAD) is observably distinct from a real-work push.

Steering: `POST /runs/:id/steer` (warren) → `POST /burrows/:burrow_id/inbox` (burrow). Cancellation: `POST /runs/:id/cancel` (warren) → `POST /runs/:burrow_run_id/cancel` (burrow). Burrow's full HTTP contract is at `GET /openapi.json` on the burrow socket; warren generates code against the OpenAPI document, so contract drift surfaces at build time.

The agent's worklist (seeds) belongs to the project, not the agent. Same project worked on by `refactor-bot` today and `sre-bot` tomorrow uses the same seeds queue.

---

## 5. Architecture Overview

```
┌─────── HOME SERVER (Linux container, Mac Pro / Fly.io / etc.) ────────┐
│                                                                        │
│   ┌────────────────────────┐                                           │
│   │ warren                 │                                           │
│   │ ─ HTTP API + UI        │                                           │
│   │ ─ scheduler (cron)     │                                           │
│   │ ─ webhook receiver     │                                           │
│   │ ─ shells out: cn/sd/ml │                                           │
│   │ ─ HTTP: burrow         │                                           │
│   └────┬───────────────────┘                                           │
│        │                                                               │
│        ├─── unix socket: /var/run/burrow.sock                          │
│        │     ┌────────────────────────────────┐                        │
│        │     │ burrow serve                   │                        │
│        │     │ (separate Bun process)         │                        │
│        │     │ owns SQLite + sandboxes        │                        │
│        │     └────────────────────────────────┘                        │
│        │                                                               │
│        └─── shell: cn render / sd list / git                           │
│                                                                        │
│   /data/                                                               │
│   ├── canopy-repo/         ← cloned agent library                      │
│   ├── projects/<owner>/<name>/  ← cloned project repos                 │
│   ├── burrow/              ← burrow's home: SQLite, workspaces         │
│   └── warren.db            ← warren's SQLite: schedules, run history   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                  ▲
                  │ HTTPS
              [browser]
```

### 5.1 Process model

Three processes inside the container, supervised by a small Bun parent (see §10.3):

- **supervisor** — `src/supervisor/main.ts`, ~50–100 LOC. Spawns warren and burrow as children, forwards SIGTERM/SIGINT, restarts `burrow serve` on unexpected exit (with a budget), exits non-zero on warren crash.
- **`warren`** — Bun.serve, the platform process. HTTP API + UI + scheduler tick (single-flight in-process loop, §11.I). The V2 webhook receiver will run in the same process.
- **`burrow serve`** — Bun.serve bound to a unix socket at `/var/run/burrow.sock`, the runtime substrate. Owns SQLite + sandboxes.

Plus short-lived shell-outs to `cn`, `sd`, `ml`, `git` invoked from the warren process.

### 5.2 Why burrow is a separate process

Warren restarts shouldn't kill in-flight agent runs. Burrow's SQLite + run loop persist across warren deploys; the supervisor restarts only the failing child. The unix socket is the seam — no TCP exposure, no auth on the loopback, trust-the-socket posture matches burrow's default (§7 of burrow's spec). Warren never imports burrow as a library; only the typed `HttpClient` from `@os-eco/burrow` (§15.6 of burrow's spec) crosses the boundary.

### 5.3 Sandbox nesting

Burrow runs `bwrap`-isolated agents inside the warren container. The container needs the four flags from `mulch:mx-94901b` / `mulch:mx-c085ba`:

```yaml
security_opt:
  - apparmor=unconfined
  - seccomp=unconfined
  - systempaths=unconfined
cap_add: [SYS_ADMIN]
```

Verified empirically on Docker 28.4 / Ubuntu 24.04. Same recipe applies to Fly.io machines.

### 5.4 Multi-worker model

Zero-config deployment is unchanged: one warren container, one
in-container `burrow serve` over `/var/run/burrow.sock` (§5.1).
Multi-worker is opt-in via a `[[workers]]` block in warren's server-level
TOML config; when present, warren dispatches across N burrow workers
(local-only or remote, across hosts) with the same per-run isolation
contract as the single-worker path. The warren↔burrow seam is unchanged
— every request still rides the typed `HttpClient` from `@os-eco/burrow`
whose `Transport = unix | tcp` already covered both shapes. Multi-worker
is registry + routing, not a protocol change.

Cross-repo split: warren-side (this document) ships the worker registry,
client pool, placement rules, fan-out reads, and admin endpoints.
Burrow-side (non-loopback TCP bind safety, `POST /admin/drain`, OpenAPI
updates, ROADMAP supersession) is tracked in burrow as `burrow-62ce` /
`pl-cb3e`. The parent seed in this repo is `warren-6747`; the warren
plan is `pl-9ba1`.

**Registry.** Migration 0007 adds the `workers` table
`(name PK, url, state, added_at)` with state machine
`healthy | draining | unreachable`. Migration 0008 adds the warren-side
`burrows` table `(id PK, worker_id NOT NULL, added_at)` plus
`runs.worker_id` (denormalized from `burrows.worker_id` at run-create
time so cancel / steer / stream routing skips the join). A single shared
`BURROW_API_TOKEN` env var fronts the whole pool — bearer is not a
per-worker column (rotation = one env-var update; per-worker tokens are
deferred until a concrete multi-tenancy driver emerges, pl-9ba1
alternative #3).

**Pool.** `src/burrow-client/pool.ts` (`BurrowClientPool`) replaces the
legacy `BurrowClient.fromEnv()` singleton. Holds
`Map<workerName, BurrowClient>` and exposes two routing primitives:
`placeFor({ projectId })` for new-burrow provisioning and
`clientFor({ burrowId })` for everything else (cancel, steer, stream,
per-resource reads). Two factories: `fromEnv` for the zero-config path
synthesizes one `'local'` worker from `WARREN_BURROW_*` env vars;
`fromConfig` takes the parsed `[[workers]]` entries plus the shared
bearer and registers a `BurrowClient` per row with no local synthesis.
`bootServer` picks the factory based on whether any `[[workers]]`
entries loaded.

**Placement** (`src/runs/placement.ts`):

- *Sticky-by-burrow.* Streaming, cancel, steer, reap, and
  runs-against-an-existing-burrow all resolve via
  `pool.clientFor({ burrowId })` against the worker stored on the
  `burrows` row. A `draining` worker keeps serving its existing burrows
  until they finish; an `unreachable` worker fails loudly with
  `StickyWorkerUnreachableError`. No silent migration — operators must
  drain + remove a dead worker explicitly.
- *New-burrow placement* is two-tier: (A) project-affinity — the worker
  of the most recent succeeded run for the same `projectId`, honored
  only if that worker is `healthy`. (B) least-loaded healthy worker by
  in-flight `queued + running` count, alphabetical worker-name tiebreak.
  Draining and unreachable workers are filtered before either tier.
  `NoEligibleWorkerError` is the no-healthy-workers terminal. Both
  errors map to HTTP 503 (handlers that want 404 for missing-burrow add
  an explicit pre-check; same error class covers both cases).

A single run never crosses workers: `spawnRun` resolves placement
**before** `runs.create` (so `runs.worker_id` lands at row creation),
then services provision + dispatch + rollback against the resolved
`placement.client`. Mid-run failover is V2.

**Probe.** `src/server/probe.ts` runs a single-flight periodic loop —
same shape as the scheduler tick (§11.I) — reconciling per-worker
state (`WARREN_WORKER_PROBE_INTERVAL_MS`, default 30s; disable with
`WARREN_WORKER_PROBE_DISABLED=1`). Probe ok flips
`unreachable → healthy`; probe fail flips `healthy → unreachable`.
`draining` is sticky — operator-set state, never overwritten by the
probe, exited only via the admin endpoint.

**Admin surface.**

- `POST /workers/:name/drain { drain: boolean }` — issues
  `POST /admin/drain` against the burrow worker **first**, then flips
  warren's state. Burrow-then-warren ordering means a failed burrow call
  never leaves warren claiming a state burrow does not honor. Reverse
  with `{ drain: false }`.
- `GET /workers` — returns the workers table joined with `pool.names()`
  so each row carries pool-membership status; per-worker errors are
  surfaced for operator visibility.

**Fan-out reads.** `src/burrow-client/fanout.ts`
(`fanOutAcrossWorkers`) drives `Promise.allSettled` across
`pool.names()` (alphabetical for determinism) for list-shaped routes
(`GET /burrows`, etc.). Responses are unioned and sorted by domain
field (`createdAt`); per-worker rejections are normalized and surfaced
as `workerErrors: { worker, message }[]` on the wire envelope alongside
the unioned rows. The helper never throws. Per-resource reads
(`GET /burrows/:id`, streaming) deliberately do not fan out — they use
`pool.clientFor` because exactly one worker holds that burrow's
sandbox + SQLite row.

**Server-level config.** The `[[workers]]` block lives in warren's
server-level TOML config (`src/server-config/`) — distinct from the
per-project `.warren/` loader in §11.H. Unlike the per-project loader's
missing-vs-malformed envelope, the server-level loader fails loudly on
malformed, missing-when-required, or schema-reject inputs: a bad
server-level config is a deployment failure, not a per-project
recoverable. The supervisor refuses to start when `[[workers]]` is
non-empty and `BURROW_API_TOKEN` is unset.

**Failure semantics.**

- *Decommissioning a worker with live burrows.* Operator action: drain
  via `POST /workers/:name/drain`, wait for in-flight runs to finish,
  remove the entry from `[[workers]]`, restart. Orphaned
  `burrows.worker_id` rows surface in `warren doctor` as
  `worker_missing`. Auto-migration is V2.
- *Network partition mid-dispatch.* `spawnRun`'s existing
  `BurrowUnreachableError` rollback (§4.3 step 2) handles transient
  blips; the pool's `clientFor` retries through the transport-mapping
  wrapper, so structured errors bubble up unchanged.
- *Sticky-by-burrow with an unreachable worker* fails loudly rather
  than migrating — a feature, not a bug.
- *Process model.* The supervisor (§5.1, §10.3) still spawns one local
  `burrow serve` per warren container; remote workers are
  operator-managed (their own supervisors, on their own hosts). The
  supervisor's life-cycle scope is the single co-tenanted burrow, not
  the pool.

**Zero-config back-compat.** A deploy with no `[[workers]]` block and
the existing `WARREN_BURROW_*` env vars behaves identically to the
single-worker container: same socket, same dispatch flow, one synthetic
`'local'` worker, fan-out unions of one. Existing handlers / scheduler
/ bridges tests pass unmodified.

Future work tracked under `ROADMAP.md` R-12 and §11.J item #1: dynamic
worker registration, capacity-aware / label-based placement, per-worker
tokens, and auto-migration on decommission.

---

## 6. Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Bun** (≥1.1) | Matches every other os-eco tool. |
| Language | **TypeScript** (strict) | Type safety across server, scheduler, UI. |
| HTTP | **Bun.serve** | Same posture as burrow's `serve` — sufficient, no framework. |
| DB | **`bun:sqlite`** (WAL mode, default) or **Postgres** (`drizzle-orm/node-postgres`, opt-in via `WARREN_DB_URL`) | Run history, schedules, webhook secrets. SQLite stays the zero-config default for the home-server appliance; Postgres lights up for org-scale deploys (R-13). Burrow's per-worker SQLite is untouched. |
| ORM | **Drizzle** | Match burrow. |
| Validation | **Zod 4** | Match burrow. |
| CLI framework | **commander** | Match burrow / mulch / seeds / canopy. |
| Logging | **pino** | Match burrow. |
| Frontend | **React + Vite + shadcn/ui + Tailwind** | SPA served as static files from warren. shadcn for component primitives (copy-in, no runtime dep), Tailwind for styling. Build output lives at `src/ui/dist/`, served by the same Bun.serve. |
| Burrow client | **`HttpClient` from `@os-eco/burrow`** (§15.6) | Typed mirror of burrow's library API over the unix socket. No hand-written HTTP. |
| Cron | **`croner`** (in-process tick) | Tz/DST-aware, ~30 KB, no native deps. Single in-process tick wrapped in a single-flight guard; cadence via `WARREN_SCHEDULER_TICK_MS` (§11.I). |

No HTTP framework on the server. No Redis, no Docker-in-Docker. Postgres is opt-in (R-13) — SQLite remains the zero-config default.

---

## 7. Project Structure

```
warren/
├── package.json                # @os-eco/warren
├── bunfig.toml
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
├── README.md
├── SPEC.md                     # this document
├── CLAUDE.md
├── Dockerfile                  # extends ghcr.io/jayminwest/burrow-base
├── docker-compose.yml          # default home-server compose file
├── fly.toml                    # default Fly deploy template
├── src/
│   ├── index.ts                # public library entry
│   ├── core/
│   │   ├── types.ts            # AgentDef, AgentRun, Project, Schedule
│   │   ├── errors.ts
│   │   └── ids.ts              # ag_xxx, prj_xxx, run_xxx, sched_xxx
│   ├── registry/
│   │   ├── canopy.ts           # cn render — turn canopy prompts into AgentDefs
│   │   └── schema.ts           # canopy schema validating "agent: true" prompts
│   ├── projects/
│   │   ├── clone.ts            # git clone <url> → /data/projects/...
│   │   └── repo.ts             # discovery, .seeds/.mulch/ presence checks
│   ├── warren-config/          # per-project .warren/ loader (§11.H, R-02)
│   │   ├── schema.ts           # zod: triggers.yaml + config.yaml + preview.yaml
│   │   ├── load.ts             # missing-vs-malformed envelope, never throws
│   │   ├── cache.ts            # per-project cache invalidated on refreshProject
│   │   └── errors.ts           # WarrenConfigUnavailableError + per-file codes
│   ├── runs/
│   │   ├── spawn.ts            # composition flow §4.3
│   │   ├── reap.ts             # capture mulch deltas (§11.A), close seeds, push branch
│   │   ├── stream.ts           # bridge burrow events → warren events table → subscribers
│   │   └── events.ts           # warren event log (write-through cache of burrow stream)
│   ├── burrow-client/          # thin facade over @os-eco/burrow HttpClient
│   ├── supervisor/
│   │   └── main.ts             # docker entrypoint: spawns warren + burrow serve, signal forwarding (§10.3)
│   ├── server/
│   │   ├── main.ts             # Bun.serve entry
│   │   ├── routes/
│   │   ├── auth.ts
│   │   └── ui.ts               # static SPA serving
│   ├── db/
│   │   ├── client.ts
│   │   ├── schema.ts
│   │   └── repos/
│   ├── cli/
│   │   ├── main.ts             # `warren` CLI for ops/admin
│   │   └── commands/
│   │       ├── register-agent.ts
│   │       ├── add-project.ts
│   │       ├── run.ts
│   │       └── doctor.ts
│   ├── ui/                     # React + Vite + shadcn/ui SPA, build output served by server
│   ├── triggers/               # in-process cron tick + scheduled-seed dispatch (§11.I, R-06)
│   │   ├── schema.ts           # TriggerSummary wire envelope
│   │   ├── repo.ts             # triggers table CRUD (composite-string PK)
│   │   ├── cron.ts             # croner facade — parse + nextRun
│   │   ├── seeds-extension.ts  # sd list / sd update --extensions shell-out
│   │   ├── dispatch.ts         # spawnRun with trigger='cron'|'scheduled'
│   │   ├── tick.ts             # single-flight tick loop
│   │   ├── config.ts           # WARREN_SCHEDULER_TICK_MS / WARREN_SCHEDULER_DISABLED
│   │   └── errors.ts
│   └── scheduler/              # (V2) GitHub webhook receiver
├── data/                       # gitignored, runtime state (mounted volume in deploy)
└── docker/
    └── burrow-base/            # if base image lives here vs burrow repo
```

---

## 8. Public Surface

### 8.1 HTTP API (top-level resources)

```
# V1 — manual run path
GET    /agents                  — list registered agent defs (built-ins + library); `?projectId=<id>` adds that project's `.canopy/` tier (R-03)
POST   /agents/refresh          — re-clone canopy library AND scan every project's `.canopy/` (per-project errors collected, never fatal — R-03)
GET    /agents/:name            — full rendered agent (cn render output); `?projectId=<id>` resolves project-first with global fallback (R-03)

GET    /projects                — list cloned project repos
POST   /projects                — { gitUrl, defaultBranch? } → clone
DELETE /projects/:id            — remove project
GET    /projects/:id/warren-config — parsed .warren/ envelope (§11.H, R-02)
GET    /projects/:id/triggers   — parsed triggers.yaml joined with last/next-fire state (§11.I, R-06)
POST   /projects/:id/triggers/:triggerId/run — Run Now: dispatch trigger inline with trigger='manual'
POST   /projects/:id/agents/refresh — refresh one project's `.canopy/` tier (R-03)

POST   /runs                    — { agent, project, prompt } → spawn
GET    /runs                    — list with filters (status, agent, project)
GET    /runs/:id                — detail + summary (includes rendered_agent_json)
GET    /runs/:id/events?follow=1 — NDJSON event tail (warren log + live tail)
POST   /runs/:id/steer          — send steering message (proxies to burrow inbox)
POST   /runs/:id/cancel         — graceful cancel (proxies to burrow)

GET    /healthz                 — liveness
GET    /readyz                  — readiness (canopy reachable, burrow reachable)

# V2 — deferred
POST   /webhooks/github         — GitHub webhook target (event-driven trigger half of the scheduler)
```

Auth: `Authorization: Bearer ${WARREN_API_TOKEN}` on every route except `/healthz`. Warren expects HTTPS termination at a reverse proxy (Caddy on home server, Fly's edge on Fly.io); it does not terminate TLS itself. Token is single-user, single-value, no rotation in V1 — see §11 for the security posture.

### 8.2 CLI (admin-only)

The CLI is for ops, not daily use — the UI is daily.

```
warren register-agent <name>       — refresh canopy and register one agent
warren add-project <git-url>       — clone a project
warren run <agent> <project> -p "..."  — one-shot, no UI
warren doctor                       — burrow reachable? canopy clean? bwrap working?
warren serve                        — start the HTTP server (default in docker entrypoint)

# V2 — deferred
warren schedule add ...
warren schedule list
```

### 8.3 Library API (V2)

Deferred. V1's `Client` class is internal; warren's only public surface is the HTTP API + CLI. When the HTTP surface stabilizes, `src/index.ts` will export a `Client` that mirrors the routes 1:1, following burrow's `Client` / `HttpClient` pattern (§15 of burrow's spec).

---

## 9. Data Model (sketch)

```sql
agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- synthetic rowid PK (R-03; migration 0011)
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global tier (built-in or library); non-null = project-scoped (R-03)
  name TEXT NOT NULL,           -- canopy prompt name
  rendered_json TEXT,           -- last cn render output, cached
  registered_at TEXT,
  last_refreshed TEXT
);
-- Composite unique on (project_id, name) plus partial unique on (name) WHERE
-- project_id IS NULL guarantees one global row per name (sqlite treats NULL
-- as distinct in plain unique indexes, so the partial index is load-bearing).
-- The agents table is a soft cache: `POST /agents/refresh` re-discovers from
-- canopy, so the old `runs.agent_name → agents.name` FK was dropped in 0011
-- rather than rippled into a composite FK.

projects (
  id TEXT PRIMARY KEY,          -- prj_xxx
  git_url TEXT,
  local_path TEXT,              -- /data/projects/owner/name
  default_branch TEXT,
  added_at TEXT
);

runs (
  id TEXT PRIMARY KEY,          -- run_xxx (warren's, not burrow's)
  agent_name TEXT,
  project_id TEXT,
  burrow_id TEXT,               -- see burrow's /openapi.json
  burrow_run_id TEXT,           -- see burrow's /openapi.json
  rendered_agent_json TEXT,     -- frozen at run start; survives canopy edits
  state TEXT,                   -- queued | running | succeeded | failed | cancelled
  started_at TEXT,
  ended_at TEXT,
  prompt TEXT,
  trigger TEXT                  -- 'manual' | 'cron' | 'scheduled' (V2 adds 'webhook'); arbitrary strings accepted (mx-513713)
);

events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  burrow_event_seq INTEGER,     -- mirrors burrow's monotonic seq for replay
  ts TEXT NOT NULL,             -- ISO8601 from burrow envelope
  kind TEXT NOT NULL,           -- 'tool_use' | 'tool_result' | 'thinking' | 'text' | 'state_change' | 'error' | 'stderr'
  stream TEXT,                  -- 'stdout' | 'stderr' | 'system'
  payload_json TEXT NOT NULL    -- pass-through from burrow
);
-- Index: events(run_id, burrow_event_seq) for ordered replay; events(run_id, ts) for time queries.

-- V1 — scheduler state (R-06, §11.I)
triggers (
  id TEXT PRIMARY KEY,          -- composite: '<projectId>:<triggerId>'
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  last_fired_at TEXT,
  next_fire_at TEXT,
  last_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL
);
-- Trigger definitions themselves live in <projectPath>/.warren/triggers.yaml; this
-- table only holds dispatch state. Row identity comes from the YAML entry's
-- triggerId (mx-55296f); a project delete cascades, a run delete clears the back-ref.

-- V2 — deferred
webhook_secrets (
  source TEXT PRIMARY KEY,      -- 'github'
  secret TEXT
);
```

**Event durability rationale.** Burrow owns the canonical event log (its `events` table, NDJSON archive on destroy). Warren persists a copy of every event it streams from burrow because (a) the UI's "reload page, see history" expectation requires server-side history, (b) warren restart shouldn't lose events users were watching, and (c) decoupling warren's UI from burrow's archive lifecycle keeps the seam clean. Warren's events table is *not* the source of truth — it's a write-through cache of what burrow streamed. On warren restart, the run's stream is re-subscribed at `MAX(events.burrow_event_seq) + 1`. If warren's DB is lost, runs continue (burrow has them); the UI loses scrollback for terminated runs but not for running ones.

---

## 10. Deploy

### 10.1 Home server (canonical)

```bash
git clone https://github.com/jaymin/warren && cd warren
cp .env.example .env && $EDITOR .env
docker compose up -d
open http://localhost:8080
```

`docker-compose.yml` mounts a single named volume at `/data` and applies the bwrap-friendly security flags. Storage defaults to SQLite under `/data/warren.db`. To run against a managed Postgres instead (R-13), set `WARREN_DB_URL=postgres://user:pw@host/db` in `.env`; pg migrations apply on first start, and the SQLite path is bypassed entirely.

### 10.2 Fly.io

```bash
fly launch                          # uses ./fly.toml
fly volumes create warren_data --size 50 --region sjc
BURROW_TOKEN=$(openssl rand -hex 32)
fly secrets set \
    WARREN_API_TOKEN=$(openssl rand -hex 32) \
    BURROW_API_TOKEN=$BURROW_TOKEN \
    WARREN_BURROW_TOKEN=$BURROW_TOKEN \
    ANTHROPIC_API_KEY=... \
    GITHUB_TOKEN=...
# Optional: layer a custom canopy library on top of the built-ins:
#   CANOPY_REPO_URL=https://github.com/<you>/agents.git
# Optional: attach to a managed Postgres instead of the on-volume SQLite
# (R-13). Without this, warren falls back to sqlite:///data/warren.db.
#   fly secrets set WARREN_DB_URL=postgres://user:pw@host/db
fly deploy
```

`BURROW_API_TOKEN` (read by `burrow serve`) and `WARREN_BURROW_TOKEN` (read by warren's burrow-client) are the two ends of one channel and **must hold the same value** — the supervisor validates equality at boot (warren-d317) and refuses to spawn burrow + warren if either is missing or they disagree, instead of letting `burrow serve` crash-loop with `[validation_error]` and warren 401 on every dispatch. `WARREN_API_TOKEN` is the browser-facing bearer; rotate the three independently. For loopback-dev only, set `WARREN_BURROW_NO_AUTH=1` to skip burrow auth (and the validation).

Same image, same volume layout, same security flags. Mac Pro and Fly.io are interchangeable hosts. The storage backend (SQLite-on-volume vs. external Postgres) is a `WARREN_DB_URL` flip — the rest of the deploy is unchanged.

### 10.3 Container layout

```dockerfile
FROM ghcr.io/jayminwest/burrow-base:0.2.0   # bun + bwrap + uidmap + burrow CLI
RUN bun install -g \
    @os-eco/canopy-cli@<v> \
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

The entrypoint is the Bun supervisor (`src/supervisor/main.ts`), not warren directly:

- Spawns `burrow serve --socket /var/run/burrow.sock` as a child via `Bun.spawn`.
- Waits for the socket file to appear (`fs.access` poll, 100 ms × 50 = 5s timeout) before spawning warren.
- Spawns warren (`bun run src/server/main/index.ts`) as a child.
- Forwards `SIGTERM` and `SIGINT` to both children, then waits for clean exit (5s grace) before forcing.
- Restarts `burrow serve` if it exits non-zero, with an exponential backoff and a budget of 5 restarts in 60s; after exhaustion, the supervisor exits, the container restarts under Docker/Fly's restart policy.
- Crashes if warren exits non-zero (warren is the user-facing process; restart-by-orchestrator is preferred to mask warren bugs in-process).

Rationale: zero non-Bun deps; signal handling and lifecycle are explicit in our code; warren restarts (the more frequent kind, e.g., on deploy) leave burrow's run loop and SQLite untouched.

---

## 11. Decisions & Open Questions

### 11.A Expertise capture (mulch reap)

The decided shape, expanded from prior open question #4:

- **Per-run isolation.** Each burrow run gets its own `.mulch/` inside the burrow workspace — not shared across concurrent runs against the same project. This matches burrow's "one run at a time per burrow" default (§4.2 of burrow's spec) and avoids race conditions if that posture is later relaxed.
- **Seeding (run start, step 3 of §4.3).** Warren reads `expertise_seed` lines from the rendered agent JSON, groups them by `domain`, and emits one `HttpWorkspaceFile` entry per domain (`.mulch/expertise/<domain>.jsonl`, canonical mulch record JSONL — one record per line) alongside the `.canopy/` / `.seeds/` / `.pi/` drops. The whole list ships as the `seed.files` payload on `POST /burrows` via `HttpClient.burrows.up({ seed: { files } })` (burrow R-07, plan `bur-pl-2467`). Burrow validates and writes the files atomically with provisioning — a malformed record or a seed-side filesystem error rolls the burrow back on burrow's side before warren observes a `burrow_id`. This replaces the prior "shell out to `ml record` inside the burrow workspace via `burrow exec` (or equivalent)" sketch: warren never reaches past the HTTP seam onto disk, and the seed payload is the contract.
- **Reap (run end, step 6 of §4.3).** Warren reads `<burrow-workspace>/.mulch/expertise/*.jsonl` and merges each record into the project's persistent `.mulch/expertise/<domain>.jsonl` using the project's local clone path. The `seeds_close` sub-step has migrated to `HttpClient.files.read('.seeds/issues.jsonl')` (warren plan `pl-a31c` step 3, warren `0.2.0`); `mulch_merge` still reads off the shared `.mulch/expertise/` directory because burrow has no file-listing endpoint yet — once `burrow-18ca` lands, it flips to `HttpClient.files.list` + `.files.read` and the warren↔burrow seam is fully HTTP on the read side too. Merge rule: **last-write-wins by record `ts` field**. Conflict resolution:
  - Same `id` (named record), incoming `ts > existing ts` → overwrite, emit a warren event `mulch.record.updated`.
  - Same `id`, incoming `ts <= existing ts` → drop incoming, emit `mulch.record.skipped`.
  - No `id` (anonymous record) → append, no conflict possible.
- **Failure mode.** Reap errors (disk full, schema violation) do not fail the run — they are logged and surfaced as a `reap_failed` event on the run. The agent's work is preserved on the branch even if expertise capture fails.
- **Why not bind-mount.** Bind-mounting the project's `.mulch/` into the sandbox would break burrow's isolation contract and risks corrupting the project's expertise log if the agent runs `ml` commands incorrectly. The reap step is the seam.
- **Why not "agent commits mulch as a branch artifact".** Requires every agent definition to know about persistence mechanics. The reap step is invisible to agents — they just call `ml record` as documented in canopy/mulch.
- **Why HTTP-and-not-shared-disk for seed + close.** Same reasoning that produced burrow's R-07: shared disk is an artifact of co-tenancy, not the contract. Warren's other warren↔burrow paths (spawn, dispatch, stream, steer, cancel) are typed HTTP; the seed + reap paths were the last consumers of the disk seam. Closing it makes a future remote-burrow topology possible without re-architecting the spawn path, and locks every workspace mutation behind a contract burrow's tests already pin (`bur-pl-2467`).

### 11.B Resolved decisions

| Question | Resolution | Where |
|---|---|---|
| Process supervisor | Small Bun parent process (`src/supervisor/main.ts`), zero non-Bun deps. | §10.3 |
| Frontend stack | React + Vite + shadcn/ui + Tailwind. | §6 |
| Mulch capture | Per-run isolated `.mulch/`, post-run reap, last-write-wins-by-ts merge. | §11.A |
| Run cancellation | `POST /runs/:id/cancel` proxies to burrow's `POST /runs/:burrow_run_id/cancel`. Hard-stop = `DELETE /burrows/:burrow_id` is V2; not needed for V1. | §4.3 |
| Burrow API contract | Burrow's `/openapi.json` is the source of truth. Warren generates a typed client against it. | §4.3 |
| Burrow shippability | All 21 routes implemented as of `burrow@7926a0e` (2026-05-08). `POST /burrows` no longer returns 501. | — |
| `CANOPY_REPO_URL` is optional (warren-d3e9, 2026-05-10) | Warren ships built-in `claude-code`, `sapling`, and `pi` agents inline (`src/registry/builtins/`); the canopy library is a power-user override, not a hard dependency. Boot seeds built-ins; refresh upserts library agents on top (same-named library agents win). `warren doctor` and `/readyz` treat unset `CANOPY_REPO_URL` as info, not failure. `POST /agents/refresh` and `warren register-agent` 400 with a friendly hint when no library is configured. `GET /agents` returns `source: "builtin" \| "library"` provenance derived from `frontmatter.source`. | §10.2, §11.B |

### 11.C Open questions for V1

1. **OpenAPI spec for warren's own HTTP surface.** Same question burrow resolved by hand-authoring `src/server/openapi/spec.ts` and golden-locking it. Recommend the same pattern; defer decision until after `/runs` and `/agents` routes stabilize.
2. **Concurrent runs per project.** Warren can dispatch many runs against the same project; each run gets its own burrow (provisioned per-run, destroyed on completion). Or do we share a long-lived burrow per project and queue runs serially inside it? Decision affects burrow lifecycle (provision-per-run vs. provision-per-project) and `runs.burrow_id` semantics. Lean toward provision-per-run for V1: simpler isolation, matches "task burrow" model from burrow's §4.1.
3. **Reverse proxy assumption.** Spec assumes warren is fronted by Caddy/Fly edge for TLS. Should warren refuse to start if `WARREN_TRUST_PROXY != true` and the bind address is non-loopback? V1 default: warn loudly in `doctor`, do not refuse — home-server users may not have a proxy yet.
4. **`readyz` timing.** When does warren consider itself "ready"? Burrow socket reachable + canopy clone present + at least one agent successfully rendered? All three? Affects deploy-time orchestration.

### 11.D V1 security posture (known limitations)

Documented, accepted for V1:

- **Single bearer token.** No rotation, no expiry, no revocation. Loss of `WARREN_API_TOKEN` = full access. Mitigation: rotate by editing `.env` / `fly secrets set` and bouncing the container.
- **Plaintext secrets in `.env`.** Standard for self-host; user is responsible for filesystem perms (`chmod 600 .env`). Fly.io's secret store is encrypted at rest.
- **No HTTPS termination in warren.** TLS is the reverse proxy's job. Direct HTTP on a non-loopback address is a misconfiguration; `warren doctor` warns.
- **Trust-the-socket between warren and burrow.** Burrow's unix socket has no auth; the in-container threat model is "warren is the only client." If a third party gains code execution inside the warren process, they have full burrow access. Acceptable: warren and burrow are co-tenanted by design.
- **No CSRF protection on the UI.** UI calls warren's API with the bearer token. Not exposed to third-party origins (CORS strict). Single-user posture.

These are limitations for V1, not bugs. V2 candidates: token-pair (read/write), per-token scopes, audit log.

### 11.E First-run validation (2026-05-09)

The §4.3 composition flow was exercised end-to-end against a real claude-code agent for the first time. Three architectural gaps in burrow surfaced and shipped fixes in the same session: `burrow-7b97` (`burrow serve` had no in-process executor — runs queued forever; fixed by wiring `RunDispatcher` into `startServer` and hooking `RunsClient.setOnCreated`), `burrow-55e3` (HTTP `burrows.up` ignored agent-id hints, leaving `toolchainPaths: []`; fixed by accepting `agents` on `HttpBurrowUpInput` and threading through `resolveEffectiveAgents` — paired with warren's spawn forwarding `agents: [agent.name]`), and `burrow-0329` (`buildBwrapArgv` lacked `--uid`/`--gid`, so the sandboxed process inherited host root and claude-code refused to run with `--dangerously-skip-permissions`). Warren-side fixes were narrower: bumping `@os-eco/burrow-cli` in **both** `Dockerfile` and `package.json` + `bun.lock` (the supervisor's `Bun.spawn` resolves `./node_modules/.bin/burrow` before PATH, so a Dockerfile-only bump is a no-op), bundling `@anthropic-ai/claude-code` with an explicit postinstall invocation (`bun install -g` skips lifecycle scripts), and a compose-time `CANOPY_SOURCE_DIR` bind mount for local-canopy testing. With burrow at `0.2.3`, a `warren run claude-code <prj> -p "..."` against warren itself completes in ~5s with `state: succeeded`, `branchPushed: true`, and a real model response in `run.event seq:4`. Outstanding gaps for V1 (all open warren seeds): the supervisor doesn't auto-wire `GITHUB_TOKEN` into git's credential helper (`warren-dcf3`), the supervisor offers no `--no-auth` knob for burrow loopback dev (`warren-93ee`), the `warren` CLI isn't on `PATH` inside the container (`warren-fab1`), the reap step can't distinguish "queued, never started" from "crashed" (`warren-3c40`), and the runtime image lacks `curl` for diagnostics (`warren-bd69`).

### 11.F Second dogfood (2026-05-09)

After all five §11.E gaps were closed, a second end-to-end run against warren itself surfaced six new structural seams. Burrow patched one mid-session: `burrow-e9e7` (`claude-code` runtime now default-allows `ANTHROPIC_API_KEY` + OAuth env names without requiring a project `burrow.toml [env]` block — claude-code is a built-in runtime, so its env contract is built-in too; landed in `0.2.6`). With burrow at `0.2.6`, the agent authenticated cleanly (`apiKeySource: "ANTHROPIC_API_KEY"` in seq:1 init), ran for 12m48s, and emitted a clean terminal `result` event with `is_error: false`, 102 turns, and `bun test 417/417 + lint + typecheck` all green inside the sandbox. **None of that work landed on the remote.** Two compounding bugs explain why: `warren-67cc` (the burrow worktree's `.git` file points at `<project>/.git/worktrees/<burrowId>`, which lives outside the bwrap mount — agent literally cannot `git commit` inside its workspace, so there was nothing for reap to push) and `warren-a69a` (warren's reap doesn't transition runs on terminal events — bridge stores the result event but the runs row stays `running` forever; even if the agent could commit, reap wouldn't push). Pattern recorded as `mx-runs/branchPushed-requires-both-reap-and-sandbox-git`: `branchPushed: true` is a compound output of in-sandbox git AND warren reap, and either failing alone produces an indistinguishable "stuck running, no branch" shape. Other open seeds from this iteration: `warren-5f19` (`deleteProject` rmrf's the disk before the row delete; FK on `runs.project_id` makes the row delete fail and leaves the system in a `(row exists, disk gone)` state — recommended fix: `ON DELETE SET NULL` plus row-first ordering inside a tx), `warren-1eaa` (`bun install -g` runs as root during build, so `/usr/local/bin/{sd,ml,cn,sapling,overstory}` symlink into `/root/.bun/...` which user `bun` can't traverse — every os-eco CLI is dangling at runtime), `warren-5165` (`.env.example` and SPEC claimed canopy `env_passthrough` flows via `burrow_config`, but `parseBurrowConfig` only reads `[sandbox].network`; resolved as docs-only — claude-code's env contract is now burrow-built-in via `burrow-e9e7`, and project-level `env_passthrough` plumbing is deferred until a non-built-in runtime needs it), `warren-d9ad` (UI's RunDetail badge doesn't react to incoming events — even after the reap fix lands, the UI will show stale state until a manual refresh).

### 11.G Third dogfood (2026-05-09)

Released as `0.1.2` after closing all six §11.F gaps; bumped `@os-eco/burrow-cli` to `0.2.7` in **both** `Dockerfile` and `package.json` + `bun.lock` to pull in the gitdir-bind fix (`burrow-7a80`: burrow's bwrap profile now binds the host worktree gitdir into the sandbox, so an agent at UID 1000 can resolve `<workspace>/.git → /<host-path>/.git/worktrees/<id>` and run `git commit` inside its workspace). Two runs against warren-on-warren produced the cleanest signal yet on the §4.3 composition flow. **Run 1 (`run_a98cfx1fantf`, prompt `"Work on sd warren-9f65. Use ml"`)** completed `succeeded` in 6m28s / 49 turns with `branchPushed: true` — and zero of the agent's work on the remote (`gh compare main...burrow/bur_r9mjn6da9xc9 → ahead_by: 0, total_commits: 0`). The branch ref pointed at main's SHA; warren reap pushed an unchanged HEAD because the agent never ran `git commit`. The thin canopy `claude-code` prompt (`canopy-daf3`: `"You are a helpful coding assistant. Be concise."`) contains no commit contract; combined with `src/runs/reap.ts:257-265` (push-without-commit) and the `branchPushed` boolean (which flips `true` on any successful push including a no-op) the result is a silent work-loss shape that even an attentive operator misreads as success — filed as `warren-f3bb` (P1: observability fix B + canopy-prompt fix C + SPEC §4.3.6 doc fix D). A secondary entanglement filed as `warren-fead` (the agent emitted `stop_reason=end_turn` while waiting on a foreground `bun install` Monitor — *"I'll wait for the monitor"* with no follow-up tool call ended the run before commit could happen). **Run 2 (`run_agpet4ev6e4a`, prompt `"...Commit and push when you're done"`)** produced the first warren-on-warren success that actually shipped: branch `burrow/bur_0qgh4pwpvgv0` at SHA `15339e61` with `ahead_by: 1`, real diff across 5 files (acceptance scenario 04 implementation + lib changes + mulch + seeds). The fix-C scope is validated — instructing the agent to commit is sufficient for the smoke-test agent. The *"and push"* portion was inert and counterproductive: agent-side `git push` failed four times with `fatal: could not read Username for 'https://github.com'` because warren's supervisor installs the `insteadOf` rewrite rule into `/root/.gitconfig` (`src/supervisor/git-credentials.ts:65-71`), but burrow's bwrap profile ro-binds `/usr`, `/etc`, `/lib`, `/lib64`, `/bin`, `/sbin`, `/opt` — *not* `/root`. Same architectural pattern as `warren-1eaa` (Bun store at `/root/.bun` invisible inside sandbox); the git config has the same problem and was not relocated. Filed as `warren-1a09` (P2): for V1, fix A (canopy prompt instructs commit only — *"warren handles the push"*) and fix D (SPEC documents the contract: agent commits, reap pushes, sandbox has no github auth path) are sufficient. Reap pushed the agent's commit successfully because reap runs host-side with `/root/.gitconfig` visible — the system did the right thing while the agent burned ~5 turns on doomed retries.

### 11.H `.warren/` directory convention (2026-05-10, reorg 2026-05-14)

R-02 from `ROADMAP.md` shipped via plan `pl-5d74` (warren-571f) before the
V2 phase opens. Worth pinning in V1's frozen record because the warren ↔
project-repo seam now has a third tier alongside `.canopy/` (prompts) and
`.mulch/` (expertise). The `.warren/` YAML reorg (warren-5840) lands as a
follow-up under pl-2c59; this section captures the post-reorg layout with
the legacy file documented as the loader fallback.

**Layout (warren-5840).** Each project repo may contain a `.warren/`
directory with these optional files:

```
.warren/
  triggers.yaml      # array of trigger entries (cron today; webhooks future)
  config.yaml        # per-project default role / branch / prompt / runBranchPrefix
  preview.yaml       # per-run preview environment (R-19 / §11.L) — top-level
                     # document is the preview block itself
  pr-template.md     # per-fragment PR-body overrides (warren-bd49)
  defaults.json      # DEPRECATED: legacy JSON home for everything in
                     # config.yaml / preview.yaml; loader still reads it
                     # and emits a deprecation warning (warren-5840)
```

All files are optional; the loader's envelope returns `null` for missing
files instead of erroring (`mx-66d478`), so existing project repos keep
working unchanged.

**Format choice.** YAML across the board (warren-5840) so comments are
allowed (JSON's biggest weakness) and arrays-of-objects stay readable as
new blocks accumulate. The pre-reorg JSON choice (`mx-2cefdd`) is
superseded by the warren-5840 decision; both formats keep working until
projects migrate via `warren config migrate`. YAML parser is `js-yaml
^4.1.1` to match mulch + overstory (`mx-8b6896`).

**Schema.** `triggers.yaml` is `Array<Trigger>` with a `kind:` discriminator
(only `'cron'` is implemented today; `kind:` exists so future webhook
entries can land without a breaking schema rev — `mx-3636de`). Cron-token
validation is intentionally loose (5 or 6 whitespace-separated fields,
non-empty); R-06 owns full grammar checking when it wires in croner
(`mx-40fe51`). A cron entry may also carry an optional `maxCostUsd`
(warren-a63d) — a positive USD spend cap. At dispatch warren folds it
onto the agent's frontmatter (overriding the agent's own
`frontmatter.maxCostUsd`, so trigger > agent), freezing a single
effective cap onto `runs.rendered_agent_json`; the event-bridge cancels
the run once cumulative cost crosses it (emitting a `budget.exceeded`
event). A malformed / non-positive value fails OPEN (no cap) so a budget
typo never silently cancels every run. `config.yaml` and legacy `defaults.json` share the same
schema — `{ defaultRole?, defaultBranch?, defaultPrompt?, defaultProvider?,
defaultModel?, runBranchPrefix?, preview? }` — all optional, all strict.
`runBranchPrefix` (warren-9993) overrides the prefix warren composes the
burrow branch from (`${prefix}/${run.id}`); precedence project default >
`WARREN_RUN_BRANCH_PREFIX` env > built-in `"burrow"`. `preview.yaml` (when
present) carries the preview block at the top level and wins over any
nested `preview:` field — see `PreviewConfigSchema` in §11.L.

**Loader contract** (`src/warren-config/load.ts`):

- Returns `LoadedWarrenConfig = { triggers: TriggersConfig | null,
  defaults: DefaultsConfig | null, prTemplate: PrTemplateOverrides | null,
  errors: WarrenConfigFileError[], warnings: WarrenConfigFileError[] }`.
- Missing file → entry is `null`, no error.
- Present-but-malformed file → entry is `null`, error appended with code
  (`warren_config_parse_error | warren_config_schema_error`) and message.
- `pr-template.md` (warren-bd49) is loaded the same way: missing → `null`;
  unknown fragment names / unbalanced preview markers surface as
  `schemaError` entries that flow through doctor + readyz.
- **Defaults precedence (warren-5840):** `.warren/config.yaml` >
  `.warren/defaults.json` (legacy). When the legacy file is present the
  loader appends a `warnings[]` entry with code `warren_config_deprecated`
  pointing at `warren config migrate`; this never flips `errors[]`.
- **Preview precedence (warren-5840):** `.warren/preview.yaml` > nested
  `preview:` field on the resolved defaults envelope. The loader merges
  `preview.yaml` into `defaults.preview` so downstream consumers keep
  reading `defaults?.preview` regardless of which file the value came from.
- Per-project cache (`src/warren-config/cache.ts`) is invalidated inside
  `refreshProject` and `deleteProject` (`mx-61c0e6`) so the next request
  reparses; this avoids the stale-config race called out in pl-5d74 risk #4.

**HTTP surface.** `GET /projects/:id/warren-config` returns the
`LoadedWarrenConfig` envelope verbatim (`mx-adf588`); 404 if the project
doesn't exist; `WarrenConfigUnavailableError` joins the existing
`BurrowUnreachableError` / `CanopyUnavailableError` /
`ProjectUnavailableError` family (`mx-bd1f9f`).

**UI surface.** Project detail (`src/ui/src/pages/ProjectDetail.tsx`,
`mx-dc191e`) renders three blocks per envelope: triggers list, defaults
key/value, per-file errors. Read-only in V1 — editing the YAML/JSON is a
git operation; warren only surfaces the parsed view (`mx-a5e30e`).

**Diagnostics.** `warren doctor` and `/readyz` emit two .warren/ checks:

- `warren_config` aggregates fatal `errors[]` (parse / schema) into a
  single failing-on-any-error row (`mx-f37c30`).
- `warren_config_deprecations` (warren-5840) aggregates non-fatal
  `warnings[]` — today only the `defaults.json` deprecation — and stays
  `ok: true` regardless so a legacy install doesn't flip doctor red.
  The check's hint names the one-shot fix: `warren config migrate`.

Doctor's check ordering now includes both rows; existing acceptance
scenarios continue to look for `warren_config` specifically.

**Acceptance.** Scenario 14 (`scripts/acceptance/scenarios/14-warren-config.ts`)
exercises absent / valid / malformed against `/readyz` rather than spawning
`warren doctor` as a child, because doctor would be running against the
wrong DB (`mx-e959c0` documents the rationale).

**Scope deliberately deferred to R-04.** `defaults.defaultRole` is
parsed but spawn still falls back to `WARREN_DEFAULT_AGENT`;
`defaults.defaultPrompt` has no template-substitution consumer yet. As of
2026-05-11 the trigger half is no longer deferred — R-06 (§11.I) dispatches
`triggers.yaml` entries on a 60s tick.

### 11.I Scheduler (cron + scheduled-for, 2026-05-11)

R-06 from `ROADMAP.md` shipped via plan `pl-2f15` (warren-3f59). The
scheduler is the only consumer of the trigger half of `.warren/` (§11.H) and
the warren-side consumer of seeds' `extensions.scheduledFor` (seeds v0.4.3).

**Sources.** Two trigger kinds dispatch per tick:

- **Cron** — entries in `<projectPath>/.warren/triggers.yaml` with `kind: cron`
  and a cron expression. Warren-config parses the YAML (loose 5-or-6-token
  validation, `mx-40fe51`); the scheduler hands the expression to `croner`
  for the strict pass at fire time (`mx-5199d0`). Dispatched runs carry
  `trigger='cron'`.
- **Scheduled seeds** — `sd list --format json` against the project's
  `.seeds/` finds seeds whose `extensions.scheduledFor` (ISO-8601) is in
  the past. Dispatched runs carry `trigger='scheduled'`. The `trigger` column
  accepts arbitrary strings (`mx-513713`); current call-sites are `'manual'`
  (default and Run Now), `'cron'`, and `'scheduled'`.

**Tick.** One in-process loop, lives inside `bootServer`'s lifecycle. Cadence
via `WARREN_SCHEDULER_TICK_MS` (positive int, default 60000); disable with
`WARREN_SCHEDULER_DISABLED=1` (`mx-8e42e9`). The tick wraps itself in a
single-flight guard so a slow tick can't pile up — overlap is impossible,
worst case is reduced effective cadence rather than duplicated fires
(`mx-eb4a3a`). Acceptance harness compresses the cadence to 1s globally via
`scripts/acceptance/run.ts` extra-env (`mx-883866`). Teardown order on
shutdown is `handle.stop()` (HTTP listener) → `scheduler.stop()` →
`bridges.stopAll()` → burrow stop (`mx-15bd97`).

**Table shape.** Migration 0005 adds the `triggers` table (see §9). PK is a
composite string `'<projectId>:<triggerId>'` (`mx-55296f`), not a multi-column
key. `project_id` FK cascades on project delete; `last_run_id` FK is
`ON DELETE SET NULL` so reaping an old run never blocks the trigger row.
`TriggersRepo.upsert` uses undefined-vs-null semantics on patch fields:
omitted (`undefined`) preserves the existing value, explicit `null` clears
it (`mx-18a708`). First observation of a fresh trigger seeds
`lastFiredAt=now` and computes `nextFireAt = parsedCron.nextRun(now)`
(`mx-ac8acd`) — a fresh row never fires immediately, which is what gives the
"no catch-up after downtime" property.

**Failure semantics.**
- *Catch-up after warren downtime:* no. Cron is "fire at time T," not "fire
  N missed runs." Operators who want replay press Run Now.
- *Closed or missing referenced seed:* skip + structured log + surface as a
  `lastSkipReason` on the trigger summary in `GET /triggers`. Not a hard
  failure.
- *Cron parse failure on a YAML entry:* surfaced in the warren-config errors
  envelope on `GET /triggers` so operators see the failing entry without
  tailing logs. Other triggers in the same file continue to fire.
- *Project delete races with an in-flight tick:* per-project section of the
  tick is wrapped in try/catch; the FK cascade on `triggers.project_id`
  keeps the warren side consistent regardless.
- *Timezone / DST:* per-trigger `timezone` field is supported by croner.
  Default UTC when omitted. DST transitions in zoned triggers follow croner's
  semantics (skip the "lost" hour, fire once for the "repeated" hour) —
  document the chosen zone explicitly in `triggers.yaml`.

**Seeds write path.** When a scheduled seed fires, the write order is:
spawn run FIRST → if the spawn succeeds, attempt
`sd update <seed> --extensions '{"scheduledFor": null, "lastScheduledRun": "<iso>"}'`
(`mx-a2ea60`). The triggers row's `last_fired_at` is also written before
the extension clear is attempted — warren's DB is the source of truth, and
a failed clear gets surfaced as a system event on the dispatched run rather
than dropping the dispatch. This makes the duplicate-dispatch hazard fail
safe: the next tick reads the warren row, sees the recent fire, and skips.

**HTTP surface.** `GET /projects/:id/triggers` returns
`{triggers: TriggerSummary[], errors: WarrenConfigFileError[]}` (`mx-a93eb5`).
`POST /projects/:id/triggers/:triggerId/run` resolves the trigger from
warren-config, dispatches inline with `trigger='manual'` (Run Now is a human
press, not a cron fire), and returns the run row 201 (`mx-f3b48d`). Both
routes require the project row first (`mx-fa6ac7`) and surface
`WarrenConfigUnavailableError` if the loader can't read the YAML.

**UI surface.** `TriggersBlock` in `src/ui/src/pages/ProjectDetail.tsx`
(`mx-28b6a2`) renders the wire envelope: one row per trigger with cron
expression + last/next fire columns + Run Now button. YAML editing remains a
git operation per the R-02 read-only posture (`mx-a5e30e`).

**Acceptance.** Scenario 15
(`scripts/acceptance/scenarios/15-triggers-roundtrip.ts`) exercises three
shapes (`mx-6fc1ef`): a cron entry that fires once without double-dispatch,
a `scheduledFor` in the past + one in the future, and a trigger that
references a missing or closed seed. The scenario bootstraps
`.seeds/config.yaml` in the sample-source repo before driving the scheduler
(`mx-fc2827`).

**Adding new schema fields or new trigger kinds.** Per `mx-5339d5`, update
three places in lockstep: ROADMAP R-06 (or its successor entry), this section
(§11.I), and acceptance scenario 15. New `TriggerSchema` fields must stay
additive (all-optional) so existing `triggers.yaml` files keep parsing —
warren-config (R-02) and the dispatcher (R-06) co-own the schema.

### 11.J Org-readiness direction (2026-05-11)

V1 is shipped — manual dispatch, cron + scheduled-for, single-user box. The
next direction, decided 2026-05-11, is to make warren self-hostable by an
engineering organization of 50+ ICs without forcing a fork. V1's
"one token, one user, one box" posture stays accurate for what's shipped;
the additions below extend the seams that are already in place rather than
rewriting them. None of this changes V1 — `docker compose up` against the
current code still works exactly the same.

**Why now.** Warren is being positioned externally as the answer to the
"ephemeral cloud agents that complete a task, validate it, open a PR, then
spin down" problem that vertical-SaaS engineering teams keep asking for.
The existing architecture (warren↔burrow HTTP seam, canopy as agent source,
seeds as work queue) already points at that shape. What's missing for an
org to actually adopt it on their own infra is: multi-user identity, a
backend an SRE team will operate, MCP, audit, budgets, and the ability for
one warren to dispatch across more than one host.

**The eight planned additions, in priority order.** Full design in
`ROADMAP.md`; this section is the cross-reference:

1. **Remote burrow workers** (R-12) — one warren, N burrow workers across
   hosts. Lifts the "single box is the concurrency ceiling" limit. Burrow
   side tracked in `burrow-c47a` (the protocol design — transport, auth,
   worker registration, placement). Warren side is a worker registry + a
   dispatch router. Today's local burrow keeps working with zero registered
   remote workers, so this is additive.
2. **Bring-your-own database** (R-13, **shipped 2026-05-14 via `pl-f17e`**) —
   `WARREN_DB_URL` selects SQLite (default) or Postgres
   (`drizzle-orm/node-postgres`). SQLite stays the home-server default.
   Burrow's own SQLite stays per-worker (it's run-local state, not org
   truth). One-shot porter for existing operators:
   `warren db migrate-to-postgres --from <sqlite> --to <pg-url>`.
3. **Per-user identity / SSO** (R-09, repromoted from `[deferred]`) — OIDC
   login replacing the single bearer token; the bearer stays as a
   service-account path for CI. Prerequisite for R-16 and R-17.
4. **MCP support** (R-15) — `mcp_servers` block in canopy frontmatter,
   threaded into the agent's runtime config; burrow-side per-run credential
   mount (same architectural shape as the `.gitconfig` resolution in §11.G).
5. **Cross-project activity UI + stable OpenAPI** (R-14) — a global "what
   is every agent doing right now" view; a versioned OpenAPI spec so teams
   can build their own dashboards (closes §11.C #1).
6. **Audit log** (R-16) — append-only dispatch/steer/cancel/secret-read
   ledger keyed to the authenticated user. Depends on R-09.
7. **Cost & concurrency guardrails** (R-17) — per-user / per-project token
   budgets and concurrent-run caps enforced at dispatch time. Depends on R-09.
8. **GitHub App** (R-18) — installation-scoped tokens with per-repo
   allowlists replacing the shared PAT; short-lived tokens minted per run.

**What stays single-tenant.** "Not a multi-tenant SaaS" remains a non-goal
(§2.3). The deployment unit is one team / one org self-hosting one warren.
SSO does not turn warren into a hosted service — it turns one warren into
something a 50-person team can share without sharing a credential.

**Cross-repo footprint.** Only burrow has an open dependency: the
`burrow-c47a` design (remote-worker protocol) gates R-12. Seeds, canopy,
mulch, and sapling have no new asks from this direction — the org-readiness
work is almost entirely warren-internal. Update the cross-repo readiness
table in `ROADMAP.md` when `burrow-c47a` produces a sub-plan.

### 11.K Pi runtime support (2026-05-12)

The `pi` (`@earendil-works/pi-coding-agent`) runtime is the third built-in
coding agent alongside `claude-code` and `sapling`. It shipped as
plan `pl-4374` (warren-39c1) in seven phased steps: a cross-repo burrow
piRuntime contract (`warren-0e06` → `burrow-8aff`), a parity-shape builtin
(`warren-d18e`), workspace seeding for pi-namespaced canopy sections
(`warren-846b`), a multi-provider surface (`warren-f8c0`), per-run cost
tracking (`warren-a7dc`), event-model widening in the UI (`warren-70af`),
and this docs/decision record (`warren-f1da`).

**Why a third built-in.** Pi is distinguished from `claude-code` and
`sapling` by three properties warren operators care about: (1) a unified
multi-provider LLM API (Anthropic, OpenAI, Google, Bedrock, Vertex,
DeepSeek, Groq, Mistral, Azure OpenAI, and custom OpenAI-compatible
endpoints) — pick the best model per task without standing up a second
runtime; (2) first-class `get_session_stats` RPC reporting tokens
(input / output / cacheRead / cacheWrite) + cost (USD) per session — see
what a run actually cost; (3) a clean customization surface
(`.pi/skills/<name>/SKILL.md`, `.pi/prompts/<name>.md`) that maps onto
warren's existing canopy-section seeding flow.

**Built-in shape.** `src/registry/builtins/pi.ts` (`PI_BUILTIN`,
`mx-4888d2`) mirrors `SAPLING_BUILTIN` exactly: `name='pi'`, `version=1`,
`sections.system` + `sections.burrow_config` with `network='open'`,
`frontmatter.source='builtin'`, `resolvedFrom=['builtin:pi']`. Wired into
`BUILTIN_AGENTS` (`src/registry/builtins/index.ts`), asserted by
`builtins.test.ts`, surfaced in the Agents page (`mx-723c5e`), and covered
by acceptance scenario 16 (`mx-05f62f`). Warren forwards `agent.name='pi'`
to burrow as the runtime id via the existing
`agent.name → burrow agentId` convention (`mx-7352f4`, `mx-c8fc41`); burrow's
piRuntime is registered in the `AgentRegistry` per the warren-0e06 contract
(`mx-0db923`).

**Burrow piRuntime contract.** Pinned at `mx-0db923`:
`id='pi'`; `displayName='Pi'`; `supportsResume=true` (pi has
`--continue` / `--session`, *not* one-shot like codex); spawn shape
`pi --mode rpc --no-session [--no-extensions] --provider <…> --model <…>`
(RPC mode, not JSON — chosen for the bidirectional steer / abort /
get_state / get_session_stats surface that warren's spawn-per-turn flow
assumes). RPC commands warren consumes: `prompt`, `steer`, `abort`,
`get_state`, `get_session_stats`. Event kinds warren's parser surfaces:
`agent_start`/`end`, `turn_start`/`end`, `message_start`/`update`/`end`,
`tool_execution_start`/`update`/`end`, `queue_update`, `compaction_start`/`end`,
`auto_retry_start`/`end`, `extension_error`. `envPassthrough` widens beyond
claude-code's `ANTHROPIC_*` + `CLAUDE_CODE_OAUTH_TOKEN` set to include
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `PI_API_KEY`,
`GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY` — implemented at the
runtime-contract layer (burrow's `envPassthrough` escape hatch), so warren
does not change `docker-compose.yml` to add a new provider. If burrow ships
piRuntime under a different id (e.g. `pi-coding-agent`), warren's
`BUILTIN_AGENTS` name must change in lockstep — the two strings must match
exactly (`mx-7352f4`).

**Canopy sections.** Pi accepts two extra canopy sections beyond the
generic enumeration in §4.2: `pi_skills` and `pi_prompts`. Bodies are
JSON-Lines `{name, body}` envelopes, materialized by
`src/runs/seed.ts` into the burrow workspace before dispatch
(`mx-413c1b`): `pi_skills` writes to `.pi/skills/<name>/SKILL.md`
(per-skill subdir matching the `agentskills.io` standard); `pi_prompts`
writes to `.pi/prompts/<name>.md` (flat). Both reject malformed JSON,
non-object lines, missing/empty `name`, non-string `body`, duplicate
names, and unsafe names with `RunSpawnError` — same shape as
`expertise_seed`. Sections are pi-namespaced (not generic `skills`) so a
canopy author can land a generic `skills` section on a base agent and have
it remain ignored by pi without collision.

**Multi-provider surface.** `AgentDefinition.frontmatter` grows two
well-known optional string fields: `provider` and `model` (`mx-20a3b9`).
Built-in `PI_BUILTIN` leaves both unset by default — pi resolves from its
own `~/.pi/agent/models.json`. `POST /runs` accepts optional
`providerOverride` + `modelOverride` strings (`mx-fd6008`); they thread onto
`agent.frontmatter` before freeze, so the rendered agent on
`runs.rendered_agent_json` records exactly what ran. `NewRun.tsx` surfaces
the pair as two free-text Inputs in a 2-col grid (`mx-0048cb`), auto-filled
from the selected agent's frontmatter.

**Cost + token accounting.** Migration 0006 adds five nullable columns to
`runs`: `cost_usd REAL`, `tokens_input INTEGER`, `tokens_output INTEGER`,
`tokens_cache_read INTEGER`, `tokens_cache_write INTEGER`. `RunsRepo.attachStats`
mirrors `attachBurrow`'s partial-input semantics (`mx-49272e`): omitted fields
preserve existing values; explicit `null` does not clear. Two runtimes
populate the columns by shape-sniffing events as they flow through
`bridgeRunStream`:
- **pi** (`warren-17a4`): `accumulatePiUsage` sums `turn_end.message.usage`
  totals across turns; persisted at the first `agent_end`. The legacy
  out-of-band `PiStatsClient` (`mx-916eb6`) is still wired as an explicit
  override that wins over in-stream when injected — it fetches
  `get_session_stats` at run-start and run-end and persists the delta,
  defending against the multi-session cost double-count when pi resumes
  via `--continue` / `--session`.
- **claude-code** (`warren-87f9`): `extractClaudeUsage` reads the single
  terminal `result` envelope's `total_cost_usd` + `usage.{input_tokens,
  output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`.
  Single-shot — claude-code emits cumulative run totals once at end, so
  no accumulation is needed. Persisted on terminal detection.

Dispatch is shape-sniffed (not keyed off `runs.agent_name`) so a future
runtime emitting a known terminal shape Just Works. If both shapes
appear in one stream (mixed runtimes — unlikely in practice), pi wins
for parity with the pre-warren-87f9 behavior. `sapling` runs leave every
column `null` (no terminal cost emission yet — separate seed). RPC failures are logged as a system
event and do not fail the run. `RunDetail.tsx` renders a header cost badge
using `formatCostUsd()` (`mx-9d987a`): `≥$1` → 2 decimals, `<$1` → 3 decimals;
badge omitted when `cost_usd` is `null`. `Runs.tsx` adds an opt-in Cost
column (hidden by default, toggled via the toolbar).

**Event model.** Pi's wider event vocabulary (`compaction_start`/`end`,
`auto_retry_start`/`end`, `extension_error`, `queue_update`) is collapsed by
burrow's pi parser (`src/runtime/parsers/pi.ts`) into burrow's stable
event taxonomy, with the original pi envelope `type` preserved in
`payload.type`. `RunDetail.tsx` `EventLine` detects pi sub-kinds by peeking
at `payload.type` when `event.kind` is `state_change` or `telemetry`
(`mx-66ff69`); `PI_SUBKIND_LABELS` maps each to a friendlier display label;
`extension_error` additionally tints `rose-700` like stderr. A kind-direct
match (e.g. `event.kind === 'compaction_start'`) is also honored so a
future burrow release that promotes any of these to first-class kinds Just
Works without a UI rev. Unknown kinds fall through to the existing generic
renderer.

**Pi extensions are deferred** (`.pi/extensions/*.ts`). Pi extensions are
TypeScript source modules with access to `ExtensionAPI` (`registerTool`,
`registerCommand`). Encoding TS source inside a canopy section body works
but is awkward — operators lose `tsc` / `biome` on the source, syntax errors
only surface at run time, and the canopy diff view becomes useless. The
right fix is a canopy *artifact type* (file-shaped, not section-shaped)
that warren materializes alongside the rendered `AgentDefinition`. That is
a canopy-side change first. V1 ships `pi_skills` + `pi_prompts` (already
file-shaped + markdown) and leaves `.pi/extensions/` to a follow-up plan
once canopy ships artifact types.

**No MCP support on pi.** Pi explicitly has no MCP — its tool surface is
built-in plus extensions only. This is a worldview difference, not an
omission: R-15 (MCP via canopy frontmatter, post-V1) stays scoped to
`claude-code` and `sapling` and is *not* a blocker for the `pi` built-in.
Operators wanting MCP-style external tools on pi should reach for pi's
extensions story once canopy artifact types land.

**Headless provider-auth posture.** Warren passes provider API keys into
the sandbox via burrow's `envPassthrough` (see contract above). Pi's
interactive `/login` flow (OAuth for Anthropic Claude Pro/Max, ChatGPT
Plus, GitHub Copilot, etc.) is unsupported by design: warren is headless.
A future "bring-your-own-browser" path for OAuth-only providers is
reconsiderable in V2 if there is demand; in V1, pi is API-key-only.

**Why not ship pi as a canopy library agent?** Built-ins exist precisely
so a fresh warren install can dispatch a run without `CANOPY_REPO_URL` set
(see §2.1, `src/registry/builtins/index.ts`). `claude-code` and `sapling`
both ship inline; `pi` is the third member of the same set and deserves the
same treatment. A library-only path would mean every operator who wants
pi has to stand up a canopy fork first — high friction for the
"multi-provider out of the box" value proposition.

**Per-agent tool allowlist/denylist (warren-8dee).** `AgentDefinition.frontmatter`
grows an optional `tools` object so a reviewer / patrol agent can declare a
hard read-only (or otherwise scoped) tool surface at the harness level, not
just via bwrap network policy. Shape:
`tools = { allow?: string[], deny?: string[], noBuiltins?: boolean, noTools?: boolean }`.
`readToolsFrontmatter` (`src/registry/schema.ts`) parses, validates, and
normalizes it: `allow`/`deny` accept a real `string[]` or a single
comma/whitespace-separated string (the shape `cn --fm key:value`
stringification produces — same string/boolean trap as `auto_plan_run`,
warren-5f07), and `noBuiltins`/`noTools` tolerate `"true"`/`"false"` strings.
A malformed declaration throws `AgentSchemaError` at parse time
(`parseRenderedAgent` + `validateAgentDefinition`) rather than silently
dropping the guarantee. `parseRenderedAgent` freezes the *normalized* policy
back onto `frontmatter.tools`, so the rendered envelope on
`runs.rendered_agent_json` and the metadata warren forwards to burrow carry a
canonical shape. The policy rides the existing `composeBurrowMetadata` seam
(`src/runs/spawn/dispatch.ts`) — no new dispatch plumbing — so it forwards on
`Run.metadataJson.frontmatter.tools` exactly like `provider`/`model`.

This is a **paired warren↔burrow change** (same pin discipline as the
piRuntime contract above): warren validates + forwards the policy; burrow's
`buildPiArgv` (`../burrow src/runtime/pi.ts`) reads
`ctx.frontmatter.tools` and appends `--tools <allow>` /
`--exclude-tools <deny>` / `--no-builtin-tools` / `--no-tools` to the pi
argv. Only the `pi` runtime consumes the field in V1 — `claude-code` and
`sapling` ignore it. Until burrow ships the `buildPiArgv` half, warren
already freezes + forwards a well-formed policy, so the burrow change is
additive and non-breaking.

**Adding a fourth built-in (or schema-extending pi).** Per `mx-39a64f`,
five places update in lockstep: (1) `src/registry/builtins/<name>.ts`,
(2) `BUILTIN_AGENTS` array + re-export in `src/registry/builtins/index.ts`,
(3) `builtins.test.ts` assertions on `BUILTIN_AGENT_NAMES` + `readAgentSource`,
(4) `scripts/acceptance/scenarios/13-container-smoke.ts` builtin-names check,
(5) `src/ui/src/pages/Agents.tsx` header + empty-state copy. Scenario
`02-agents-refresh.ts` already filters on `source !== 'builtin'`
(`mx-ae877e`), so it auto-extends without a code change.

### 11.L Per-run preview environments (2026-05-14)

Design lock for R-19. Tracked by plan `pl-2c59` (root seed
`warren-1bcb`, design-lock step `warren-94d8`). Closes the R-19 open
questions; the implementing steps assume this section as contract.

**Status: shipped 2026-05-14.** All 11 implementation steps under
`pl-2c59` closed in sequence — burrow's cross-repo inbound-networking
+ sidecar-exec change (`burrow-8647`) landed first; warren-side
schema (migration 0009 + `RunsRepo.attachPreview`), SQLite-backed
port allocator, reap-time `preview_launch` + `pr_annotate_preview`
best-effort sub-steps, idle-TTL / max-lifetime / LRU eviction worker,
host proxy preamble + signed-cookie auth, manual teardown route,
RunDetail UI surface, and acceptance scenario `20-preview.ts`
(happy-path + idle-TTL eviction; macOS skipped per `mx-1d31f0`)
followed. Operator setup (wildcard CNAME, Caddy DNS-01 snippet, the
full `WARREN_PREVIEW_*` knob table) is documented in
[README](README.md#per-run-previews--operator-setup) and
[`.env.example`](.env.example). Static-site previews
(`type: static`), PR-template configurability, the `.warren/` YAML
reorg, and a PR-close webhook → preview-teardown hook stay as
sibling follow-ups under `pl-2c59`. The PR-close webhook teardown
design is locked in §11.N (V2, awaits webhook receiver
infrastructure tracked next to R-18).

**Burrow-side dependency.** Burrow's bwrap profile is outbound-only
today (§8.1, `network: 'none' | 'restricted' | 'open'`), and the run
API is shaped around single-shot agent runs — neither an inbound
loopback port-forward nor a long-lived sidecar lifecycle exists on
burrow's HTTP surface. The cross-repo coordination seed is filed as
`burrow-8647` (consumed by warren-side step `warren-83dc`): warren
declares `inboundPortForwards: [{hostPort, sandboxPort}]` on the
sandbox profile and calls `POST /burrows/:id/sidecars` (with
parallel `GET / DELETE` and a `logs` endpoint) to spawn
`preview.command` alongside the finished agent run. Warren
orchestrates allocation, eviction, and TTLs; burrow enforces the
per-burrow forward + a small sidecar cap. Acceptance scenario 20's
Linux path exercises the full warren↔burrow seam; macOS skips per
`mx-1d31f0` because sandbox-exec doesn't isolate the network
namespace the same way.

**Project opt-in shape.** A project drops a `preview` block into
`.warren/preview.yaml` (canonical, warren-5840) — the top-level
document is the block itself. The same block is still accepted nested
under `preview:` in `.warren/config.yaml` or legacy `.warren/defaults.json`
for projects still on the old layout. The schema carries a `type`
discriminator from day one so we don't have to break the config when
the static-mode fallback lands:

    preview:
      type: server          # 'server' ships in V1; 'static' is a follow-up
      command: "bun run dev"
      port: 3000
      readiness_path: "/healthz"     # optional
      idle_ttl: "30m"                # default WARREN_PREVIEW_IDLE_TTL
      max_lifetime: "8h"             # default WARREN_PREVIEW_MAX_LIFETIME

V1 implements only `type: server`. `type: static` (build step + dir to
serve) is filed as a follow-up under the same plan; the schema accepts
the field but the launcher rejects with a "not yet implemented" error
that names the follow-up seed. Missing-block is not an error — projects
that haven't opted in simply skip the preview sub-step at reap.

**Reap-time launch (5th best-effort sub-step).** Mirrors the `pr_open`
pattern (`mx-05abb2`): a new `preview_launch` sub-step runs in
`src/runs/reap.ts` *after* `pr_open`, only when `outcome === 'succeeded'`
and the project opted in, never fails the run. Sequencing matters:
`pr_open` runs first and opens the PR with a
`<!-- warren:preview-placeholder -->` line embedded in the body so the
reviewer sees the PR immediately; `preview_launch` then asks burrow to
spawn `preview.command` as a long-lived sidecar in the same workspace,
allocates a port, and transitions `preview_state: starting → live` once
`readiness_path` (or a default `GET /`) returns 2xx. Once the preview
reaches `live` or `failed`, a third best-effort sub-step
`pr_annotate_preview` issues a `PATCH /repos/.../pulls/:n` to replace
the placeholder line with either the preview URL (live) or the failure
tail (failed). PR open does **not** block on preview ready; the
annotation patch is its own idempotent step. All three sub-steps emit
`reap_failed` events with `step` ∈ {`pr_open`, `preview_launch`,
`pr_annotate_preview`} on error and never mark the run failed.

**Two-phase readiness probe (warren-9b15).** The launcher splits its
wall clock into two named phases so sidecar startup overhead doesn't
eat the bundler budget:

1. **`connect` phase.** Cap: `connect_timeout` (default 5m). Covers
   shell pre-exec, dev-server CLI startup, dependency import-graph load,
   and port bind. Any HTTP response the server returns — even 4xx/5xx
   while the bundler still compiles — flips the loop into phase 2.
   Exhaustion surfaces as `LaunchFailureReason: 'connect_timeout'` —
   operator action is "check the sidecar's command (binding wrong host?
   port mismatch?), check burrow forwarder."
2. **`readiness` phase.** Cap: `readiness_timeout` (default 10m). Starts
   at first successful TCP connect, not sidecar create. Waits for 2xx/3xx
   from `readiness_path` (or `GET /`). Exhaustion surfaces as
   `LaunchFailureReason: 'readiness_timeout'` — operator action is
   "check the dev server's first-compile cost, possibly raise
   `readiness_timeout`."

`preview_failure_message` records the failing phase (`phase=connect:` /
`phase=readiness:`) so operators can tell which cap was actually hit.
Both timeouts accept the standard duration grammar (`1s..1h`) and are
overridable per-project under the `preview` block.

**Same sandbox, not a fork.** The preview runs in the same burrow
workspace the agent used. Forking would double burrow workload and
complicate port binding for marginal safety; the agent's side effects
(deleted files, half-applied migrations) are accepted as the cost of
realness. Failure mode surfaces as `preview_state: failed` with the
stderr tail in `preview_failure_message` — reviewers read "agent broke
the build" attributable to the agent's output, not warren.

**Lifecycle — idle-TTL is the primary signal.** Wall-clock TTL is the
wrong primary kill-rule: a reviewer mid-session shouldn't get their
preview yanked because N hours elapsed. The eviction worker
(`pl-2c59` step 7) combines four signals:

1. **Idle TTL.** The proxy updates `runs.preview_last_hit_at` on each
   request, **before** returning the response (a slow upstream must not
   make the preview look idle). Updates are debounced to ~once per 30s
   per run to keep the hot path cheap. Sweep evicts when
   `now - preview_last_hit_at > idle_ttl` (default 30 min, overridable
   per-project and via `WARREN_PREVIEW_IDLE_TTL`).
2. **Max lifetime ceiling.** Hard cap from launch time regardless of
   activity. Default 8h, overridable per-project and via
   `WARREN_PREVIEW_MAX_LIFETIME`. Stops the "browser tab from yesterday
   is still ticking the proxy" failure mode.
3. **Global LRU cap.** When `WARREN_PREVIEW_MAX_LIVE` (default 20) is
   reached and a new launch needs space, evict the longest-idle preview.
   Bounds container memory regardless of TTL choices.
4. **Manual teardown.** `POST /runs/:id/preview/teardown` is bearer-
   required, idempotent, emits `preview_torn_down`. UI exposes a button
   in `starting` / `live` states. Polite recourse when reviewer is done.

A V2 fifth signal — **PR-close webhook teardown** — funnels through the
same `teardownPreview` path with a structured `actor` tag once warren
ships a GitHub webhook receiver. Locked separately in §11.N to avoid
extending `EvictionReason` for code that can't land until the webhook
surface exists.

All eviction paths free the port and stop the sidecar process. The
**burrow workspace stays** — only the preview process dies. Workspace
cleanup is a separate concern keyed off the run's lifecycle, not the
preview's, so a re-launch (e.g. if R-12 remote-worker future ever wants
to re-spin a preview on a different host) is cheap.

**Auth — signed cookie, not bearer.** A run against private code
produces a preview that may contain secrets. Bearer-in-header is
impossible for a browser hitting `run-<id>.<host>` directly, so warren
issues a signed cookie from `GET /runs/:id/preview/login?token=…&redirect=…`
(ROADMAP option a). Cookie scope is `Domain=.<warren-host>;
Path=/; HttpOnly; Secure; SameSite=Lax` **in subdomain mode**; path
mode narrows the scope to `Path=/p/<run-id>/` with no `Domain` (see
the "Routing modes — path vs subdomain" addendum below). The proxy
preamble verifies the HMAC before forwarding; unauthenticated requests
401, not 502. A doctor check warns when `WARREN_PREVIEW_HOST` is set
but `WARREN_API_TOKEN` is the default placeholder (mode-gated; see
addendum). GitHub OAuth (ROADMAP option b) defers to R-18; per-run
basic-auth password (option c) and no-auth (option d) stay rejected.

**Routing — in-process Bun route, not a separate reverse proxy.** The
proxy match (`Host: run-<id>.<host>` for subdomain mode; `/p/<run-id>/`
path-prefix for path mode — see the "Routing modes" addendum below)
lives in `src/server/main/index.ts` as a preamble before the API/UI routes.
It resolves `runs.preview_port` → `127.0.0.1:<port>` and forwards
HTTP + WS through `burrowClientPool.clientFor({burrowId})` so the
multi-worker placement (`warren-c0c9` / `pl-9ba1` step 5) keeps
holding. Cross-host (`runs.worker_id !== local`) returns **501 with
an explicit R-12 deferral message** — silent fall-through to a closed
loopback port would manifest as "preview works for some runs, not
others."

**TLS termination stays operator-side.** Per SPEC §8.1 / §11.D, TLS is
the operator's Caddy / Fly edge. Warren ships docs for the wildcard
`*.<warren-host>` CNAME + DNS-01 wildcard cert with a Caddy snippet,
not built-in cert provisioning. The DEPLOY guide is honest about the
operator burden (DNS provider must be on Caddy's DNS-01 list; some are
paid).

**Port allocator persistence.** The allocator is SQLite-backed, not in-
memory. On warren startup, in-use ports are derived from
`SELECT preview_port FROM runs WHERE preview_state IN ('starting','live')`.
Default range `30000-31000`, configurable via
`WARREN_PREVIEW_PORT_RANGE`. Exhaustion emits a `preview_failed` event
with `reason='port_exhausted'`; a doctor warning fires when ≥80% of
the range is in use.

**Schema additions.** Migration 0009 adds five columns to `runs`.
Per R-13's dual-backend story (§3.2, §6), the migration lands in
**both** dialects in lockstep — `src/db/migrations/0009_*.sql` and
`src/db/migrations/postgres/0009_*.sql` — and the column declarations
land in **both** schema files (`src/db/schema/sqlite.ts` +
`src/db/schema/postgres.ts`). The preview-state enum tuple
(`['starting','live','failed','torn-down']`) lives in the shared
`src/db/schema/columns.ts` module so TS-side narrowing stays
dialect-agnostic.

    preview_state              TEXT NULL    -- (sqlite) / TEXT NULL (postgres). Enum: starting|live|failed|torn-down
    preview_port               INTEGER NULL -- (sqlite) / INTEGER NULL (postgres)
    preview_started_at         TEXT NULL    -- (sqlite ISO8601) / TIMESTAMPTZ NULL (postgres)
    preview_last_hit_at        TEXT NULL    -- (sqlite ISO8601) / TIMESTAMPTZ NULL (postgres); proxy-updated, debounced
    preview_failure_message    TEXT NULL    -- stderr tail on failure

`RunsRepo.attachPreview` is **async** (Promise-returning, matching the
post-R-13 repo layer from `pl-f17e` step 1) and mirrors `attachStats`'s
partial-input semantics (`mx-49272e`): omitted fields preserve existing
values; explicit `null` does not clear. Migration-parity CI lint
(R-13 acceptance #7) enforces lockstep on every commit.

**PR-template fragment contract.** The preview footer is a **named
template fragment** in the PR body that no-ops when the project hasn't
opted in. The full named-fragment registry shipped in `warren-bd49`:
`buildPrContent` (`src/runs/pr.ts`) composes its body from the
`PR_FRAGMENT_NAMES` registry in `src/runs/pr-template.ts`, and projects
override any fragment by shipping `.warren/pr-template.md` with `## name`
H2s. The `preview_url_or_placeholder` fragment is one entry in the
registry — same start/end markers, same idempotent annotate path. The
broader `.warren/` YAML reorg (one file per concern) is filed under the
same plan as a follow-up.

**Remote-worker (R-12) explicit deferral.** Cross-host preview routing
is out of scope. The proxy preamble asserts local-worker-only and
returns 501 with a clear R-12 deferral message; acceptance scenario 20
covers the assertion. When R-12 lands, this becomes the natural place
to splice in the worker-aware routing layer.

**Acceptance scenario number.** Scenario **20** (`20-preview.ts`), not
19 — scenario 19 (`19-warren-on-postgres.ts`) is taken by the R-13
dual-backend acceptance from `pl-f17e`. Per the dialect-aware `withDb()`
helper landed in `pl-f17e` step 6, scenario 20 should run on both
backends (SQLite default + `WARREN_TEST_DIALECT=postgres`) — preview
state, port allocator persistence, and eviction queries all touch the
DB seam that R-13 dual-tracks.

**`.warren/` reorg.** Shipped as warren-5840 under pl-2c59. The
canonical layout is one file per concern (`config.yaml`, `preview.yaml`,
`triggers.yaml`, `pr-template.md`); the legacy `defaults.json` still
loads with a deprecation warning, and `warren config migrate` converts
an existing install in place. See §11.H for the loader precedence and
the schemas in `src/warren-config/schema.ts` for the field-by-field
shape.

**Routing modes — path vs subdomain (warren-f4d7, pl-f4ea, 2026-05-15).**
The original §11.L lock above describes subdomain-mode routing
(`Host: run-<id>.<warren-host>`). That mode requires the operator to own
a domain, configure a wildcard CNAME, and provision a wildcard TLS cert
via DNS-01 — a closed door for the common self-hoster who just
`fly deploy`s warren. A second mode, **path mode**, reuses the single
hostname + cert that already serves the warren UI and adds zero
DNS/cert work. Path mode is the **default** from this addendum onward;
subdomain mode stays as the explicit opt-in for multi-tenant operators.

Selection knob:

```
WARREN_PREVIEW_MODE = path | subdomain        # default: path
```

(Also accepted as a top-level field in `.warren/preview.yaml` — but the
env var is the operator-facing surface; the per-project field exists
only so a project can pin a mode for its own previews when the operator
runs warren in a mixed configuration. The env wins on conflict, matching
the rest of `WARREN_PREVIEW_*`.)

**URL contract.** Path mode serves a run's preview at
`https://<warren-host>/p/<run-id>/...`. The run-id slug is the same
`[a-z0-9-]+` shape already used in `run-<id>.<warren-host>`. Subdomain
mode keeps the `https://run-<id>.<warren-host>/...` contract from the
original §11.L. No URL form ever serves a preview outside its
`/p/<run-id>/` (path mode) or `run-<id>.<host>` (subdomain mode) scope.

**Routing — path-prefix preamble.** The proxy preamble in
`src/server/main/index.ts` (mx-787718) grows a sibling match:

- Subdomain mode: existing `Host: run-<id>.<warren-host>` match.
- Path mode: regex `^/p/(?<runId>[a-z0-9-]+)(?<rest>/.*)?$` on the
  request path; strip `/p/<run-id>` before forwarding upstream. The
  upstream sees a request rooted at `<rest>` (or `/` when `rest` is
  empty), identical in shape to what subdomain mode forwards today.

Both branches share the rest of the seam: resolve
`runs.preview_port → 127.0.0.1:<port>` via
`burrowClientPool.clientFor({burrowId})`, forward HTTP + WS, update
`runs.preview_last_hit_at` with the 30s-debounce (mx-411a6f), 501 on
cross-host (`runs.worker_id !== local`) with the R-12 deferral message,
404 (not 502) on unknown run-id. The eviction worker, port allocator,
and reap-time `preview_launch` / `pr_annotate_preview` sub-steps stay
mode-agnostic.

**HTML rewrite contract (path mode only, best-effort).** Root-relative
asset URLs (`/assets/foo.js`) and dev-server `Location:` redirects
(`Location: /signin`) would escape the `/p/<run-id>/` prefix and 404
against warren's UI/API routes. The path-mode proxy applies two
response transforms:

1. **`<base href>` injection.** When the upstream response
   `Content-Type` is `text/html` (parameters tolerated), inject
   `<base href="/p/<run-id>/">` immediately after the opening `<head>`
   tag. Skipped when the document already declares a `<base>` element
   (idempotent — re-proxying the warren-served HTML is a no-op).
   Rewrites are bounded to the first 64 KiB of body; larger documents
   without a `<head>` in the first 64 KiB pass through untouched and
   accept the breakage (the apps that hit this are rare enough that
   subdomain mode is the right escape hatch).
2. **`Location:` header rewrite.** On any 3xx response, if `Location:`
   parses as a same-origin or scheme-relative path that starts with `/`
   and does **not** already start with `/p/<run-id>/`, rewrite to
   `/p/<run-id>/<rest>`. Absolute URLs to external origins pass through
   untouched. `Location:` values that already start with `/p/<run-id>/`
   are not double-prefixed.

JSON, JS, CSS, images, fonts, and all other non-HTML content types pass
through byte-for-byte. The rewriter is best-effort: an upstream that
streams chunked HTML without a parseable `<head>` in the first chunk
gets no `<base>`, but the proxy never errors the response over this.

**Cookie scope per mode.** The signed-cookie auth (`src/preview/cookie.ts`,
mx-c38965) parameterizes scope by mode:

- Subdomain mode (unchanged): `Domain=.<warren-host>; Path=/; HttpOnly;
  Secure; SameSite=Lax`.
- Path mode: `Path=/p/<run-id>/; HttpOnly; Secure; SameSite=Lax`. No
  `Domain` attribute. Two previews on the same warren host hold
  independent path-scoped cookies; a reviewer can be authenticated to
  multiple previews simultaneously in the same browser.

The HMAC and token shape are identical across modes. The login route
`GET /runs/:id/preview/login?token=…&redirect=…` stays the canonical
entry point; in path mode it sets the path-scoped cookie and redirects
to `/p/<run-id>/<redirect-or-slash>`. Unauthenticated requests on the
proxied path 401 (not 502) just as in subdomain mode.

**PR annotation URL shape.** `src/runs/pr-annotate.ts` (mx-ba79c4)
branches on mode when composing the `preview_url_or_placeholder`
fragment: `https://<warren-host>/p/<run-id>/` in path mode,
`https://run-<id>.<warren-host>/` in subdomain mode. The
`<!-- warren:preview-start --> / <!-- warren:preview-end -->` markers
are unchanged; the annotate step stays idempotent across mode flips
between reap and re-annotate (a project that flips modes mid-PR will
see a single replacement, not duplicate markers).

**Doctor checks per mode.** The existing `checkPreviewAuthStrength`
(mx-f2cf0b) warning — `WARREN_PREVIEW_HOST` set with placeholder
`WARREN_API_TOKEN` — still applies in both modes. The
`WARREN_PREVIEW_HOST`-required warning becomes **mode-gated**: in path
mode `WARREN_PREVIEW_HOST` is optional (warren derives the preview
origin from the request's own `Host`), so the warning fires only in
subdomain mode. Wildcard-DNS / DNS-01 cert advisories are
subdomain-only.

**Single-tenant-per-host caveat.** Path mode shares one cookie jar
(scoped by `/p/<run-id>/`) across all previews on the warren host. The
Path scope keeps sessions distinct per run, but an organization that
wants org-scale previews — many reviewers, many projects, dozens of
concurrent previews — should run subdomain mode. Path mode is sized
for solo-operator and small-team deploys, which is exactly the
audience that motivated this follow-up.

**Trade-offs accepted by path mode.**

- Apps that compute URLs from `window.location.host` and assume
  `host == app-origin` (rare in modern SPAs, common in older PHP-style
  apps) may misbehave under `/p/<run-id>/`. Operators with such apps
  use subdomain mode. The trade-off is documented; warren does not
  rewrite JS at runtime.
- Some dev servers (Vite, Next, CRA) honor `<base href>` for asset
  resolution but require an explicit `--base` flag for HMR websocket
  paths. Projects configure the framework-specific base via their
  existing `preview.command` in `.warren/preview.yaml` — warren ships
  `<base>` injection as best-effort and documents the known-good
  shapes; it does not synthesize per-framework wrappers.

**Acceptance coverage.** Scenario `20-preview.ts` (the existing
Linux-only happy-path + idle-TTL scenario) gains a path-mode sibling
(`20-preview-path.ts`, or a parametrized variant of the same scenario)
that boots warren with `WARREN_PREVIEW_MODE=path`, exercises the
`/p/<run-id>/` URL end-to-end (cookie issuance, `<base>` injection,
`Location:` rewrite on a redirect), and verifies that the
wildcard-host doctor warning does **not** fire when
`WARREN_PREVIEW_HOST` is unset. macOS still skips per mx-1d31f0.

### 11.M PR-body template (warren-bd49, 2026-05-14)

`buildPrContent` (`src/runs/pr.ts`) composes the PR body from a fixed
registry of **named fragments** (`PR_FRAGMENT_NAMES` in
`src/runs/pr-template.ts`):

```
title                         → drives the PR title (truncated to 72 chars)
summary                       → first commit subject or "agent ran for X; no commits."
run                           → warren UI link, agent, duration, cost
seeds                         → "id — title" when the prompt referenced a seed
preview_url_or_placeholder    → §11.L preview footer (start/end markers)
commits                       → "## Commits (N)" bullet list
files_changed                 → `git diff --stat` fenced block
prompt                        → collapsed `<details>` audit trail
trailer                       → footer / signature
```

The registry — not inline string concatenation — is what assembles the
body. Each fragment has a default renderer that no-ops when its data
isn't present (e.g. the `seeds` fragment renders nothing when no seed
was resolved). The `preview_url_or_placeholder` fragment is one entry
in the same list; the §11.L `pr_annotate_preview` step patches it
later using the same `<!-- warren:preview-start -->` /
`<!-- warren:preview-end -->` markers it always has.

**Project overrides.** A project ships `.warren/pr-template.md` with
H2 headings whose names match fragment names:

```markdown
## trailer

Reviewed-by: @platform-team

Please follow our [PR checklist](https://example.com/checklist) before merging.
```

Override semantics:

- Fragment-by-fragment: missing keys keep the default; explicit body
  replaces it wholesale.
- Whitespace-only body removes the fragment from output entirely.
- Names are normalized to snake_case so `## Files Changed`,
  `## files-changed`, and `## files_changed` all match `files_changed`.
- Variable interpolation is **not** supported in V1 — overrides are
  literal markdown. Projects that need per-run dynamic data keep the
  default fragment for that section.

**Doctor / readyz coverage.** Unknown fragment names and unbalanced
preview markers (one of `<!-- warren:preview-start -->` /
`<!-- warren:preview-end -->` without the other) surface as
`warren_config_schema_error` entries on `.warren/pr-template.md`. The
existing `checkWarrenConfig` probe aggregates them across projects —
no new diagnostic check needed.

**Wire-up.** `bridges.ts` resolves the project's parsed overrides via
the same `WarrenConfigCache` it uses for `previewConfig`, then threads
them into `reapRun({ prTemplate })` on succeeded-outcome reaps.
`buildPrContent` accepts `templateOverrides` and forwards into
`composeBody` / `composeTitle`. Failures from the loader fall through
to the built-in defaults — the PR still gets opened.

### 11.N PR-close webhook → preview teardown (warren-38f7, 2026-05-14)

Design lock for the V2 fifth eviction signal called out in §11.L.
Adopted into plan `pl-2c59` as a sibling follow-up; implementation is
deferred until warren ships a GitHub webhook receiver (the event-driven
half of the scheduler, §3.1 / ROADMAP R-06 follow-up, synergistic with
R-18 webhook-secret handling). This section exists so when that
infrastructure lands, the teardown hook is a single new event handler,
not a fresh round of design.

**Why now, when the code can't land.** R-19's design lock (§11.L)
settled on four eviction signals. The cleanest fifth — "the reviewer
merged or closed the PR, the preview is no longer needed" — wasn't
shippable in V1 because warren has no GitHub webhook surface. Filing
the design lock alongside R-19 (rather than waiting for webhook infra)
keeps the eviction story in one place and prevents the eventual handler
from sliding back into a fresh "should we extend `EvictionReason` or
reuse `teardownPreview`?" debate.

**Trigger source.** GitHub `pull_request` event with `action ∈
{closed}`. Both merge (`pull_request.merged === true`) and
close-without-merge (`merged === false`) fire `action: closed`; both
mean the preview is no longer load-bearing. No other PR action triggers
teardown — `opened`, `synchronize`, `reopened`, label changes are
explicitly out of scope (a reopened PR can keep its preview if the
original run's workspace is still live; if the run was reaped, a new
run is the right shape, not preview resurrection).

**Run lookup.** The webhook handler resolves the matching run via
`runs.pr_url = pull_request.html_url`. The column is already populated
by `pr_open` (see §11.L) and the PR URL is stable for the PR's
lifetime. No new index is required for V1 cardinality (a single warren
host serves on the order of thousands of runs; a SQL scan against
`preview_state IN ('starting','live')` first narrows the candidate
set). The lookup is "exactly one or zero rows" — a webhook for a PR
warren never opened (e.g. a hand-opened PR on the same repo) returns a
200 no-op.

**Reuse `teardownPreview`, do not extend `EvictionReason`.** The
webhook handler calls `teardownPreview({ runId, actor })` (§11.L,
`warren-d725`). Rationale:

- The CAS in `RunPreviewsRepo.claimTeardown` already serializes against
  the eviction worker and the manual route, so a webhook racing an
  idle-TTL sweep deterministically lands in exactly one of them.
- `preview_torn_down` already carries an `actor` field for attribution.
  A structured tag (`actor: "github-webhook:pr_merged"` or
  `"github-webhook:pr_closed_unmerged"`) distinguishes the trigger
  source without growing the `EvictionReason` enum or adding a new
  event kind.
- "All eviction paths funnel through one idempotent action" (seed
  framing) is satisfied: the existing teardown route is the funnel.
- The seed's original "emit `preview_evicted` with `reason='pr_closed'`"
  framing predated the warren-d725 split between `preview_torn_down`
  (operator/external trigger, carries `actor`) and `preview_evicted`
  (worker sweep, carries `EvictionReason`). The lock resolves it
  toward the `preview_torn_down` side because a PR close is an
  external trigger, not a periodic sweep.

**Handler shape.** A new module (`src/webhooks/github/pull-request.ts`
once the receiver lands — exact path is the webhook track's call) does:

    if (event.action !== "closed") return { handled: false };
    const run = await repos.runs.findOneByPrUrl(event.pull_request.html_url);
    if (!run) return { handled: false, reason: "no-matching-run" };
    if (run.previewState !== "starting" && run.previewState !== "live") {
      return { handled: true, status: "already-terminal" };
    }
    const actor = event.pull_request.merged
      ? "github-webhook:pr_merged"
      : "github-webhook:pr_closed_unmerged";
    return teardownPreview({ runId: run.id, repos, previews,
      burrowClientPool, broker, actor });

`RunsRepo.findOneByPrUrl` does not exist today; it's a one-method
addition when the handler lands. No migration, no new column.

**Idempotency & failure modes.**

- GitHub redelivers webhooks aggressively. Second delivery: CAS sees
  `preview_state='torn-down'` and returns the existing
  `already-torn-down` branch with `tornDown: false`. No second
  `preview_torn_down` event emitted.
- Webhook arrives before `pr_open`'s annotate completes (unlikely but
  possible if GitHub fires very fast): the run still has
  `preview_state='starting'`; the CAS still transitions it; the
  preview never reaches `live`. Acceptable — the reviewer closed the
  PR before the preview was usable anyway.
- Webhook arrives for a `preview_state='failed'` run: no-op (the CAS
  rejects the transition; handler returns `already-terminal`).
- Webhook arrives for a project that never opted in: `pr_url` is null
  (no PR was opened) or matches but `preview_state` is null — no-op.

**Out of scope for this lock.**

- Webhook signature verification (HMAC over the raw body using the
  configured webhook secret). Owned by the future receiver module
  (§3.1 / R-18-adjacent), not by this handler. Without verification
  the receiver doesn't run; with it, this handler trusts the parsed
  payload.
- GitHub App auth (R-18) for resolving the matching run when warren
  ever supports multi-repo-per-project. V1 single-PAT, single-repo
  posture means `pr_url` uniquely identifies the run.
- Label-triggered teardown ("preview-stale" label, etc.) and
  manual-dispatch teardown via comment commands. These are separate
  sibling features; if shipped, they reuse the same `teardownPreview`
  funnel with a different `actor` tag.
- Cross-host (R-12) routing. The proxy preamble already returns 501
  for non-local workers; the teardown path doesn't need cross-host
  awareness because `teardownPreview` operates on `runs` rows and
  `burrowClientPool`, both of which the local worker can address.

**When this turns on.** The webhook receiver is the gate. When it
lands (signature verification, route mounting, secret storage), this
handler is one ~20-line module + one repo method + one acceptance
scenario. The seed `warren-38f7` stays open as the implementation
tracker; closing the design-lock half is intentional so the
implementation work isn't blocked on re-deriving the design.

### 11.O Plot integration (pl-2047, 2026-05-17)

Phase 1 of `warren-000b` — adopting [Plot](https://github.com/jayminwest/plot)
as warren's coordination primitive. Plot is the fifth opt-in bundled
feature alongside canopy, mulch, seeds, and sapling: a project lights it
up by shipping a `.plot/` directory, and projects without one are
byte-identical to the pre-change behavior. Phase 1 is the dispatch wiring
only — the run knows which Plot it belongs to, the agent inside the
sandbox reads and appends to that Plot via the `plot` CLI, and
agent-emitted events mirror into warren's event stream tagged with
`plot_id`. No UI changes yet; Phase 2 (`warren-fcc9`, PlanRun
composition) and Phase 3 (UI shift to Plot-centric views) follow.

**Why now.** The blog post *Agentic Networks*
(jayminwest.com/blog/12-agentic-networks) argues for a network topology
where humans and agents are peer nodes coordinating on a shared Plot
substrate. Warren's V1 primary coordination unit is the run
(orchestrator → worker); Plot generalizes that into a multi-actor event
log per work item. Phase 1 wires the substrate without disturbing
existing flows.

**Gating (opt-in, mirrors mulch/seeds).** Plot integration is gated on
two flags being both present:

1. `project.hasPlot` — set by `src/projects/refresh.ts` when the cloned
   project contains a `.plot/` directory. Detected on the same probe
   pass as `.mulch/`, `.seeds/`, `.canopy/`, `.pi/`.
2. `run.plot_id` — optional nullable column on the runs row, accepted on
   `POST /runs`. Validated at the handler edge: passing `plot_id` against
   a project with `hasPlot=false` returns a typed 400 *before* any side
   effect (no row insert, no burrow up). Mirrors the no-half-spawned-state
   policy.

A project with `.plot/` but a run dispatched without `plot_id` runs
exactly as before — Plot integration is per-run opt-in even when the
project supports it.

**Data flow.**

```
POST /runs { plot_id }
   │
   ▼  validate project.hasPlot
spawnRun
   │
   ├─►  burrows.up(.., env={PLOT_ID, PLOT_ACTOR=agent:<name>:<run-id>})
   │    (sandbox-side `plot get` / `plot append` resolve the right Plot)
   │
   ├─►  emitRunDispatchedToPlot      (fire-and-log; failure ≠ spawn failure)
   │    └─►  appends `run_dispatched` to .plot/plot-<id>.events.jsonl
   │         actor=user:<handle>, payload={run_id, agent, model, project}
   │
   ▼
[ agent runs; `plot append` writes to workspace .plot/plot-*.events.jsonl ]
   │
   ▼  reap (src/runs/reap.ts)
mergePlotsFromBurrow
   │
   ├─►  merge workspace .plot/plot-*.json into project .plot/ (content-addr;
   │    conflict-on-content emits a `plot.conflict` warren event and
   │    leaves the project copy untouched)
   │
   ├─►  append-only union of .plot/plot-*.events.jsonl deltas (dedupe by
   │    event id; replay-safe and idempotent)
   │
   └─►  mirror agent-emitted decision_made / question_posed /
        artifact_produced into warren's event stream tagged with plot_id
        (other event types merge into .plot/ but are not mirrored)
```

JSONL-tail-at-reap is chosen over a live socket bridge for V1:
deterministic, no new plumbing, and the loss of live UI updates doesn't
matter until Phase 3.

**Env contract.** When a run is bound to a Plot, the sandbox env carries
two variables injected via `burrows.up`:

| Variable | Value | Producer |
|---|---|---|
| `PLOT_ID` | `<run.plot_id>` | `composePlotEnv` (`src/runs/spawn.ts`) |
| `PLOT_ACTOR` | `agent:<agent-name>:<run-id>` | `composePlotEnv` |

The `plot` CLI inside the sandbox (installed globally in the Dockerfile,
mirroring the `burrow-cli` double-pin rule) reads these on every
invocation. A run dispatched without `plot_id` gets neither variable —
the sandbox env is unchanged from the non-Plot path.

**ACL surface (write-side).** Plot's SPEC §6 partitions event types by
allowed actor. Four event types are `["user"]` only:

- `intent_edited`
- `status_changed`
- `attachment_removed`
- `question_answered`

Warren's `src/plot-client/` facade narrows the agent-actor surface at
the type level so warren code paths cannot construct these from an
agent. `AgentPlotHandle` exposes only `AgentAllowedEventType =
Exclude<PlotEventType, HumansOnlyEventType>` to `append()`, and the four
mutators that would emit humans-only events (`editIntent`, `setStatus`,
`detach`, plus the `question_answered` append path) live exclusively on
`UserPlotHandle`. The `HUMANS_ONLY_EVENT_TYPES` constant is pinned with
`as const satisfies readonly PlotEventType[]` so a Plot SPEC rename
fails compilation instead of silently drifting. Defense in depth: Plot
enforces the same ACL at the library level, but warren refuses to
construct disallowed events at all — same pattern as `src/burrow-client/`
narrowing the burrow HTTP surface.

The user-actor write surface from warren itself (currently only
`run_dispatched` emission) uses `user:<handle>` resolved from the
dispatching user. Cron-triggered and scheduled-seed dispatches inherit
the trigger owner's handle; webhook-triggered runs (V2) will follow
the same rule once the receiver lands.

**Dispatch event payload.**

```json
{
  "type": "run_dispatched",
  "actor": "user:<handle>",
  "data": {
    "run_id": "<run-id>",
    "agent": "<agent-name>",
    "model": "<frontmatter.model | null>",
    "project": "<project-id>"
  }
}
```

Emission is fire-and-log: a failure to append (missing `.plot/.index.db`
on first dispatch, disk full, malformed Plot) emits a
`plot_run_dispatched_failed` system event on the run and does **not**
roll the spawn back. The `.index.db` is gitignored and rebuildable —
when missing, warren best-effort runs `plot rebuild-index` and retries
once before logging the failure. The dispatch hot-path cost of a
rebuild is bounded by the project's Plot count; projects with many
Plots should refresh after `plot init` so the index is warm.

**Acceptance.** Scenario 25 (`scripts/acceptance/scenarios/25-plot-roundtrip.ts`)
covers the round-trip end-to-end against a real warren+burrow stack:

1. Init a project with `.plot/` containing one Plot.
2. Dispatch a run with `plot_id`. Assert `PLOT_ID` + `PLOT_ACTOR` reach
   the sandbox env via an in-sandbox `printenv` snapshot.
3. Agent runs `plot append` from inside the sandbox; assert the event
   lands in `.plot/plot-*.events.jsonl` after reap.
4. Assert `run_dispatched` is present in the Plot's event log.
5. Assert warren's event stream contains the mirrored agent events
   tagged with `plot_id`.
6. Snapshot-compare: dispatching against a project **without** `.plot/`
   produces an event-stream byte-identical to the pre-change baseline.

**Deferred to later phases.**

- **Phase 2 (`warren-fcc9`):** PlanRun composition — a multi-step run
  driven by a Plot's open questions and pending intents, where warren
  composes a sequence of agent runs against the same Plot.
- **Phase 3:** UI shift from run-centric to Plot-centric — Plot view as
  the primary surface, runs grouped under their Plot, live event
  streaming from sandbox `plot append` calls (replacing JSONL-tail-at-reap
  for the live-UI case).
- **System actor for non-user dispatch paths:** Plot's actor format
  documents `user:<handle>` and `agent:<name>[:<run-id>]` only. A
  dedicated `system:warren` actor for genuinely-unattributable dispatch
  (e.g. internal maintenance jobs) is not added in Phase 1 — current
  cron and scheduled-seed paths attribute to the trigger owner's handle.

**`.plot/` preservation across refresh (pl-d4d6, 2026-05-18).** Warren's
host-side Plot appenders (`defaultPlotAppender` in `src/runs/spawn.ts`,
`defaultPlanRunPlotAppender` in `src/plan-runs/plot-appender.ts`,
`autoTransitionPlotToDone` in `src/plan-runs/plot-transition.ts`) write
to `<project_clone>/.plot/<id>.events.jsonl` and
`<project_clone>/.plot/<id>.json` without `git add`/`git commit` — they
rely on the working tree itself being durable. But `refreshProjectClone`
(`src/projects/refresh.ts`) runs `git reset --hard origin/<ref>` on
every `spawnRun`, which discards uncommitted working-tree changes
including untracked files. Pre-fix, only the **last** child's
`run_dispatched` event survived on disk; `plan_run_dispatched` and
earlier per-child events vanished at the next child's refresh, and the
auto-`done` status snapshot reverted to `active` on subsequent
refreshes — observably broken once any second `spawnRun` ran against
the same clone (`warren-6f25`).

Fix shape: **preserve `.plot/` across the reset** rather than commit it
through reap (shape (a) commit-through-reap deferred as `warren-343a`).
The `preservePlot` wrapper (default `defaultPreservePlot`) hooks the
fetch→reset sequence: when the pre-reset working tree contains `.plot/`
(probed via the same dirent check as `detectProjectFeatures`),
`snapshotPlotDir` copies regular files recursively to an out-of-tree
`mkdtemp("warren-plot-snapshot-")` directory, the reset runs, then
`restorePlotDir` writes the snapshot back into the post-reset tree.
Snapshot wins on conflict — host-side appender writes are strictly
newer than anything committed in the project. The `.index.db*` SQLite
files are skipped (derived state, gitignored per plot's contract;
rebuilt on demand via the existing `plot rebuild-index` retry-once path
in `defaultPlotAppender`). Temp dirs are removed in a `finally`. A
project without `.plot/` short-circuits before any fs work — the
`hasPlot=false` path is byte-identical to the pre-fix `refreshProjectClone`.

Durability surface: preservation is **across resets of the same clone**,
not **across machines**. Origin still sees only what reap commits and
pushes; an operator inspecting `.plot/` on a different host or after
`deleteProject` + re-clone observes the in-repo committed state only.
Full origin-durability is shape (a), tracked under `warren-343a` —
it's a larger change (PR carries `.plot/` writes, agents need a
`.plot/` commit contract, trivial-merge children with no agent commits
need a separate carrier) and was deliberately deferred. Scenario 27
(`scripts/acceptance/scenarios/27-plan-run-plot-roundtrip.ts`) reads
`.plot/<id>.events.jsonl` directly at the end of the plan-run to
assert the preservation contract; it previously tailed the file every
100ms to capture transient writes (removed in `warren-aa63`).

**Commit through reap (warren-343a, 2026-05-18).** Plot state now
round-trips to origin alongside the agent's workspace edits. After
`mergePlot` writes the workspace's `.plot/` deltas into the project
clone, a new `plot_commit` sub-step in `src/runs/reap.ts`
(`stagePlotForCommit`) replicates `plot-*.events.jsonl` and
`plot-*.json` files back into the burrow workspace, runs
`git add -- .plot/`, and — when `git diff --cached --quiet -- .plot/`
exits non-zero — authors a `chore(warren): plot state` commit under a
fixed warren bot identity (`-c user.name=warren -c user.email=warren@os-eco.dev`).
The follow-on `branch_push` carries that commit upstream. Filtering on
copy: `.index.db*` files are skipped (derived state per the
snapshot/restore contract above), and only `plot-*.{json,events.jsonl}`
files are eligible — the SPEC §11.O `.plot/` layout is flat and the
filter keeps stray dotfiles out of the warren-authored commit. The
host-side `.plot/` snapshot+restore in `refreshProjectClone`
(`warren-fdd2`, shape (b)) stays as belt-and-suspenders preservation
for in-flight host-side writes between dispatch and the next reap.
Gating: the step is skipped when `project.hasPlot === false`, so
projects without `.plot/` are byte-identical to the pre-`warren-343a`
reap. Best-effort like the surrounding sub-steps: a failure emits a
`reap_failed` event with `step: "plot_commit"` and never fails the
run. The trivial-merge case (`reap.empty_push` per `warren-f3bb`) no
longer fires when the agent skipped `git commit` but warren wrote
`.plot/` entries — the warren-authored commit lifts `commitsAhead`
above zero. The reap result surface adds a `plotCommitted: boolean`
and a `reap.plot_committed` event.

*Concurrent children writing to the same Plot.* When two plan-run
children commit `.plot/` deltas for the same plot id, the
plan-run-gates-next-child-on-prev-PR-merged rule (§11.P) serialises
them — child A's PR must merge into the default branch before B's
spawn refresh sees A's `.plot/` lines, so A's and B's warren-commits
land in order. For ad-hoc parallel runs against the same project the
conflict shape is: B's branch was forked from origin before A's PR
merged, A's PR merges to origin, B's reap eventually pushes a branch
whose `.plot/<id>.events.jsonl` overlaps A's at the line level. GitHub
will refuse the merge on conflicting lines. The append-only union
primitive in `mergePlotEventsFile` is idempotent, so re-running reap
against B's workspace after refreshing from A's merged origin
produces a clean superset commit; operators retry the merge by
re-dispatching B (or re-pushing after a manual refresh).

#### 11.O.Plot.UI Plot-centric UI surface (pl-9d6a, 2026-05-18)

Phase 3 of `warren-d362` shifts warren's web UI from run-centric to
Plot-centric on deployments that opt into Plot, without disturbing the
standalone path. Plots become the primary surface — list page, detail
page with intent + substrate + unified activity feed, and a default
landing redirect — while every write path stays bound to the same
`UserPlotClient` ACL surface §11.O established for single-run dispatch.

Following the §11.O / mx-49a44c five-thing template:

1. **Gating contract.** Two-level gate, evaluated independently:
   - **Default-landing gate.** `someProject.hasPlot === true` AND
     `GET /plots` returns at least one Plot. Both conditions must hold
     before the index route's `DefaultLanding` component
     (`src/ui/src/components/DefaultLanding.tsx`) redirects to `/plots`;
     otherwise it redirects to `/runs` so the CLAUDE.md standalone path
     stays byte-identical. The sidebar reorder in
     `src/ui/src/components/Layout.tsx` mirrors the same gate: Plots →
     Runs → Plan Runs → Projects → Agents when the gate is true; the
     existing order is preserved when it is false.
   - **Per-endpoint gate.** Every `/plots*` write handler
     (`POST /plots`, `POST /plots/:id/intent`, `POST /plots/:id/status`,
     `POST/DELETE /plots/:id/attachments`,
     `POST /plots/:id/questions/:event_id/answer`) re-checks
     `project.hasPlot === true` against the project resolved by
     `PlotResolver` and rejects with a typed `ProjectLacksPlotError`
     (400) before any side effect — defensive against the rare case
     where `.plot/` is removed after a Plot's events.jsonl already
     exists on disk. `GET /plots` returns an empty array (not 404) when
     no `hasPlot` projects exist; the contract is pinned by the
     handler test in `warren-c167`.

2. **API contract.** All `/plots*` routes are registered in
   `src/server/router.ts` and live behind the same bearer-token
   middleware as the rest of warren's HTTP surface:

   | Route | Body | Returns |
   |---|---|---|
   | `GET /plots?status=` | — | `PlotSummary[]` (aggregated across `hasPlot` projects, sorted by `last_event_ts` desc) |
   | `POST /plots` | `{project_id, name?, intent?, dispatcher_handle?}` | new `PlotSummary` |
   | `GET /plots/:id` | — | full Plot envelope `{id, name, status, intent, attachments[], event_log[], project_id}` |
   | `POST /plots/:id/intent` | `{goal?, non_goals?, constraints?, success_criteria?, dispatcher_handle?}` | new `PlotSummary` + `intent_edited` event |
   | `POST /plots/:id/status` | `{next, dispatcher_handle?}` | new `PlotSummary` + `status_changed` event |
   | `POST /plots/:id/attachments` | `{kind, ref, role?, dispatcher_handle?}` | `attachment_added` event |
   | `DELETE /plots/:id/attachments/:ref` | — | `attachment_removed` event |
   | `POST /plots/:id/questions/:event_id/answer` | `{answer, dispatcher_handle?}` | new `question_answered` event |

   `dispatcher_handle` resolves through `resolveDispatcherHandle` with
   an `operator` fallback (the mx-6a9788 pattern shared with §11.O's
   single-run dispatch). Write paths are **not** fire-and-log here —
   the user is waiting on the response, so failures surface
   synchronously as typed 4xx errors. `GET` paths return the
   `PlotResolver`-backed 404 when the id is unknown.

3. **ACL surface.** Every write path opens a `UserPlotClient` against
   the owning project's `.plot/` directory, attributed as
   `user:<dispatcher_handle>`. The facade narrows the emittable event
   set to `HUMANS_ONLY_EVENT_TYPES` at the type level — `agent:*`
   attribution is unreachable from any of these handlers at compile
   time (mx-bd4d67). Status transitions are double-validated: the
   handler checks the SPEC §6.5 whitelist before the library call as
   defense in depth; intent edits reject when the current status is
   `done` or `archived` (intent is frozen at done). Answer handlers
   enforce the concurrency invariant — already-answered questions
   reject at the handler edge, since the Plot library does not by
   itself guarantee one-answer-per-question across racing writers.

4. **Data-flow diagram.** Two loops converge on the unified Activity
   Feed:

   ```
   ── UI write path (synchronous) ─────────────────────────────────────
   PlotDetail / Plots list (src/ui/src/pages/{PlotDetail,Plots}.tsx)
       │  plotsApi.{create,editIntent,setStatus,attach,detach,answer}
       ▼
   warren handler (src/server/handlers.ts)
       │  hasPlot gate → PlotResolver → resolveDispatcherHandle
       ▼
   UserPlotClient facade (src/plot-client/, HUMANS_ONLY_EVENT_TYPES)
       │  .editIntent / .setStatus / .attach / .answerQuestion
       ▼
   PlotStore → .plot/plot-<id>.events.jsonl  (single-writer fsync)
       ▲
   ── Reap loop (asynchronous, from §11.O) ────────────────────────────
   burrow reap → mergePlot → tail agent-emitted events into
       warren's event stream tagged with plot_id
       ▲
   Sandbox: agent runs `plot append` (agent:<name>:<run-id>)
   ```

   The ActivityFeed component (`src/ui/src/pages/PlotDetail.tsx`)
   polls `GET /plots/:id` every 5s with tanstack-query `staleTime: 5s`
   (mx-268674), so events from either loop converge in one feed within
   one polling interval. Human and agent events render with the same
   `EventLine` shape (mx-b97599 from RunDetail) — the actor slot is
   the only visual distinction. Chains of 3+ same-kind / same-actor
   events collapse into a single fold; open `question_posed` events
   render an inline answer-card that POSTs to the answer endpoint with
   optimistic insertion of the `question_answered` event.

5. **Deferred.**
   - **Live event channel.** Phase 3 polls at 5s rather than streaming
     `plot append` events live (pl-2047 risk #6). A future phase will
     push agent-emitted events into warren's event stream without the
     reap-time JSONL tail.
   - **Status-tag triggers.** Promoting a Plot to `ready` does not yet
     fire an agent dispatch; the operator still clicks `Run plan` on
     an attached `sd_plan` for the active execution path.
   - **Multi-Plot cross-references.** Linking one Plot from another's
     substrate panel is not modelled — attachments use only the
     fixed kind set (`seeds_issue`, `mulch_record`, `canopy_prompt`,
     `agent_run`, `gh_pr`, `sd_plan`).

**Acceptance.** Scenarios 28 + 29 cover the surface end-to-end against
a live warren+burrow stack:

- **Scenario 28** (`scripts/acceptance/scenarios/28-plot-list-and-create.ts`)
  pins the list+create roundtrip across a mix of `hasPlot` and
  non-`hasPlot` projects, including the byte-identical-empty snapshot
  on the non-`hasPlot` `/runs` surface.
- **Scenario 29** (`scripts/acceptance/scenarios/29-plot-detail-roundtrip.ts`)
  exercises the full detail page — intent edits, status-transition
  rejections per §6.5, attachment add/remove, the already-answered
  question rejection, and the `Run plan` → `POST /plan-runs` →
  Plot auto-`done` composition that reuses §11.P.Plot's wiring.

**Interactive runs configuration (warren-cd37 / pl-0344 step 2).** The
Plot-workbench loop (pl-0344) introduces a *paused* run state for batch
runs that emit `question_posed` and a respawn-per-turn lifecycle for
interactive runs (warren-1117 / warren-2976). Both need a wall-clock
budget for how long warren waits on the human before respawning the
agent with a timeout warning. That budget is per-project:

```yaml
# .warren/config.yaml
agent:
  pauseTimeoutMs: 1800000  # 30 minutes (default)
```

- Lives on `DefaultsConfigSchema.agent.pauseTimeoutMs`
  (`src/warren-config/schema.ts`), surfaced by `loadWarrenConfig()`
  alongside the existing defaults.
- Bounds: 1s..24h. Sub-second timeouts aren't meaningful given Plot
  event polling cadence; >24h is almost certainly a typo — operators
  can still cancel paused runs by hand.
- Default constant `DEFAULT_AGENT_PAUSE_TIMEOUT_MS` (1_800_000) is
  exported from the same module; consumers that need to handle the
  "no agent block at all" case fall back to it. The schema applies
  `.default()` so a parsed `agent` block always carries a number.
- Future agent-runtime knobs slot under `agent.*` rather than
  inflating the top-level shape — the nested block exists to give that
  growth a home.

**Brainstorm + Formalize (warren-d22e / pl-0344 step 8).** The
fresh-start UX for the Plot workbench loop is a single click that
creates a draft Plot and opens a brainstorm chat against it. Two
endpoints carry that flow:

- `POST /brainstorm` — atomically (a) creates a draft Plot via
  `defaultPlotCreator` (status defaults to `drafting`, empty intent,
  name defaults to `"Untitled brainstorm"`) and (b) dispatches the
  first interactive turn against the built-in `brainstorm` agent
  bound to that Plot. Body: `{ project_id, prompt, name?, agent?,
  dispatcher_handle?, providerOverride?, modelOverride?, ref? }`.
  Returns 201 with `{plot: PlotSummary, run: RunRow, burrow: {id,
  workspacePath}}`. The two underlying primitives (`POST /plots`
  + `POST /runs` mode=interactive) remain available; this endpoint
  exists so the UI doesn't need to issue them sequentially with
  partial-failure rollback.
- `POST /plots/:id/formalize` — deterministic-extraction endpoint
  that returns a **suggested** intent (`{goal, non_goals, constraints,
  success_criteria}`) parsed from `agent_message` events on the Plot's
  interactive runs. The Plot is NOT mutated and no Plot event is
  emitted: the user reviews + edits the suggestion and applies it via
  the existing `POST /plots/:id/intent` route, then transitions to
  `ready` via `POST /plots/:id/status`. The parser anchors a marker
  contract (`**goal**: ...`, `**non_goals**: -`, etc.) advertised in
  the brainstorm agent's system prompt; LLM-generated summaries are
  intentionally not part of the response shape (async dispatch +
  synchronous HTTP don't compose, and the user re-edits the
  suggestion anyway). Response: `{plot_id, suggested_intent,
  source_message_count}`. An all-empty suggestion + `0` count is
  the legitimate "no agent_message events yet" response so the UI
  can show "start chatting first" instead of an empty form.

Seams: `ServerDeps.plotFormalizer` (default
`createDefaultPlotFormalizer({repos})`) lets tests stub the extraction;
`RunsRepo.listByPlotId(plotId)` fans the underlying events query out
over the `runs_plot_id` index without an N+1. Brainstorm rides the
existing `defaultPlotCreator` + `spawnRun` seams — no new sandbox
shape, no new agent contract.

### 11.P PlanRun: serial plan execution (pl-a258, 2026-05-18)

PlanRun is a dispatch mode, not a fifth bundled feature. The substrate
is the existing single-run primitive — `spawnRun`, the events bus, the
runs/projects/agents repos — composed by a second tick loop that takes
a [seeds](https://github.com/jayminwest/seeds) plan and walks its
children sequentially, one warren run per child, gated on each child's
PR merging before the next dispatches. No new sandbox shape, no new
agent contract, no new burrow surface: PlanRun is warren orchestrating
itself.

A project lights it up by shipping a `.seeds/` directory. Projects
without one return a typed 400 from `POST /plan-runs` (the same
no-half-spawned-state policy as Plot's `hasPlot` gate, §11.O) and never
see the dispatch path.

**Data model.** Two tables, both dialect-polymorphic across SQLite and
Postgres (`src/db/schema/sqlite.ts`, `src/db/schema/postgres.ts`):

- `plan_runs` — one row per dispatch. Columns: `id` (PK), `plan_id`,
  `project_id` (FK), `agent_name`, `prompt_template` (defaults to
  `'work on sd {seed_id}'`), `ref`, `provider_override`,
  `model_override`, `dispatcher_handle`, `trigger`, `state`
  (`queued`|`running`|`succeeded`|`failed`|`cancelled`),
  `failure_reason`, `created_at`, `started_at`, `ended_at`. Indexes on
  `(project_id, state)` and `state` cover the coordinator's
  `listActive()` and the UI's per-project list.
- `plan_run_children` — one row per child step. Composite PK
  `(plan_run_id, seq)`; `seed_id`, `run_id` (FK SET NULL to `runs`),
  `state` (`pending`|`dispatched`|`running`|`pr_open`|`merged`|`failed`|`skipped`),
  timestamps, `pr_merged_at`, `failure_reason`. The parent row + N
  child rows land in a single transaction via the adapter's `tx`
  helper, so a constraint violation mid-tx leaves no orphan children.

The **sequencing contract** is strict: `seq` is monotonically increasing
from `1`; the coordinator advances by selecting the lowest-seq child
whose state ∈ {`dispatched`,`running`,`pr_open`} as the in-flight slot,
and only spawns the next child when that slot transitions to `merged`
or `skipped`. There is never more than one in-flight child per
PlanRun.

**Coordinator state machine.** `advancePlanRun` in
`src/plan-runs/coordinator.ts` is a pure function over a stub-injected
deps bag (repos, `showPlan`, `showSeed`, `checkPrMerged`, `spawn`,
`now`, `emit`). It returns a discriminated union of 7 shapes — the
load-bearing contract the tick wrapper, the unit tests, and the
event-emit seam all narrow against:

```ts
type AdvanceResult =
  | { kind: 'dispatched'; childRunId: string }
  | { kind: 'waiting_for_run' }
  | { kind: 'waiting_for_merge' }
  | { kind: 'advanced'; mergedChildSeq: number; dispatchedChildSeq?: number }
  | { kind: 'plan_failed'; failedSeq: number; reason: string }
  | { kind: 'plan_succeeded' }
  | { kind: 'noop'; reason: string }
```

Transitions, per advance call:

1. If `planRun.state === 'queued'` → transition to `running`, stamp
   `startedAt`, fall through.
2. If there is an in-flight child:
   - linked run non-terminal → `waiting_for_run`;
   - linked run terminal-succeeded and child.state ≠ `pr_open` →
     decide pr_open vs trivial-merge (see below);
   - child.state === `pr_open` → call `checkPrMerged(run.prUrl)`:
     `merged` flips child to `merged` and falls through to dispatch
     the next; `open` → `waiting_for_merge`; `closed_unmerged` or
     `http_error` 4xx → `plan_failed` with reason
     `pr_closed_without_merge`;
   - linked run terminal-failed/cancelled → `plan_failed` with
     reason `` `child_${reason ?? 'failed'}` ``.
3. If no in-flight child, call `pickNextPending`:
   - null → `plan_succeeded` (transition the parent row, stamp
     `endedAt`);
   - non-null → call `showSeed(child.seedId)`; `status === 'closed'`
     → flip child to `skipped` (resume semantics, below) and loop;
     `status === 'open'` → spawn via `dispatch.ts`, persist
     `child.runId` + `child.state='dispatched'` + `child.startedAt`,
     return `dispatched`. A `RunSpawnError` becomes `plan_failed`
     with reason `` `dispatch_failed:${err.message}` ``.

Every transition is mirrored as a system event on the most-recently-
dispatched child run via the existing emit seam — kinds: `plan_run.advanced`,
`plan_run.dispatched`, `plan_run.waiting_for_merge`, `plan_run.merged`,
`plan_run.failed`, `plan_run.succeeded`.

**Trivial-merge advance rule.** A child run that succeeded but produced
no commits is treated as merged without ever opening a PR. The signal
is the `reap.empty_push` system event (`commitsAhead === 0`) that
reap emits when the workspace branch is identical to its base. When
the coordinator sees `run.prUrl === null` AND the
`reap.empty_push` event is present on the child run, it advances the
child straight to `merged` (no GitHub poll, no `pr_open` intermediate
state). This is the docs-only / no-op-step case — without this rule a
plan whose middle step had nothing to push would deadlock waiting for
a PR that never opens.

**PR-merge polling contract.** `src/runs/pr.ts` `checkPullRequestMerged`
hits the GitHub REST API directly (`GET /repos/:owner/:repo/pulls/:number`,
`Accept: application/vnd.github+json`, `Authorization: Bearer
<GITHUB_TOKEN>`) and returns a discriminated union: `{kind:'merged',
mergedAt}` | `{kind:'open'}` | `{kind:'closed_unmerged'}` |
`{kind:'missing_token'}` | `{kind:'http_error', status, message}`.
`mergedAt` is GitHub's `merged_at` field — non-null `merged_at` is the
truth source; `state:'closed'` with `merged_at:null` is
`closed_unmerged`. The coordinator (via the `pr-merge.ts` retry
wrapper) treats `missing_token` as a no-op (logged, plan stalls until
the operator sets `GITHUB_TOKEN`) rather than failing the plan, since
the operator can recover by adding the token without losing progress.
GHE-hosted PRs whose URL does not match the regex in
`parsePullRequestUrl` return null — the coordinator treats them as
"cannot verify merge" and waits indefinitely on the operator to merge
manually rather than auto-failing.

**Resume semantics on re-dispatch.** A second `POST /plan-runs`
against the same `planId` after some children have been closed
out-of-band (`sd close` from a human, from another agent, from a
parallel plan-run) is a first-class flow. The new PlanRun row is
independent — it has its own `id`, its own children enumerated fresh
from `plan.children`. As the coordinator walks the new children, any
child whose `showSeed` returns `status:'closed'` flips to `skipped`
without dispatching a run; the coordinator loops to the next pending
child. This makes PlanRun safe to re-invoke as a "resume from the
next open child" operation without bookkeeping about which previous
plan-run owned which child.

**Server API.**

```
POST   /plan-runs                 dispatch (rejects without project.hasSeeds)
GET    /plan-runs                 list (filter by project / state)
GET    /plan-runs/:id             detail + fanned-out child runs[]
POST   /plan-runs/:id/cancel      sets state='cancelled', cancels in-flight run
GET    /plan-runs/:id/events      tails the union of every child run's events
```

The dispatch handler rejects in this order: (1) project not found →
404; (2) `!project.hasSeeds` → `ProjectLacksSeedsError` (typed 400,
recoveryHint references adding `.seeds/`); (3) plan status ∉
{`approved`,`active`,`done`} or empty children → `ValidationError` /
`PlanHasNoOpenChildrenError`; (4) every child already closed → also
`PlanHasNoOpenChildrenError` (the resume case where there's nothing
left to do). Side-effect-free until all gates pass.

**Env vars.**

| Variable | Default | Effect |
|---|---|---|
| `WARREN_PLAN_RUN_TICK_MS` | `10000` (10s) | Coordinator tick interval. Faster than the scheduler's 60s because in-flight plans are typically short-lived dispatch chains. |
| `WARREN_PLAN_RUN_DISABLED` | unset | When set (`1`/`true`), `bootPlanRunCoordinator` skips boot — same shape as `WARREN_SCHEDULER_DISABLED`. Useful for diagnostic warren instances that should serve the API but not advance plans. |

The coordinator uses the same single-flight wrapper shape as
`bootScheduler` (`src/server/scheduler.ts`) — overlapping ticks are
dropped, not stacked, and a per-PlanRun catch ensures one bad row
cannot tear down the loop.

**Acceptance.** Scenario 26
(`scripts/acceptance/scenarios/26-plan-run-roundtrip.ts`) covers the
round-trip end-to-end against a live warren+burrow stack: three-child
plan including one docs-only child that exercises the trivial-merge
branch; assertions on terminal state (`succeeded`, all children
`merged`); a second dispatch against the same plan id after closing
one child out-of-band, asserting the close advances to `skipped`
without a new run; stubbed `WARREN_GH_FETCH_OVERRIDE` for the PR-merge
poll so the harness stays deterministic.

**Plot composition.** A PlanRun dispatched against a project shipping
both `.seeds/` AND `.plot/` can carry an optional `plot_id` that
threads through every child run and reports lifecycle back to the
originating Plot. The wiring is purely additive — a PlanRun dispatched
without `plot_id`, or against a project without `.plot/`, is
byte-identical to the §11.P baseline. See §11.P.Plot below. The
between-child durability of those Plot writes depends on the `.plot/`
preservation contract documented at the bottom of §11.O — without it,
only the last child's `run_dispatched` would survive on disk.

### 11.P.Plot PlanRun + Plot composition (pl-7937, 2026-05-18)

Phase 2 of `warren-000b` — composing PlanRun (§11.P) onto Plot (§11.O).
Phase 1 wired Plot into single-run dispatch; this phase mirrors that
shape on the PlanRun surface so a plan-run launched from a Plot
threads `plot_id` through every child and reports parent + child
lifecycle back into the Plot's event log. Composition is purely
additive: a PlanRun dispatched without `plot_id` (or against a project
without `.plot/`) is byte-identical to the §11.P baseline, and the
single-run path is unchanged.

**Gating stack (.plot/ on .seeds/).** PlanRun's existing `.seeds/`
gate is the base; Plot is an optional layer on top. The handler edge
rejects in a fixed order — a project missing `.seeds/` returns
`ProjectLacksSeedsError` (typed 400) even when `plot_id` is supplied;
a project shipping `.seeds/` but not `.plot/` returns
`ProjectLacksPlotError` (typed 400, same envelope shape) when
`plot_id` is supplied; a project shipping both lights up the full
composition. `plot_id` never short-circuits the `.seeds/` requirement,
and PlanRun-with-Plot only appears when **both** directories are
present. Side-effect-free until every gate passes — no half-row state,
no Plot writes, no spawn.

**Data model addendum.** One nullable indexed column on the existing
`plan_runs` table, mirroring the shape of `runs.plot_id` from §11.O:

- `plan_runs.plot_id` — nullable text. Index `plan_runs_plot_id_idx`
  registered in `src/db/schema/columns.ts` so the drift test
  (`src/db/schema/drift.test.ts`) asserts sqlite + postgres parity.
  No new tables; the column lives alongside `dispatcher_handle` /
  `trigger` on the parent row. PlanRun children inherit the parent's
  `plot_id` at spawn time — there is no per-child column.

**Data flow.**

```
POST /plan-runs { plot_id }
   │
   ▼  validate project.hasSeeds → project.hasPlot (stacked gates)
   ▼  validate plan, enumerate children
   ▼  repos.planRuns.create  (one tx, parent + child rows)
   │
   ├─►  emitPlanRunDispatchedToPlot       (fire-and-log; failure ≠ POST failure)
   │    └─►  appends `plan_run_dispatched` to the bound Plot
   │         actor=user:<dispatcherHandle>, payload={plan_run_id, plan_id, children_count}
   │
   ▼
[ coordinator ticks ]
   │
   ▼  for each child: dispatch.ts forwards planRun.plotId into spawnRun
   ▼  composePlotEnv injects PLOT_ID + PLOT_ACTOR=agent:<name>:<run-id>
   ▼  defaultPlotAppender emits per-child `run_dispatched` on the Plot (§11.O)
   │
   ▼  child runs → PR opens → reap → checkPullRequestMerged
   ▼  trivial-merge children advance without ever opening a PR (§11.P)
   │
   ▼  every child terminal → coordinator → AdvanceResult { kind: 'plan_succeeded' }
   ▼  autoTransitionPlotToDone   (fire-and-log; failure ≠ PlanRun rollback)
   ▼  guard plot.status === 'active' → setStatus('done') as user:<dispatcherHandle>
```

Every transition in the data flow is **best-effort** at the Plot edge:
a Plot-write failure (missing `.index.db` on first dispatch, disk
full, malformed Plot, ACL drift) emits a system event and logs but
never rolls back persisted warren state. The PlanRun's authoritative
state machine (§11.P) is unaffected by Plot-side outcomes.

**`plan_run_dispatched` event.** A new Plot event type, added in
`@os-eco/plot-cli@0.3.0` via plot's `plot-3e3d`. Warren consumes it
via the existing `src/plot-client/` facade. Emission happens **once
per PlanRun**, immediately after `repos.planRuns.create` returns
(handler edge, not coordinator tick), via the
`defaultPlanRunPlotAppender` helper in `src/plan-runs/plot-appender.ts`
— same rebuild-index + retry-once shape as `defaultPlotAppender`
(`src/runs/spawn.ts`). Payload:

```json
{
  "type": "plan_run_dispatched",
  "actor": "user:<dispatcherHandle>",
  "data": {
    "plan_run_id": "<plan-run-id>",
    "plan_id": "<seeds-plan-id>",
    "children_count": <int>
  }
}
```

The parent event is one-shot; per-child `run_dispatched` events still
land via the unchanged Phase 1 path as the coordinator dispatches each
child. PlanRun composition is additive — `plan_run_dispatched` is the
parent lifecycle anchor, NOT a replacement for the per-child events
(rejected alternative #5 on `pl-7937`). A `plan_run.plot_append_failed`
warren log entry surfaces append failures; unlike the single-run
`plot_run_dispatched_failed` system event, there is no `events` row at
PlanRun creation because `events` is keyed by `run_id` and no child
run exists yet — logger-level surfacing mirrors the
`plan_run.cancel_child_failed` posture in `src/server/handlers.ts`.

**Auto-done transition contract.** When the coordinator reaches
`plan_succeeded` on a PlanRun with a non-null `plot_id`, the
post-transition hook fires `autoTransitionPlotToDone`
(`src/plan-runs/plot-transition.ts`):

1. Open a `UserPlotClient` against `<project>/.plot/` with actor
   `user:<dispatcherHandle>` — satisfies plot's `status_changed: ['user']`
   ACL (plot SPEC §6) without needing a synthetic `system:warren`
   actor (rejected alternative #2 on `pl-7937`).
2. Read the Plot's current status. **Guard:**
   `plot.status === 'active'`. Any other status — `drafting`, `ready`,
   `done`, `archived` — yields `kind: 'skipped'` and a
   `plan_run.plot_status_skipped` warren event with `{planRunId,
   plotId, currentStatus}` so warren never tramples an operator-driven
   transition mid-PlanRun (`pl-7937` risk #4).
3. Call `setStatus('done')`. A throw is caught and surfaced as
   `kind: 'failed'` with a `plan_run.plot_auto_done_failed` warren
   event; the PlanRun's `succeeded` state is unaffected (acceptance
   criterion #10 on `pl-7937`).
4. Success emits `plan_run.plot_auto_done` for observability.

The `dispatcherHandle` defaults to `operator` (per `pl-a258` /
`mx-77f5ac`). Operators who want auto-done attributions to reflect a
real human handle should pass a `dispatcherHandle` on dispatch — future
work, gated on warren growing an auth surface, will pre-populate this
from the logged-in user.

**Concurrency.** Concurrent PlanRuns bound to the same Plot interleave
per-child `run_dispatched` events in wall-clock-insert order; Plot's
append-only event log is event-id-keyed and idempotent on replay (per
`../plot/SPEC.md` §5) so events themselves are correct but ordering
reflects insertion, not logical grouping. V1 accepts this — operators
rarely dispatch two concurrent PlanRuns against the same Plot. The
auto-done guard (`plot.status === 'active'`) also handles the
double-completion case: the second PlanRun to finish observes
`status: 'done'` and emits `plan_run.plot_status_skipped`, no
clobber.

**UI.** `NewPlanRun.tsx` surfaces an optional free-form `plot_id`
input after the `planId` input, gated on the selected project having
both `hasPlot` and `hasSeeds`; `PlanRunDetail.tsx` renders the
`plot_id` as a placeholder `/plots/:id` link. Phase 3 (`warren-d362`)
owns the live Plot detail page, so the link is a dead href in V1 — a
deliberate sequencing decision per `pl-7937` step 7. Pre-population
from a Plot detail page → "Dispatch PlanRun" action is also Phase 3.

**Cross-repo dependency (plot-3e3d).** The `plan_run_dispatched` event
type is defined in plot's `PLOT_EVENT_TYPES` (closed enum) and ACL
(`status_changed`-style allow-user-actor entry). Warren cannot
construct events outside the enum at compile time — the
`src/plot-client/` facade narrows `append()` to
`AgentAllowedEventType`, and the user-actor write surface is typed
against `PlotEventType` from `@os-eco/plot-cli`. The dependency on
the new event type is therefore a hard pin: `@os-eco/plot-cli` is
double-pinned at `^0.3.0` (package.json + bun.lock) AND `0.3.0`
(Dockerfile global install) per the burrow-cli rule documented in
`CLAUDE.md` "Relationship to burrow". A future plot SPEC rename of
`plan_run_dispatched` fails warren's typecheck instead of silently
drifting.

**Disjoint flows preserved.**

- **Single-run path unchanged.** `POST /runs` does not see `plot_id`
  from PlanRun; child runs spawned by the coordinator inherit
  `planRun.plotId` via the spawn input, but the single-run handler
  itself is untouched. Existing `POST /runs` tests pass without
  modification (acceptance criterion #13 on `pl-7937`).
- **PlanRun-without-plot path unchanged.** A PlanRun dispatched
  without `plot_id`, or against a project where `hasPlot=false`,
  is byte-identical to the §11.P baseline — no Plot writes, no
  Plot-side env injection, no auto-done hook (acceptance criterion #4).

**Acceptance.** Scenario 27
(`scripts/acceptance/scenarios/27-plan-run-plot-roundtrip.ts`)
composes scenarios 25 + 26 against a real warren+burrow stack:

1. Init a project with both `.plot/` (one Plot, `status: 'active'`)
   and `.seeds/` (one plan with three children, one docs-only).
2. `POST /plan-runs` with `plot_id`. Assert one `plan_run_dispatched`
   event lands on the Plot at creation with the right payload shape.
3. Coordinator walks the children. For each child sandbox, assert
   `PLOT_ID=<plot id>` and `PLOT_ACTOR=agent:<name>:<run-id>` via an
   in-sandbox `printenv` snapshot.
4. Assert one `run_dispatched` event per child on the Plot (including
   the trivial-merge child where `commitsAhead === 0`).
5. After the final child merges, assert the Plot's status flipped to
   `'done'` AND a `status_changed` event landed in its event log with
   actor `user:<dispatcherHandle>`.
6. Re-dispatch the same plan id against a project without `.plot/`
   and snapshot-compare the resulting events — byte-identical to the
   pl-a258 §11.P baseline (zero Plot leakage).

**Deferred to Phase 3 (`warren-d362`).**

- Live Plot detail page; the `PlanRunDetail` `/plots/:id` link
  becomes active.
- Auto-populating `plot_id` on the NewPlanRun form when dispatch
  originates from a Plot detail page → "Dispatch PlanRun" button.
- Unified activity feed grouping runs + PlanRuns under their Plot,
  live-streaming events from sandbox `plot append` calls (replacing
  JSONL-tail-at-reap for live updates).

### 11.Q Plot → synthesized plan-run pipeline (pl-5310 step 4, 2026-05-18)

Design lock for `warren-a4b7` (pl-5310 step 4, parent epic
`warren-e40a`). Closes the deepest realization of the Plot UX vision:
 a Plot becomes a plan becomes seeds become runs, with the seeds plan
synthesized on the fly from the Plot's `seeds_issue` attachments so
the user never hand-rolls a plan file. The implementing seed assumes
this section as contract.

**Status: design-locked, not yet implemented.** Per the
`cross-repo-design-lock-seed` pattern (mx-bffcf1), phase 1 freezes
this section AND files the upstream seeds-cli dependency seed before
any code lands. The full pl-5310-step-4 sub-plan decomposes into
(a) seeds-cli ships existing-seed children support, (b) warren
double-pins the new seeds-cli version, (c) warren ships a synthesis
module, (d) `POST /plot-plan-runs` endpoint, (e) PlotDetail "Dispatch
as plan-run" button, (f) acceptance scenario.

**The gap.** §11.O ships Plot, §11.P ships PlanRun, §11.P.Plot ships
their composition — given an existing seeds plan id + a plot id, the
stack works end-to-end (one `plan_run_dispatched` event, per-child
`PLOT_ID` injection, auto-`done` on final merge). What is missing is
the synthesis step: today a user with a Plot bound to N `seeds_issue`
attachments must either (a) dispatch the N runs one-by-one via the
per-seed Run button (warren-ff2a, pl-5310 step 1) or (b) fire the
batch parallel/serial dispatcher (warren-7c3f, pl-5310 step 3) which
bypasses plan-run's PR-merge serial gating. Neither path produces a
tracked PlanRun row, neither inherits `pl-7937`'s auto-done hook, and
neither reuses the existing `/plan-runs/:id` detail page as the
launch-and-watch surface. The cleanest shape is to synthesize a
seeds plan whose children ARE the attached seeds, then dispatch it
through the existing §11.P coordinator unmodified.

**Upstream seeds-cli dependency.** Today's `sd plan submit` spawns
NEW child seeds; it has no notion of adopting existing seeds as
children of a new plan. That capability is the hard prerequisite for
this section and is tracked in warren's `.seeds/` as the cross-repo
coordination seed (per mx-bffcf1: "files the dependency seed in the
consumer repo's .seeds/"). The seeds-cli contract this section
assumes:

- `sd plan submit <seed-id> --plan <file>` accepts a new optional
  `existing_seeds: ["warren-X", "warren-Y", ...]` field in the plan
  JSON's `steps` array (or a sibling top-level field — exact shape
  is seeds-cli's call). Either form: children become references to
  the named seeds, not new spawns.
- Validation, seeds-side: every named seed must exist in the same
  `.seeds/issues.jsonl`; cross-repo seed ids are rejected; closed
  seeds are rejected at plan-submit time (plan-run already skips
  closed children at advance time, but plan creation should be
  intentional, not a silent skip).
- The resulting plan row in `plans.jsonl` is byte-compatible with
  today's plans for plan-run's `showPlan(planId)` reader — same
  `children: [seedId, ...]` projection — so warren's `src/plan-runs/`
  coordinator needs zero changes.

The upstream seed is filed locally as the design lock's pinned
blocker; once seeds-cli ships, warren double-pins per the
burrow-cli rule (CLAUDE.md "Relationship to burrow": package.json +
bun.lock + Dockerfile global install, lockstep).

**Endpoint.** `POST /plot-plan-runs` — synthesize-and-dispatch is one
call, atomic from the caller's perspective. Request body:

```ts
{
  plot_id: string;          // PLOT_ID_REGEX-validated per warren-bae5
  project_id: string;
  agent_name: string;
  prompt_template?: string; // defaults to 'work on sd {seed_id}'
  ref?: string;
  provider_override?: string;
  model_override?: string;
  dispatcher_handle?: string;
}
```

No `plan_id` — the endpoint synthesizes one. The handler:

1. Validates the Plot exists and `project.hasPlot` (typed 4xx on
   miss, mirrors §11.O's `ProjectLacksPlotError`).
2. Validates the project has `.seeds/` (typed 4xx, mirrors §11.P's
   gate).
3. Reads the Plot's `seeds_issue` attachments, filtering out
   `isSdPlanAttachment` shapes (sd_plan-typed attachments already
   dispatch via the §11.P.Plot path — see PlotDetail's existing
   Run-plan button, warren-5d94 / step 14) and closed seeds.
4. If zero candidates remain: typed 4xx `NoDispatchableSeedsError`
   with `recoveryHint: "attach open seeds_issue items to this Plot
   first, or close and re-create the Plot if all attached seeds are
   already merged"`.
5. Synthesizes a seeds plan rooted at a fresh throwaway parent seed
   (`type: task`, title `"Plot <plot-id> synthesized plan-run"`,
   description back-refs the Plot) via the new `sd plan submit
   --existing-seeds` API. Children are the candidate seed ids in
   their attachment order.
6. Calls the existing `POST /plan-runs` handler in-process with
   `plot_id` set — reusing every §11.P.Plot wiring for free
   (`plan_run_dispatched` event, per-child `PLOT_ID` injection,
   auto-`done` on final merge). Returns `201` with the same shape
   `POST /plan-runs` returns; the caller navigates to
   `/plan-runs/:id` from the response.

**Disjoint flows preserved.** This endpoint is additive. `POST
/plan-runs` remains the canonical entry for explicit-plan dispatch
(including the existing PlotDetail Run-plan button for `sd_plan`
attachments, warren-5d94). `POST /runs` is untouched. The synthesis
step runs server-side; the existing seeds-cli call is a `Bun.spawn`
through the same `sd` binary the host already shells out to (per
§11.B-era convention; no new sandbox shape).

**Idempotency / replay.** Synthesis is not idempotent — a second
click mints a second throwaway parent seed and a second plan id, and
therefore a second PlanRun. This is intentional symmetry with the
batch dispatcher (warren-7c3f): the user clicks, gets a confirm
dialog, and is responsible for the dispatch. The confirm dialog
displays the candidate seed list (with closed/sd_plan filter
rationale) and the synthesized plan title before submission. If the
user wants to resume a stalled PlanRun against the same children,
that is the existing `POST /plan-runs` re-dispatch path on the
synthesized plan id (mx-382fab).

**UI surface.** PlotDetail (`src/ui/src/pages/PlotDetail.tsx`) gains
a "Dispatch as plan-run" button in the same Summary slot as the
batch dispatcher (warren-7c3f), gated on the same
`isBatchDispatchTarget` filter producing ≥1 candidate. The button
opens a confirm dialog (shared shape with `BatchDispatchDialog`)
showing the synthesized plan title + the candidate seed list, fires
`POST /plot-plan-runs`, and routes to `/plan-runs/:id` on success.
The batch dispatcher (step 3) remains as the parallel-fan-out
escape hatch; the plan-run button is the recommended path once this
section ships (CHANGELOG to call this out, and the batch button's
inline help text updated to point at the plan-run alternative).

**Acceptance.** Scenario 31
(`scripts/acceptance/scenarios/31-plot-plan-run-synthesis.ts` —
slot 30 was claimed by `30-pi-multi-provider-env.ts` / warren-fe96
before this section landed)
composes scenarios 25 + 27 + 29 against a real warren+burrow stack:

1. Init a project with both `.plot/` (one Plot, ≥3 `seeds_issue`
   attachments, one closed seed mixed in, one `sd_plan`-shaped
   attachment mixed in) and `.seeds/`.
2. `POST /plot-plan-runs` with the Plot id. Assert: response is a
   201 with a PlanRun row; the synthesized plan row exists in
   `.seeds/plans.jsonl`; children are the open non-`sd_plan`
   attachments only.
3. Walk children to completion. Assert one `run_dispatched` event
   per child on the Plot (including trivial-merge), one
   `plan_run_dispatched` event at start, `PLOT_ID` / `PLOT_ACTOR`
   reach each child sandbox.
4. After the final child merges, assert the Plot's status flipped
   to `'done'` (auto-transition inherited from §11.P.Plot).
5. Negative paths: project without `.plot/` → typed 4xx; project
   without `.seeds/` → typed 4xx; Plot with zero dispatchable
   attachments → `NoDispatchableSeedsError`; malformed `plot_id` →
   typed 4xx (mirrors warren-bae5).
6. Re-dispatch the same Plot a second time → second PlanRun spawns
   against a second synthesized plan, both visible on the Plot's
   activity feed (no clobber, no idempotency).

**Deferred.**

- A "Replay this PlanRun against the same Plot" shortcut on
  `PlanRunDetail` that reuses the existing synthesized plan id
  instead of minting a new one (the existing `POST /plan-runs`
  re-dispatch already covers the mechanism; the UI shortcut is a
  follow-up).
- Surfacing the synthesized plan in PlotDetail's attachments list
  retroactively (would require a Plot append at synthesis time;
  out of scope for this section, file a follow-up if dogfood
  surfaces the need).
- Cross-repo seed adoption (children referencing seeds in a
  different `.seeds/issues.jsonl` than the parent plan) — the
  seeds-cli contract above explicitly rejects this; revisit when
  the org-readiness work (§11.J) lights up multi-project Plots.

---

## 12. Relationship to other os-eco tools

| Tool | Warren's relationship |
|---|---|
| **burrow** | Hard dependency. HTTP API consumer via the typed `HttpClient` from `@os-eco/burrow` (burrow's §15.6). Warren cannot run without burrow. Burrow's HTTP API is shipped as of `7926a0e` (2026-05-08); all routes warren needs (`POST /burrows`, `POST /burrows/:id/runs`, `GET /runs/:id/stream`, `POST /burrows/:id/inbox`, `POST /runs/:id/cancel`, `DELETE /burrows/:id`, `GET /watch`) are live. |
| **canopy** | Hard dependency. Source of agent definitions. Cloned at startup, refreshed on demand. |
| **mulch** | Used per-project. Warren reads the project's `.mulch/expertise/` on the host to source `expertise_seed` lines and merges per-run mulch records back during reap (host-side disk write, last-write-wins-by-ts). The per-run `.mulch/` inside the burrow workspace is seeded via the `seed.files` payload on `POST /burrows` (R-07; see §11.A) — warren never shells out to `ml record` inside the sandbox. |
| **seeds** | Used per-project. Warren reads `sd ready` to surface the project's worklist in the UI; agents file/close seeds during runs. |
| **plot** | Used per-project. Gated on the project shipping a `.plot/` directory and the dispatch request carrying a `plot_id`. Warren imports `@os-eco/plot-cli` as a typed facade (`src/plot-client/`), injects `PLOT_ID` + `PLOT_ACTOR` env into the sandbox at spawn, appends `run_dispatched` to the originating Plot, and mirrors agent-emitted events back into warren's event stream at reap (§11.O). Plan-runs compose onto Plot when both `.seeds/` and `.plot/` are present and `plot_id` is on the dispatch: one `plan_run_dispatched` lands at PlanRun start, every child inherits the parent's `plot_id` for free, and the Plot auto-transitions to `done` when the final child merges (§11.P.Plot). A Plot's `seeds_issue` attachments can be synthesized into a fresh plan and dispatched in one `POST /plot-plan-runs` call (§11.Q, pl-5310 step 4) — design-locked, gated on an upstream seeds-cli capability tracked locally. |
| **sapling** | One of three built-in harnesses (alongside `claude-code` and `pi`). Shipped as a pre-installed CLI in the container; selected per agent via `burrow_config`. |
| **pi** (`@earendil-works/pi-coding-agent`) | Third built-in harness, multi-provider with first-class per-run cost reporting. Shipped as a pre-installed CLI in the container; runtime contract lives in burrow's `AgentRegistry` (see §11.K). |
| **overstory** | Sibling, not subordinate. Multi-agent orchestration is overstory's domain; warren is single-agent-per-run. Overstory could be invoked as a "harness" in a future agent definition. |
| **mycelium / grove** | Out of scope for this document. |

---

## 13. References

- Burrow HTTP API: shipped via `pl-5b40` / `burrow-1d64`. Canonical contract at `GET /openapi.json` on a running `burrow serve`; spec pointer in burrow's SPEC.md §27. `POST /burrows` provisioning landed in `burrow@7926a0e` (2026-05-08).
- Burrow library API (`@os-eco/burrow` `HttpClient`): burrow's SPEC.md §15.6.
- Burrow dashboard snapshot envelope (`GET /watch`): burrow's SPEC.md §26 — possible future basis for warren's dashboard view.
- Bwrap-in-container recipe: `mx-94901b`, `mx-c085ba` (burrow repo `.mulch/expertise/sandbox.jsonl`).
- Canopy inheritance + mixins: see canopy `cn tree` / `cn render` (canopy repo).
- Seeds plan workflow: `sd plan templates` (any os-eco repo with seeds).
- Mulch record types and lifecycle: see mulch `ml --help` (mulch repo).
- Os-eco ecosystem overview: `/Users/jayminwest/Projects/os-eco/CLAUDE.md`.
