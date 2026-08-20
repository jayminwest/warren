# Warren Roadmap

This file carries direction, sequencing, and seam status. Seeds holds the work queue, so run `sd ready` for what to pick up next.

The topic records under [docs/design/](docs/design/) are the design record. [CHANGELOG.md](CHANGELOG.md) is the ship log. [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) owns the operating policy. This file owns the order of work.

Two rules keep this file short.

1. Shipped items shrink, never grow. A shipped item is one table row that points at its design record.
2. No design sketches. A schema or a config shape belongs in a seed at implementation time, or in a `docs/design/` record after a design lock.

Status vocabulary: `now`, `next`, `deferred`, `shipped`, `not-in-core`.

## The direction

Warren earns external users in three rings. Each ring pays for the seams the next ring needs.

1. **The solo self-hoster.** Make the front door real: the image runs on their machine, their repo works, health checks tell the truth, and the CLI installs from npm. No seam work.
2. **The team.** The Forge campaign: short-lived GitHub App installation tokens, bot attribution, and one place that mints and refreshes forge credentials. One payer cuts the `Forge` seam and removes the worst blockers of `IssueTracker`. The deployment is the unit of trust — a team shares a deployment, not accounts.
3. **The organization with its own stack.** Bring your own tracker (Linear), forge, and runtime. Each is cheap because ring 2 built the substrate.

The brake on all three is PHILOSOPHY rule 1: features pay for seams. Work with no payer sits in **Deferred until paid**, not in Next.

## Seam status

| Seam | Contract | Status |
|------|----------|--------|
| Runtime / sandbox | `RuntimeProvider` (`src/runtime/contract.ts`) | **Live** — local (warren-owned sandbox) + docker (sibling containers) + k8s. The burrow absorption (pl-3007, v0.17.0) internalized the sandbox. Warren imports zero burrow code. |
| Storage | dialect-aware db layer (`src/db/client.ts`) | **Live** — sqlite + postgres. |
| Auth | `AuthProvider` (`src/server/auth.ts`) | **Live** — `NoAuth`, `BearerToken`, `PublicRead` behind `WARREN_AUTH` (pl-b82d). The multi-user widening moved to Deferred until paid (2026-08-03). |
| Extensions (Tier 1) | lifecycle bus (`src/runs/lifecycle-bus.ts`, `warren-ext/v1`) | **Live, observe-only** — all 6 hooks emit in production (`run_started` + `event_emitted` wired in v0.13.1, warren-28ca). |
| Forge | `Forge` — repo refs, git auth, PR open/find, checks, error taxonomy | **Live** (v0.15.0, pl-d1c9) — GitHubForge (PAT) + GitHubApp (installation tokens) + FakeForge, boot-resolved via `WARREN_FORGE`, boundary held by a `check:layers` rule pair. Design record: `docs/design/forge-contract.md`. |
| Issue tracker | `IssueTracker` — capability-flagged (`supportsPlans`, `isGitNative`). Seeds in-core. External trackers arrive through the `RemoteTracker` bridge speaking `warren-tracker/v1` (wire protocol experimental until a foreign implementation survives the conformance suite). | **Live** (v0.18.0, pl-a37b) — `SeedsTracker` + `RemoteTracker`, per-project `tracker` block in `.warren/config.yaml`. Design record: `docs/design/issue-tracker.md`. |
| Agent runtime | `AgentRuntimeAdapter` phase 1 — terminal detect, usage, error classes, seed layout | **Live** — phase 2 (harness repatriation) shipped with pl-3007 in v0.17.0. The adapters are warren-owned (`src/runtime/adapters/`). Phase 1 completed with `runtimeId` typed off the union + the `check:runtime-ids` guard (GH#846 items 4–5, PR #964). |

## Now — in flight

- **The v0.18.0 campaign (pl-a37b, seed warren-bc61) — the any-setup release.** Planned 2026-08-18, three fronts, all merged. The dispatch-context log: corpus-flywheel step 2 as a core insert-only `dispatch_context` fact table. The full `IssueTracker` cut: contract, seeds as implementation #1, the `RemoteTracker` bridge, and the conformance suite (see the Shipped row). The external-repo readiness set from the 2026-08-18 mirror-fleet audit: base-commit pinning, host-clone serialization, multi-stack agent image, tracker-neutral builtin prompts, `repoContext` onboarding. The open reliability backlog rides the same plan. After this release, focus turns to the mirror fleet and corpus-flywheel steps 3–5.

## Next — planned, in order

1. **Linear — the first external tracker extension** (v0.19, own release track per the 2026-08-04 decision). Speaks `warren-tracker/v1` behind the `RemoteTracker` bridge and must survive the published conformance suite (`extensions/tracker-conformance/`) unchanged before the wire protocol stops being experimental. GitHub Issues follows as an extension too, not on the forge's HTTP core.

## Deferred until paid

Honest replacements for old sequencing steps with no payer. Each entry names its price of admission.

- **Re-platform plan-runs, mulch, and seeds as extensions** (old step 6). The old payoff claim was wrong: on current inventory the move kills 2 of 31 `ServerDeps` fields, and mulch has no field at all. `seedsCli` already died with the `IssueTracker` seam (v0.18.0). `refreshProjectFn` survives because `POST /projects/:id/refresh` is about the clone, not the tracker. The rest of the dep bag dies by other means or not at all. Returns when a real payer appears.
- **Tier-2 mutating hooks.** No consumer exists, first-party or external. `IssueTracker` is a boot-injected provider, not a bus subscriber, so it does not pay for this. Returns when a real extension needs to mutate.
- **The multi-user auth widening** — the login half of the old GitHub App campaign: async `authorize`, `Actor.subject`, sessions, GitHub OAuth login, `run.dispatched_by`. Descoped 2026-08-03. The public instance stays read-only by decision, so no deployment needs a human login. A solo operator holds the token. A team shares deployment trust. The one deployment with strangers never authenticates them. Price of admission: a real multi-user deployment. If attribution alone becomes the want, named bearer tokens with subjects is the cheap first step and needs no sessions. Per-run scoped tokens (warren-57fd) already shipped and stay.
- **The seeds identifier rename.** 1,470 lines and four strings that live in users' repos, for zero behavior change. Not planned at any scale.

## Shipped

| What | Landed | Record |
|------|--------|--------|
| `.warren/` per-project config convention | v0.1.5 | `docs/design/warren-config.md` |
| Cron scheduler and past-due scheduled seeds | v0.1.6 | `docs/design/scheduler.md` |
| Seeds `extensions` field for runtime metadata | v0.3.11 | `docs/design/scheduler.md` |
| Postgres backend behind `WARREN_DB_URL` | v0.3.2 | `src/db/` (Postgres adapter behind `WARREN_DB_URL`) |
| Per-run preview environments | v0.3.2 | `docs/design/preview-environments.md` |
| Plan-runs — serial `sd` plan execution | v0.3.17 | `docs/design/plan-run-coordinator.md` |
| OpenAPI 3.1 schema and the `gen:openapi:check` gate | v0.6.14 | `docs/openapi.yaml` |
| Ready-to-dispatch surface | v0.9.4 | `docs/design/plan-run-coordinator.md` |
| `RuntimeProvider` seam plus the Kubernetes runtime | v0.10.0 | `docs/design/runtime-provider-contract.md` |
| Burrow-client eviction and the layer gate | v0.10.x | pl-829f, `scripts/layer-rules.json` |
| Release machinery — version bump, version-sync gate, `ghcr.io` image | v0.11.0 | [CHANGELOG.md](CHANGELOG.md) |
| Deletion pass — conversations, plot, canopy | v0.11.0–v0.13.0 | pl-3a79 |
| Public-read auth stack — `AuthProvider`, `Actor`, route policy, projections, scrubber | v0.12.x | pl-b82d |
| Tier-1 lifecycle bus, healer + seed-close consumers | v0.13.0 | `docs/design/tier1-observation-bus.md` |
| Per-run scoped run tokens — sandboxes drop the operator token | v0.13.0 | warren-57fd, [CHANGELOG.md](CHANGELOG.md) |
| Release-pipeline integrity — PR image-build gate, draft-until-image ordering, multi-arch image | v0.13.0 | [CHANGELOG.md](CHANGELOG.md) |
| Truth-and-hygiene pass — doc truth pass, rule-8 deletions, full lifecycle-bus emit coverage | v0.13.1 | warren-ab7a, warren-801e, warren-28ca |
| Self-host hardening — local `baseBranch` forward, salvage-before-destroy, functional bwrap probe | v0.13.1 | pl-1c02 |
| Seam precursors — capability flags, `rate_limited` class, wider wire stems, scrubber redaction | v0.13.1 | warren-9bbc |
| Hygiene residue — `closeSeedId` deletion, finalize holdouts generalized to opaque artifact keys | v0.13.2 | warren-11e4, warren-357c |
| Security hardening pass — route-param traversal fix, preview origin split, public-projection leak sweep, security headers | v0.13.2 | warren-7c1e, warren-3f8a, [SECURITY.md](SECURITY.md) |
| SPEC retirement — living contracts salvaged into `docs/design/` records, AGENTS.md canonical | v0.13.2 | warren-6fe3, warren-b771, [docs/design/](docs/design/) |
| Agent-facing CLI + npm publish — CLI collapses onto HTTP, show/wait/tail/cancel, login/prime, output contract, `@os-eco/warren-cli` on npm | v0.14.0 | pl-882c, [docs/cli-reference.md](docs/cli-reference.md) |
| Flagship Tier-1 extension — `extensions/audit-log/` out-of-core, zero audit lines in core, friction report as the delivery-mechanism spec | v0.14.1 | pl-116e, `docs/design/extensions.md`, `extensions/audit-log/FRICTION.md` |
| The Forge campaign — `Forge` seam live, GitHub REST consolidated into `src/forge/github/`, GitHubForge (PAT) + GitHubApp (installation tokens, manifest registration) + FakeForge, old static-token paths deleted | v0.15.0 | pl-d1c9, `docs/design/forge-contract.md` |
| Agent analytics — dispatch/reap facts as real columns, `tool_calls` rollup, behavioral insights, Run Analytics UI | v0.16.0 | pl-103e, `docs/design/agent-analytics.md` |
| The judge extension — 15-class rubric v1, append-only verdict store, bounded judge loop, collector daemon, `GET /verdicts.jsonl` export | v0.16.0 | pl-17ca, `docs/design/agent-analytics.md` §12 |
| The burrow absorption — sandbox, harness adapters, spawn path, and preview sidecars internalized; `src/burrow-client/` deleted; supervisor spawns only warren | v0.17.0 | pl-3007, `docs/design/runtime-and-supervisor.md` |
| The self-host push — first-boot operator-token minting, `DockerProvider` sibling containers, one-line docker bring-up pinned by `acceptance:container` | v0.17.0 | warren-ef6e, `docs/design/runtime-docker-provider.md` |
| The IssueTracker cut — neutral contract + capability flags, `SeedsTracker` behind the seam, `isGitNative` fence, ordered-issue-list plan-runs, `RemoteTracker` bridge speaking `warren-tracker/v1`, published conformance suite + FakeTracker | v0.18.0 | pl-a37b, `docs/design/issue-tracker.md` |

## Deliberately not in core

PHILOSOPHY mandates a public entry for every refusal, with a recipe that names the extension tier. The tier definitions live in [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md).

- **Issues UI** (old R-04) — **Tier 0**. The agent already runs `sd` inside the sandbox against the project's own repo. A browser CRUD surface over the tracker buys a sync problem and little else.
- **Per-harness UI surfaces** (old R-07) — **Tier 1**. A new harness is an agent image plus a registry entry. What a runtime's events mean belongs behind `AgentRuntimeAdapter`, not in a page per harness.
- **Schema-driven configuration UI** (old R-10) — **Tier 2**. An operator who owns the deployment can render a config form from each tool's JSON Schema.
- **Cross-project activity feed** (old R-14) — **Tier 1**. The JSONL event stream and the events table are already the API. A feed reads them from outside the process.
- **MCP server management** (old R-15) — **Tier 0**. MCP servers are project tooling that the agent starts inside the sandbox, with credentials the project supplies.
- **Audit log** (old R-16) — **Tier 1**. The flagship event-bus consumer, shipped as pl-116e (v0.14.1). A core `audit_log` table would make the same data twice. **Amended 2026-08-03:** no longer waits on `Actor.subject` — actor kind (operator, agent, spectator) is enough attribution until named tokens land.
- **Per-user spend budgets** (old R-17) — **Tier 1**. Per-run cost caps stay in core because dispatch must reject before spend. Per-user budgets need identity plus policy, which reads better on the bus.
- **Slack, Sentry, and Grafana integrations** — **Tier 1**. Integration sprawl arrives as extensions, never as new `ServerDeps` fields.
- **Linear as a notification sink** — **Tier 1**. Distinct from Linear as the tracker: the tracker is the first external tracker extension (see Next), while notifications into Linear ride the event bus. The old entry conflated the two.
- **In-core tracker adapters (Linear, Jira, GitLab, GitHub Issues)** — **Tier 1**. Every tracker after Seeds arrives as an external container behind the `RemoteTracker` bridge. The bridge is the last tracker core adds (Decisions, 2026-08-04).

## Removed

Honest tombstones. A removed feature can return as an extension when someone wants it enough to pay for the API it needs.

| What | When | Why |
|------|------|-----|
| Conversations (Leveret) | v0.11.0 | No users. PHILOSOPHY rule 8 deletes rather than re-platforms. |
| Plot | v0.11.0 | No users. Twelve injector fields left `ServerDeps` with it. |
| Canopy — the library tier and the project tier | v0.13.0 | No users. Built-in agents ship inline (warren-a781 moved the Audit Warden agents first). |
| Multi-worker burrow model and remote workers (old R-12) | v0.10.0 | Superseded by the `k8s` runtime provider. Carried a RETIRED banner before the old design doc's retirement. |
| Fly.io deploy path | v0.10.0 | Superseded by the container image plus GKE. See `docs/RUNBOOK-K8S.md`. |
| Pause machinery (`markPaused`, `question_posed` remnants) | v0.13.1 | Dead since the plot deletion. No non-test caller. |
| `mergePullRequest` | v0.13.1 | Built for the deleted Plot PR surface. No production caller. |
| Cross-repo plan-run routing (pl-fb43) | v0.13.2 | Seeds-bound machinery built ahead of the IssueTracker seam; no payer. Deleted per rule 8; the execution-vs-coordination project split survives as an IssueTracker design input. |
| Sapling — the builtin agent, runtime id, and adapter | v0.17.0 | No users, no maintenance capacity (warren-f525). Returns as a registry entry + adapter if a payer appears. |

## Under evaluation

- **Colonies, or project groups** (old R-20, warren-2fa8) — a go or no-go spike, not a commitment. Cross-project scheduling policy may fit the event bus better than a new core noun.

## Decisions already made

Choices locked earlier, recorded so that nobody relitigates them when an item becomes a seed. Two carry amendments dated 2026-07-29.

- The database holds runtime state only. Issues, expertise, and trigger config stay git-tracked in the project repo under `.seeds/`, `.mulch/`, and `.warren/`. **Amended 2026-07-29:** a warren-side sidecar table keyed by `(project_id, issue_id)`, which holds only warren's own run bookkeeping, counts as permitted runtime state. It is not an issues mirror.
- **Amended 2026-07-29:** the project's tracker is the source of truth for issues. Seeds is `IssueTracker` implementation #1, not a structural dependency. Warren still keeps no issues table (see the sidecar amendment above).
- The kernel's guaranteed output is a pushed workspace branch. Everything past it is extension behavior ([PHILOSOPHY](docs/PHILOSOPHY.md)).
- Warren stays self-hostable, not SaaS. One warren deploy serves one team. Seams declare a single-org scope explicitly.
- `claude-code` is the public default agent, and `WARREN_DEFAULT_AGENT` picks another one without a source change.
- GitHub webhook triggers stay out of the current phase. The `.warren/triggers.yaml` schema leaves room for another `kind:` entry later.
- Linear before GitHub Issues for `IssueTracker`. GitHub Issues shares its REST surface with `Forge` and would produce a seam with one honest implementation. **Amended 2026-08-04:** both now arrive as external extensions through the `RemoteTracker` bridge. The ordering stands.
- `Forge` owns the branch's fate. `IssueTracker` owns the work item. Issue-close-on-merge stays domain orchestration. Neither seam calls the other.
- **2026-08-03: the public instance stays read-only, permanently.** Spectators never authenticate, and no plan exists to add a login surface. This removed the last payer for sessions and GitHub login, which moved the multi-user auth widening to Deferred until paid.
- **2026-08-03: the GitHub App is a credential mechanism, not an identity provider.** Each deployment registers its own app through GitHub's manifest flow. The app supplies short-lived installation tokens and bot attribution. Fine-grained PAT mode stays a permanent peer, never a legacy path. The deployment, not the user account, is warren's unit of trust. An organization that wants SSO puts a proxy in front, or pays for an `AuthProvider` implementation.
- **2026-08-04: tracker implementations arrive as extensions, through a bridge.** Seeds stays in-core as `IssueTracker` implementation #1. Implementation #2 is `RemoteTracker`, an in-core bridge that speaks a versioned wire protocol (`warren-tracker/v1`) to an external container. The bridge is the last tracker core adds. Linear ships as the first external tracker extension, first-party authored, on its own release track. Jira, GitLab, and GitHub Issues follow the same path without a core commit. The wire contract stays experimental until a foreign implementation survives it unchanged. A conformance suite, not a grep, proves an implementation (PHILOSOPHY rule 4). The extension holds its own tracker credential, and warren never stores it. Whether forges follow the same pattern is an open question, deliberately not decided here.
- **2026-07-30: warren absorbs burrow.** Burrow was a scaffold, built to build warren. Agent-runtime logic is internal to warren and does not live in another repo. End state: warren imports zero burrow code — the harness adapters move in (Next item 2), then the sandbox spawn itself (Next item 3). The burrow project survives as a published standalone sandbox tool, but warren no longer depends on it. Origin: the pi event-volume investigation, which traced a pi parser gap (`tool_execution_update`) into burrow library code inside warren's k8s pods. That detour through another repo is what this decision ends.
