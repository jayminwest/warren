<p align="center">
  <img src="branding/logo.png" alt="warren — self-hostable cloud control plane" width="640">
</p>

# Warren

Spawn cloud agents at your GitHub repos. Watch them work live, steer them mid-run, get a branch back.

[![CI](https://github.com/jayminwest/warren/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/warren/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[**Watch the demo**](https://youtu.be/daa7y8g9BkM)

> A network of interconnected burrows. Agents that operate in isolation, self-manage, self-repair, and self-improve.

Warren is a self-hostable control plane for ephemeral coding agents. Runs are short-lived and sandboxed: they complete a task, validate the changes, push a branch, and spin down. Point it at your repos, dispatch from a browser or CLI, watch the events stream live, and reap the result. **One container, one volume, one HTTP API, one UI.**

Warren runs against a swappable **runtime provider**, selected once at boot by `WARREN_RUNTIME` (`src/runtime/registry.ts`), behind one contract (`src/runtime/contract.ts`). Two topologies, same domain code:

- **`local` (default) — self-host.** The whole system is one container: warren plus a co-tenanted [burrow](https://github.com/jayminwest/burrow) sandbox daemon that isolates each run with `bwrap`. This is the primary path everything below describes.
- **`k8s` — scale-out.** Each run is its own Kubernetes pod (the pod boundary is the sandbox); there is no burrow. Built for clusters / GKE Autopilot. See [**the K8s runbook**](docs/RUNBOOK-K8S.md) and [`deploy/k8s/`](deploy/k8s/README.md).

Burrow is the LocalProvider's substrate, not a required dependency of warren — under `WARREN_RUNTIME=k8s` there is no burrow at all.

A fresh install needs nothing but a GitHub URL and a prompt. The built-in `claude-code` agent ships inline; pick it, paste your repo, write what you want done. Power features (versioned prompt libraries, persistent agent memory, an integrated issue queue, a steerable alternative harness, a shared coordination substrate) light up when you opt into them.

## Who this is for

Engineering teams self-hosting their own agent infrastructure. The deployment unit is one team or one org running one warren on their own box or their own cluster. Run it for yourself on a home server today; the [org-readiness roadmap](ROADMAP.md) extends the same architecture to a 50+ engineer organization without forcing a fork.

## Status

Stable (`0.9.10`), running on GKE in continuous use against real GitHub repos, with the Kubernetes runtime (`WARREN_RUNTIME=k8s`, pod-per-run) as the supported hosted target on GKE Autopilot. The end-to-end path is covered by 38 scenario-based acceptance tests in [`scripts/acceptance/`](scripts/acceptance/): manual runs, cron triggers, K8s pod dispatch (OOM fast-fail, steer delivery), Postgres backend, per-run preview environments, restart recovery, cost tracking, cost analytics, seeds-extensions roundtrip, serial plan-run dispatch, plan-run + Plot composition, Plot-workbench loop. The active frontier is the org-readiness cluster: SSO, remote workers, MCP, audit, budgets, GitHub App auth. See [ROADMAP.md](ROADMAP.md).

## What you get

- **One image, one volume.** The supervisor (`src/supervisor/main.ts`) is the container ENTRYPOINT. It spawns the sandbox runtime first, waits for the unix socket, then spawns warren. SIGTERM/SIGINT forward to both children; the runtime restarts under a 5-in-60s budget on unexpected exit.
- **Native sandboxing per run.** In the default `local` topology every run gets a fresh `bwrap`-isolated workspace under `/data/burrow/`; the host is unreachable and warren talks to the runtime over a unix socket with a shared bearer token. Under `WARREN_RUNTIME=k8s` the sandbox is the pod boundary instead (kubelet-enforced CPU/memory, no bwrap) — see [the K8s runbook](docs/RUNBOOK-K8S.md).
- **Built-in agents.** `claude-code`, `sapling`, and `pi` ship inline (`src/registry/builtins/`), so dispatching a run needs no extra setup.
- **Live event stream.** NDJSON events are persisted to warren's SQLite log and tailed over `GET /runs/:id/events?follow=1`. The UI, CLI (`warren run`), and HTTP clients all consume the same stream.
- **Steerable mid-run.** `POST /runs/:id/steer` lands a message in the agent's inbox; the next turn picks it up. `POST /runs/:id/cancel` aborts cleanly.
- **Scheduled runs.** `.warren/triggers.yaml` defines cron triggers per project; the in-process scheduler dispatches them on the same composition path as manual runs.
- **Serial plan-run dispatch.** Projects shipping `.seeds/` can `POST /plan-runs` against a seeds plan; warren walks the plan's children one at a time, spawning one run per child and gating each on the previous PR merging before the next dispatches. Re-dispatching the same plan after some children have closed resumes from the next open child.
- **Workspace UI on opt-in deployments.** When any project ships `.plot/` and at least one Plot exists, warren's default landing flips to `/workspace` and the sidebar collapses Plots into a single **Workspace** entry; the standalone path (no `.plot/` projects) stays byte-identical with `/runs` as the index. The Workspace list shows one row per Plot (the durable spine), and the `/workspace/:id` detail page walks the whole flow across tabs — **Plan** (planner run + sign-off gate that arms dispatch), **Run** (serial plan-run execution with per-child PR-merge status), and **Activity** (unified Plot event log + substrate). Human and agent events share one timeline with inline answer-cards on open questions. See [SPEC §11.O.Plot.UI](SPEC.md#11oplotui-plot-centric-ui-surface-pl-9d6a-2026-05-18).
- **Three thin clients of one pipeline.** Web UI, `warren` admin CLI, and HTTP API all flow through the same composition path ([SPEC §4.3](SPEC.md#43-the-composition-flow)).

## Quickstart (home server)

```bash
git clone https://github.com/jayminwest/warren && cd warren
cp .env.example .env && $EDITOR .env
docker compose up -d
open http://localhost:8080
```

Paste your `WARREN_API_TOKEN`, click **Projects → Add**, give it a GitHub URL. Then **Dispatch run**, pick `claude-code`, write a prompt, hit go. The events panel streams; when the run completes warren pushes a branch you can open a PR from.

Required environment variables (see [`.env.example`](.env.example) for the full list):

| Variable | Purpose |
|---|---|
| `WARREN_API_TOKEN` | Bearer token on every route except `/healthz`. `openssl rand -hex 32`. |
| `BURROW_API_TOKEN` | Token the sandbox runtime requires to bind. `openssl rand -hex 32`. |
| `WARREN_BURROW_TOKEN` | Token warren's runtime client sends. **Must equal `BURROW_API_TOKEN`**; they are the two ends of one channel. |
| `ANTHROPIC_API_KEY` | Forwarded to agent runtimes that need it. |
| `GITHUB_TOKEN` | Forwarded for project clones + branch pushes. |

The compose file applies the four bwrap-required security flags (`apparmor=unconfined`, `seccomp=unconfined`, `systempaths=unconfined`, `cap_add: SYS_ADMIN`). These relax the outer container so the runtime's nested userns sandboxes can come up. Removing any one of them breaks sandbox provisioning.

> **Image requirement (self-host / `local` runtime): burrow-cli ≥ 0.3.12.** In the default topology warren is co-tenanted with [burrow](https://github.com/jayminwest/burrow) inside the container and talks to it over a shared unix socket. The published image pins `@os-eco/burrow-cli@0.3.12` (see [`Dockerfile`](Dockerfile)); if you build your own image or override the runtime, install burrow-cli **0.3.12 or newer** — earlier releases predate the runtime contract warren depends on (agent spawn shape, resume support, event kinds) and will fail at dispatch. Under `WARREN_RUNTIME=k8s` this does not apply — the run pods carry their own toolchain image and no burrow is installed.

## Deploy

Two supported paths:

- **Single box (`local` runtime).** The [Quickstart](#quickstart-home-server) above *is* a complete deploy — one container, one volume, warren + burrow co-tenanted. Run it on a home server or any Docker host. Warren does not terminate TLS; front the container with Caddy (home server) or your ingress if you need HTTPS.
- **Cluster (`k8s` runtime), the hosted target.** Deploy to Kubernetes — **GKE Autopilot is the reference cluster**. Each run is its own pod, there is no burrow, and admission caps shed load before the cluster thrashes. The canonical procedure is **[docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md)**; the manifest quick-start is [`deploy/k8s/README.md`](deploy/k8s/README.md); see [Deploy to Kubernetes (scale-out)](#deploy-to-kubernetes-scale-out) below.

Continuous deployment ships in [`.github/workflows/deploy-gke.yml`](.github/workflows/deploy-gke.yml): a published GitHub release (cut by [`release.yml`](.github/workflows/release.yml)) builds the three SHA-pinned images and rolls the GKE Autopilot deployment forward. Auth is GCP Workload Identity Federation — no long-lived keys; the OIDC provider, service account, and cluster coordinates are repo secrets/variables (see [docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md) §1.6).

### Observability on a live deploy

Warren ships enough operator-visible surface to be inspectable without bolting on extra infrastructure. The pieces:

- **Health & readiness probes.** `GET /healthz` is a cheap liveness check (returns `{ok: true}`, auth-exempt — point an uptime monitor or the cluster's liveness probe at it). `GET /readyz` runs deeper diagnostics (DB reachable, bwrap usable under `local`, canopy clone fresh when `CANOPY_REPO_URL` is set) and returns a `DiagnosticCheck[]` payload — use it for deploy gating and the cluster's readiness probe, not for hot-path liveness. `GET /version` returns `{version}` straight from `src/index.ts` so you can confirm a rollout actually swapped the image.
- **Structured JSON logs.** The server emits one [pino](https://getpino.io) JSON line per event on stdout (name `warren`, level controlled by `WARREN_LOG_LEVEL`, default `info`). Stream them with `docker compose logs -f warren` on a single box or `kubectl -n warren logs deploy/warren` on a cluster. Pipe through `| jq` for ad-hoc filtering; ship to an external store with a [pino transport](https://getpino.io/#/docs/transports) if you need retention beyond your log driver's window.
- **Correlation IDs.** Every HTTP response carries an `X-Request-ID` header (`src/server/request-id.ts`, warren-30af). Warren honours a well-formed inbound `X-Request-ID` and otherwise mints one; the same id is bound into the per-request pino child logger, so grepping the logs with `jq 'select(.req_id == "…")'` reconstructs the full server-side trace for one client call. Forward the header from any reverse proxy in front of warren to keep the chain unbroken.
- **Per-run cost & token usage.** `runs.cost_usd` and `runs.tokens_*` columns are populated for the `pi` and `claude-code` built-ins (SPEC §11.K); the UI run-detail page surfaces them and `GET /analytics/cost?from=&to=&projectId=` aggregates across runs (`src/db/repos/runs.ts:listForAnalytics`). This is reporting, not enforcement — budget caps are deferred to R-17.
- **Pre-flight checks.** Run `warren doctor` (`src/cli/commands/doctor.ts`) against a deployed instance to surface common misconfigurations — empty/placeholder bearer tokens, unbalanced preview markers, missing `WARREN_PREVIEW_HOST` when previews are wired, etc. Cheaper than reading the logs after a failed run.

There is no built-in Prometheus / OpenTelemetry exporter for the `local` runtime in V1. If you need one there, the request-id + pino combination is the seam to extend; the route table (`ROUTE_TABLE` in `src/server/handlers.ts`, documented in [`docs/http-api.md`](docs/http-api.md)) is the stable surface to instrument against. The `k8s` runtime *does* ship pod-lifecycle Prometheus metrics on `/metrics` — see the runbook.

## Deploy to Kubernetes (scale-out)

The `local` topology above is one box: warren + burrow in one container, and one host is the concurrency ceiling. The `k8s` topology lifts that ceiling by running **each agent run as its own pod** — kubelet enforces per-run CPU/memory natively, a runaway run kills its own pod (not the control plane), and admission caps shed load before the cluster thrashes. There is no burrow: the pod boundary is the sandbox.

```bash
# Build + push the three images (control plane, agent, workspace-init)
deploy/docker/build-images.sh

# Apply the manifests (kustomize; pick an overlay)
kubectl apply -k deploy/k8s/overlays/gke     # GKE Autopilot (the hosted target)
kubectl apply -k deploy/k8s/overlays/kind    # local kind / k3d dev
```

Turn it on with `WARREN_RUNTIME=k8s` on the control-plane Deployment. The full operator story — deploy, secrets + rotation, RBAC, garbage collection, admission knobs, observability, and incident playbooks — is in **[docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md)**; the manifest quick-start lives in **[deploy/k8s/README.md](deploy/k8s/README.md)**. Some LocalProvider features degrade under `k8s` (previews are off, steering is ~5s poll rather than real-time) — the runbook's capability section spells out the gaps.

## Power features (opt-in)

Warren bundles a small set of [os-eco](https://github.com/jayminwest/os-eco) tools as built-in features. They're not required for a basic run. Each lights up when you use it and stays silent when you don't.

### Custom agents: bring your own prompt library

The built-in `claude-code`, `sapling`, and `pi` agents cover the common case. To define custom agents as versioned prompts (with inheritance, mixins, and per-agent sandbox config), point warren at a [canopy](https://github.com/jayminwest/canopy) repo by setting `CANOPY_REPO_URL` in the environment (`.env`, compose, or a cluster secret):

```bash
CANOPY_REPO_URL=https://github.com/<you>/agents.git
```

Library agents override built-ins by name. See [SPEC §4.2](SPEC.md#42-the-bundle-expressed-in-canopy) for the agent-as-prompt schema.

### Agent memory: persistent expertise across runs

If a project has a `.mulch/` directory, every run gets that expertise primed into context on spawn. As the agent learns conventions, patterns, and failure modes, it records them with `ml record`; reap merges the new records back to the project's persistent `.mulch/` with last-write-wins by timestamp. Memory accumulates across runs without a database, just files in the repo. See [mulch](https://github.com/jayminwest/mulch).

### Issue queue: agents work from and write to seeds

If a project has a `.seeds/` directory, agents can `sd ready` for unblocked work, claim it with `sd update`, file follow-ups with `sd create`, and close completed seeds with `sd close`. Reap closes any seeds the agent marked done. The trigger scheduler can also fire on past-due `extensions.scheduledFor` seed timestamps ([SPEC §11.I](SPEC.md)). See [seeds](https://github.com/jayminwest/seeds).

`.seeds/` also enables **plan-run dispatch**: `POST /plan-runs { project, planId, agent }` against a seeds plan walks its children sequentially, one warren run per child, gating each step on the previous PR merging before the next dispatches. Children whose seeds are already closed are skipped, so re-dispatching the same plan after partial completion resumes from the next open child. PlanRun is a dispatch mode on top of the existing single-run primitive — same spawn path, same sandbox, same event stream. Tune the coordinator with `WARREN_PLAN_RUN_TICK_MS` (default 10s) or disable it with `WARREN_PLAN_RUN_DISABLED=1`. See [SPEC §11.P](SPEC.md#11p-planrun-serial-plan-execution-pl-a258-2026-05-18).

### Steerable harness: sapling as an alternative to claude-code

The built-in `sapling` agent is a headless coding harness with proactive context management. Use it the same way you'd use `claude-code`. See [sapling](https://github.com/jayminwest/sapling).

### Shared coordination: plot as a peer-network substrate

If a project has a `.plot/` directory, runs dispatched with a `plot_id` get `PLOT_ID` + `PLOT_ACTOR=agent:<name>:<run-id>` injected into the sandbox. The agent inside reads context with `plot get` and appends `decision_made` / `question_posed` / `artifact_produced` events with `plot append`. Warren appends a `run_dispatched` event to the originating Plot on spawn and merges the workspace `.plot/` back at reap, mirroring agent events into the run's event stream tagged with `plot_id`. Projects without `.plot/` are byte-identical to the pre-change behavior. See [plot](https://github.com/jayminwest/plot) and [SPEC §11.O](SPEC.md#11o-plot-integration-pl-2047-2026-05-17).

When a project ships **both** `.plot/` and `.seeds/`, plan-runs compose onto Plot. A `POST /plan-runs { plot_id }` emits one `plan_run_dispatched` event on the bound Plot at start, threads `plot_id` through every child so each gets `PLOT_ID` + `PLOT_ACTOR` in its sandbox and emits its own `run_dispatched` event, and auto-transitions the Plot from `active` → `done` when the final child merges. Plan-runs dispatched without `plot_id`, or against a project without `.plot/`, are byte-identical to the standalone plan-run baseline. See [SPEC §11.P.Plot](SPEC.md#11pplot-planrun--plot-composition-pl-7937-2026-05-18).

### PR-body template: per-project overrides for the PR warren opens

After a successful run, warren opens a PR with a generated body (summary, run link, commits, files-changed, prompt, etc.). Projects override individual sections by shipping a `.warren/pr-template.md` file: every `## <fragment_name>` heading replaces the default body for that fragment. Unspecified fragments keep the built-in defaults, so you can override just one piece.

```markdown
## trailer

Reviewed-by: @platform-team

Please follow our [PR checklist](https://example.com/checklist) before merging.
```

Recognized fragment names: `title`, `summary`, `run`, `seeds`, `preview_url_or_placeholder`, `commits`, `files_changed`, `prompt`, `trailer`. A whitespace-only body removes the fragment entirely. Unknown names + unbalanced preview markers surface via `warren doctor` so typos are loud. See [SPEC §11.L](SPEC.md) for the full fragment contract.

### Per-run preview environments: click the agent's branch instead of checking it out

When a project ships a `.warren/preview.yaml`, warren launches `preview.command` as a sidecar inside the same burrow workspace after a successful run, allocates a port, and exposes the running app at `https://run-<runId>.<WARREN_PREVIEW_HOST>`. Reviewers click the URL instead of `git checkout`-ing the branch. Idle sessions are reaped automatically; the run-detail page surfaces a status badge and a manual teardown button. Opt in with two pieces:

1. **Operator side.** Set `WARREN_PREVIEW_HOST=preview.<your-host>` and point a wildcard CNAME at the warren box (see [Per-run previews: operator setup](#per-run-previews-operator-setup) below). Without `WARREN_PREVIEW_HOST` the launch sub-step is a no-op (the run still completes, the URL just has no listener).
2. **Project side.** Ship `.warren/preview.yaml` with the preview block at the top level:

   ```yaml
   type: server
   command: bun run dev
   port: 3000
   readiness_path: /healthz
   idle_ttl: 30m
   max_lifetime: 8h
   ```

   Projects that don't opt in skip the preview sub-step entirely. See [SPEC §11.L](SPEC.md#11l-per-run-preview-environments-2026-05-14) for the full contract.

## Per-run previews: operator setup

Enable the preview proxy by giving warren a host suffix it can route on:

```bash
WARREN_PREVIEW_HOST=preview.warren.example.com
```

Warren then matches `Host: run-<runId>.preview.warren.example.com` as a preamble before its API/UI routes and forwards to the in-sandbox port allocated at reap time. The login route (`GET /runs/:id/preview/login?token=…&redirect=…`) accepts the warren bearer in the query and issues a domain-scoped signed cookie (`warren_preview`); the proxy rejects unauthenticated browser requests with 401 (not 502). The HMAC key is derived from `WARREN_API_TOKEN`, so there's no second secret to manage. `warren doctor` warns if the token is empty or matches a placeholder.

**Wildcard DNS.** Point a wildcard CNAME at the warren box so every `run-*` subdomain resolves:

```
*.preview.warren.example.com   CNAME   warren.example.com
```

**TLS via Caddy with a wildcard cert.** TLS stays on the operator's edge (SPEC §8.1 / §11.D). Use Caddy's DNS-01 challenge to issue `*.preview.warren.example.com` (HTTP-01 cannot issue wildcards). Minimal Caddyfile snippet:

```caddyfile
*.preview.warren.example.com {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy localhost:8080
}
```

Caddy's DNS-01 plugin supports Cloudflare, Route 53, DigitalOcean, Hetzner, Linode, OVH, Vultr, and others. See [caddy-dns](https://github.com/caddy-dns) for the current list. If your provider isn't on it, an operator-controlled per-project subdomain pattern is the alternative.

**Lifecycle knobs.** Tune for scale via `WARREN_PREVIEW_IDLE_TTL` (default `30m`), `WARREN_PREVIEW_MAX_LIFETIME` (`8h`), `WARREN_PREVIEW_MAX_LIVE` (`20`), `WARREN_PREVIEW_PORT_RANGE` (`30000-31000`), and `WARREN_PREVIEW_EVICTION_TICK_MS` (`60000`). Per-project overrides for `idle_ttl` and `max_lifetime` live in `.warren/preview.yaml`. `/readyz` surfaces port-allocator saturation warnings.

Cross-host routing for runs landing on remote workers is in progress as R-12. Until then, the proxy returns **501** for off-host runs.

See [SPEC §11.L](SPEC.md#11l-per-run-preview-environments-2026-05-14) for the full design.

## Architecture

```
┌──────────────── container (bwrap-friendly host) ────────────────┐
│  supervisor  ─┬─►  sandbox runtime  (unix socket: /var/run/...) │
│  (Bun parent) └─►  warren           (Bun.serve :8080, SPA + API)│
│                                                                 │
│  /data/                                                         │
│  ├── canopy-repo/         ← optional cloned agent library       │
│  ├── projects/<o>/<n>/    ← cloned project repos                │
│  ├── burrow/              ← runtime home (SQLite, workspaces)   │
│  └── warren.db            ← warren's SQLite (runs, events)      │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │  HTTPS (terminated upstream)
                          [browser]
```

That is the default (`local`) topology: warren talks to [burrow](https://github.com/jayminwest/burrow) as the sandbox runtime. They are co-tenanted inside the container, share a unix socket, and share a bearer token (`BURROW_API_TOKEN` == `WARREN_BURROW_TOKEN`). See [SPEC §10.3](SPEC.md#103-container-layout) for the full layout. Under `WARREN_RUNTIME=k8s` this diagram changes shape entirely — no burrow, no supervisor, no unix socket; warren is a Deployment and each run is a pod ([docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md)).

## CLI

The `warren` (or `wr`) admin CLI is for ops; the web UI is daily.

| Command | Description |
|---|---|
| `warren register-agent <name>` | Refresh canopy + register one agent |
| `warren add-project <git-url>` | Clone a project under `/data/projects` |
| `warren run <agent> <project> -p "..."` | One-shot run, no UI |
| `warren plan run <plan-id> --project <id> --agent <name>` | Dispatch a serial plan-run, tail events as NDJSON |
| `warren plan cancel <plan-run-id>` | Cancel a plan-run and its in-flight child |
| `warren plan status <plan-run-id>` | Child-state table with per-child cost + duration |
| `warren plan list [--project --state]` | List plan-runs, optionally filtered |
| `warren init` | Scaffold a `.warren/` directory in a project |
| `warren doctor` | Runtime reachable? Bwrap working? DB reachable? |
| `warren serve` | Start the HTTP server (default in entrypoint) |
| `warren db migrate-to-postgres --from <sqlite> --to <pg-url>` | One-shot SQLite → Postgres porter ([R-13](ROADMAP.md)) |

`warren run claude-code <project> -p "..."` does the full composition end-to-end: resolves the agent (built-in or library), provisions the sandbox, dispatches the run, streams events back, then pushes the branch. If the project has `.mulch/` or `.seeds/`, those round-trip too.

## HTTP API

```
GET    /agents                       list registered agents
POST   /agents/refresh               re-clone the optional canopy library
GET    /agents/:name                 rendered agent JSON

GET    /projects                     list cloned projects
POST   /projects                     { gitUrl, defaultBranch? } → clone
POST   /projects/:id/refresh         git fetch + reset to upstream HEAD
DELETE /projects/:id                 remove project
GET    /projects/:id/warren-config   parsed .warren/ envelope
GET    /projects/:id/triggers        scheduler state per trigger
POST   /projects/:id/triggers/:tid/run   dispatch a trigger inline

POST   /runs                         { agent, project, prompt } → spawn
GET    /runs                         list (filter by status / agent / project)
GET    /runs/:id                     detail incl. rendered_agent_json
GET    /runs/:id/events?follow=1     NDJSON tail (warren log + live)
POST   /runs/:id/steer               proxy to runtime inbox
POST   /runs/:id/cancel              proxy to runtime cancel
GET    /runs/:id/preview/login       issue signed-cookie + 302 (auth-exempt, ?token=)
POST   /runs/:id/preview/teardown    manual preview teardown (idempotent)

POST   /plan-runs                    { project, planId, agent } → serial dispatch (.seeds/ only)
GET    /plan-runs                    list (filter by project / state)
GET    /plan-runs/:id                detail + fanned-out child runs[]
POST   /plan-runs/:id/cancel         cancel; aborts the in-flight child run
GET    /plan-runs/:id/events         NDJSON tail union over every child run

GET    /healthz                      liveness (no auth)
GET    /readyz                       runtime + first-render check
```

`Authorization: Bearer ${WARREN_API_TOKEN}` is required on every non-`/healthz` route. Warren does not terminate TLS; front it with Caddy on a home server, or your cluster's ingress.

## Development

Requires [Bun](https://bun.sh) v1.1+.

```bash
bun install
bun test                                          # all unit tests
bun run lint                                      # biome check --error-on-warnings
bun run typecheck                                 # tsc --noEmit
bun test && bun run lint && bun run typecheck     # all quality gates
```

UI development (separate from the server build):

```bash
bun run ui:install
bun run ui:dev
```

The acceptance harness in [`scripts/acceptance/`](scripts/acceptance/) drives 38 scenarios against a live container. See [ACCEPTANCE.md](ACCEPTANCE.md) for the runbook.

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, testing conventions, and PR expectations.

## Project layout

```
src/
├── index.ts            library entry (currently VERSION constant only)
├── core/               types, errors, id minting (ag_*, prj_*, run_*)
├── registry/           agent definition resolution (built-in + library)
├── projects/           GitHub clone management
├── runs/               spawn / stream / reap composition flow (SPEC §4.3)
├── triggers/           cron + scheduled-for dispatcher (SPEC §11.I)
├── warren-config/      .warren/ per-project config loader + cache (SPEC §11.H)
├── client/             typed SDK for driving warren's HTTP API programmatically
├── burrow-client/      facade over the sandbox runtime's HttpClient
├── supervisor/         container entrypoint (spawns warren + runtime)
├── server/             Bun.serve HTTP API + static UI serving
├── db/                 drizzle schema + bun:sqlite repos
├── cli/                warren admin commands
└── ui/                 React + Vite + shadcn SPA
```

## Client SDK

`src/client/` exports a typed TypeScript client for driving warren programmatically — dispatching runs, streaming events, managing projects and plots — without reimplementing the wire format. Zero server-side imports; intended for scripts, CLIs, acceptance harnesses, and external agents.

### Setup

```bash
export WARREN_BASE_URL=https://warren.example.com   # default: http://localhost:8080
export WARREN_API_TOKEN=<your-token>
```

### Dispatch a run and wait for it

```ts
import { WarrenClient } from "./src/client/index.ts";

const warren = WarrenClient.fromEnv();
await warren.probe();  // throws WarrenUnreachableError if warren is down

const { run } = await warren.dispatch({
  agent: "claude-code",
  project: "my-project",
  prompt: "Add input validation to the signup form",
  branch: "main",          // optional: git ref to clone from
  model: "claude-sonnet-4-6", // optional: override the default model
});

const final = await warren.waitForRun(run.id, {
  onTick: (r) => console.log(`${r.id}: ${r.state}`),
});
console.log(`Run ${final.state}, PR: ${final.prUrl}`);
```

### Stream events

```ts
for await (const event of warren.streamRunEvents(run.id, { follow: true })) {
  if (event.stream === "stdout") process.stdout.write(String(event.payload));
}
```

### Steer a running agent

```ts
await warren.steer(run.id, {
  body: "Focus on the email field first, skip phone for now",
  priority: "high",
});
```

### Plots and plan-runs

```ts
// List active plots
const { plots } = await warren.listPlots({ status: "active" });

// Get full plot detail (intent + attachments + event log)
const plot = await warren.getPlot(plots[0].id);

// Dispatch a serial plan-run against a seeds plan
const { planRun, children } = await warren.createPlanRun({
  project: "my-project",
  planId: "pl-abc123",
  agent: "claude-code",
  plotId: plot.id,  // optional: compose onto the plot
});

// Inspect a plan-run's child-state + fanned-out child runs[]
const detail = await warren.getPlanRun(planRun.id);
for (const child of detail.children) {
  const run = detail.runs.find((r) => r.id === child.runId);
  console.log(`#${child.seq} ${child.seedId} [${child.state}] cost=${run?.costUsd ?? "—"}`);
}

// List plan-runs, optionally filtered by project / state
const { planRuns } = await warren.listPlanRuns({ project: "my-project", state: "running" });
```

### Error handling

```ts
import { WarrenClientError, WarrenUnreachableError } from "./src/client/index.ts";

try {
  await warren.dispatch({ agent: "claude-code", project: "bad-id", prompt: "..." });
} catch (err) {
  if (err instanceof WarrenUnreachableError) {
    // warren is down or unreachable
  } else if (err instanceof WarrenClientError) {
    // warren returned an error: err.status, err.code, err.message, err.hint
  }
}
```

The full type surface (all inputs, outputs, row shapes, enums) is in `src/client/types.ts`.

## Operating model

How the current release is scoped. Full details in [SPEC §11.D](SPEC.md#11d-v1-security-posture-known-limitations):

- **Single bearer token.** Rotation, expiry, and scopes are not supported; rotate by editing `.env` (or the cluster secret) and bouncing the container. Per-user identity is on the roadmap (R-09).
- **TLS is upstream's job.** Direct HTTP on a non-loopback bind is a misconfiguration; `warren doctor` warns.
- **Trust-the-socket** between warren and the runtime inside the container, which are co-tenanted by design.
- **No CSRF, single-user.** UI calls warren's API with the bearer; CORS is strict.
- **SQLite by default; Postgres optional.** Run history and scheduler state live in `/data/warren.db` on the local volume out of the box. Org-scale deploys can attach a managed Postgres by setting `WARREN_DB_URL=postgres://user:pw@host/db`; burrow's per-run SQLite stays untouched either way.
- **One host is the concurrency ceiling — in the `local` topology.** A single container caps concurrency at what one box can sandbox. The scale-out answer is the `k8s` runtime (each run a pod, cluster-scheduled with admission caps), not a multi-worker burrow fan-out — see [docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md).

## Roadmap

The active direction is org-readiness, extending warren from "one team, one box" to "50-engineer org, their own infra":

- **Remote sandbox workers** ([R-12](ROADMAP.md)): one warren dispatching across many runtime workers; lifts the single-host ceiling.
- **SSO / per-user identity** ([R-09](ROADMAP.md)): OIDC login replacing the shared bearer. The bearer stays as a service-account path for CI.
- **MCP support** ([R-15](ROADMAP.md)): agents declare `mcp_servers` in their prompt frontmatter; warren plumbs credentials into the sandbox.
- **Cross-project activity UI + stable OpenAPI** ([R-14](ROADMAP.md)): a "what is every agent doing right now" view, plus a versioned API contract.
- **Audit log** ([R-16](ROADMAP.md)) and **cost / concurrency guardrails** ([R-17](ROADMAP.md)): security review and budget control once real user identity lands.
- **GitHub App auth** ([R-18](ROADMAP.md)): installation-scoped, short-lived per-run tokens replacing the shared PAT.

All items are additive: none change current behavior when unconfigured. See [ROADMAP.md](ROADMAP.md) for design sketches and sequencing.

## Security

Found a vulnerability? Please follow the disclosure process in [SECURITY.md](SECURITY.md).

## Part of os-eco

Warren is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

## License

MIT. See [LICENSE](LICENSE).
