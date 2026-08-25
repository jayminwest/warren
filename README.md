<p align="center">
  <a href="https://warren.run">
    <img src="branding/logo.png" alt="Warren — coding agents into infrastructure" width="640">
  </a>
</p>

<div align="center">

[![CI](https://img.shields.io/github/actions/workflow/status/jayminwest/warren/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/jayminwest/warren/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/jayminwest/warren?style=for-the-badge&label=Release)](https://github.com/jayminwest/warren/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2.svg?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/4r6r5jUEFE)

**[Live runs](https://app.warren.run)** · **[Demo](https://youtu.be/daa7y8g9BkM)** · **[Quickstart](#quickstart)** · **[Docs](docs/README.md)** · **[Contributing](CONTRIBUTING.md)** · **[Roadmap](ROADMAP.md)**

</div>

# Warren

Warren is the self-hosted control plane for coding agents. Give it a repository and a task. It runs the agent in an isolated workload, streams what happens, enforces limits, and delivers a pushed branch or pull request.

Run Pi and Claude Code through the same lifecycle on one Linux host, in sibling Docker containers, or as pods in your Kubernetes cluster. Your code, model credentials, compute, and run history stay on infrastructure you control.

- **Every run gets its own workspace.** Warren starts from a fresh worktree or clone on a dedicated branch, then cleans it up when the run ends.
- **Agents run behind a real isolation boundary.** Use `bwrap`, a sibling Docker container, or one Kubernetes pod per run.
- **Watch and intervene live.** Events stream to the UI, CLI, and API. Steer supported harnesses, cancel bad runs, and inspect the complete history later.
- **Put limits around autonomous work.** Enforce spend caps, concurrency limits, timeouts, and cluster admission before one run becomes everyone else's problem.
- **Recover useful work.** Watchdogs reconcile lost workloads, and finalization salvages and pushes changes before teardown when possible.
- **Deliver Git, not a transcript.** The kernel guarantee is a pushed workspace branch. Project settings can add pull requests, previews, tracker updates, and other reactions.

**[See Warren running Warren](https://app.warren.run)** · real projects · real runs · live event streams · no login

Questions, ideas, or deployment help? **[Join the Discord](https://discord.gg/4r6r5jUEFE)**.

---

## Table of contents

- [Why Warren](#why-warren)
- [How it works](#how-it-works)
- [Features](#features)
- [Quickstart](#quickstart)
- [Harnesses and runtimes](#harnesses-and-runtimes)
- [Automation and integrations](#automation-and-integrations)
- [Who it fits today](#who-it-fits-today)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Status](#status)
- [Community and contributing](#community-and-contributing)
- [License](#license)

## Why Warren

An agent in a terminal is a tool. An agent that runs unattended, repeats on a schedule, works through a queue, or serves a team is a workload.

That workload needs more than a prompt:

- **A safe place to run.** Agent processes should not inherit an operator's entire machine.
- **A lifecycle.** Dispatch, observe, steer, cancel, recover, finalize, and clean up should work the same way every time.
- **A budget.** Spend and concurrency need hard boundaries while the run is still active.
- **A durable record.** Events, usage, cost, prompts, and outcomes should survive the terminal session.
- **A delivery path.** Useful work should leave behind a branch or pull request, even when the process fails late.
- **A control surface.** Humans and automation should operate the same run through a UI, CLI, SDK, or HTTP API.

Warren owns that layer. The coding-agent harness remains replaceable, the runtime remains replaceable, and the repository remains the source of truth.

## How it works

```text
repository + task
       │
       ▼
resolve agent, model, limits, and project policy
       │
       ▼
create isolated workspace and workload
       │
       ├── stream events and usage
       ├── enforce spend and concurrency limits
       ├── accept steering or cancellation
       └── reconcile crashes and lost workloads
       │
       ▼
finalize changes ──► push branch ──► optional pull request
       │
       └── cleanup, previews, tracker updates, and other reactions
```

A run freezes its resolved agent, provider, model, limits, and workspace intent at dispatch. Registry or project changes do not mutate work already in flight.

Warren separates two things that are often bundled together:

- An **agent runtime adapter** knows how to start a harness, parse its events, extract usage, detect failures, and deliver steering.
- A **runtime provider** decides where the workload lives and how Warren communicates with it.

That separation lets Pi and Claude Code follow one run lifecycle across local, Docker, and Kubernetes deployments.

## Features

### Runs and control

| Capability | What it does |
|---|---|
| **Isolated workspaces** | Creates a fresh worktree or clone on a run branch, separate from the control plane and other runs |
| **Live event streams** | Persists normalized events and tails them through the web UI, CLI, SDK, or NDJSON HTTP stream |
| **Steering and cancellation** | Sends follow-up instructions to supported harnesses or stops a run cleanly |
| **Spend limits** | Tracks model usage and enforces a per-run USD ceiling during execution |
| **Concurrency and admission** | Caps work per project and protects Kubernetes clusters from excess queued or Pending pods |
| **Recovery** | Reconciles lost processes and pods, retries lifecycle work safely, and salvages changes during finalization |
| **Git delivery** | Manages credentials, commit identity, branch construction, push, and optional pull request creation |
| **Run history** | Stores prompts, events, cost, token use, state transitions, and outcomes in SQLite or Postgres |

### Automation

| Capability | What it does |
|---|---|
| **Built-in agents** | Ships Pi and Claude Code harness support plus planner, nightwatch, bugwatch, PR fixer, and healer roles |
| **Scheduled runs** | Dispatches project-defined cron triggers through the same path as an interactive run |
| **Plan runs** | Walks an ordered issue plan one task at a time and gates each task on the previous pull request merging |
| **Project policy** | Reads dispatch defaults, limits, branch rules, and repository context from `.warren/config.yaml` |
| **Preview environments** | Starts an optional review app from a successful run workspace and exposes its lifecycle in Warren |
| **Forge integration** | Supports GitHub PAT and GitHub App credentials for clone, push, checks, and pull requests |

### Operations

| Capability | What it does |
|---|---|
| **One control surface** | Serves the React UI, HTTP API, typed TypeScript SDK, and machine-friendly CLI from the same domain pipeline |
| **Runtime choice** | Places runs in a local sandbox, sibling Docker container, or Kubernetes pod |
| **Operational visibility** | Exposes health, readiness, version, Prometheus metrics, structured logs, and request correlation IDs |
| **Storage choice** | Uses SQLite by default and supports Postgres for a shared deployment |
| **Public projection** | Can expose a deliberately restricted, read-only view of public projects while keeping mutation routes authenticated |

## Quickstart

The shortest complete path uses Docker Compose on a Linux host. You need Docker, an Anthropic API key, and a GitHub token with clone and push access. You also need a Git author name and email.

```bash
git clone https://github.com/jayminwest/warren
cd warren
cp .env.example .env
$EDITOR .env                 # set the two secrets and Git author identity
docker compose up -d
docker compose logs warren | grep mintedOperatorToken
```

Leave `WARREN_API_TOKEN` empty on first boot. Warren mints an operator token, persists it under the data directory, and prints it once as `mintedOperatorToken`.

Open <http://localhost:8080>, paste the token, add a GitHub repository, and dispatch a run. The events panel streams live, and a successful run pushes its result branch.

The Compose file selects the `local` runtime and includes the Linux security settings needed for nested `bwrap`. For sibling-container isolation, custom agent images, persistent paths, and macOS Docker Desktop requirements, follow [Docker self-hosting](docs/self-host/docker.md). For a cluster deployment, use the [Kubernetes runbook](docs/RUNBOOK-K8S.md).

Install the CLI when you want the same control surface from a shell:

```bash
npm i -g @os-eco/warren-cli
echo "$WARREN_API_TOKEN" | warren login --url http://localhost:8080
warren projects
```

The full first-run walkthrough is in [docs/quickstart.md](docs/quickstart.md).

## Harnesses and runtimes

A harness needs a Warren adapter before the runtime can drive it. The current distribution includes adapters for **Pi** and **Claude Code**. Agent roles compose prompts and policy on top of those harnesses rather than creating separate execution paths.

Warren selects one runtime provider at boot with `WARREN_RUNTIME`:

| Runtime | Isolation boundary | Best fit |
|---|---|---|
| `local` | `bwrap` on Linux, `sandbox-exec` on macOS | One host with the lowest operational overhead |
| `docker` | Sibling container per run | Docker hosts and custom agent images |
| `k8s` | Pod per run | Cluster scheduling, resource limits, and admission control |

The providers implement one lifecycle but advertise their differences explicitly. Domain code branches on capabilities such as preview ports, network policy, resource limits, archival, and garbage collection instead of checking runtime names.

## Automation and integrations

A fresh Warren install does not require any other os-eco tool.

Projects can opt into persistent [Mulch](https://github.com/jayminwest/mulch) memory by committing a `.mulch/` directory. They can opt into the [Seeds](https://github.com/jayminwest/seeds) issue queue and plan-run support with `.seeds/`. External trackers can connect through Warren's `IssueTracker` seam and `RemoteTracker` bridge.

Two optional, out-of-process extensions demonstrate the published boundaries:

- [`extensions/audit-log/`](extensions/audit-log/) tails run events into an append-only audit log.
- [`extensions/judge/`](extensions/judge/) scores finished runs against a versioned rubric and stores verdicts separately.

Neither extension runs in a base installation. See [Extensions](docs/design/extensions.md) for the delivered contract and current packaging limits.

## Who it fits today

Warren is for individual operators and small, trusted engineering teams that already use coding agents and want those runs off a developer terminal. It is especially useful when code, model credentials, compute, and run history must stay on infrastructure the operator controls.

The current boundary is straightforward:

- One deployment serves one operator or trusted team.
- One bearer credential guards the operator surface.
- Warren has no named users, RBAC, or per-user attribution yet.
- The shipped forge supports GitHub PAT and GitHub App credentials.
- Warren is self-hosted software, not a hosted SaaS.

Read [Security](SECURITY.md) for the threat model and [Roadmap](ROADMAP.md) for the path beyond the current trust model.

## Documentation

- **Start:** [First run](docs/quickstart.md) · [Project setup](docs/project-setup.md) · [Docker self-hosting](docs/self-host/docker.md)
- **Operate:** [Kubernetes runbook](docs/RUNBOOK-K8S.md) · [Operations and observability](docs/operations.md) · [Preview environments](docs/previews.md)
- **Integrate:** [CLI reference](docs/cli-reference.md) · [TypeScript SDK](docs/sdk.md) · [HTTP API](docs/http-api.md) · [OpenAPI](docs/openapi.yaml)
- **Understand:** [Architecture](docs/architecture.md) · [Design records](docs/design/README.md) · [Philosophy](docs/PHILOSOPHY.md)
- **Contribute:** [Contributing guide](CONTRIBUTING.md) · [Roadmap](ROADMAP.md) · [Full documentation index](docs/README.md)

## Roadmap

Warren's roadmap is evidence-led. The current phase tests trustworthy autonomous maintenance on unfamiliar scientific repositories, starting with detached mirrors of Snakemake and then a second project. The next planned layer is a campaign controller for durable policy, budgets, reconciliation, and reporting across repeated runs.

Broader integrations, resumable environments, routing, and multi-user auth advance when real deployments or measured pilot friction pay for them. The full [ROADMAP.md](ROADMAP.md) tracks what is in flight, what comes next, what has shipped, and what deliberately stays out of core.

## Status

Stable (`0.18.0`). Warren runs continuously on GKE against real repositories, including this one. [app.warren.run](https://app.warren.run) exposes the public, read-only run history and live event streams.

Warren is pre-1.0. Unit, integration, and scenario tests exercise the run lifecycle. The current shared-token trust model remains a deliberate limit.

## Community and contributing

Questions, help, or feedback? [Join the Discord](https://discord.gg/4r6r5jUEFE).

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), browse the [open issues](https://github.com/jayminwest/warren/issues), or read the [roadmap](ROADMAP.md).

## License

MIT. See [LICENSE](LICENSE).
