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

<a href="https://www.producthunt.com/products/warren-5?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-warren-5" target="_blank" rel="noopener noreferrer"><img alt="Warren - Infrastructure for coding-agent workloads | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1232085&amp;theme=light&amp;t=1787762729601"></a>

**[Live runs](https://app.warren.run)** · **[Quickstart](#quickstart)** · **[Documentation](docs/README.md)** · **[Demo](https://youtu.be/daa7y8g9BkM)** · **[Roadmap](ROADMAP.md)**

</div>

# Warren

## Coding agents are tools. Warren turns them into infrastructure.

Warren runs agent harnesses as isolated, observable workloads on infrastructure you control. It owns the workspace, run lifecycle, spend limits, live events, intervention, recovery, and Git delivery.

## When a run becomes a workload

Warren becomes useful when an agent run stops being a terminal session and starts being a workload. The run may need to continue unattended, repeat on a schedule, survive failure, or become visible to someone besides the person who started it.

You can run warren alone. A small, trusted engineering team can share one deployment and one trust boundary today.

```text
repository + task
       │
       ▼
isolated agent workload
       │
       ├── live events
       ├── spend and concurrency limits
       ├── steering and cancellation
       └── recovery and cleanup
       │
       ▼
pushed branch ──► optional pull request
```

## What warren owns

- **Workspace.** Each run starts from a fresh worktree or clone on its own branch.
- **Isolation.** Runs operate under `bwrap`, in a sibling Docker container, or in a Kubernetes pod.
- **Lifecycle.** Warren dispatches, monitors, cancels, finalizes, and cleans up each run.
- **Control.** Streams stay live, steering reaches supported harnesses, and spend caps hold during execution.
- **Recovery.** Watchdogs reconcile lost processes and pods. Finalization salvages work before teardown when possible.
- **Git delivery.** Agents commit their changes. Warren manages Git credentials, branch construction, push, and configured PR creation.
- **History.** Run state, events, cost, token use, and outcomes persist behind one HTTP API, CLI, and UI.

The core guarantee is a pushed workspace branch. Project settings can add PR creation, tracker updates, previews, and other reactions.

## Harnesses and runtimes

A **harness** is the coding-agent process warren drives. A **runtime** is the place where that workload runs.

Warren's run model supports any harness with a Warren runtime adapter. The current distribution includes adapters for Pi and Claude Code. Agent roles such as planner, healer, and PR fixer compose prompts and policy on top of those harnesses.

Three runtime providers implement the same lifecycle:

| Runtime | Isolation boundary | Best fit |
|---|---|---|
| `local` | `bwrap` on Linux, `sandbox-exec` on macOS | One host |
| `docker` | Sibling container | Docker hosts and custom agent images |
| `k8s` | Pod per run | Cluster scheduling and admission control |

## Who it fits today

Warren fits individual operators and small, trusted teams that already use coding agents and want the runs off a developer terminal. It is especially useful when code, model credentials, compute, and run history must remain on infrastructure the operator controls.

The current boundary is explicit:

- One deployment serves one operator or trusted team.
- One bearer credential guards the operator surface.
- Warren has no named users, RBAC, or per-user attribution.
- The shipped forge supports GitHub PAT and GitHub App credentials.
- Warren is self-hosted software, not a hosted SaaS.

See [Security](SECURITY.md) for the full threat model and [Roadmap](ROADMAP.md) for future work.

## Quickstart

### CLI-only install

On macOS or Linux, the one-liner installs Bun if needed and the `warren` CLI globally (no sudo, user-local paths):

```bash
curl -fsSL https://warren.run/install | sh
```

That lands `warren` on your PATH and prints the next step, `warren up`. To pin a version or install a local build, see the env knobs (`WARREN_INSTALL_VERSION`, `WARREN_INSTALL_TARBALL`) documented at the top of [`scripts/install.sh`](scripts/install.sh). The script itself lives in this repo. The warren.run serving side lives in the warren-site repo.

### Full deployment via Compose

The shortest complete path uses the shipped Compose file and the `local` runtime on a Linux Docker host. Compose includes the security flags that nested `bwrap` needs.

```bash
git clone https://github.com/jayminwest/warren
cd warren
cp .env.example .env
$EDITOR .env                 # set two secrets plus WARREN_GIT_AUTHOR_NAME/EMAIL
docker compose up -d
docker compose logs warren | grep mintedOperatorToken
```

Open <http://localhost:8080>, paste the minted token, add a GitHub repository, and dispatch a run. Warren streams the events and pushes the result branch.

For the sibling-container topology, custom agent images, persistent paths, and macOS Docker Desktop requirements, use the [Docker self-host guide](docs/self-host/docker.md). For Kubernetes, use the [Kubernetes runbook](docs/RUNBOOK-K8S.md).

## Optional integrations and extensions

A fresh install needs no other os-eco tool. Projects can opt into persistent [Mulch](https://github.com/jayminwest/mulch) memory or the [Seeds](https://github.com/jayminwest/seeds) issue tracker by committing their data directories.

The audit log and judge are optional, out-of-process extensions. They do not run in a base warren installation:

- [`extensions/audit-log/`](extensions/audit-log/) exports append-only JSONL run activity.
- [`extensions/judge/`](extensions/judge/) scores finished runs against a versioned rubric and stores verdicts separately.

See [Extensions](docs/design/extensions.md) for their contracts and current packaging limits.

## Documentation

- [First run](docs/quickstart.md)
- [Docker self-hosting](docs/self-host/docker.md)
- [Kubernetes operations](docs/RUNBOOK-K8S.md)
- [Operations and observability](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Project configuration](docs/design/warren-config.md)
- [Preview environments](docs/previews.md)
- [PR templates](docs/pr-templates.md)
- [CLI reference](docs/cli-reference.md)
- [HTTP API](docs/http-api.md) and [OpenAPI](docs/openapi.yaml)
- [TypeScript SDK](docs/sdk.md)
- [Contributing](CONTRIBUTING.md)

## Roadmap

[ROADMAP.md](ROADMAP.md) owns warren's direction and sequencing. It tracks what is in flight, what comes next, what has shipped, and what stays out of core.

## Status

Stable (`0.18.0`). The run lifecycle is in continuous use on GKE. It operates against real repositories, including this one. [app.warren.run](https://app.warren.run) exposes the read-only run history and event streams without a login.

Warren is pre-1.0. Unit, integration, and scenario tests exercise the run lifecycle. The current shared-token trust model remains a deliberate limit.

## License

MIT. See [LICENSE](LICENSE).
