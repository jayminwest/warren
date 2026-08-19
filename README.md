<p align="center">
  <a href="https://warren.run">
    <img src="branding/logo.png" alt="warren, the self-hosted control plane for coding agents" width="640">
  </a>
</p>

<div align="center">

[![CI](https://img.shields.io/github/actions/workflow/status/jayminwest/warren/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/jayminwest/warren/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/jayminwest/warren?style=for-the-badge&label=Release)](https://github.com/jayminwest/warren/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2.svg?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/4r6r5jUEFE)

**[Live instance](https://app.warren.run)** · **[Demo](https://youtu.be/daa7y8g9BkM)** · **[Quickstart](#quickstart)** · **[Docs](docs/README.md)** · **[Contributing](CONTRIBUTING.md)** · **[Roadmap](ROADMAP.md)**

</div>

# Warren

The self-hosted control plane for coding agents. Issue in, PR out. Your infra, your keys.

[app.warren.run](https://app.warren.run) is the public read-only instance: real projects, real runs, live event streams, no login. The [demo](https://youtu.be/daa7y8g9BkM) shows a run dispatched, streamed, steered, and reaped.

<!-- TODO: this slot still wants the canonical demo GIF (issue -> dispatch ->
     live events -> PR). The repo ships no such asset yet (branding/ holds the
     logo only). -->

Anyone can get a PR out of an agent. Warren is for what happens next: dozens of runs a day, on your infrastructure, with your API keys. Each run needs a sandbox, a spend cap, an audit trail, and a verdict.

## Table of contents

- [Quickstart](#quickstart)
- [Why warren](#why-warren)
- [Who this is for](#who-this-is-for)
- [Status](#status)
- [What you get](#what-you-get)
- [Deploy](#deploy)
- [Community](#community)
- [Optional integrations](#optional-integrations)
- [Extensions](#extensions)
- [PR-body template](#pr-body-template)
- [Per-run preview environments](#per-run-preview-environments)
- [Architecture](#architecture)
- [CLI](#cli)
- [HTTP API](#http-api)
- [Development](#development)
- [Project layout](#project-layout)
- [Client SDK](#client-sdk)
- [Operating model](#operating-model)
- [Roadmap](#roadmap)
- [Security](#security)
- [License](#license)

## Quickstart

One `docker run`, two secrets, no security flags. Warren publishes a prebuilt image to `ghcr.io/jayminwest/warren`. Nothing to clone, nothing to compile.

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # your key
export GITHUB_TOKEN=ghp_...             # repo scope: clone + push

docker run -d --name warren --restart unless-stopped -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(command -v docker)":/usr/bin/docker:ro \
  -v /srv/warren:/srv/warren \
  -e WARREN_RUNTIME=docker \
  -e WARREN_DATA_DIR=/srv/warren \
  -e ANTHROPIC_API_KEY \
  -e GITHUB_TOKEN \
  ghcr.io/jayminwest/warren:latest

docker logs warren | grep mintedOperatorToken   # your UI token, printed once
```

Leave `WARREN_API_TOKEN` unset. First boot mints an operator token, prints it to the logs exactly once, and persists it under the data dir.

The `docker` runtime runs each agent as a sibling container over the docker socket. The container boundary is the sandbox, so the run needs no `security-opt` or `cap-add` flags (see [docs/design/runtime-docker-provider.md](docs/design/runtime-docker-provider.md)). The data dir bind-mounts at the same absolute path on host and container. That path parity lets agent containers resolve the workspace. Build the agent image once from a clone with `docker build -f deploy/docker/Dockerfile.agent -t warren-agent:latest .`, or point `WARREN_DOCKER_AGENT_IMAGE` at your own.

> **macOS Docker Desktop caveats.** Three traps hit this quickstart on a Mac.
>
> - **The docker CLI mount becomes an empty directory.** Docker Desktop shares a fixed set of host paths with its VM, and the host `docker` binary sits outside that set. The `-v "$(command -v docker)":/usr/bin/docker:ro` mount then creates an empty directory at the target, and every dispatch fails with `Executable not found in $PATH: "docker"`. Put a [static linux docker CLI](https://download.docker.com/linux/static/stable/x86_64/) on the data volume instead, then add `-e WARREN_DOCKER_BIN=/srv/warren/bin/docker`. Under `WARREN_RUNTIME=docker`, `GET /readyz` reports a `docker_cli` failure until that CLI answers.
>
> - **`-v /srv/warren:/srv/warren` materializes inside the Desktop VM, not on the host filesystem.** Path parity still holds for the agent containers, because they share the same VM. Read the data dir with `docker exec`, not with Finder.
>
> - **Pull the image before you run it.** Run `docker pull ghcr.io/jayminwest/warren:latest` first. A stale cached `:latest` from before the 0.17.0 absorption release crash-loops and demands `BURROW_API_TOKEN`.

Open <http://localhost:8080> and paste the token. Click **Projects → Add** and give it a GitHub URL.

Then **Dispatch run**, pick `claude-code`, write a prompt, and start it. The events panel streams live. When the run completes, warren pushes a branch you can open a PR from.

`:latest` tracks `main`. Pin a release tag such as `:v0.13.1` for a reproducible deploy. [CHANGELOG.md](CHANGELOG.md) records the release history.

The quickstart exports the two required secrets. [`.env.example`](.env.example) documents the full knob set.

To manage the same container declaratively, use the compose file instead. The shipped compose file targets the `local` runtime and carries the four bwrap security flags that topology needs:

```bash
git clone https://github.com/jayminwest/warren && cd warren
cp .env.example .env && $EDITOR .env
docker compose up -d
```

> **Image requirement (self-host, `local` runtime): bubblewrap + user namespaces.** In the `local` topology warren sandboxes each run itself with `bwrap`, and the container needs the four security flags in `docker-compose.yml`. Under `WARREN_RUNTIME=docker` or `WARREN_RUNTIME=k8s` this does not apply, because the run container or pod boundary is the sandbox.

## Why warren

Warren dispatches ephemeral agents at your GitHub repos and controls the whole run:

- **Dispatch.** Point warren at a repo, pick an agent, write a prompt. Seven builtin agents ship behind one adapter registry, `claude-code` and `pi` included.
- **Sandbox.** Warren isolates every run: bwrap locally, a sibling container under Docker, a pod on Kubernetes.
- **Cap.** Per-run USD spend caps, enforced mid-run. Per-project concurrency and cluster admission control on top.
- **Steer.** Send instructions into a live run. Steering is the escalation path, not the interface.
- **Audit.** Every run event lands in an append-only audit log, exported at `GET /audit-log.jsonl`.
- **Judge.** An isolated judge scores finished runs against a 15-class rubric and serves verdicts at `GET /verdicts.jsonl`. Agents never see their verdicts.

A run completes a task, validates the changes, pushes a branch, and exits. **One container, one volume, one HTTP API, one UI.**

Warren runs warren. In the seven days before 2026-08-18, warren-dispatched agents authored 91 of this repo's 239 commits (38%). The product judged and audited that work itself, in public at [app.warren.run](https://app.warren.run).

## Who this is for

Engineering teams that self-host their own agent infrastructure. The deployment unit is one team or one org that runs one warren on their own box or their own cluster.

Run it for yourself on a home server today. The [org-readiness roadmap](ROADMAP.md) extends the same architecture to a 50-engineer organization without a fork.

## Status

Stable (`0.17.0`), running on GKE in continuous use against real GitHub repos. The Kubernetes runtime (`WARREN_RUNTIME=k8s`, pod-per-run) is the supported hosted target on GKE Autopilot.

Scenario-based acceptance tests in [`scripts/acceptance/`](scripts/acceptance/) cover the end-to-end path. They span manual runs, cron triggers, K8s pod dispatch, Postgres, previews, restart recovery, cost analytics, the seeds-extensions roundtrip, and serial plan-run dispatch.

The 0.17.0 absorption release internalized the sandbox substrate (plan pl-3007) and added a `DockerProvider` (`WARREN_RUNTIME=docker`) that runs each agent as a sibling container. The active frontier is the issue-tracker contract cut. See [ROADMAP.md](ROADMAP.md).

## What you get

- **One image, one volume.** The supervisor (`src/supervisor/main.ts`) is the container ENTRYPOINT. It spawns warren and forwards SIGTERM and SIGINT to it.
- **Native sandboxing per run.** In the default `local` topology every run gets a fresh `bwrap`-isolated workspace. The host is unreachable from the sandbox. Under `WARREN_RUNTIME=k8s` the pod boundary is the sandbox instead (kubelet-enforced CPU and memory, no bwrap). See [the K8s runbook](docs/RUNBOOK-K8S.md).
- **Built-in agents.** `claude-code` and `pi` ship inline (`src/registry/builtins/`), so a dispatch needs no extra setup.
- **Live event stream.** NDJSON events persist to warren's SQLite log. Clients tail them over `GET /runs/:id/events?follow=1`. The UI, the CLI (`warren run`), and HTTP clients all read the same stream.
- **Steerable mid-run.** `POST /runs/:id/steer` lands a message in the agent's inbox, and the next turn picks it up. `POST /runs/:id/cancel` aborts cleanly.
- **Scheduled runs.** `.warren/triggers.yaml` defines cron triggers per project. The in-process scheduler dispatches them on the same composition path as manual runs.
- **Serial plan-run dispatch.** Projects that ship `.seeds/` can `POST /plan-runs` against a seeds plan. Warren walks the plan's children one at a time, spawns one run per child, and gates each on the previous PR merging. A re-dispatch after some children close resumes from the next open child.
- **Three thin clients of one pipeline.** The web UI, the `warren` admin CLI, and the HTTP API all flow through the same composition path ([docs/design/agent-composition.md](docs/design/agent-composition.md)).

## Deploy

Two supported paths:

- **Single box (`local` runtime).** The [Quickstart](#quickstart) above *is* a complete deploy: one container, one volume. Run it on a home server or any Docker host. Warren serves plain HTTP. Put TLS on your edge with Caddy on a home server, or with your ingress.
- **Cluster (`k8s` runtime), the hosted target.** Set `WARREN_RUNTIME=k8s` and each run becomes its own pod, with **GKE Autopilot** as the reference cluster. Kubelet enforces per-run CPU and memory, and a runaway run kills its own pod, not the control plane. Admission caps shed load before the cluster thrashes. Two features degrade: previews are off, and steering is a 5s poll rather than real-time. The canonical procedure is **[docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md)**, and the manifest quick-start is [`deploy/k8s/README.md`](deploy/k8s/README.md).

Continuous deployment ships in [`.github/workflows/deploy-gke.yml`](.github/workflows/deploy-gke.yml).

A published GitHub release (cut by [`release.yml`](.github/workflows/release.yml)) builds the three SHA-pinned images, publishes the control plane to `ghcr.io`, and rolls the GKE Autopilot deployment forward.

The job then fails unless the rolled-out image is the released SHA **and** the ingress `/version` reports the released semver.

Auth is GCP Workload Identity Federation, so there are no long-lived keys. The OIDC provider, service account, and cluster coordinates are repo secrets and variables (see [docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md) §1.6).

### Observability on a live deploy

Warren ships enough operator-visible surface to stay inspectable without extra infrastructure. The pieces:

- **Health and readiness probes.** `GET /healthz` is a cheap liveness check that returns `{ok: true}` and needs no auth. Point an uptime monitor or the cluster's liveness probe at it. `GET /readyz` runs deeper diagnostics (DB reachable, bwrap usable under `local`) and returns a `DiagnosticCheck[]` payload. Use it for deploy gating and the cluster's readiness probe, not for hot-path liveness. `GET /version` returns `{version}` straight from `src/index.ts`, which confirms that a rollout actually swapped the image. [`deploy-gke.yml`](.github/workflows/deploy-gke.yml) polls it after every release and fails the deploy on a mismatch.
- **Structured JSON logs.** The server emits one [pino](https://getpino.io) JSON line per event on stdout (name `warren`, level from `WARREN_LOG_LEVEL`, default `info`). Stream them with `docker compose logs -f warren` on a single box, or `kubectl -n warren logs deploy/warren` on a cluster. Pipe through `| jq` for ad-hoc filtering. Ship to an external store with a [pino transport](https://getpino.io/#/docs/transports) if you need retention beyond your log driver's window.
- **Correlation IDs.** Every HTTP response carries an `X-Request-ID` header (`src/server/request-id.ts`, warren-30af). Warren honours a well-formed inbound `X-Request-ID` and otherwise mints one. The same id binds into the per-request pino child logger, so `jq 'select(.req_id == "…")'` over the logs reconstructs the full server-side trace for one client call. Forward the header from any reverse proxy in front of warren to keep the chain unbroken.
- **Per-run cost and token usage.** Warren populates the `runs.cost_usd` and `runs.tokens_*` columns for the `pi` and `claude-code` built-ins (see [docs/design/agent-composition.md](docs/design/agent-composition.md)). The UI run-detail page surfaces them, and `GET /analytics/cost?from=&to=&projectId=` aggregates across runs (`src/db/repos/runs.ts:listForAnalytics`). A per-run `maxCostUsd` cap in `.warren/config.yaml` cancels a run at its spend ceiling (see [docs/design/warren-config.md](docs/design/warren-config.md)).
- **Pre-flight checks.** Run `warren doctor --local` (`src/cli/commands/doctor.ts`) on a deployed instance. It surfaces common misconfigurations: empty or placeholder bearer tokens, unbalanced preview markers, and a missing `WARREN_PREVIEW_HOST` on a project that uses previews. Cheaper than reading the logs after a failed run.

Both runtimes serve `GET /metrics` (bearer-gated, warren-682a), a Prometheus exposition endpoint. Each scrape reports run-count, cost, token, and event-stream gauges (`src/server/handlers/metrics.ts`), plus pod-lifecycle gauges under `k8s`. Warren carries no OpenTelemetry exporter. For richer tracing, the request-id and pino combination is the seam to extend.

## Community

Questions, help, or feedback? [Join the Discord](https://discord.gg/4r6r5jUEFE).

## Optional integrations

Warren bundles a few [os-eco](https://github.com/jayminwest/os-eco) tools as opt-in features. A basic run needs none of them, and each one stays silent until a project uses it.

- **Agent memory.** A project with a `.mulch/` directory gets its expertise primed into every run, and reap merges new records back with last-write-wins by timestamp.
- **Issue queue.** A project with a `.seeds/` directory lets agents read the queue, claim work, file follow-ups, and close finished issues. `.seeds/` also unlocks serial plan-run dispatch and past-due `extensions.scheduledFor` triggers (see [docs/design/scheduler.md](docs/design/scheduler.md) and [docs/design/plan-run-coordinator.md](docs/design/plan-run-coordinator.md)). Tune the plan-run coordinator with `WARREN_PLAN_RUN_TICK_MS` (default 10s), or turn it off with `WARREN_PLAN_RUN_DISABLED=1`.
See the topic records under [docs/design/](docs/design/) for the full contracts.

## Extensions

The audit log and the judge from [Why warren](#why-warren) are not core code. Each one is an out-of-process extension under [`extensions/`](extensions/): a standalone Bun package with its own lockfile, tests, and container image. An extension consumes warren's published HTTP surface only. It never imports `src/`, and core never imports an extension. The `check:layers` gate enforces the boundary in both directions.

[`extensions/audit-log/FRICTION.md`](extensions/audit-log/FRICTION.md) records every gap the flagship build found in that HTTP surface. That list is the spec for the future extension loader and public catalog. See [docs/design/extensions.md](docs/design/extensions.md).

## PR-body template

After a successful run, warren opens a PR with a generated body: summary, run link, commits, files-changed, prompt, and a trailer.

A project overrides individual sections by shipping a `.warren/pr-template.md` file. Every `## <fragment_name>` heading replaces the default body for that fragment. Unspecified fragments keep the built-in defaults, so you can override just one piece.

```markdown
## trailer

Reviewed-by: @platform-team

Please follow our [PR checklist](https://example.com/checklist) before merging.
```

Recognized fragment names: `title`, `summary`, `run`, `seeds`, `preview_url_or_placeholder`, `commits`, `files_changed`, `prompt`, `trailer`.

A whitespace-only body removes the fragment entirely. Unknown names and unbalanced preview markers surface through `warren doctor`, so typos are loud. See [docs/design/preview-environments.md](docs/design/preview-environments.md) for the full fragment contract.

## Per-run preview environments

When a project ships a `.warren/preview.yaml`, warren launches `preview.command` as a sidecar inside the same run workspace after a successful run. It then allocates a port and exposes the running app at `https://run-<runId>.<WARREN_PREVIEW_HOST>`.

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

**TLS through Caddy with a wildcard cert.** TLS stays on the operator's edge (see [SECURITY.md](SECURITY.md)). Use Caddy's DNS-01 challenge to issue `*.preview.warren.example.com`, because HTTP-01 cannot issue wildcards. Minimal Caddyfile snippet:

```caddyfile
*.preview.warren.example.com {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy localhost:8080
}
```

Caddy's DNS-01 plugin supports Cloudflare, Route 53, DigitalOcean, Hetzner, Linode, OVH, Vultr, and others. See [caddy-dns](https://github.com/caddy-dns) for the current list. If your provider is absent from it, an operator-controlled per-project subdomain pattern is the alternative.

**Lifecycle knobs.** [`.env.example`](.env.example) documents the idle-TTL, lifetime, live-count, and port-range knobs with their defaults.

Per-project overrides for `idle_ttl` and `max_lifetime` live in `.warren/preview.yaml`. `/readyz` surfaces port-allocator saturation warnings.

Warren does not route cross-host preview traffic: the proxy returns **501** for off-host runs (`runs.worker_id` other than the local worker). The `k8s` runtime provider superseded the multi-worker model that once scoped this work (old R-12). See [ROADMAP.md](ROADMAP.md). See [docs/design/preview-environments.md](docs/design/preview-environments.md) for the full design.

## Architecture

Warren runs against a swappable **runtime provider**, selected once at boot by `WARREN_RUNTIME` (`src/runtime/registry.ts`), behind one contract (`src/runtime/contract.ts`). Two topologies share the same domain code:

- **`local` (default): self-host.** The whole system is one container. Warren isolates each run with `bwrap` through its own in-process engine. This is the primary path everything above describes.
- **`k8s`: scale-out.** Each run is its own Kubernetes pod. Built for clusters and GKE Autopilot. See [**the K8s runbook**](docs/RUNBOOK-K8S.md) and [`deploy/k8s/`](deploy/k8s/README.md).

GitHub access sits behind the same kind of seam: a **forge**, resolved once at boot by `WARREN_FORGE` (`src/forge/registry.ts`). The default `github` forge authenticates with a static PAT. The `app` forge runs warren as a GitHub App and mints a short-lived installation token per operation. Register an App in one browser round-trip at `GET /github-app/register` (see [the K8s runbook §2.6](docs/RUNBOOK-K8S.md)). A `fake` forge backs the acceptance harness.

Only `src/forge/` speaks the GitHub REST API, and `check:layers` holds that boundary. The contract is [docs/design/forge-contract.md](docs/design/forge-contract.md).

```
┌──────────────── container (bwrap-friendly host) ────────────────┐
│  supervisor  ───►  warren        (Bun.serve :8080, SPA + API)   │
│  (Bun parent)        └─► in-process engine drives bwrap runs    │
│                                                                 │
│  /data/                                                         │
│  ├── projects/<o>/<n>/    ← cloned project repos                │
│  ├── local/               ← engine home (workspaces, run state) │
│  └── warren.db            ← warren's SQLite (runs, events)      │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │  HTTPS (terminated upstream)
                          [browser]
```

That is the default (`local`) topology. Warren owns the sandbox engine in-process. See [docs/design/runtime-and-supervisor.md](docs/design/runtime-and-supervisor.md) for the full layout.

Under `WARREN_RUNTIME=k8s` this diagram changes shape entirely. Warren is a Deployment, and each run is a pod ([docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md)).

## CLI

The `warren` (or `wr`) CLI is the agent-facing surface: the same pipeline the web UI drives, scriptable from any shell. The web UI is for daily human work.

Install it from npm. The package ships raw bun-shebang TypeScript, so it needs [Bun](https://bun.sh) v1.1+ on the machine that runs it. No build step, no Node fallback:

```bash
npm i -g @os-eco/warren-cli
```

Programmatic consumers import the typed client straight from the package: `import { WarrenClient } from "@os-eco/warren-cli/client"`.

Every remote-capable command talks to a warren server over HTTP. A local user is a remote user pointed at localhost. Server resolution: `--url`/`--token` flags, then `WARREN_BASE_URL` (default `http://localhost:8080`) / `WARREN_API_TOKEN`, then the client config file `warren login` writes. The genuinely-local commands are `serve`, `db migrate-to-postgres`, and `doctor --local`.

Agents bootstrapping a session run `warren prime` first. It emits the command reference (derived from the program definition), the env contract, the stable exit-code table, and the canonical workflows. Then store credentials once, piping the token on stdin so it stays out of shell history:

```bash
warren prime
echo "$WARREN_API_TOKEN" | warren login --url https://warren.example.com
```

| Command | Description |
|---|---|
| `warren login --url <base>` | Verify a base URL + token against `/whoami` and persist them to `~/.warren/client.json` (mode 0600; token via flag, env, or stdin) |
| `warren prime` | Agent session context: command reference, env contract, exit-code table, canonical workflows |
| `warren add-project <git-url>` | Register a project (POST /projects); the server clones it under its projects root |
| `warren run <agent> <project> -p "..."` | One-shot run, no UI: dispatch, tail events as NDJSON, exit with the terminal state |
| `warren plan run <plan-id> --project <id> --agent <name>` | Dispatch a serial plan-run, tail events as NDJSON |
| `warren plan cancel <plan-run-id>` | Cancel a plan-run and its in-flight child |
| `warren plan status <plan-run-id>` | Child-state table with per-child cost and duration |
| `warren plan list [--project --state]` | List plan-runs, optionally filtered |
| `warren init` | Scaffold a `.warren/` directory in a project |
| `warren doctor` | Client half: server reachable? auth valid? version match? |
| `warren doctor --local` | Deployment half: runtime reachable? Bwrap working? DB reachable? |
| `warren serve` | Start the HTTP server (default in entrypoint) |
| `warren db migrate-to-postgres --from <sqlite> --to <pg-url>` | One-shot SQLite → Postgres porter |

`warren run claude-code <project> -p "..."` drives the full composition end-to-end through the server. The server resolves the agent, provisions the sandbox, dispatches the run, streams events back, then pushes the branch. A project with `.mulch/` or `.seeds/` round-trips those too.

## HTTP API

The route list comes from `ROUTE_TABLE`. `bun run gen:docs` writes [`docs/http-api.md`](docs/http-api.md), and `bun run gen:openapi` writes [`docs/openapi.yaml`](docs/openapi.yaml).

`Authorization: Bearer ${WARREN_API_TOKEN}` is required on every route except `/healthz` and `/version`. Warren serves plain HTTP. Put TLS on your edge with Caddy on a home server, or with your cluster's ingress.

## Development

Requires [Bun](https://bun.sh) v1.1+.

```bash
bun install
bun test                  # all unit tests
bun run verify            # every quality gate CI enforces (alias of check:all)
```

[CONTRIBUTING.md](CONTRIBUTING.md) lists the full build-and-test command set.

UI development is a separate package:

```bash
bun run ui:install
bun run ui:dev
```

The acceptance harness in [`scripts/acceptance/`](scripts/acceptance/) drives end-to-end scenarios against a live container. See [ACCEPTANCE.md](ACCEPTANCE.md) for the runbook. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, testing conventions, and PR expectations. [docs/README.md](docs/README.md) indexes every document in the repo.

## Project layout

```
src/
├── index.ts            library entry (currently VERSION constant only)
├── core/               types, errors, id minting (ag_*, prj_*, run_*)
├── registry/           agent definition resolution (built-in + library)
├── projects/           GitHub clone management
├── forge/              boot-resolved GitHub access: PAT, App, fake (docs/design/forge-contract.md)
├── runs/               spawn / stream / reap composition flow (docs/design/agent-composition.md)
├── plan-runs/          serial plan execution (docs/design/plan-run-coordinator.md)
├── triggers/           cron + scheduled-for dispatcher (docs/design/scheduler.md)
├── warren-config/      .warren/ per-project config loader + cache (docs/design/warren-config.md)
├── client/             typed SDK for driving warren's HTTP API programmatically
├── runtime/            RuntimeProvider contract + local and k8s backends
├── sandbox/            warren-owned bwrap sandbox primitives
├── supervisor/         container entrypoint (spawns warren)
├── server/             Bun.serve HTTP API + static UI serving
├── db/                 drizzle schema + bun:sqlite repos
├── cli/                warren admin commands
└── ui/                 React + Vite + shadcn SPA
```

## Client SDK

`src/client/` exports a typed TypeScript client for driving warren programmatically: dispatching runs, streaming events, and managing projects, agents, and plan-runs. It imports nothing from the server, and it targets scripts, CLIs, acceptance harnesses, and external agents.

```ts
import { WarrenClient } from "./src/client/index.ts";

const warren = WarrenClient.fromEnv();  // WARREN_BASE_URL + WARREN_API_TOKEN
await warren.probe();  // throws WarrenUnreachableError if warren is down

const { run } = await warren.dispatch({
  agent: "claude-code",
  project: "my-project",
  prompt: "Add input validation to the signup form",
});

const final = await warren.waitForRun(run.id, {
  onTick: (r) => console.log(`${r.id}: ${r.state}`),
});
console.log(`Run ${final.state}, PR: ${final.prUrl}`);
```

The same client streams events (`streamRunEvents`, with `follow`), steers a live run (`steer`), and drives plan-runs (`createPlanRun`, `getPlanRun`, `listPlanRuns`). A failed call throws `WarrenClientError` (with `status`, `code`, and `hint`) or `WarrenUnreachableError`. The full type surface (all inputs, outputs, row shapes, enums) is in `src/client/types.ts`.

## Operating model

How the current release is scoped. Full details in [SECURITY.md](SECURITY.md#v1-security-posture-known-limitations):

- **Single bearer token.** Rotation, expiry, and scopes are not supported. Rotate by editing `.env` (or the cluster secret) and bouncing the container. Per-user identity is on the roadmap ([ROADMAP.md](ROADMAP.md)).
- **TLS is upstream's job.** Direct HTTP on a non-loopback bind is a misconfiguration, and `warren doctor` warns.
- **Trust-the-socket** between warren and the runtime inside the container, which share the container by design.
- **No CSRF, single-user.** The UI calls warren's API with the bearer, and CORS is strict.
- **SQLite by default, Postgres optional.** Run history and scheduler state live in `/data/warren.db` on the local volume out of the box. Org-scale deploys can attach a managed Postgres by setting `WARREN_DB_URL=postgres://user:pw@host/db`.
- **One host is the concurrency ceiling in the `local` topology.** A single container caps concurrency at what one box can sandbox. The scale-out answer is the `k8s` runtime (each run a pod, cluster-scheduled with admission caps). See [docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md).

## Roadmap

Warren extends from "one team, one box" to a 50-engineer org on its own infra. [ROADMAP.md](ROADMAP.md) owns the sequencing: what is in flight, what is next, and what stays out of core.

## Security

Found a vulnerability? Please follow the disclosure process in [SECURITY.md](SECURITY.md).

## Part of os-eco

Warren is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

## License

MIT. See [LICENSE](LICENSE).
