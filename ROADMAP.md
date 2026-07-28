# Warren Roadmap

This file carries direction only. Seeds holds the work queue, so run `sd ready` for what to pick up next.

[SPEC.md](SPEC.md) is the design record. [CHANGELOG.md](CHANGELOG.md) is the ship log. [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) owns the operating policy and the sequencing.

Two rules keep this file short.

1. Shipped items shrink, never grow. A shipped item is one table row that points at its design record.
2. No design sketches. A schema, a config shape, or a table definition belongs in a seed at implementation time, or in SPEC after a design lock.

Status vocabulary: `now`, `next`, `shipped`, `not-in-core`.

## Now — in flight

- **Public read-only instance** (warren-1841, plan `pl-b82d`). The auth stack landed on main. It carries a capability-bearing `Actor`, a `PublicReadProvider` behind `WARREN_AUTH`, and a declarative route policy table. It also carries public response projections, an event scrubber, `GET /whoami`, a UI capability layer, and Cloud Armor. The cutover stays open, and `app.warren.run` answers 401 to anonymous callers today.
- **Public-facing readiness** (plan `pl-b82d`). A docs truth pass, one shared home for the wire vocabulary, a data-driven layer gate, and `src/ui` under the quality gates.
- **Deletion-pass closeout** (plan `pl-3a79`). Canopy removal and the Tier-1 event-bus steps stay open.

## Next — planned

The order below mirrors the Sequencing section of [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md), which is the one source of truth. Each step waits on a roadmap item to pay for it.

1. **Burrow-client eviction** (`pl-829f`). Effectively landed: `ServerDeps.burrowClient` is gone and spawn plus reap route through `RuntimeProvider`. What remains is the last `pl-829f` children and the boundary lint.
2. **Deletion pass** (`pl-3a79`). Conversations and plot are gone. Canopy is the last of the three and stays open.
3. **Tier-1 event bus** (warren-bb60, warren-4e74, warren-df3e) on `RunEventBroker`, proven by moving healer onto it and evicting the mulch and seeds mirrors from `finalize()`. The finalize contract stops enumerating features.
4. **`Forge` and `AuthProvider` contracts**, both paid for by the GitHub App. Teams need login, repo-permission mirroring, and `run.dispatched_by` attribution.
5. **`IssueTracker` contract**, paid for by Linear or GitHub Issues. A `supportsPlans` capability flag lets plan-runs degrade on trackers without seeds-style plan shapes.
6. **Re-platform plan-runs, mulch, and seeds as extensions.** Here `ServerDeps` finishes dying and "remove a feature" becomes "do not load it".
7. **`AgentRuntimeAdapter`.** Runtime string interpretation and payload parsing (`terminal-detect.ts`) move behind a warren-owned registry.

## Shipped

| What | Landed | Record |
|------|--------|--------|
| `.warren/` per-project config convention | v0.1.5 | SPEC §11.H |
| Cron scheduler and past-due scheduled seeds | v0.1.6 | SPEC §11.I |
| Seeds `extensions` field for runtime metadata | v0.3.11 | SPEC §11.I |
| Postgres backend behind `WARREN_DB_URL` | v0.3.2 | SPEC §3.2 |
| Per-run preview environments | v0.3.2 | SPEC §11.L |
| Plan-runs — serial `sd` plan execution | v0.3.17 | SPEC §11.P |
| OpenAPI 3.1 schema and the `gen:openapi:check` gate | v0.6.14 | `docs/openapi.yaml` |
| Ready-to-dispatch surface | v0.9.4 | SPEC §11.R |
| `RuntimeProvider` seam plus the Kubernetes runtime | v0.10.0 | `docs/design/runtime-provider-contract.md` |
| Release machinery — version bump, version-sync gate, `ghcr.io` image | v0.11.0 | [CHANGELOG.md](CHANGELOG.md) |
| Public-read auth stack — `Actor`, route policy, projections, scrubber | unreleased | plan `pl-b82d` |

## Deliberately not in core

PHILOSOPHY mandates a public entry for every refusal, with a recipe that names the extension tier. Tier 0 is in-repo skills, Tier 1 is container plugins on the event bus, and Tier 2 is operator hooks.

- **Issues UI** (old R-04) — **Tier 0**. The agent already runs `sd` inside the sandbox against the project's own repo. Warren keeps no issues table, so a browser CRUD surface over seeds buys a sync problem and little else.
- **Per-harness UI surfaces** (old R-07) — **Tier 1**. A new harness is an agent image plus a registry entry. What a runtime's events mean belongs behind `AgentRuntimeAdapter`, not in a page per harness.
- **Schema-driven configuration UI** (old R-10) — **Tier 2**. An operator who owns the deployment can render a config form from each tool's JSON Schema. Warren does not track the config schema of every os-eco tool.
- **Cross-project activity feed** (old R-14) — **Tier 1**. The JSONL event stream and the events table are already the API. A feed reads them from outside the process.
- **MCP server management** (old R-15) — **Tier 0**. MCP servers are project tooling that the agent starts inside the sandbox, with credentials the project supplies.
- **Audit log** (old R-16) — **Tier 1**. This is the flagship event-bus consumer and the proof that Tier 1 carries real weight. A core `audit_log` table would make the same data twice.
- **Per-user spend budgets** (old R-17) — **Tier 1**. Per-run cost caps stay in core because dispatch has to reject before spend. Per-user and per-team budgets need identity plus policy, which reads better on the bus.
- **Slack, Linear, Sentry, and Grafana integrations** — **Tier 1**. Integration sprawl arrives as extensions, never as new `ServerDeps` fields.

## Removed

Honest tombstones. A removed feature can return as an extension when someone wants it enough to pay for the API it needs.

| What | When | Why |
|------|------|-----|
| Conversations (Leveret) | v0.11.0 | No users. PHILOSOPHY rule 8 deletes rather than re-platforms. |
| Plot | v0.11.0 | No users. Twelve injector fields left `ServerDeps` with it. |
| Canopy (agent library, `register-agent`, `CANOPY_REPO_URL`, `/agents/refresh`) | v0.12.0 | No users. Built-in agents ship inline. PHILOSOPHY rule 8 deletes rather than re-platforms. |
| Multi-worker burrow model and remote workers (old R-12) | v0.10.0 | Superseded by the `k8s` runtime provider. SPEC §5.4 carries the RETIRED banner. |
| Fly.io deploy path | v0.10.0 | Superseded by the published container image plus GKE. See `docs/RUNBOOK-K8S.md`. |

The canopy agent library, its `register-agent` CLI, the `CANOPY_REPO_URL`
knob, and the `/agents/refresh` routes are gone as of the `pl-3a79`
deletion pass (PHILOSOPHY sequencing step 2). Built-in agents now ship
inline (`src/registry/builtins/`). Mulch and seeds stay live.

## Under evaluation

- **Colonies, or project groups** (old R-20, warren-2fa8) — a go or no-go spike, not a commitment. Cross-project scheduling policy and colony-level agents may fit the event bus better than a new core noun.

## Decisions already made

Choices locked in earlier, recorded so that nobody relitigates them when an item becomes a seed.

- The database holds runtime state only. Issues, expertise, prompts, and trigger config stay git-tracked in the project repo under `.seeds/`, `.mulch/`, and `.warren/`.
- Seeds is the source of truth for issues. Warren has no issues table.
- The kernel's guaranteed output is a pushed workspace branch. Everything past that point is extension behavior.
- Warren stays self-hostable, not SaaS. One warren deploy serves one team, and multi-tenancy stays out of scope.
- `claude-code` is the public default agent, and `WARREN_DEFAULT_AGENT` picks another one without a source change.
- GitHub webhook triggers stay out of the current phase. The `.warren/triggers.yaml` schema leaves room for another `kind:` entry later.
