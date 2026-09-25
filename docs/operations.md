# Operations and observability

Warren exposes enough operational state to run a single-box or cluster deployment without a required observability stack. This page covers the common surface. The [Kubernetes runbook](RUNBOOK-K8S.md) adds pod-specific procedures.

## Probes

`GET /healthz` is an auth-free liveness probe. It returns a cheap `{ok: true}` response and is suitable for a container or load-balancer health check.

`GET /readyz` requires the operator bearer token. It checks the database, registered agents, project configuration, and the selected runtime. Use it during deployment and diagnosis rather than on every request.

`GET /version` reports the running warren version. Release automation uses it to prove that a rollout replaced the image.

## Structured logs

Warren writes one Pino JSON object per line to stdout. `WARREN_LOG_LEVEL` selects the minimum level and defaults to `info`.

```bash
docker compose logs -f warren | jq
kubectl -n warren logs deploy/warren | jq
```

Configure retention in the container runtime, cluster logger, or an external Pino transport. The shipped Compose file rotates its `json-file` logs.

## Request IDs

Every HTTP response includes `X-Request-ID`. Warren accepts a valid incoming ID or creates one, then binds it to the request logger. Forward the header through a reverse proxy so one value traces the request across the edge and server logs.

```bash
jq 'select(.req_id == "<request-id>")' warren.log
```

## Metrics

`GET /metrics` is bearer-gated and uses Prometheus exposition format. It reports run counts, cost, tokens, event-stream state, and runtime-specific gauges. Kubernetes deployments also expose pod lifecycle metrics.

Use the endpoint for alerting on admission rejection, runtime loss, finalization failure, and growing queue depth. The [Kubernetes runbook](RUNBOOK-K8S.md#6-observability) lists its provider-specific metrics and alert signals.

## Cost and tokens

Each run can record cost and token totals when its harness adapter supplies usage events. The UI exposes per-run values and analytics. `GET /analytics/cost` aggregates them by project, agent, provider, and model.

A cost cap can come from three levels, in strongest-first order:

1. Dispatch override
2. Agent frontmatter
3. Project `maxCostUsd` default

Warren enforces the resolved cap during the run. A malformed agent cap fails open rather than overriding a valid project default silently.

## Run duration cap

A wall-clock cap in whole minutes uses the same three levels: the `maxDurationMinutes` dispatch field (`warren run --max-duration-minutes`), the agent's `frontmatter.maxDurationMinutes`, and the project `maxDurationMinutes` default in `.warren/config.yaml`.

The run watchdog enforces the cap on each tick. When a running run passes `started_at` plus the cap, the watchdog emits a `duration.exceeded` event, cancels the workload, and reaps the run `failed` with `failureReason: timed_out`. The deadline comes from persisted columns, so it survives a restart. `WARREN_WATCHDOG_DISABLED=1` also turns off this cap.

## Run events

`GET /runs/:id/events` returns the persisted NDJSON stream. A request follows a non-terminal run by default. Use `?follow=0` for replay, `?since=<seq>` for cursor paging, or `?limit=N` for a bounded read.

The event store is the core run record. The optional audit-log extension consumes this surface and exports a separate append-only projection. The optional judge extension stores its verdicts outside the warren database. Neither extension is part of a base installation.

## Pre-flight checks

Run the deployment-side doctor from the server environment:

```bash
warren doctor --local
```

It checks environment and runtime prerequisites that are cheaper to diagnose before a dispatch. The client-side form checks reachability, authentication, and version compatibility:

```bash
warren doctor --url https://warren.example.com
```

## Backups

The local default stores runtime state in `/data/warren.db`. The same data root also contains managed clones and runtime workspaces. Back up the database and project configuration. Treat active workspaces as recoverable run state rather than the sole copy of source changes.

Postgres deployments set `WARREN_DB_URL`. Back up that database with the operator's normal Postgres procedure. Agent pods and containers do not receive the database credential.

## Common triage order

1. Check `/healthz` and `/version`.
2. Check authenticated `/readyz`.
3. Read the run row and its bounded event tail.
4. Filter server logs by request or run ID.
5. Inspect the selected runtime: local process, sibling container, or Kubernetes pod.
6. Confirm the forge credential can fetch and push the target repository.
7. Confirm the configured cost and admission limits did not reject or cancel the run.

Use [Docker self-hosting](self-host/docker.md) or the [Kubernetes runbook](RUNBOOK-K8S.md) for topology-specific remedies.
