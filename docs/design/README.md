# Warren design records

This directory holds design work before and after implementation. A design can be approved without being scheduled. Promotion into [`ROADMAP.md`](../../ROADMAP.md) is the separate commitment that assigns build order. Seeds holds executable work, and [`CHANGELOG.md`](../../CHANGELOG.md) records releases.

Existing record paths stay flat because every path under `docs/` is a public surface. Lifecycle changes update metadata and this index; they do not move files between status directories.

## Lifecycle

```text
draft → proposed → approved
                       │
                       └─ roadmap promotion → now / next → shipped
```

The metadata axes answer different questions:

- **Kind** says what the record is: `direction`, `proposal`, `pilot`, `contract`, `architecture-decision`, or `historical-evidence`.
- **Design state** says how settled the design is: `draft`, `proposed`, `approved`, `superseded`, or `retired`.
- **Delivery** says where implementation stands: `unscheduled`, `now`, `next`, `deferred`, `shipped`, `mixed`, `not-in-core`, or `not-applicable`.
- **Arrived** is the date the record first became a published file at its current path. It is distinct from the first discussion, approval, and ship dates.

`mixed` is reserved for a record whose independently useful phases have different delivery states. Such a record carries a `Scope status` section instead of hiding the split behind one label.

## Catalog

This table is the complete inventory. `Approved` means a design is coherent enough to promote. It does not mean the roadmap has made that commitment.

<!-- design-catalog:start -->
| Record | Kind | Design state | Delivery | Arrived |
|---|---|---|---|---|
| [The corpus flywheel](./corpus-flywheel.md) | `direction` | `draft` | `unscheduled` | 2026-08-15 |
| [MCP server](./mcp-server.md) | `proposal` | `draft` | `unscheduled` | 2026-08-26 |
| [External-repository mirror pilot](./external-repository-mirror-pilot.md) | `pilot` | `approved` | `now` | 2026-08-20 |
| [Campaign controller](./campaign-controller.md) | `direction` | `approved` | `next` | 2026-08-20 |
| [Resumable agent environments](./resumable-agent-environments.md) | `proposal` | `proposed` | `unscheduled` | 2026-08-20 |
| [Agent analytics](./agent-analytics.md) | `direction` | `approved` | `mixed` | 2026-08-11 |
| [Extensions](./extensions.md) | `direction` | `proposed` | `mixed` | 2026-08-04 |
| [Agent composition and Pi runtime](./agent-composition.md) | `contract` | `approved` | `shipped` | 2026-08-01 |
| [Forge contract](./forge-contract.md) | `contract` | `approved` | `shipped` | 2026-08-11 |
| [IssueTracker contract](./issue-tracker.md) | `contract` | `approved` | `shipped` | 2026-08-20 |
| [PlanRun coordinator](./plan-run-coordinator.md) | `contract` | `approved` | `shipped` | 2026-08-01 |
| [Preview environments](./preview-environments.md) | `contract` | `approved` | `shipped` | 2026-08-01 |
| [Provider-error retry](./provider-retry.md) | `contract` | `approved` | `shipped` | 2026-08-22 |
| [Runtime and supervisor](./runtime-and-supervisor.md) | `contract` | `approved` | `shipped` | 2026-08-01 |
| [Docker runtime provider](./runtime-docker-provider.md) | `contract` | `approved` | `shipped` | 2026-08-17 |
| [RuntimeProvider contract](./runtime-provider-contract.md) | `contract` | `approved` | `shipped` | 2026-07-09 |
| [Scheduler](./scheduler.md) | `contract` | `approved` | `shipped` | 2026-08-01 |
| [Tier-1 observation bus](./tier1-observation-bus.md) | `contract` | `approved` | `shipped` | 2026-07-28 |
| [`.warren/` configuration](./warren-config.md) | `contract` | `approved` | `shipped` | 2026-08-01 |
| [Kubernetes migration](./k8s-migration.md) | `architecture-decision` | `approved` | `shipped` | 2026-07-07 |
| [2026-07-29 planning-session record](./2026-07-29-planning-session-record.md) | `historical-evidence` | `approved` | `not-applicable` | 2026-07-31 |
<!-- design-catalog:end -->

## Pre-roadmap discovery

The current unscheduled records are the draft [corpus flywheel](./corpus-flywheel.md), the draft [MCP server](./mcp-server.md), and the proposed [resumable agent environments](./resumable-agent-environments.md). They remain ideas until the roadmap promotes them.

## Build order

[`ROADMAP.md`](../../ROADMAP.md) is the only source of build order. When a design is promoted, change its delivery to `now` or `next`, add `**Roadmap order:** N` for a `next` record, and reflect that lane here. Do not infer commitment from approval or from a detailed design.

The [external-repository mirror pilot](./external-repository-mirror-pilot.md) is the `now` campaign. [Campaign controller](./campaign-controller.md) Phase 1 is roadmap order 1 in `next`; later controller phases remain evidence-gated. Integration breadth uses the already-shipped [`IssueTracker`](./issue-tracker.md) and [`Forge`](./forge-contract.md) contracts when a real deployment pays for it, but it is not currently scheduled.

## Shipped records

A shipped record preserves rationale and contract history. Its `Current truth` field points to the code or operator document that wins if implementation and prose disagree. The catalog above is sorted by lifecycle for discovery; use the chronology below to reconstruct when records entered the repository.

## Arrival chronology

| Arrived | Records |
|---|---|
| 2026-07-07 | Kubernetes migration |
| 2026-07-09 | RuntimeProvider contract |
| 2026-07-28 | Tier-1 observation bus |
| 2026-07-31 | 2026-07-29 planning-session record |
| 2026-08-01 | Agent composition; PlanRun coordinator; preview environments; runtime and supervisor; scheduler; `.warren/` configuration |
| 2026-08-04 | Extensions |
| 2026-08-11 | Agent analytics; Forge contract |
| 2026-08-15 | The corpus flywheel |
| 2026-08-17 | Docker runtime provider |
| 2026-08-20 | Campaign controller; external-repository mirror pilot; IssueTracker contract; resumable agent environments |

## Adding or changing a record

1. Add the standard metadata fields directly below the title.
2. Add exactly one row inside the catalog markers above.
3. Keep the path flat and stable.
4. Promote delivery to `now` or `next` only when `ROADMAP.md` does so.
5. Set `Current truth` when work ships, and use a `Scope status` section for mixed delivery.
6. Run `bun run check:design-docs`.

The check enforces complete catalog coverage, controlled vocabulary, required dates, catalog-to-header agreement, shipped-current-truth pointers, mixed-scope tables, and roadmap order for `next` records.
