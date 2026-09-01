# Warren Roadmap

This file carries direction, sequencing, and seam status. Seeds holds the work queue, so run `sd ready` for what to pick up next.

The topic records under [docs/design/](docs/design/) are the design record. [CHANGELOG.md](CHANGELOG.md) is the ship log. [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) owns the operating policy. This file owns the order of work.

Two rules keep this file short.

1. Shipped items shrink, never grow. A shipped item is one table row that points at its design record.
2. No design sketches. A schema or a config shape belongs in a seed at implementation time, or in a `docs/design/` record after a design lock.

Status vocabulary: `now`, `next`, `deferred`, `shipped`, `not-in-core`.

## The direction

Warren's next phase proves trustworthy autonomous maintenance on unfamiliar,
scientifically relevant repositories. Detached mirrors provide the workload.
Campaign controllers provide durable policy execution.

Outcome-joined telemetry provides the evidence. Core grows only where repeated
foreign-repository friction pays for it.

The self-hosting, Forge, tracker, runtime, and analytics campaigns built the substrate.
The external-repository mirror pilot now uses it against real foreign stacks. Snakemake
is first. Biopython or AnnData will test whether the method transfers.

The pilot is an experiment rather than a product campaign. It permits no upstream
contact and no router. It uses one fixed dispatch arm, hidden executable grading, and
explicit denominators.

Its control records and work queue live in the private
[`warren-experiments`](https://github.com/jayminwest/warren-experiments) repository.

PHILOSOPHY rule 1 remains the brake: features pay for seams. Integration breadth and
new core nouns with no waiting user sit in **Deferred until paid**.

Review queues, replicas, cross-project scheduling, routing, and resumable Environments
advance only when pilot evidence supplies their payer.

## Seam status

| Seam | Contract | Status |
|------|----------|--------|
| Runtime / sandbox | `RuntimeProvider` (`src/runtime/contract.ts`) | **Live** — local (warren-owned sandbox) + docker (sibling containers) + k8s. The burrow absorption (pl-3007, v0.17.0) internalized the sandbox. Warren imports zero burrow code. |
| Storage | dialect-aware db layer (`src/db/client.ts`) | **Live** — sqlite + postgres. |
| Auth | `AuthProvider` (`src/server/auth.ts`) | **Live** — `NoAuth`, `BearerToken`, `PublicRead` behind `WARREN_AUTH` (pl-b82d). The multi-user widening moved to Deferred until paid (2026-08-03). |
| Extensions (Tier 1) | lifecycle bus (`src/runs/lifecycle-bus.ts`, `warren-ext/v1`) | **Live, observe-only** — all 6 hooks emit in production (`run_started` + `event_emitted` wired in v0.13.1, warren-28ca). |
| Forge | `Forge` — repo refs, git auth, PR open/find, checks, error taxonomy | **Live** (v0.15.0, pl-d1c9) — GitHubForge (PAT) + GitHubApp (installation tokens) + AdoForge (Azure DevOps Repos, PAT) + FakeForge, boot-resolved via `WARREN_FORGE`, boundary held by `check:layers` rules. Design record: `docs/design/forge-contract.md`. Further forges (GitLab, then Forgejo/Gitea) land in-core as registry arms, not as extensions (Decisions, 2026-08-20). |
| Issue tracker | `IssueTracker` — capability-flagged (`supportsPlans`, `isGitNative`). Seeds in-core. External trackers arrive through the `RemoteTracker` bridge speaking `warren-tracker/v1` (wire protocol experimental until a foreign implementation survives the conformance suite). | **Live** (v0.18.0, pl-a37b) — `SeedsTracker` + `RemoteTracker`, per-project `tracker` block in `.warren/config.yaml`. `extensions/tracker-jira/` (v0.19.0) is the first external implementation of the wire protocol. Design record: `docs/design/issue-tracker.md`. |
| Agent runtime | `AgentRuntimeAdapter` phase 1 — terminal detect, usage, error classes, seed layout | **Live** — phase 2 (harness repatriation) shipped with pl-3007 in v0.17.0. The adapters are warren-owned (`src/runtime/adapters/`). Phase 1 completed with `runtimeId` typed off the union + the `check:runtime-ids` guard (GH#846 items 4–5, PR #964). |

## Now — in flight

1. **External-repository mirror pilot.** Prove that Warren can turn an unfamiliar,
   scientifically relevant repository into a trustworthy repeatable workload. Start with
   Snakemake. Then transfer the written method to Biopython or AnnData.

   Use detached public mirrors, sanitized historical execution origins, a fixed dispatch
   arm, hidden executable grading, and a structured friction record. The full plan and
   experiment records live in
   [`warren-experiments`](https://github.com/jayminwest/warren-experiments).

   Warren keeps only this commitment and any generalized changes that observed friction
   pays for. Design record: `docs/design/external-repository-mirror-pilot.md`.

## Next — planned, in order

1. **Upstream contribution loop v1 (Phase 3, pl-096b).** The campaign controller's
   V0 dry run and Phase 2 policy-gated create-PR shipped in v0.19.0 and opened the
   first live OpenClaw PR. Phase 3 closes the response loop: consume upstream review
   comments, checks, and merge outcomes, and turn them into bounded follow-up work.
   Design record: `docs/design/campaign-controller.md`.

## Deferred until paid

Honest replacements for old sequencing steps with no payer. Each entry names its price of admission.

- **Integration breadth: Linear, GitLab, and Forgejo/Gitea.** The contracts are ready,
  but no waiting deployment currently pays for another implementation. Jira shipped as
  the first external tracker behind `warren-tracker/v1` (v0.19.0,
  `extensions/tracker-jira/`), and Azure DevOps Boards followed as the second
  (`extensions/tracker-ado/`). Linear follows the same path when a payer appears.

  Azure DevOps Repos arrived as the second in-core Forge (`src/forge/ado/`, GH#1172),
  paid for by a deployment running on it. GitLab remains the intended third:
  warren-1b6f was its no-regret pre-work, and warren-7ba8 is the provider issue.
  Forgejo/Gitea follows GitLab when a real Codeberg or self-hosted user appears.

  Price of admission: a concrete deployment prepared to exercise the implementation and
  its conformance or acceptance suite.
- **Resumable agent Environments.** The proposal correctly keeps Runs immutable and
  gives durable workspace and service state a separate owner. The mirror pilot starts
  with CPU-local deterministic cases that do not yet need this new core noun.

  Price of admission: repeated measured setup, service, or multi-repository continuity
  friction that materially limits useful pilot workloads.
- **Re-platform plan-runs, mulch, and seeds as extensions** (old step 6). The old payoff claim was wrong: on current inventory the move kills 2 of 31 `ServerDeps` fields, and mulch has no field at all. `seedsCli` already died with the `IssueTracker` seam (v0.18.0). `refreshProjectFn` survives because `POST /projects/:id/refresh` is about the clone, not the tracker. The rest of the dep bag dies by other means or not at all. Returns when a real payer appears.
- **A remote-forge bridge** — a forge analogue of `RemoteTracker` + `warren-tracker/v1`, so a forge could ship as an out-of-process extension. Declined 2026-08-20 (Decisions). The forge market is three or four names that change once a decade. In-core arms cost less than a second wire protocol plus a conformance suite, and credential minting (forge-contract.md §4) stays in-process. Price of admission: a forge request from someone who cannot wait on a core release. At that point `RemoteForge` becomes one more registry arm.
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
| The any-setup campaign — IssueTracker cut, dispatch-context analytics, external-repo onboarding, and runtime hardening | v0.18.0 | pl-a37b, `docs/design/issue-tracker.md` |
| Direction C operator console — full UI rebuild on the design spec, Operations index, Event explorer, `GET /events` + `GET /instance` + ops-overview APIs, mobile pass, bug sweep | v0.19.0 | pl-7e38, pl-3ce8, pl-4ab6 (verification sweep warren-2c97 pending) |
| The casual-user happy path — one-line installer, `warren up` credential wizard + runtime autodetect, browser auth handoff, GitHub App persistence + hot-activation, first-run onboarding | v0.19.0 | pl-26f3 |
| Campaign controller V0 + Phase 2 — `extensions/campaign-controller/`, immutable manifests, action journal, dry-run tick, policy-gated create-PR, first live OpenClaw PR | v0.19.0 | pl-91b6, `docs/design/campaign-controller.md` |
| Jira tracker extension — first external tracker, warren-tracker/v1 over Jira Cloud | v0.19.0 | warren-27d9, `docs/design/issue-tracker.md` |

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
- **Linear as a notification sink** — **Tier 1**. Linear remains the intended first external tracker extension, currently Deferred until paid. Notifications into Linear ride the event bus instead. The old entry conflated the two.
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

- **Verdict ingest and a ranked review queue** (warren-9236) — promote only when pilot
  review volume proves the need. Decide the core fact-ingest shelf as one cut. Core never
  reads an extension endpoint.
- **Descriptive and shadow routing** — begins only after the pilot produces enough clean,
  outcome-joined episodes. Live dispatch/defer or cost-tier policy follows shadow evidence,
  not the other way around.
- **Replica dispatch and Colonies/project groups** (old R-20, warren-2fa8) — the mirror
  fleet can become their payer, but only after fixed-arm cohorts establish a baseline.
  Cross-project scheduling policy may fit the controller better than a new core noun.

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
- **2026-08-20: forges stay in-core.** This closes the question the 2026-08-04 tracker decision left open. The `Forge` registry grows one arm per forge: `WARREN_FORGE=gitlab`, then a Forgejo/Gitea arm. No remote-forge bridge and no forge wire protocol. The asymmetry with trackers is deliberate. Trackers are a long tail (Jira, Linear, Asana, Shortcut, Plane, GitHub Issues, GitLab Issues, …) with few, read-mostly calls. A bridge keeps them out of core at low cost. Forges are three or four names with near-identical APIs. The forge's load-bearing job is to mint short-lived git credentials (forge-contract.md §4), and that job should not gain a process hop. The contract already has room for a second arm: `RepoRef.forge`, `parseRepoRef` chaining, `GitCredential.username`, and the capability flags. Acceptance scenario 40 proves the domain does not change when the forge swaps. A remote bridge returns only if a payer appears (Deferred until paid). One forge per deployment remains the story. Per-project forge selection is a separate feature nobody has asked for. Origin: GH#662, split into GH#1028 (GitLab forge) and GH#1029 (Jira tracker extension).
- **2026-07-30: warren absorbs burrow.** Burrow was a scaffold, built to build warren. Agent-runtime logic is internal to warren and does not live in another repo. This shipped in v0.17.0: Warren owns the harness adapters and sandbox spawn and imports zero burrow code. The burrow project survives as a published standalone sandbox tool, but Warren no longer depends on it. Origin: the pi event-volume investigation, which traced a pi parser gap (`tool_execution_update`) into burrow library code inside warren's k8s pods. That detour through another repo is what this decision ended.
