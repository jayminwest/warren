# Warren documentation

This directory holds the operator and contributor documents. The root [README](../README.md) covers what warren is, the quickstart, and the deploy paths — read that first.

Two paths lead out of here. Take the first to run warren against your own repos. Take the second to change warren itself.

## Path 1 — run warren

- [`../README.md`](../README.md) — what warren is, the container quickstart, and the two deploy shapes.
- [`project-setup.md`](project-setup.md) — how to make one of your repos ready for warren: the `.warren/` directory, dispatch defaults, and the PR template.
- [`RUNBOOK-K8S.md`](RUNBOOK-K8S.md) — the operator playbook for the `k8s` runtime: deploy, secrets and rotation, RBAC, garbage collection, admission caps, observability, and incident response.
- [`../deploy/k8s/README.md`](../deploy/k8s/README.md) — the Kubernetes manifest quick start: overlay layout, `kubectl apply -k`, and the secret commands.
- [`PHILOSOPHY.md`](PHILOSOPHY.md) — the ideas warren rests on, and why the loop has the shape it has.
- [`../SECURITY.md`](../SECURITY.md) — the threat model, and how to report a vulnerability.

## Path 2 — change warren

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — branch names, build commands, test conventions, and what a pull request must carry.
- [`../AGENTS.md`](../AGENTS.md) — the same ground for a coding agent: repo map, quality gates, and the rules an agent must obey here.
- [`labels.md`](labels.md) — the GitHub label taxonomy that triage and the issue templates depend on.
- [`http-api.md`](http-api.md) — every HTTP route with its auth posture. `bun run gen:docs` writes this file from `ROUTE_TABLE`.
- [`openapi.yaml`](openapi.yaml) — the same surface as an OpenAPI 3.1 schema. `bun run gen:openapi` writes it from the same route table.
- [`CONSTITUTION.md`](CONSTITUTION.md) — the articles that govern warren-authored code, commits, and bot identity.
- [`../ROADMAP.md`](../ROADMAP.md) — what is in flight now, what comes next, and what warren will not do.
- [`../ACCEPTANCE.md`](../ACCEPTANCE.md) — the scenario harness that drives a live stack from end to end.

## Design records

These two documents record the design of the Kubernetes runtime. Both shipped in v0.10.0, so read them as history rather than as a plan.

- [`design/k8s-migration.md`](design/k8s-migration.md) — why each run became a pod: the OOM postmortem, pod-per-run, the init container, pod-log event streams, and `run_inbox` steering.
- [`design/runtime-provider-contract.md`](design/runtime-provider-contract.md) — the `RuntimeProvider` seam that lets the `local` and `k8s` backends swap without a domain rewrite.

## History

- [`CHANGELOG-archive.md`](CHANGELOG-archive.md) — released versions older than the window the current [`../CHANGELOG.md`](../CHANGELOG.md) keeps.
