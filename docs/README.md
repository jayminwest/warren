# Warren documentation

This directory holds operator, API, architecture, and contributor documentation. Start with the root [README](../README.md) for the product boundary, then choose the path that matches your task.

## Run warren

- [`quickstart.md`](quickstart.md) — the casual path end to end: install script, `warren up`, credential wizard, GitHub App connect, first run.
- [`credentials.md`](credentials.md) — the two model paths and the two GitHub paths, including machine-account guidance.
- [`self-host/docker.md`](self-host/docker.md) — local and sibling-container Docker topologies, agent images, persistence, and macOS Docker Desktop requirements.
- [`RUNBOOK-K8S.md`](RUNBOOK-K8S.md) — Kubernetes deployment, secrets, RBAC, garbage collection, admission, and incident response.
- [`../deploy/k8s/README.md`](../deploy/k8s/README.md) — Kubernetes manifest and overlay commands.
- [`operations.md`](operations.md) — probes, structured logs, metrics, run events, cost, backups, and common triage.
- [`../.env.example`](../.env.example) — annotated deployment environment reference.
- [`project-setup.md`](project-setup.md) — repository permissions, CI, auto-merge, and branch cleanup.
- [`onboarding-external-repos.md`](onboarding-external-repos.md) — configure a mirror or repository that you do not control.
- [`previews.md`](previews.md) — optional per-run preview environments, DNS, TLS, auth, and lifecycle.
- [`local-models.md`](local-models.md): dispatch pi runs against a local OpenAI-compatible model server (unsupported but verified).
- [`pr-templates.md`](pr-templates.md) — customize generated pull request body fragments.

## Integrate with warren

- [`cli-reference.md`](cli-reference.md) — every `warren` command, flag, output mode, and exit code.
- [`sdk.md`](sdk.md) — TypeScript client setup, dispatch, events, intervention, and errors.
- [`http-api.md`](http-api.md) — generated route catalog and auth posture.
- [`openapi.yaml`](openapi.yaml) — generated OpenAPI 3.1 schema.
- [`architecture.md`](architecture.md) — run kernel, harness adapters, runtime providers, seams, storage, and source map.
- [`design/warren-config.md`](design/warren-config.md) — `.warren/config.yaml` contract.

## Understand the project

- [`PHILOSOPHY.md`](PHILOSOPHY.md) — product and architecture policy.
- [`design/README.md`](design/README.md) — complete design-record catalog with delivery state.
- [`../ROADMAP.md`](../ROADMAP.md) — current direction and sequencing.
- [`../SECURITY.md`](../SECURITY.md) — threat model and vulnerability reporting.
- [`CONSTITUTION.md`](CONSTITUTION.md) — governance for warren-authored changes.

## Change warren

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — branch names, build commands, tests, and pull request expectations.
- [`../AGENTS.md`](../AGENTS.md) — canonical coding-agent instructions and repository map.
- [`labels.md`](labels.md) — issue and pull request label taxonomy.
- [`../ACCEPTANCE.md`](../ACCEPTANCE.md) — scenario harness for a live stack.

## Generated and authored docs

Generators write the route catalog, OpenAPI schema, CLI reference, and builtin-agent inventory. CI guards them. Humans maintain operator guides and design records.

Design approval does not imply roadmap commitment. [`../ROADMAP.md`](../ROADMAP.md) owns build order, Seeds holds executable work, and [`../CHANGELOG.md`](../CHANGELOG.md) records shipped releases.

## Tombstones

Docs paths are a public surface (warren-d602). When maintainers delete or move a document, its old path stays here as a pointer.

- `deploy/gke-deploy-prep.md` — retired, see [`RUNBOOK-K8S.md`](RUNBOOK-K8S.md) §1.5 (warren-c69e)
- `design/k8s-migration-plan.md` — retired, see [`design/k8s-migration.md`](design/k8s-migration.md) (warren-c69e)
- `design/data-plane-trajectory.md` — retired because its feature no longer exists (warren-c69e)

## History

- [`CHANGELOG-archive.md`](CHANGELOG-archive.md) — releases older than the window in the current [`../CHANGELOG.md`](../CHANGELOG.md).
