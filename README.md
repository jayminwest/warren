<p align="center">
  <img src="branding/logo.png" alt="warren — self-hostable cloud control plane" width="640">
</p>

# Warren

Spawn cloud agents at your GitHub repos. Watch them work live, steer them mid-run, get a branch back.

[![CI](https://github.com/jayminwest/warren/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/warren/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/4r6r5jUEFE)

[**Watch the demo**](https://youtu.be/daa7y8g9BkM) — a run dispatched, streamed, steered, and reaped.

[**Watch it live**](https://app.warren.run) — the public read-only instance. Real projects, real runs, live event streams, no login.

<!-- TODO: this slot still wants a run-detail screenshot or GIF. The repo ships
     no such asset yet (branding/ holds the logo only). -->

> The Coolify of coding agents. Self-hosted control plane: point it at a repo, bring your own key, agents run in sandboxes on your infra, PRs come out.

Warren is a self-hostable control plane for ephemeral coding agents. It is harness-agnostic — run pi, Claude Code, and other agents behind one interface — on your own infrastructure with your own API keys.

Every run is short-lived and sandboxed. A run completes a task, validates the changes, pushes a branch, and exits. **One container, one volume, one HTTP API, one UI.**

## Quickstart

Warren publishes a prebuilt image to `ghcr.io/jayminwest/warren`. Nothing to clone, nothing to compile:

```bash
export WARREN_API_TOKEN=$(openssl rand -hex 32)
export BURROW_TOKEN=$(openssl rand -hex 32)
export ANTHROPIC_API_KEY=sk-ant-...     # your key
export GITHUB_TOKEN=ghp_...             # repo scope: clone + push

docker run -d --name warren --restart unless-stopped -p 8080:8080 -v warren_data:/data \
  --security-opt apparmor=unconfined \
  --security-opt seccomp=unconfined \
  --security-opt systempaths=unconfined \
  --cap-add SYS_ADMIN \
  -e WARREN_API_TOKEN \
  -e ANTHROPIC_API_KEY \
  -e GITHUB_TOKEN \
  -e BURROW_API_TOKEN="$BURROW_TOKEN" \
  -e WARREN_BURROW_TOKEN="$BURROW_TOKEN" \
  ghcr.io/jayminwest/warren:latest

echo "$WARREN_API_TOKEN"   # paste this into the UI
```

Open <http://localhost:8080> and paste the token. Click **Projects → Add** and give it a GitHub URL.

Then **Dispatch run**, pick `claude-code`, write a prompt, and start it. The events panel streams live. When the run completes, warren pushes a branch you can open a PR from.

`:latest` tracks `main`. Pin a release with `:v0.12.2`, the first buildable 0.12 image. The `v0.12.0` and `v0.12.1` tags exist but carry no container image. Their builds were broken and the fix landed in v0.12.2, so do not pin them. Two of the three 0.12 tags are unbuildable. Prefer the explicit `:v0.12.2` pin over the moving `:0.12` minor tag.

The four security flags relax the outer container so the sandbox runtime can nest its own user namespaces (SPEC §5.3). Remove any one of them and sandbox provisioning fails.

| Variable | Purpose |
|---|---|
| `WARREN_API_TOKEN` | Bearer token on every route except `/healthz` and `/version`. `openssl rand -hex 32`. |
| `BURROW_API_TOKEN` | Token the sandbox runtime requires to bind. `openssl rand -hex 32`. |
| `WARREN_BURROW_TOKEN` | Token warren's runtime client sends. **Must equal `BURROW_API_TOKEN`** — they are the two ends of one channel. |
| `ANTHROPIC_API_KEY` | Forwarded to agent runtimes that need it. |
| `GITHUB_TOKEN` | Forwarded for project clones and branch pushes. |

[`.env.example`](.env.example) documents the full knob set. To manage the same container declaratively, use the compose file instead. It pulls the same image and applies the same flags:

```bash
git clone https://github.com/jayminwest/warren && cd warren
cp .env.example .env && $EDITOR .env
docker compose up -d
```

> **Image requirement (self-host, `local` runtime): burrow-cli 0.3.15 or newer.** In the default topology warren shares the container with [burrow](https://github.com/jayminwest/burrow) and talks to it over a unix socket. The published image pins `@os-eco/burrow-cli@0.3.15` (see [`Dockerfile`](Dockerfile)). If you build your own image, install 0.3.15 or newer. Earlier releases predate the runtime contract warren depends on (agent spawn shape, resume support, event kinds) and fail at dispatch. Under `WARREN_RUNTIME=k8s` this does not apply, because the run pods carry their own toolchain image and no burrow.

## Who this is for

Engineering teams that self-host their own agent infrastructure. The deployment unit is one team or one org that runs one warren on their own box or their own cluster.

Run it for yourself on a home server today. The [org-readiness roadmap](ROADMAP.md) extends the same architecture to a 50-engineer organization without a fork.

## Status

Stable (`0.13.0`), running on GKE in continuous use against real GitHub repos. The Kubernetes runtime (`WARREN_RUNTIME=k8s`, pod-per-run) is the supported hosted target on GKE Autopilot.

37 scenario-based acceptance tests in [`scripts/acceptance/`](scripts/acceptance/) cover the end-to-end path. They span manual runs, cron triggers, and K8s pod dispatch (OOM fast-fail, steer delivery). They also span the Postgres backend, per-run preview environments, restart recovery, cost tracking, cost analytics, the seeds-extensions roundtrip, and serial plan-run dispatch.

The active frontier is the org-readiness cluster: SSO, remote workers, MCP, audit, budgets, GitHub App auth. See [ROADMAP.md](ROADMAP.md).

## What you get

- **One image, one volume.** The supervisor (`src/supervisor/main.ts`) is the container ENTRYPOINT. It spawns the sandbox runtime first, waits for the unix socket, then spawns warren. SIGTERM and SIGINT forward to both children. The runtime restarts under a 5-in-60s budget on unexpected exit.
- **Native sandboxing per run.** In the default `local` topology every run gets a fresh `bwrap`-isolated workspace under `/data/burrow/`. The host is unreachable, and warren talks to the runtime over a unix socket with a shared bearer token. Under `WARREN_RUNTIME=k8s` the pod boundary is the sandbox instead (kubelet-enforced CPU and memory, no bwrap). See [the K8s runbook](docs/RUNBOOK-K8S.md).
- **Built-in agents.** `claude-code`, `sapling`, and `pi` ship inline (`src/registry/builtins/`), so a dispatch needs no extra setup.
- **Live event stream.** NDJSON events persist to warren's SQLite log. Clients tail them over `GET /runs/:id/events?follow=1`. The UI, the CLI (`warren run`), and HTTP clients all read the same stream.
- **Steerable mid-run.** `POST /runs/:id/steer` lands a message in the agent's inbox, and the next turn picks it up. `POST /runs/:id/cancel` aborts cleanly.
- **Scheduled runs.** `.warren/triggers.yaml` defines cron triggers per project. The in-process scheduler dispatches them on the same composition path as manual runs.
- **Serial plan-run dispatch.** Projects that ship `.seeds/` can `POST /plan-runs` against a seeds plan. Warren walks the plan's children one at a time, spawns one run per child, and gates each on the previous PR merging. A re-dispatch after some children close resumes from the next open child.
- **Three thin clients of one pipeline.** The web UI, the `warren` admin CLI, and the HTTP API all flow through the same composition path ([SPEC §4.3](SPEC.md#43-the-composition-flow)).

## Deploy

Two supported paths:

- **Single box (`local` runtime).** The [Quickstart](#quickstart) above *is* a complete deploy — one container, one volume, warren and burrow together. Run it on a home server or any Docker host. Warren serves plain HTTP. Put TLS on your edge with Caddy on a home server, or with your ingress.
- **Cluster (`k8s` runtime), the hosted target.** Deploy to Kubernetes. **GKE Autopilot is the reference cluster.** Each run is its own pod, there is no burrow, and admission caps shed load before the cluster thrashes. The canonical procedure is **[docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md)**. The manifest quick-start is [`deploy/k8s/README.md`](deploy/k8s/README.md).

Continuous deployment ships in [`.github/workflows/deploy-gke.yml`](.github/workflows/deploy-gke.yml).

A published GitHub release (cut by [`release.yml`](.github/workflows/release.yml)) builds the three SHA-pinned images, publishes the control plane to `ghcr.io`, and rolls the GKE Autopilot deployment forward.

The job then fails unless the rolled-out image is the released SHA **and** the ingress `/version` reports the released semver.

Auth is GCP Workload Identity Federation, so there are no long-lived keys. The OIDC provider, service account, and cluster coordinates are repo secrets and variables (see [docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md) §1.6).

### Deploy to Kubernetes (scale-out)

The `local` topology is one box, and one host is the concurrency ceiling. The `k8s` topology lifts that ceiling by running **each agent run as its own pod**.

Kubelet enforces per-run CPU and memory natively. A runaway run kills its own pod instead of the control plane, and admission caps shed load before the cluster thrashes. There is no burrow — the pod boundary is the sandbox.

```bash
# Build + push the three images (control plane, agent, workspace-init)
deploy/docker/build-images.sh

# Apply the manifests (kustomize; pick an overlay)
kubectl apply -k deploy/k8s/overlays/gke     # GKE Autopilot (the hosted target)
kubectl apply -k deploy/k8s/overlays/kind    # local kind / k3d dev
```

Turn it on with `WARREN_RUNTIME=k8s` on the control-plane Deployment. The full operator story — deploy, secrets and rotation, RBAC, garbage collection, admission knobs, observability, and incident playbooks — is in **[docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md)**.

Some LocalProvider features degrade under `k8s`: previews are off, and steering is a 5s poll rather than real-time. The runbook's capability section spells out the gaps.

### Observability on a live deploy

Warren ships enough operator-visible surface to stay inspectable without extra infrastructure. The pieces:

- **Health and readiness probes.** `GET /healthz` is a cheap liveness check that returns `{ok: true}` and needs no auth. Point an uptime monitor or the cluster's liveness probe at it. `GET /readyz` runs deeper diagnostics (DB reachable, bwrap usable under `local`) and returns a `DiagnosticCheck[]` payload. Use it for deploy gating and the cluster's readiness probe, not for hot-path liveness. `GET /version` returns `{version}` straight from `src/index.ts`, which confirms that a rollout actually swapped the image. [`deploy-gke.yml`](.github/workflows/deploy-gke.yml) polls it after every release and fails the deploy on a mismatch.
- **Structured JSON logs.** The server emits one [pino](https://getpino.io) JSON line per event on stdout (name `warren`, level from `WARREN_LOG_LEVEL`, default `info`). Stream them with `docker compose logs -f warren` on a single box, or `kubectl -n warren logs deploy/warren` on a cluster. Pipe through `| jq` for ad-hoc filtering. Ship to an external store with a [pino transport](https://getpino.io/#/docs/transports) if you need retention beyond your log driver's window.
- **Correlation IDs.** Every HTTP response carries an `X-Request-ID` header (`src/server/request-id.ts`, warren-30af). Warren honours a well-formed inbound `X-Request-ID` and otherwise mints one. The same id binds into the per-request pino child logger, so `jq 'select(.req_id == "…")'` over the logs reconstructs the full server-side trace for one client call. Forward the header from any reverse proxy in front of warren to keep the chain unbroken.
- **Per-run cost and token usage.** Warren populates the `runs.cost_usd` and `runs.tokens_*` columns for the `pi` and `claude-code` built-ins (SPEC §11.K). The UI run-detail page surfaces them, and `GET /analytics/cost?from=&to=&projectId=` aggregates across runs (`src/db/repos/runs.ts:listForAnalytics`). These numbers report usage. They do not enforce limits — budget caps land in R-17.
- **Pre-flight checks.** Run `warren doctor` (`src/cli/commands/doctor.ts`) against a deployed instance. It surfaces common misconfigurations: empty or placeholder bearer tokens, unbalanced preview markers, and a missing `WARREN_PREVIEW_HOST` on a project that uses previews. Cheaper than reading the logs after a failed run.

V1 ships a bearer-gated Prometheus exposition endpoint (`GET /metrics`) that works under both runtimes. It carries no OpenTelemetry exporter. For richer tracing, the request-id and pino combination is the seam to extend. The route table (`ROUTE_TABLE` in `src/server/handlers/index.ts`) is the stable surface to instrument against.

Both runtimes serve `GET /metrics` (bearer-gated, warren-682a) — a Prometheus exposition endpoint. Each scrape reports run-count, cost, token, and event-stream gauges (`src/server/handlers/metrics.ts`). Under `k8s` the same endpoint also carries pod-lifecycle gauges — see the runbook.

## Community

Questions, help, or feedback? [Join the Discord](https://discord.gg/4r6r5jUEFE).

## Optional integrations

Warren bundles a few [os-eco](https://github.com/jayminwest/os-eco) tools as opt-in features. A basic run needs none of them, and each one stays silent until a project uses it.

- **Agent memory.** A project with a `.mulch/` directory gets its expertise primed into every run, and reap merges new records back with last-write-wins by timestamp.
- **Issue queue.** A project with a `.seeds/` directory lets agents read the queue, claim work, file follow-ups, and close finished issues. `.seeds/` also unlocks serial plan-run dispatch and past-due `extensions.scheduledFor` triggers (SPEC §11.I, §11.P). Tune the plan-run coordinator with `WARREN_PLAN_RUN_TICK_MS` (default 10s), or turn it off with `WARREN_PLAN_RUN_DISABLED=1`.
- **Alternative harness.** The built-in `sapling` agent is a second coding harness on the same dispatch path. Use it the way you use `claude-code`.

See [SPEC §11](SPEC.md) for the full contracts.

## PR-body template

After a successful run, warren opens a PR with a generated body: summary, run link, commits, files-changed, prompt, and a trailer.

A project overrides individual sections by shipping a `.warren/pr-template.md` file. Every `## <fragment_name>` heading replaces the default body for that fragment. Unspecified fragments keep the built-in defaults, so you can override just one piece.

```markdown
## trailer

Reviewed-by: @platform-team

Please follow our [PR checklist](https://example.com/checklist) before merging.
```

Recognized fragment names: `title`, `summary`, `run`, `seeds`, `preview_url_or_placeholder`, `commits`, `files_changed`, `prompt`, `trailer`.

A whitespace-only body removes the fragment entirely. Unknown names and unbalanced preview markers surface through `warren doctor`, so typos are loud. See [SPEC §11.L](SPEC.md) for the full fragment contract.

## Per-run preview environments

When a project ships a `.warren/preview.yaml`, warren launches `preview.command` as a sidecar inside the same burrow workspace after a successful run. It then allocates a port and exposes the running app at `https://run-<runId>.<WARREN_PREVIEW_HOST>`.

Reviewers click the URL instead of a `git checkout`. Warren reaps idle sessions automatically, and the run-detail page surfaces a status badge and a manual teardown button. Opt in with two pieces:

1. **Operator side.** Set `WARREN_PREVIEW_HOST=preview.<your-host>` and point a wildcard CNAME at the warren box (see below). Without `WARREN_PREVIEW_HOST` the launch sub-step is a no-op. The run still completes, and the URL just has no listener.
2. **Project side.** Ship `.warren/preview.yaml` with the preview block at the top level:

   ```yaml
   type: server
   command: bun run dev
   port: 3000
   readiness_path: /healthz
   idle_ttl: 30m
   max_lifetime: 8h
   ```

   Projects that do not opt in skip the preview sub-step entirely.

### Operator setup

Enable the preview proxy by giving warren a host suffix it can route on:

```bash
WARREN_PREVIEW_HOST=preview.warren.example.com
```

Warren then matches `Host: run-<runId>.preview.warren.example.com` as a preamble before its API and UI routes, and forwards to the in-sandbox port allocated at reap time.

The login route (`POST /runs/:id/preview/login`, optional `{redirect}` body) takes the warren bearer in the `Authorization` header and issues a domain-scoped signed cookie (`warren_preview`).

The proxy rejects unauthenticated browser requests with 401, not 502. The HMAC key derives from `WARREN_API_TOKEN`, so there is no second secret to manage.

**Wildcard DNS.** Point a wildcard CNAME at the warren box so every `run-*` subdomain resolves:

```
*.preview.warren.example.com   CNAME   warren.example.com
```

**TLS through Caddy with a wildcard cert.** TLS stays on the operator's edge (SPEC §8.1 / §11.D). Use Caddy's DNS-01 challenge to issue `*.preview.warren.example.com`, because HTTP-01 cannot issue wildcards. Minimal Caddyfile snippet:

```caddyfile
*.preview.warren.example.com {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy localhost:8080
}
```

Caddy's DNS-01 plugin supports Cloudflare, Route 53, DigitalOcean, Hetzner, Linode, OVH, Vultr, and others. See [caddy-dns](https://github.com/caddy-dns) for the current list. If your provider is absent from it, an operator-controlled per-project subdomain pattern is the alternative.

**Lifecycle knobs.** Tune for scale with `WARREN_PREVIEW_IDLE_TTL` (default `30m`), `WARREN_PREVIEW_MAX_LIFETIME` (`8h`), `WARREN_PREVIEW_MAX_LIVE` (`20`), `WARREN_PREVIEW_PORT_RANGE` (`30000-31000`), and `WARREN_PREVIEW_EVICTION_TICK_MS` (`60000`).

Per-project overrides for `idle_ttl` and `max_lifetime` live in `.warren/preview.yaml`. `/readyz` surfaces port-allocator saturation warnings.

Warren does not route cross-host preview traffic: the proxy returns **501** for off-host runs (`runs.worker_id` other than the local worker). The `k8s` runtime provider superseded the multi-worker model that once scoped this work (old R-12) — see [ROADMAP.md](ROADMAP.md). See [SPEC §11.L](SPEC.md#11l-per-run-preview-environments-2026-05-14) for the full design.

## Architecture

Warren runs against a swappable **runtime provider**, selected once at boot by `WARREN_RUNTIME` (`src/runtime/registry.ts`), behind one contract (`src/runtime/contract.ts`). Two topologies share the same domain code:

- **`local` (default) — self-host.** The whole system is one container: warren plus a co-tenanted [burrow](https://github.com/jayminwest/burrow) sandbox daemon that isolates each run with `bwrap`. This is the primary path everything above describes.
- **`k8s` — scale-out.** Each run is its own Kubernetes pod, and there is no burrow. Built for clusters and GKE Autopilot. See [**the K8s runbook**](docs/RUNBOOK-K8S.md) and [`deploy/k8s/`](deploy/k8s/README.md).

Burrow is the LocalProvider's substrate, not a required dependency of warren. Under `WARREN_RUNTIME=k8s` there is no burrow at all.

```
┌──────────────── container (bwrap-friendly host) ────────────────┐
│  supervisor  ─┬─►  sandbox runtime  (unix socket: /var/run/...) │
│  (Bun parent) └─►  warren           (Bun.serve :8080, SPA + API)│
│                                                                 │
│  /data/                                                         │
│  ├── projects/<o>/<n>/    ← cloned project repos                │
│  ├── burrow/              ← runtime home (SQLite, workspaces)   │
│  └── warren.db            ← warren's SQLite (runs, events)      │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │  HTTPS (terminated upstream)
                          [browser]
```

That is the default (`local`) topology. Warren and burrow share the container, a unix socket, and a bearer token (`BURROW_API_TOKEN` == `WARREN_BURROW_TOKEN`). See [SPEC §10.3](SPEC.md#103-container-layout) for the full layout.

Under `WARREN_RUNTIME=k8s` this diagram changes shape entirely: no burrow, no supervisor, no unix socket. Warren is a Deployment, and each run is a pod ([docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md)).

## CLI

The `warren` (or `wr`) admin CLI is for ops. The web UI is for daily work.

| Command | Description |
|---|---|
| `warren add-project <git-url>` | Clone a project under `/data/projects` |
| `warren run <agent> <project> -p "..."` | One-shot run, no UI |
| `warren plan run <plan-id> --project <id> --agent <name>` | Dispatch a serial plan-run, tail events as NDJSON |
| `warren plan cancel <plan-run-id>` | Cancel a plan-run and its in-flight child |
| `warren plan status <plan-run-id>` | Child-state table with per-child cost and duration |
| `warren plan list [--project --state]` | List plan-runs, optionally filtered |
| `warren init` | Scaffold a `.warren/` directory in a project |
| `warren doctor` | Runtime reachable? Bwrap working? DB reachable? |
| `warren serve` | Start the HTTP server (default in entrypoint) |
| `warren db migrate-to-postgres --from <sqlite> --to <pg-url>` | One-shot SQLite → Postgres porter ([R-13](ROADMAP.md)) |

`warren run claude-code <project> -p "..."` does the full composition end-to-end. It resolves the agent, provisions the sandbox, dispatches the run, streams events back, then pushes the branch. A project with `.mulch/` or `.seeds/` round-trips those too.

## HTTP API

```
GET    /agents                       list registered agents
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
GET    /runs/:id                     run detail
GET    /runs/:id/events?follow=1     NDJSON tail (warren log + live)
POST   /runs/:id/steer               proxy to runtime inbox
POST   /runs/:id/cancel              proxy to runtime cancel
POST   /runs/:id/preview/login       issue signed-cookie + preview url (bearer-gated)
POST   /runs/:id/preview/teardown    manual preview teardown (idempotent)

POST   /plan-runs                    { project, planId, agent } → serial dispatch (.seeds/ only)
GET    /plan-runs                    list (filter by project / state)
GET    /plan-runs/:id                detail + fanned-out child runs[]
POST   /plan-runs/:id/cancel         cancel; aborts the in-flight child run
GET    /plan-runs/:id/events         NDJSON tail union over every child run

GET    /whoami                       caller identity + capability set
GET    /healthz                      liveness (no auth)
GET    /version                      running semver (no auth)
GET    /readyz                       runtime + first-render check
```

`bun run gen:docs` writes the full route list to [`docs/http-api.md`](docs/http-api.md) from `ROUTE_TABLE`.

`Authorization: Bearer ${WARREN_API_TOKEN}` is required on every route except `/healthz` and `/version`. Warren serves plain HTTP. Put TLS on your edge with Caddy on a home server, or with your cluster's ingress.

## Development

Requires [Bun](https://bun.sh) v1.1+.

```bash
bun install
bun test                  # all unit tests
bun run lint              # biome + boundary, version-sync, and prose guards
bun run typecheck         # tsc --noEmit
bun run verify            # every quality gate CI enforces (alias of check:all)
```

UI development is a separate package:

```bash
bun run ui:install
bun run ui:dev
```

The acceptance harness in [`scripts/acceptance/`](scripts/acceptance/) drives 37 scenarios against a live container. See [ACCEPTANCE.md](ACCEPTANCE.md) for the runbook. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, testing conventions, and PR expectations. [docs/README.md](docs/README.md) indexes every document in the repo.

## Project layout

```
src/
├── index.ts            library entry (currently VERSION constant only)
├── core/               types, errors, id minting (ag_*, prj_*, run_*)
├── registry/           agent definition resolution (built-in + library)
├── projects/           GitHub clone management
├── runs/               spawn / stream / reap composition flow (SPEC §4.3)
├── plan-runs/          serial plan execution (SPEC §11.P)
├── triggers/           cron + scheduled-for dispatcher (SPEC §11.I)
├── warren-config/      .warren/ per-project config loader + cache (SPEC §11.H)
├── client/             typed SDK for driving warren's HTTP API programmatically
├── runtime/            RuntimeProvider contract + local and k8s backends
├── burrow-client/      facade over the sandbox runtime's HttpClient
├── supervisor/         container entrypoint (spawns warren + runtime)
├── server/             Bun.serve HTTP API + static UI serving
├── db/                 drizzle schema + bun:sqlite repos
├── cli/                warren admin commands
└── ui/                 React + Vite + shadcn SPA
```

## Client SDK

`src/client/` exports a typed TypeScript client for driving warren programmatically: dispatching runs, streaming events, and managing projects, agents, and plan-runs. It imports nothing from the server, and it targets scripts, CLIs, acceptance harnesses, and external agents.

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
  branch: "main",             // optional: git ref to clone from
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

### Plan-runs

```ts
// Dispatch a serial plan-run against a seeds plan
const { planRun } = await warren.createPlanRun({
  project: "my-project",
  planId: "pl-abc123",
  agent: "claude-code",
});

// Inspect child state alongside the fanned-out child runs[]
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

- **Single bearer token.** Rotation, expiry, and scopes are not supported. Rotate by editing `.env` (or the cluster secret) and bouncing the container. Per-user identity is on the roadmap (R-09).
- **TLS is upstream's job.** Direct HTTP on a non-loopback bind is a misconfiguration, and `warren doctor` warns.
- **Trust-the-socket** between warren and the runtime inside the container, which share the container by design.
- **No CSRF, single-user.** The UI calls warren's API with the bearer, and CORS is strict.
- **SQLite by default, Postgres optional.** Run history and scheduler state live in `/data/warren.db` on the local volume out of the box. Org-scale deploys can attach a managed Postgres by setting `WARREN_DB_URL=postgres://user:pw@host/db`. Burrow's per-run SQLite stays untouched either way.
- **One host is the concurrency ceiling — in the `local` topology.** A single container caps concurrency at what one box can sandbox. The scale-out answer is the `k8s` runtime (each run a pod, cluster-scheduled with admission caps), not a multi-worker burrow fan-out. See [docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md).

## Roadmap

The active direction is org-readiness, which extends warren from "one team, one box" to "50-engineer org, their own infra":

- **SSO / per-user identity** ([R-09](ROADMAP.md)): OIDC login replacing the shared bearer. The bearer stays as a service-account path for CI.
- **MCP support** ([R-15](ROADMAP.md)): agents declare `mcp_servers` in their prompt frontmatter, and warren plumbs credentials into the sandbox.
- **Cross-project activity UI + stable OpenAPI** ([R-14](ROADMAP.md)): a "what is every agent doing right now" view, plus a versioned API contract.
- **Audit log** ([R-16](ROADMAP.md)) and **cost / concurrency guardrails** ([R-17](ROADMAP.md)): security review and budget control once real user identity lands.
- **GitHub App auth** ([R-18](ROADMAP.md)): installation-scoped, short-lived per-run tokens replacing the shared PAT.

Every item is additive. None changes current behavior when unconfigured. See [ROADMAP.md](ROADMAP.md) for design sketches and sequencing.

## Security

Found a vulnerability? Please follow the disclosure process in [SECURITY.md](SECURITY.md).

## Part of os-eco

Warren is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

## License

MIT. See [LICENSE](LICENSE).
