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
2. **The team.** The GitHub App campaign: login, attribution, and short-lived tokens. One payer cuts two seams (`Forge` and the `AuthProvider` widening) and removes the worst blockers of the third (`IssueTracker`).
3. **The organization with its own stack.** Bring your own tracker (Linear), forge, and runtime. Each is cheap because ring 2 built the substrate.

The brake on all three is PHILOSOPHY rule 1: features pay for seams. Work with no payer sits in **Deferred until paid**, not in Next.

## Seam status

| Seam | Contract | Status |
|------|----------|--------|
| Runtime / sandbox | `RuntimeProvider` (`src/runtime/contract.ts`) | **Live** — local (burrow) + k8s. pl-829f closed 50/50, boundary lint enforced. |
| Storage | dialect-aware db layer (`src/db/client.ts`) | **Live** — sqlite + postgres. |
| Auth | `AuthProvider` (`src/server/auth.ts`) | **Live** — `NoAuth`, `BearerToken`, `PublicRead` behind `WARREN_AUTH` (pl-b82d). The GitHub App widening is `next`. |
| Extensions (Tier 1) | lifecycle bus (`src/runs/lifecycle-bus.ts`, `warren-ext/v1`) | **Live, observe-only** — all 6 hooks emit in production (`run_started` + `event_emitted` wired in v0.13.1, warren-28ca). |
| Forge | `Forge` — repo refs, git auth, PR open/find, checks, error taxonomy | `next` — paid by the GitHub App. Design doc first. |
| Issue tracker | `IssueTracker` — capability-flagged (`supportsPlans`) | `next`, after the App campaign — paid by Linear. |
| Agent runtime | `AgentRuntimeAdapter` phase 1 — terminal detect, usage, error classes, seed layout | `next` — already paid: pi and claude-code are two live implementations. Phase 2 (burrow repatriation) promoted to `next` 2026-07-30 — see the burrow-absorption decision. |

## Now — in flight

- **Hygiene residue** — what remains of the v0.13.1 truth-and-hygiene pass. Delete `closeSeedId` per rule 8 if it is in fact dead. Generalize the finalize holdouts (`commit?: "seeds"[]`, the `FinalizeStage` union) in one contract touch.
- **Self-host hardening residue** `[plan: pl-1c02, outcome: success]`. Two durability items stay open after the batch shipped in v0.13.0–v0.13.1: fetch-before-carve (warren-b94b) and the tracker-integrity gate (warren-a71f part 1).
- **Agent-facing CLI + npm publish** `[plan: not yet filed]`. Step 5 of that plan is also `AgentRuntimeAdapter` phase 1 item 10: one event-envelope extractor in `src/core`, three consumers. The docker-build CI gate shipped in v0.13.0, so the npm publish step no longer inherits the release-before-artifact failure.

## Next — planned, in order

1. **The GitHub App campaign: `Forge` + `AuthProvider` widening, co-designed.** Two design docs come first, modeled on `docs/design/runtime-provider-contract.md`, written while the Now batch runs. Implementation starts on an explicit owner go/no-go. Internal order: consolidate the three GitHub REST clients into `src/forge/github/http.ts` first. Then cut a capability-minimal `Forge` contract, with a FakeForge acceptance provider as implementation #2. Then widen auth: async `authorize`, `Actor.subject`, sessions, `run.dispatched_by`. Then the token story, once. Per-run scoped run tokens shipped in v0.13.0 (warren-57fd) and satisfy the campaign's hard gate on human login. Falsification tests: a FakeForge project completes dispatch → reap → push → PR with zero domain-code changes, and scenario 39 stays green at every commit.
2. **`AgentRuntimeAdapter` phase 1.** Warren-only, parallel with the campaign — the file sets are disjoint. Consolidate the dual usage extractors behind a `usageShape` capability. Move `classifyProviderError`, `seedLayout`, and `harnessStatePrefixes` behind the adapter registry. Type `runtimeId` off `KNOWN_RUNTIME_IDS`. Enforcement: a runtime-id literal outside the adapter directory fails lint. Named non-goals: burrow's `AgentRuntime` interface, the k8s in-pod dispatcher, steering encoding — all of it phase 2 scope (item 4).
3. **`IssueTracker`, Linear first.** After the campaign, which dissolves its worst blockers. Credential storage (B1) generalizes the App's project-to-credential mapping. The sandbox stays `network: none` (B6): tracker calls proxy through warren on the run-scoped token. The FakeForge pattern becomes FakeTracker (B5). Budget the caching and backoff layer (B3, B4) as a real step. The public-mode leak (B2) is a contract-time owner decision. GitHub Issues lands after Linear as implementation #3, on the shared GitHub HTTP core. Design input from the deleted pl-fb43 prototype: any future cross-repo routing must key off tracker-agnostic metadata. That means the 2026-07-29 sidecar-table amendment, keyed by (project_id, issue_id) — never a tracker-specific field like seeds extensions.repo.
4. **`AgentRuntimeAdapter` phase 2 — repatriate the harness logic from burrow.** Promoted from Deferred on 2026-07-30. The promotion trigger was an explicit decision to cut the k8s dependency on `@os-eco/burrow-cli`, and the owner made that decision (see Decisions). Move `AgentRegistry`, the pi and claude-code parsers, `buildSpawnCommand`, and the steering encoders into the warren adapter registry — a source lift from burrow, not a rewrite. Rehome the burrow types and error classes that ~15 domain files import today into warren's own vocabulary. Exit criterion: the k8s path (`src/runtime/k8s/`) imports zero burrow code. The npm dependency survives only for the LocalProvider daemon client. Depends on phase 1 only. The file sets are disjoint from the campaign, so this phase can run early if capacity allows.
5. **Sandbox internalization — the burrow endgame.** `LocalProvider` spawns agents through warren-owned bwrap / sandbox-exec profile generation (lifted from burrow), driven by the same host-side loop the k8s entrypoint already runs. Kills `burrow serve`, the unix socket, the token handshake, `src/burrow-client/`, and the supervisor sibling process. No intermediate raw-exec daemon mode — the absorption decision retires that contract. The excision rides with it: drop `@os-eco/burrow-cli` from `package.json` and the Dockerfile, the burrow-pin assertions in `check:version-sync`, and the two burrow rules in `layer-rules.json`. Rewrite the CLAUDE.md and docs/design/runtime-and-supervisor.md burrow sections. The compose bwrap capability flags stay — warren itself runs bwrap after this.

## Deferred until paid

Honest replacements for old sequencing steps with no payer. Each entry names its price of admission.

- **Re-platform plan-runs, mulch, and seeds as extensions** (old step 6). The old payoff claim was wrong: on current inventory the move kills 2 of 31 `ServerDeps` fields, and mulch has no field at all. The honest version: `seedsCli` and `refreshProjectFn` die when `IssueTracker` lands. The rest of the dep bag dies by other means or not at all. Returns when a real payer appears.
- **Tier-2 mutating hooks.** No consumer exists, first-party or external. `IssueTracker` is a boot-injected provider, not a bus subscriber, so it does not pay for this. Returns when a real extension needs to mutate.
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

## Deliberately not in core

PHILOSOPHY mandates a public entry for every refusal, with a recipe that names the extension tier. Tier 0 is in-repo skills. Tier 1 is container plugins on the event bus. Tier 2 is operator hooks.

- **Issues UI** (old R-04) — **Tier 0**. The agent already runs `sd` inside the sandbox against the project's own repo. A browser CRUD surface over the tracker buys a sync problem and little else.
- **Per-harness UI surfaces** (old R-07) — **Tier 1**. A new harness is an agent image plus a registry entry. What a runtime's events mean belongs behind `AgentRuntimeAdapter`, not in a page per harness.
- **Schema-driven configuration UI** (old R-10) — **Tier 2**. An operator who owns the deployment can render a config form from each tool's JSON Schema.
- **Cross-project activity feed** (old R-14) — **Tier 1**. The JSONL event stream and the events table are already the API. A feed reads them from outside the process.
- **MCP server management** (old R-15) — **Tier 0**. MCP servers are project tooling that the agent starts inside the sandbox, with credentials the project supplies.
- **Audit log** (old R-16) — **Tier 1**. The flagship event-bus consumer. A core `audit_log` table would make the same data twice. Depends on `Actor.subject` from the App campaign.
- **Per-user spend budgets** (old R-17) — **Tier 1**. Per-run cost caps stay in core because dispatch must reject before spend. Per-user budgets need identity plus policy, which reads better on the bus.
- **Slack, Sentry, and Grafana integrations** — **Tier 1**. Integration sprawl arrives as extensions, never as new `ServerDeps` fields.
- **Linear as a notification sink** — **Tier 1**. Distinct from Linear as the tracker: the tracker is `IssueTracker` implementation #2 (see Next), while notifications into Linear ride the event bus. The old entry conflated the two.

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
| Cross-repo plan-run routing (pl-fb43) | v0.13.x (unshipped release line) | Seeds-bound machinery built ahead of the IssueTracker seam; no payer. Deleted per rule 8; the execution-vs-coordination project split survives as an IssueTracker design input. |

## Under evaluation

- **Colonies, or project groups** (old R-20, warren-2fa8) — a go or no-go spike, not a commitment. Cross-project scheduling policy may fit the event bus better than a new core noun.

## Decisions already made

Choices locked earlier, recorded so that nobody relitigates them when an item becomes a seed. Two carry amendments dated 2026-07-29.

- The database holds runtime state only. Issues, expertise, and trigger config stay git-tracked in the project repo under `.seeds/`, `.mulch/`, and `.warren/`. **Amended 2026-07-29:** a warren-side sidecar table keyed by `(project_id, issue_id)`, which holds only warren's own run bookkeeping, counts as permitted runtime state. It is not an issues mirror.
- **Amended 2026-07-29:** the project's tracker is the source of truth for issues. Seeds is `IssueTracker` implementation #1, not a structural dependency. Warren still keeps no issues table (see the sidecar amendment above).
- The kernel's guaranteed output is a pushed workspace branch. Everything past that point is extension behavior.
- Warren stays self-hostable, not SaaS. One warren deploy serves one team. Seams declare a single-org scope explicitly.
- `claude-code` is the public default agent, and `WARREN_DEFAULT_AGENT` picks another one without a source change.
- GitHub webhook triggers stay out of the current phase. The `.warren/triggers.yaml` schema leaves room for another `kind:` entry later.
- Linear before GitHub Issues for `IssueTracker`. GitHub Issues shares its REST surface with `Forge` and would produce a seam with one honest implementation.
- `Forge` owns the branch's fate. `IssueTracker` owns the work item. Issue-close-on-merge stays domain orchestration. Neither seam calls the other.
- **2026-07-30: warren absorbs burrow.** Burrow was a scaffold, built to build warren. Agent-runtime logic is internal to warren and does not live in another repo. End state: warren imports zero burrow code — the harness adapters move in (Next item 4), then the sandbox spawn itself (Next item 5). The burrow project survives as a published standalone sandbox tool, but warren no longer depends on it. Origin: the pi event-volume investigation, which traced a pi parser gap (`tool_execution_update`) into burrow library code inside warren's k8s pods. That detour through another repo is what this decision ends.
