# Warren Roadmap

This file carries direction, sequencing, and seam status. Seeds holds the work queue, so run `sd ready` for what to pick up next.

[SPEC.md](SPEC.md) is the design record. [CHANGELOG.md](CHANGELOG.md) is the ship log. [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) owns the operating policy. This file owns the order of work.

Two rules keep this file short.

1. Shipped items shrink, never grow. A shipped item is one table row that points at its design record.
2. No design sketches. A schema or a config shape belongs in a seed at implementation time, or in SPEC after a design lock.

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
| Extensions (Tier 1) | lifecycle bus (`src/runs/lifecycle-bus.ts`, `warren-ext/v1`) | **Live, observe-only** — 4 of 6 hooks emit today. `run_started` and `event_emitted` are declared and do not emit. Phase 0 closes or marks that gap. |
| Forge | `Forge` — repo refs, git auth, PR open/find, checks, error taxonomy | `next` — paid by the GitHub App. Design doc first. |
| Issue tracker | `IssueTracker` — capability-flagged (`supportsPlans`) | `next`, after the App campaign — paid by Linear. |
| Agent runtime | `AgentRuntimeAdapter` phase 1 — terminal detect, usage, error classes, seed layout | `next` — already paid: pi and claude-code are two live implementations. Phase 2 (burrow repatriation) is `deferred`. |

## Now — in flight

- **Truth and hygiene pass.** Correct the stale claims in PHILOSOPHY, this file, and the two bus/runtime design docs. Re-scope warren-937e. Delete dead code per rule 8: `mergePullRequest`, the pause machinery, `closeSeedId`. Generalize the finalize holdouts (`commit?: "seeds"[]`, the `FinalizeStage` union) in one contract touch. Emit `run_started`, and emit or mark `event_emitted` as reserved.
- **Self-host hardening batch** `[plan: TBD — until the seeds land, the source is local-planning/2026-07-29-self-hosting-docker-path.md]`. Forward `baseBranch` on the local runtime — the silent wrong-base bug. Durability triage: salvage-before-destroy for `finalize_failed` (warren-cd3b), fetch-before-carve (warren-b94b), a tracker-integrity gate (warren-a71f part 1). A functional bwrap probe and a sandbox failure reason. The release-pipeline half — the docker-build CI gate, draft-until-image release ordering, the multi-arch image — shipped in v0.13.0.
- **Agent-facing CLI + npm publish** `[plan: TBD — until the seeds land, the source is local-planning/2026-07-29-cli-and-single-source.md]`. Step 5 of that plan is also `AgentRuntimeAdapter` phase 1 item 10: one event-envelope extractor in `src/core`, three consumers. The docker-build CI gate shipped in v0.13.0, so the npm publish step no longer inherits the release-before-artifact failure.
- **Seam precursors.** Rate-limit classification in `pr-checks.ts`. Redaction entries for `LINEAR_API_KEY` and `GH_TOKEN`. `DOMAIN_STEMS` gains `seed` and `project`. `hasSeeds` directory probes become capability flags (rule 7).

## Next — planned, in order

1. **The GitHub App campaign: `Forge` + `AuthProvider` widening, co-designed.** Two design docs come first, modeled on `docs/design/runtime-provider-contract.md`, written while the Now batch runs. Implementation starts on an explicit owner go/no-go. Internal order: consolidate the three GitHub REST clients into `src/forge/github/http.ts` first. Then cut a capability-minimal `Forge` contract, with a FakeForge acceptance provider as implementation #2. Then widen auth: async `authorize`, `Actor.subject`, sessions, `run.dispatched_by`. Then the token story, once. Per-run scoped run tokens shipped in v0.13.0 (warren-57fd) and satisfy the campaign's hard gate on human login. Falsification tests: a FakeForge project completes dispatch → reap → push → PR with zero domain-code changes, and scenario 39 stays green at every commit.
2. **`AgentRuntimeAdapter` phase 1.** Warren-only, parallel with the campaign — the file sets are disjoint. Consolidate the dual usage extractors behind a `usageShape` capability. Move `classifyProviderError`, `seedLayout`, and `harnessStatePrefixes` behind the adapter registry. Type `runtimeId` off `KNOWN_RUNTIME_IDS`. Enforcement: a runtime-id literal outside the adapter directory fails lint. Named non-goals: burrow's `AgentRuntime` interface, the k8s in-pod dispatcher, steering encoding.
3. **`IssueTracker`, Linear first.** After the campaign, which dissolves its worst blockers. Credential storage (B1) generalizes the App's project-to-credential mapping. The sandbox stays `network: none` (B6): tracker calls proxy through warren on the run-scoped token. The FakeForge pattern becomes FakeTracker (B5). Budget the caching and backoff layer (B3, B4) as a real step. The public-mode leak (B2) is a contract-time owner decision. GitHub Issues lands after Linear as implementation #3, on the shared GitHub HTTP core.

## Deferred until paid

Honest replacements for old sequencing steps with no payer. Each entry names its price of admission.

- **Re-platform plan-runs, mulch, and seeds as extensions** (old step 6). The old payoff claim was wrong: on current inventory the move kills 2 of 31 `ServerDeps` fields, and mulch has no field at all. The honest version: `seedsCli` and `refreshProjectFn` die when `IssueTracker` lands. The rest of the dep bag dies by other means or not at all. Returns when a real payer appears.
- **Tier-2 mutating hooks.** No consumer exists, first-party or external. `IssueTracker` is a boot-injected provider, not a bus subscriber, so it does not pay for this. Returns when a real extension needs to mutate.
- **`AgentRuntimeAdapter` phase 2** — repatriate `buildSpawnCommand`, `parseEvents`, and steering encoding from burrow. A paired warren↔burrow migration. Returns with a third runtime, or with an explicit decision to cut the k8s dependency on `@os-eco/burrow-cli`.
- **The seeds identifier rename.** 1,470 lines and four strings that live in users' repos, for zero behavior change. Not planned at any scale.

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
| Burrow-client eviction and the layer gate | v0.10.x | pl-829f, `scripts/layer-rules.json` |
| Release machinery — version bump, version-sync gate, `ghcr.io` image | v0.11.0 | [CHANGELOG.md](CHANGELOG.md) |
| Deletion pass — conversations, plot, canopy | v0.11.0–v0.13.0 | pl-3a79 |
| Public-read auth stack — `AuthProvider`, `Actor`, route policy, projections, scrubber | v0.12.x | pl-b82d |
| Tier-1 lifecycle bus, healer + seed-close consumers | v0.13.0 | `docs/design/tier1-observation-bus.md` |
| Per-run scoped run tokens — sandboxes drop the operator token | v0.13.0 | warren-57fd, [CHANGELOG.md](CHANGELOG.md) |
| Release-pipeline integrity — PR image-build gate, draft-until-image ordering, multi-arch image | v0.13.0 | [CHANGELOG.md](CHANGELOG.md) |

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
| Multi-worker burrow model and remote workers (old R-12) | v0.10.0 | Superseded by the `k8s` runtime provider. SPEC §5.4 carries the RETIRED banner. |
| Fly.io deploy path | v0.10.0 | Superseded by the container image plus GKE. See `docs/RUNBOOK-K8S.md`. |
| Pause machinery (`markPaused`, `question_posed` remnants) | pending (Now) | Dead since the plot deletion. No non-test caller. |
| `mergePullRequest` | pending (Now) | Built for the deleted Plot PR surface. No production caller. |

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
