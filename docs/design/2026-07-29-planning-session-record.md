# Planning-session record — 2026-07-29 (reconstructed 2026-07-30)

**Kind:** historical-evidence
**Design state:** approved
**Delivery:** not-applicable
**Arrived:** 2026-07-31

The seven `local-planning/` docs from the
2026-07-29 planning session were deleted (warren-0a2c) after their
*decisions* were promoted into `docs/PHILOSOPHY.md`, `ROADMAP.md`, and
seeds plan pl-1c02 — but before their *evidence layer* had a durable
home. This file reconstructs that evidence from a same-day detailed
digest. It is not verbatim (~3,000 lines condensed), but it preserves
the load-bearing findings the distilled docs deliberately omit.

**Who needs this:** whoever files the 0.14 CLI/single-source plan
(§3), writes the Forge/Auth campaign design docs (§4, §5), or starts
the IssueTracker phase (§6).

The session's structure: three investigations (issue-tracker-seam,
self-hosting-docker-path, cli-and-single-source), one condensed
evidence record (audit-findings), one sequencing synthesis
(seam-sequencing, run as three independent lenses: external adoption,
architectural discipline, risk), and two promotion drafts (now applied
as PHILOSOPHY/ROADMAP).

---

## 1. Corrections to ground truth the session had to make first

- PHILOSOPHY's old sequencing steps 1–3 (burrow-client eviction,
  deletion pass, Tier-1 bus) were ALL DONE while the doc said otherwise;
  the auth seam was Live (NoAuth/BearerToken/PublicRead) while the seam
  table said "Planned".
- warren-df3e shipped **re-scoped**: only the finalize *contract types*
  went feature-neutral; the mulch/seeds/plans mirrors still ran inside
  `finalize()`, features enumerated at ~5 sites.
- Tier-1 bus reality: 6 hooks declared, only 4 emitted (`run_started`,
  `event_emitted` had no production emitters — the design doc claimed
  otherwise). Consumers: healer (observe-only) and seed-close (which
  MUTATES via `sd close` — "observe-only" is about payloads, not
  effects).
- `ServerDeps` had 31 fields; the step-6 extensions re-platform would
  kill only ~2 (`seedsCli`, `refreshProjectFn`); mulch has no field at
  all. **"ServerDeps finishes dying at step 6" was false on inventory**
  — this falsified the old step 6's payoff claim and is why it moved to
  "Deferred until paid".

## 2. The one-payer theorem (why the sequencing is what it is)

All three sequencing lenses independently converged: **the GitHub App
is one payer for two seams and a blocker-remover for a third.** It pays
for Forge (installation tokens, checks, PR lifecycle) and for the
AuthProvider widening (login, subject, sessions), and its substrate
dissolves IssueTracker blockers B1, B5, B6 (§6). Therefore Forge + Auth
ship as ONE campaign, and Linear lands after it. Equally load-bearing
negative results: nothing pays for the extensions re-platform or for
Tier-2 mutating hooks — all three lenses killed both.

Phases as decided: 0 truth/hygiene → 0′ self-host hardening (parallel,
"do not queue it behind seams") → 1 CLI/single-source → 2 GitHub App
campaign (gated on explicit owner go/no-go after design docs) → 3
adapter phase 1 (parallel with 2, disjoint files) → 4 IssueTracker
(Linear first). Phases 0/0′ are now pl-1c02.

## 3. CLI & single-source consolidation (the 0.14 plan's source)

**Measured duplication above the HTTP line:** 3 HTTP clients (1,295
lines); 4 copies of the wire response envelopes with **8 live drifts**;
15 hand-rolled poll-until-terminal loops; 21 `sleep`s; 3 event-payload
interpreters; ~215 lines of plan-run logic trapped in a handler. The
CLI was split-brain: only the `plan` group was remote — everything else
opened local SQLite, so `warren run` on a non-host machine died with a
misleading `EROFS`. `@os-eco/warren-cli` 404s on npm: no `files`, no
`publishConfig`, no `exports`, no publish workflow.

**Guard-blindness finding:** the existing guards catch **homonym**
drift (same name redeclared) and are blind to **synonym** drift (same
shape, different name). The fix that pays: extend the guard's *source*,
not its scope — move response envelopes into `src/core/wire.ts` so
`check:wire-types` enforces them for free; add `"project"` (and
`"seed"`) to `DOMAIN_STEMS`.

**Owner decisions D1–D6 (made, not to be relitigated):**
- D1: ONE npm package, not CLI + SDK split (fleet precedent 8/8; Node
  can't load `.ts` from `node_modules`).
- D2: share TYPES only — the UI keeps its own HTTP client ("duplicated
  *transport* is cheap; duplicated *truth* is what bit us").
- D3: the CLI collapses onto HTTP — no local/remote split ("a local
  user is a remote user pointed at localhost"). Genuinely-local
  remainder: `serve`, `db migrate-to-postgres`, half of `doctor`.
- D4: `warren run` keeps its name.
- D5: client config holds base URL + token only, never a DB credential.
- D6: durations render as `4.2s` / `3.1m` / `1.4h`.

**The 8 steps:** (1) fix two live bugs — dead `/agents/refresh` route
in `register-projects.ts`; 3 wrong `readFrontmatter` UI sites; (2) fix
false `dups-allowlist.json` why-strings; (3) envelopes → `src/core`;
(4) acceptance harness adopts `waitForRun` / one `sleep`; (5)
event-payload extraction → `src/core` (relabeled: this IS
AgentRuntimeAdapter phase-1 item 10 — extract, don't re-plan); (6)
plan-run logic → domain; (7) npm publish infra (`files`,
`publishConfig`, `exports["./client"]`, publish workflow) — gated
behind the docker-build CI gate so a second registry can't inherit the
release-before-artifact failure mode; (8) CLI collapses onto HTTP +
new commands `show` / `wait` / `tail` / `prime` / `login`. Serverless
`warren run` (no server running): **killed** by the sequencing doc.

**Doc bugs it flagged:** CLAUDE.md referenced a nonexistent
`@os-eco/burrow` package; SPEC §8.2 claimed "CLI is for ops"
(contradicted by step 8); `ACCEPTANCE.md` referenced a never-existed
`warren events` command.

## 4. Audit findings (Forge / Auth / adapter evidence)

**Forge/GitHub coupling:** ~8 files own ~95% of GitHub knowledge;
three duplicate REST clients; `mergePullRequest` is dead code (delete,
don't wrap); `url.ts` hard-rejects non-github.com; `x-access-token@github.com`
hardcoded in 4 places; `clone-apply.ts:191` pushed with neither auth
mechanism. Forge contract direction: capability-minimal (repo refs,
git auth, PR open/find, checks, error taxonomy), **FakeForge as
implementation #2**, no `mergePr`, no GitLab-shaped generality.
Falsification test: FakeForge completes dispatch→reap→push→PR with
ZERO domain changes; scenario 39 green at every commit.

**Auth surface:** `authorize` was synchronous; `Actor` had no
`subject`; no sessions. Widening scope: async `authorize`,
`Actor.subject`, sessions, `run.dispatched_by`. Hard gate: **no second
human login GAs before scoped tokens ship** ("the token story, once").
warren-57fd (operator token in every sandbox) has since shipped its
narrow fix — `RunTokenMinter` is deliberately the R-18 App seam.

**AgentRuntimeAdapter scoping:** terminal detection is the cheap part.
The real mass: dual usage extractors with a "pi wins if seen" tiebreak
(money-reporting correctness); three disagreeing envelope parsers; pi
workspace layout (`.pi/skills|prompts|extensions`) hardcoded. BIGGEST
FACT: command construction + event parsing + steering encoding live in
burrow's `AgentRuntime` interface, so full repatriation is a paired
warren↔burrow migration — that is adapter phase 2, deferred until a
third runtime pays (or an explicit decision to cut k8s's
`@os-eco/burrow-cli` dependency). Phase 1 (parser/extractor collapse
into warren) is already paid by pi + claude-code being two live
implementations. Pause machinery: dead, delete (in pl-1c02).

## 5. Self-hosting / docker-path findings

Verdict: "the code is not the problem… what has drifted is everything
around the code." Local (the default runtime) had no CI coverage, no
runbook, no release verification, while being the marketing lead.

- Release pipeline: v0.12.0 and v0.12.1 tagged+announced with **no
  image** (TS2307 in Docker UI stage; frozen-lockfile failure);
  v0.12.2 "built by accident". → Fixed post-session: docker-build gate
  on PRs (warren-3380), draft-until-image + promote-then-announce
  (warren-89f2), multi-arch (warren-fe9f), README pin (warren-0d85).
  Residual: ghcr push still lives inside `deploy-gke.yml`.
- **baseBranch bug** (since fixed, #673): `LocalProvider` never
  forwarded `spec.baseBranch`; three outcomes, two silent (hard
  failure; silent corruption where git DWIMs; silent wrong base). It
  was test-locked (`create.test.ts:147` asserted the omission) and
  traced to a false sentence in `runtime-provider-contract.md:91-92` —
  a design-doc lie that *generated* a pinning test.
- Health checks green-while-broken: bwrap probe was `--version` only;
  sandbox failure then misclassified as `no_model_response` ("a
  self-hoster is pointed at their API key"). Seven further proxy
  probes were ranked; nothing checked `GITHUB_TOKEN` /
  `ANTHROPIC_API_KEY` / `git`. → warren-daef in pl-1c02.
- Boot fragility: untunable 5s supervisor socket timeout; README's
  `docker run` had no `--restart` ("a first-timer's very first command
  dies permanently on exit 1").
- Parity ledger: local capabilities are a strict SUPERSET of k8s, but
  local has no concurrency cap and no real per-run resource limits;
  `.warren/config.yaml` knobs silently discarded; only 2 of 7
  capability flags read anywhere ("mostly decorative"); `/metrics`
  works fully on local and the README denied it.
- §9.4 swappability: "at the maintainer level, yes; at the user level,
  no." Under k8s, "the topology whose premise is 'no burrow at all'
  still rents burrow as an agent-runtime library" — the residual
  burrow surface is the single largest blocker to a third runtime
  provider. A `DockerProvider`'s true cost ≈ LocalProvider's 1,939
  lines; nothing structural blocks it.
- The philosophy-consistent ask: not "make local extensible" — "make
  local ENFORCED" (CI coverage, rule 4 applied to behavior).

## 6. IssueTracker seam (Linear phase's source)

Verdict: "the read path is nearly a provider already; the write path
is where seeds' git-native nature is baked into warren's control flow;
the prompts are the part no interface can fix; the operational story
is where the only true blockers live."

**The seven true blockers, B1–B7:**
- B1 — no per-project credential storage anywhere in warren.
- B2 — private issue text would be published anonymously: `prompt` is
  in `PUBLIC_RUN_FIELDS`, safe today only because seeds lives in an
  allowlisted public repo. Owner call: redact behind a
  `trackerIsPrivate` flag vs declare hosted trackers incompatible with
  public mode.
- B3 — polling blows hosted rate limits (measured: 8,640 calls/hour
  from one browser tab vs Linear's 1,500/hr).
- B4 — no caching layer; tick loops drop overlapping ticks;
  `pr-checks.ts` doesn't classify HTTP 429 (precursor in pl-1c02).
- B5 — acceptance harness can't fake an HTTPS tracker (`insteadOf`
  only).
- B6 — sandbox default `network:"none"` forces proxy-through-warren or
  an open sandbox.
- B7 — tracker mutations become non-transactional with the branch
  push.

The App campaign's by-products dissolve the worst: credential storage
→ B1; run-scoped token proxy → B6; FakeForge→FakeTracker harness
pattern → B5; the 429/caching precedent → B3/B4.

**Linear first, GitHub Issues second — deliberately.** GitHub Issues
"feels easier and is harder": same REST family as PRs, so a
`GitHubIssuesTracker` would quietly merge into the Forge seam and
produce a one-real-implementation abstraction (pl-9ba1 again). Linear
shares ZERO substrate, so it cannot cheat the contract. GitHub Issues
arrives later as impl #3 on the shared GitHub HTTP core.

**Design decisions:** seam boundary — `Forge` owns the branch's fate,
`IssueTracker` owns the work item, issue-close-on-merge stays domain
orchestration, neither seam calls the other. The `extensions` metadata
gets a warren-side **sidecar table** keyed `(project_id, issue_id)` —
ratified as permitted runtime state, "not an issues mirror" (amended
locked decision). **Synthetic plans**: `POST /plan-runs` accepts an
ordered issue-id list so `supportsPlans:false` trackers lose plan
*discovery*, not plan *execution* (stable child ordering is the
specific thing hosted trackers lack). The seam plugs in as a
boot-injected provider, NOT a bus subscriber — the Tier-1 bus is
observe-only/detached, so "a subscriber can never *perform* a merge";
warren-df3e's `artifacts: Record<string, ArtifactDelta>` is the
queued-write seam and the better plug point.

**Rename scope, measured then refused:** seeds identifiers appear in
1,470 non-test lines / 277 files, and four strings live in users' own
repos needing permanent aliases — effectively an argument to never
rename.

## 7. Seam house style (the RuntimeProvider template)

Provider-neutral DTOs (never name a first-party feature); capability
flags read by the domain; one registry resolved once at boot; unknown
selections fail loudly; a falsification test written BEFORE the
contract; a lint gate landed in the SAME PR as the contract.
Anti-precedent: pl-9ba1 (speculative abstraction) — "an IssueTracker
seam cut before a real second tracker exists becomes pl-9ba1."

## 8. Owner calls from the session, and their current status

1. warren-57fd timing — RESOLVED: narrow fix shipped (#666/0.13.0),
   `RunTokenMinter` shaped for R-18.
2. App campaign go/no-go — OPEN: run phases 0/0′/1 first, write
   Forge/Auth design docs during, explicit decision after.
3. B2 public-mode vs hosted-tracker privacy — OPEN.
4. warren-a71f part 2 (concurrent seeds-file collision depth) — OPEN.
5. Gitea/GitLab demand — refused for now (capability-minimal Forge).
6. Rewrite of old PHILOSOPHY step 6 — RESOLVED: ratified via the
   promotion (deferred-until-paid).
Plus post-session: agent-registration path for the SDK story (project
tier `.warren/agents/*` was the recommended cheapest option) — OPEN;
v1.0.0 stance (rolling minors + "ecosystem-ready" checklist;
reconsider after the campaign) — OPEN.

## 9. Watchlist / falsification tests

- pl-9ba1 watchlist: any seam cut without a paying second
  implementation.
- Forge: FakeForge end-to-end with zero domain changes.
- Tracker: FakeTracker (B5) before Linear code.
- Adapter phase 2: only with a third runtime or an explicit k8s
  burrow-cli decision.
- Tier-2 mutating hooks (`warren-ext/v2` sketch existed: awaited
  dispatch, return-value semantics, veto pre-hooks, failure policy,
  compat shim, trust/loader story): only when a real extension pays.
