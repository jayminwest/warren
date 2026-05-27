# Issue & PR label taxonomy

The canonical label set for warren lives in
[`.github/labels.yml`](../.github/labels.yml) and is mirrored to the
GitHub repository by
[`.github/workflows/sync-labels.yml`](../.github/workflows/sync-labels.yml).

Labels are namespaced (`<group>/<value>`) so that humans and
agents can filter issues programmatically without scanning free-text
fields. The five primary groups are **priority**, **type**, **area**,
**status**, and **effort**.

Issue templates apply baseline labels automatically; maintainers add the
remaining `area/*` / `effort/*` / `status/*` labels during triage.

## Groups

### `priority/*` — how urgent?

| Label          | When to use                                                        |
| -------------- | ------------------------------------------------------------------ |
| `priority/P0`  | Production-impacting or blocks a release. Drop everything.         |
| `priority/P1`  | Required for the next milestone.                                   |
| `priority/P2`  | **Default.** Normal feature / bug work.                            |
| `priority/P3`  | Nice-to-have. Pick up when capacity allows.                        |

Every open issue should carry exactly one `priority/*` label.

### `type/*` — what kind of change?

| Label              | Meaning                                                  |
| ------------------ | -------------------------------------------------------- |
| `type/bug`         | Existing behaviour is incorrect.                         |
| `type/feature`     | New user-facing capability.                              |
| `type/chore`       | Tooling, CI, build, internal cleanup.                    |
| `type/refactor`    | Internal restructure without behaviour change.           |
| `type/docs`        | Documentation-only change.                               |
| `type/test`        | Add, fix, or strengthen tests.                           |
| `type/security`    | Security-sensitive change or vulnerability fix.          |
| `type/performance` | Latency, throughput, or memory improvement.              |

Every issue should carry exactly one primary `type/*` label. Combinations
(e.g. `type/refactor` + `type/test`) are allowed when the work materially
spans two categories.

### `area/*` — which part of warren?

Aligned with the top-level directories under `src/` plus cross-cutting
concerns. Multiple `area/*` labels are fine when work spans subsystems.

| Label              | Surface                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `area/server`      | HTTP API (`src/server/`, `ROUTE_TABLE`, handlers)                           |
| `area/ui`          | React/Vite SPA (`src/ui/`, `@os-eco/warren-ui`)                             |
| `area/cli`         | CLI commands (`src/cli/`, `warren` / `wr` entry points)                     |
| `area/supervisor`  | Supervisor process (`src/supervisor/`, lifecycle, signal handling)          |
| `area/burrow`      | burrow boundary (`src/burrow-client/`, sandbox HTTP facade)                 |
| `area/db`          | Persistence (`src/db/`, drizzle schema/migrations, SQLite/Postgres)         |
| `area/agents`      | Agent registry + built-ins (`src/registry/`, `src/agents/`)                 |
| `area/runs`        | Run lifecycle, events, streaming (`src/runs/`)                              |
| `area/projects`    | Project management (`src/projects/`, `.warren/config.yaml`)                 |
| `area/plot`        | Plot integration (`plot_id` wiring, sync to GitHub)                         |
| `area/plan-runs`   | plan-runs dispatch mode (`src/plan-runs/`)                                  |
| `area/preview`     | Preview environments (`.warren/preview.yaml`)                               |
| `area/scheduler`   | Cron triggers + scheduled runs (`.warren/triggers.yaml`)                    |
| `area/acceptance`  | End-to-end acceptance harness (`scripts/acceptance/`)                       |
| `area/build`       | Build, CI, lint, type-check, ratchets, tooling (`.github/`, `scripts/`)     |
| `area/docs`        | Documentation (`README`, `SPEC`, `AGENTS.md`, `docs/`)                      |
| `area/deps`        | Dependency updates (Dependabot, `bun.lock`, `package.json`)                 |

### `status/*` — workflow state

| Label                  | Meaning                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `status/needs-triage`  | Newly filed; awaits priority/area/type assignment.                |
| `status/blocked`       | Cannot proceed: waiting on dependency, decision, or external party. |
| `status/in-progress`   | Actively being worked on.                                         |
| `status/needs-review`  | Implementation complete; awaiting review.                         |
| `status/needs-info`    | Waiting on the reporter for clarification or repro steps.         |
| `status/wontfix`       | Will not be worked on; out of scope or by design. Close the issue. |
| `status/duplicate`     | Tracked elsewhere; close in favour of the canonical issue.        |

Issue templates apply `status/needs-triage` automatically. Maintainers
remove it once triage assigns the remaining classification labels.

### `effort/*` — rough sizing

| Label             | Estimate                                            |
| ----------------- | --------------------------------------------------- |
| `effort/small`    | < 1 day of focused work                             |
| `effort/medium`   | 1–3 days of focused work                            |
| `effort/large`    | > 3 days; consider splitting via `sd plan`          |

Optional but recommended for any issue picked up by an autonomous agent
so it can decide whether to plan-decompose before starting.

### Discovery labels

| Label                | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `good first issue`   | Good entry point for first-time contributors.                    |
| `help wanted`        | Maintainers welcome external contributions here.                 |

## Legacy GitHub defaults

The original GitHub defaults (`bug`, `enhancement`, `documentation`,
`dependencies`, `javascript`, `question`, `invalid`, `duplicate`,
`wontfix`) are kept for backward compatibility with existing issues and
the Dependabot configuration. New issues should prefer the namespaced
equivalents:

| Legacy            | Canonical                            |
| ----------------- | ------------------------------------ |
| `bug`             | `type/bug`                           |
| `enhancement`     | `type/feature`                       |
| `documentation`   | `type/docs` (+ `area/docs`)          |
| `dependencies`    | `area/deps`                          |
| `duplicate`       | `status/duplicate`                   |
| `wontfix`         | `status/wontfix`                     |

`question` and `invalid` remain in use for support / unactionable
reports.

## Triage workflow

1. **Reporter** files an issue via a template; the template applies
   `type/*`, the requested `priority/*`, the chosen `area/*`, and
   `status/needs-triage`.
2. **Maintainer** confirms or adjusts priority and area, adds an
   `effort/*` estimate when feasible, and removes `status/needs-triage`.
3. **Assignee** sets `status/in-progress` when work starts.
4. On PR open the assignee sets `status/needs-review`; on merge the
   issue is closed.

Agents (humans and autonomous) can filter the backlog with standard
GitHub queries, for example:

```text
is:open is:issue label:priority/P0,priority/P1 no:assignee
is:open is:issue label:area/server label:good first issue
is:open is:issue label:status/needs-triage sort:created-asc
```

## Updating the taxonomy

1. Edit [`.github/labels.yml`](../.github/labels.yml).
2. Update this document.
3. Open a PR; the sync workflow runs in dry-run mode on the PR to show
   the diff in the workflow log.
4. On merge to `main`, the workflow re-runs and applies the change to
   the live label set. `skip-delete: true` is set, so manually-created
   labels are preserved.
