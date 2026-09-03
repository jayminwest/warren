# Agent Analytics — the telemetry corpus as a pillar

**Kind:** direction
**Design state:** approved
**Delivery:** mixed
**Arrived:** 2026-08-11

Owner approval was recorded 2026-08-14. Seeds plan pl-103e executed
phases 0–3. Phase 4 contains both shipped judge work and deferred
regulation work. Modeled on
[`extensions.md`](./extensions.md), which is the house form for a
direction record rather than a locked contract.
**Date:** 2026-08-07, from a survey of HEAD plus PHILOSOPHY, ROADMAP,
`extensions.md`, and the audit-log `FRICTION.md`.
**Amended:** 2026-08-11 — the Forge campaign got its owner go
([`forge-contract.md`](./forge-contract.md), plan pl-d1c9), which is
the ordering precondition §11 names.
**Amended:** 2026-08-14 — owner go recorded; plan pl-103e (Agent
analytics phase 1) is the execution vehicle for phases 0–3, with
phase 4 (observer extension, judge layer) still deferred.
**Amended:** 2026-08-12 — §12 records the owner's judge-layer
decisions: heuristics **and** LLM judges, both on every run;
extension-first placement with a named in-core exit. Open question 3
is resolved, and question 1 gets a recorded leaning.
**Amended:** 2026-08-15 — phases 0–3 shipped: pl-103e closed
(success, 13/13 children merged). Phase 4 remains deferred behind
warren-f566 and the FRICTION.md surfaces. The §12.6 owner cut is
recorded: rubric v1 launches with the full 15-class taxonomy
(§12.4), and the verdict shape is locked (§12.3) — confidence as
three bands, evidence ranges plus a capped note.
**Grounds:** [`PHILOSOPHY.md`](../PHILOSOPHY.md) operating rules 1, 2,
5, and 6; [`ROADMAP.md`](../../ROADMAP.md); [`tier1-observation-bus.md`](./tier1-observation-bus.md);
`extensions/audit-log/FRICTION.md`.

## Scope status

| Scope | Delivery | Evidence |
|---|---|---|
| Phases 0–3: capture, insights, and UI | `shipped` | pl-103e, v0.16.0 |
| Phase 4: judge extension | `shipped` | pl-17ca, v0.16.0 |
| Phase 4: regulation and remaining extension surfaces | `deferred` | Requires a payer and the named FRICTION.md surfaces |

---

## 0. What this cuts

Warren ships an analytics layer today, and it is treated as a feature
among features. This record asks a different question: is the telemetry
that dispatch produces the durable asset, and is the dispatch loop the
commodity around it?

The record exists to fix the vocabulary and the gap inventory before
anyone writes a seed. It deliberately does **not** design a schema, a
store, or an extension package. ROADMAP rule 2 puts a schema in a seed
at implementation time or in a design record after a design lock. There
is no lock here, so §5.1 and §11 name *candidates*, not columns to
build.

## 1. The thesis

Warren is built and operated as an orchestration system: dispatch a
run, sandbox it, stream it, reap it, push a branch. The reframe: the
durable value of a control plane is not the dispatch loop. It is the
**telemetry corpus the dispatch loop produces**, and the analytics that
corpus supports.

Insights of the kind this direction targets:

- "Agents struggle with this section of the codebase."
- "This model fails in this specific way."
- "This tool call produces context that is 90% wasteful."
- "Runs steered by a human in the first 10 minutes merge at twice the
  rate of unsteered runs."

The compounding property: every run a team dispatches makes the corpus
more valuable. Orchestration is a commodity. A year of outcome-joined
run telemetry about *your* codebase is not.

## 2. Why warren's position is unique

Two structural advantages, both already true of the code.

**The vantage point.** Harness-level observability tools see the
transcript. Warren sees the transcript **and the real-world
consequence**: branch pushed, commits ahead, PR opened, PR merged
(plan-runs today), seed closed, CI checks, salvage, empty push with
dirty paths. The join `transcript × outcome` is the thing only a
control plane can compute. It turns "the agent called grep 40 times"
into "the agent called grep 40 times *and the PR did not merge*."

**The contract lock.** Every harness lands in one `NormalizedEvent` row
shape (`src/runtime/contract.ts:114`). Every runtime goes through
`RuntimeProvider`. Trackers and forges move behind `IssueTracker` and
`Forge`. Anything a team bolts on must speak warren's contracts, so
analytics computed against those contracts works whatever the harness,
model, tracker, or forge. The analytics layer inherits
stack-agnosticism from the seams instead of building N integrations.

A third advantage is specific to os-eco and is covered in §8: warren
detects the struggle, and mulch is already the delivery channel for the
remedy.

## 3. What exists today (this is not greenfield)

Warren already has a first-party analytics layer.

- **Endpoints.** `GET /analytics/runs` (totals, per-agent, per-model
  and per-provider buckets, failure-reason breakdown, duration
  percentiles, token daily series, top seeds by context),
  `GET /analytics/cost` (eight breakdowns), `GET /analytics/behavior`
  (command mining), `GET /metrics` (Prometheus). Handlers in
  `src/server/handlers/runs/analytics.ts`, aggregators in
  `src/runs/analytics/`.
- **Insight mining exists in embryo.** `src/runs/analytics/insights.ts`
  ships six severity-coded callouts: worst-success agent, most-retried
  command, model cost outlier, steering anomaly, and two more. Command
  mining computes a `stuckScore` from retry-after-failure. That is the
  "agents struggle with X" genre at v0 depth.
- **UI.** The RunAnalytics and CostAnalytics pages, with Recharts
  already a dependency.
- **Public-projection discipline.** `PUBLIC_RUN_ANALYTICS_FIELDS` and
  the redaction allowlists classify every aggregate field for spectator
  visibility. That pattern stays. One deliberate exception since
  warren-97ae: the instance-wide `costPerMergedPrUsd` ratio on
  `outcomes.costPerMergedPr.overall` is public — nothing alongside it
  reconstructs spend — while the byAgent/byModel/byProvider buckets keep
  their USD figures redacted.

So the direction is not "add analytics". It is "promote analytics from
a feature to a pillar, and fix the data problems that cap its depth."

## 4. The flagship insights, mapped to data requirements

| Insight | Data needed | Status today |
|---|---|---|
| Agents struggle with this codebase section | File paths per tool call, joined to failure, retry, and steering, aggregated by directory | Paths sit inside `tool_use` payloads (Read, Edit, Write inputs) and nothing extracts them. Only shell commands are mined. File paths as structured data appear **only** on the failure path (`reap.empty_push.dirtyPaths`) |
| This model fails in this way | Model as a queryable dimension × failure taxonomy × behavioral failure classes | Model and provider are **not columns**. Both are read out of `rendered_agent_json` frontmatter at query time, unindexed, and both describe the *declared* model, not the model the run used (mid-run fallback is invisible). The failure taxonomy (`RUN_FAILURE_REASONS`, 13 values) is infrastructure-heavy — `oom_killed`, `burrow_unreachable` — with no behavioral vocabulary for wrong approach, gate flunk, or spin loop |
| This tool call is 90% wasteful context | Per-tool-call token and byte attribution, context-window accounting | Tokens are run-level totals, nullable, and only pi and claude-code report them (sapling: null). No per-turn attribution, no context-window size, no compaction events. A cheap proxy is available now: `tool_result` payload byte sizes correlated against run context tokens |
| Steering changes outcomes | Steering events × outcome | `run_inbox` holds the full steering text and delivery latency, `steer.sent` events exist, and a steering-anomaly insight already ships. The best-supported insight today, blocked mainly by outcome quality (§5.3) |
| This run pattern lands PRs | PR merged or closed, per run | **Only plan-run children track merge** (`pr_merged_at`). For standalone runs `pr_url` is written once and never revisited, and `successRate` carries exit-code semantics |

## 5. The gaps, grouped by layer

These are the load-bearing gaps, not the full inventory.

### 5.1 Capture — core records too little

- No `queued_at` or `created_at` on runs, so queue wait is
  unmeasurable, and run ids are random rather than time-sortable.
- No model or provider columns, and no signal for the model a run
  actually used.
- `events.origin` (agent versus warren authorship) is dropped at write
  time by design, so provenance is unrecoverable afterward.
- No diff stats (files changed, insertions, deletions). No per-run CI
  check persistence — `pr-checks.ts` polls and discards.
  `commitsAhead` lives in event payloads, not in a column.
- No tool-call table. Every behavioral query re-parses raw
  `payload_json`, capped at 20k rows
  (`DEFAULT_TOOL_EVENT_CAP`, `src/db/repos/events.ts:19`) with silent
  truncation.
- No retry lineage past `parent_run_id`: no chain depth, no root id, no
  attempts counter. The healer counts attempts by scanning event JSON.
- A retention hazard: `ON DELETE CASCADE` runs from projects to runs to
  events. Deleting a project destroys its telemetry history, and no
  rollup survives the cascade.

### 5.2 Normalization — semantics are per-harness and incomplete

The envelope is normalized. The meaning is not. Usage reading, terminal
detection, and tool-shape parsing are keyed per runtime across three
modules, and coverage is uneven.

- `USAGE_SHAPES` covers pi and claude-code only
  (`src/core/usage-shape.ts:150`). **Sapling runs produce null cost,
  null tokens, and null terminal detection.** Per-provider analytics is
  structurally blind to one of the three shipped harnesses.
- Command mining assumes the Anthropic tool-call shape
  (`payload.input.command`, `tool_use_id` joins). `/analytics/behavior`
  is therefore not harness-agnostic, and its response cannot separate
  "the harness emitted no commands" from "the commands did not parse."

This was the `AgentRuntimeAdapter` seam. The seam, runtime-owned
extractors, and harness repatriation shipped by v0.17.0; Pi tool-shape
repair followed before the v0.18.0 corpus campaign. Analytics was a
second, larger payer for making those semantics harness-agnostic.

### 5.3 Outcome — success means "exited 0"

The highest-value single fix. Generalize the plan-runs `PrMergeChecker`
out of `src/plan-runs/`, drive it from a `post_reap` bus subscriber
(whose payload already carries `outcome`, `branchPushed`,
`commitsAhead`, and `prUrl`), and record PR state and merged-at for
standalone runs. The `Forge` contract is the natural home for the
polling. This turns every percentage in the analytics layer from
exit-code semantics into landed-work semantics.

## 6. Architecture — the philosophy-compliant split

PHILOSOPHY's litmus test — a feature that observes or reacts to the run
lifecycle is an extension — sorts this into three layers.

1. **Capture fidelity is core.** Rule 5 says data formats are API.
   Adding a queue timestamp, model columns, persisted origin, diff
   stats, merge state, or a durable global lifecycle stream enriches
   the data format, which is kernel work. Core records facts. It does
   not interpret them.
2. **Normalization is the adapter registry.** Per-harness semantics —
   `usageShape`, `toolShape`, terminal detection, failure
   classification — live behind `AgentRuntimeAdapter`, already Next
   item 2. ROADMAP's refusal of per-harness UI surfaces states the
   rule: what a runtime's events *mean* belongs behind the adapter, not
   in a page (or a metric) per harness.
3. **Interpretation is an observer extension.** The analytics engine —
   deep aggregation, directory-level struggle maps, context-waste
   scoring, LLM-assisted transcript analysis, long-horizon trends —
   ships as a Tier-1 observer with its own store, its own release
   track, and the lifecycle stream as its input. Its own store also
   answers the retention cascade in §5.1, because the rollups outlive a
   deleted project. [`extensions.md`](./extensions.md) already names
   metrics exporters and spend dashboards as the observer kind.

One tension to resolve deliberately: the in-core `/analytics/*`
endpoints. Rule 2 (a first-party feature must be expressible as an
extension) suggests the deep engine goes out of core while a thin
descriptive layer stays in core as the batteries-included default — the
same posture as seeds-in-core against trackers-as-extensions. Where the
line sits is a decision, not an obvious call.

## 7. Roadmap convergence — analytics as the converging payer

**The roadmap is already building the analytics substrate without
naming analytics as the payer.** No new campaign has to jump the queue.
The direction rides three items already sequenced.

- **`AgentRuntimeAdapter` phase 1** (Next 2) gives harness-agnostic
  semantics. Analytics adds `toolShape` and `fileShape` to the
  adapter's contract while the contract is cut, which is far cheaper
  than a retrofit.
- **The Forge campaign** (Next 1, owner go 2026-08-11) gives the
  credential and REST consolidation that makes generalized PR-merge
  polling honest.
- **The flagship extension mechanism** (pl-116e, shipped) gives the
  friction report. `extensions/audit-log/FRICTION.md` already specifies
  what an analytics consumer needs: one durable, sequenced, warren-wide
  lifecycle stream with a cursor per consumer (warren-f566 wants the
  same stream for the UI, so analytics is payer #2), a published
  wire-schema artifact, scoped observer credentials, and actor
  attribution. This direction co-signs every one of those items.

Per rule 1, each capture improvement in §5.1 lands with the analytics
consumer that pays for it, never as a speculative batch.

## 8. The closed loop — analytics to mulch to better runs

The os-eco-specific differentiator. Detection on its own ("agents
struggle with `src/runs/reap/`") is a dashboard. The ecosystem already
owns the remedy channel.

- Analytics detects a struggle pattern with evidence: retry clusters,
  steering hot spots, failed-gate correlation by directory.
- The finding lands as a **mulch record** — a `failure` or a `guide` in
  the project's `.mulch/` — with evidence links.
- `ml prime --files <path>` injects it into the context of the next
  agent that touches those files.
- Analytics then **measures whether the injection moved the metric**,
  which closes the loop and grades its own advice.

The maturity ladder this implies: descriptive (dashboards, exists) →
diagnostic (insight mining, embryonic) → prescriptive (recommended
mulch records, model and agent routing hints) → closed-loop
(auto-recorded expertise, dispatch policy informed by priors). Each
rung is independently valuable, and nothing commits to the top rung.

All of it is self-hosted. The team's behavioral corpus never leaves
their deployment, which is a real difference from SaaS observability.

## 9. Risks and tensions

- **Rule 1 discipline.** "Analytics" is exactly the banner that invites
  speculative core sprawl. Antidote: every schema addition names the
  insight that pays for it.
- **The lossless-payload rule.** The runtime contract passes payloads
  through verbatim by design, so semantic flattening in core breaks it.
  Interpretation stays in adapters and extensions.
- **Measurement validity.** Merged-PR success rate is confounded by
  issue difficulty, and a naive league table ("model X beats model Y")
  misleads. Insights ship with denominators and confidence, and the
  taxonomy prefers *behavioral failure classes* over rankings.
- **Goodhart.** Once an agent's context includes analytics-derived
  guidance, agents are measured by metrics they can read. The stakes
  are low today. Name it before the closed-loop rungs.
- **Sensitivity.** Prompts, steering text, and transcripts are the
  corpus. The public-projection allowlist pattern must extend to
  anything new, and the extension's own surface inherits the audit
  log's auth gap — there is no scoped observer credential yet
  (FRICTION §4).
- **Competitive honesty.** Do not compete with trace viewers on trace
  viewing. The edge is fleet-level, outcome-joined, and cross-harness:
  the control-plane join, not prettier spans.

## 10. Open questions

1. Where is the core/extension line for the analytics engine? Does
   `/analytics/*` stay as the thin in-core default while the deep
   engine goes Tier-1, or does the engine subsume the endpoints?
   *A leaning is recorded in §12.1: extension first, moved in-core
   only if the batteries-included default proves hollow without it.*
2. Does the corpus need a derived star schema (runs × tool calls ×
   files × outcomes) in the extension's store, or is on-demand event
   scanning enough at team scale? The 20k-row cap says scanning already
   strains.
3. ~~Behavioral failure taxonomy: mined heuristically (cheap, coarse)
   or LLM-judged over transcripts (expensive, rich)? Probably
   staged.~~ **Resolved 2026-08-12 (§12): both, as permanent layers,
   each on every run.** Heuristics stay near-free in core. Judges run
   a cheap model at full coverage; cost is controlled by model
   choice, not by sampling.
4. Context-waste scoring: is `tool_result` byte size against context
   tokens a good-enough v0 proxy, or does it need per-turn usage deltas
   that only some harnesses can emit?
5. Does the sidecar-table amendment (2026-07-29, `(project_id,
   issue_id)` runtime bookkeeping) cover per-run merge-state columns,
   or does outcome tracking want its own decision entry?
6. Naming and positioning: is this a feature of warren, or the second
   headline ("orchestrate and understand") in the README pitch?

## 11. Sequencing sketch

**Non-binding.** A sketch, not a plan, and not a queue. It exists to
show that the direction needs no new campaign. Nothing here is
scheduled.

One ordering decision is recorded (2026-08-07, owner): **the Forge
campaign completes before analytics work begins.** The rationale is
that the biggest gap is outcome truth, and merge polling built before
the `Forge` contract would be a second GitHub client the campaign then
has to consolidate. Waiting means the merge watcher is born a Forge
consumer instead of retrofitted into one. That campaign got its go on
2026-08-11 and runs as plan pl-d1c9.

**Phase 0 — riders on work already sequenced, no new campaign.**

- During the Forge campaign: nothing analytics-specific, but the
  contract review confirms `Forge` exposes PR state
  (`merged | open | closed_unmerged`) and merged-at, because the merge
  watcher becomes its first non-plan-run consumer.
- During `AgentRuntimeAdapter` phase 1: add `toolShape` and
  `fileShape` extractor slots to the adapter contract while it is cut,
  and fill the sapling `usageShape` hole. This is the one item worth
  doing early. Retrofitting harness-agnostic extraction later means
  rebuilding every behavioral insight.

**Phase 1 — capture fidelity, small core changes, after Forge.**

- Candidate columns: `queued_at` on runs; model and provider as real
  columns (declared now, actually-used when a harness can report it);
  `commits_ahead` plus basic diff stats at reap; persisted
  `events.origin`.
- The merge watcher: a `post_reap` bus subscriber driving Forge PR
  polling, writing PR state and merged-at onto runs. This single change
  flips every success metric from exit-code to landed-work semantics.

**Phase 2 — the derived layer.**

- A tool-calls rollup, extracted from event payloads through the
  adapter shapes, so behavioral queries stop re-parsing raw JSON under
  a 20k-row cap. It is also the survival answer to the project-delete
  cascade.

**Phase 3 — insight expansion, in core first.**

- Grow `src/runs/analytics/insights.ts` against the new data:
  per-directory difficulty, cost per merged PR, steering-outcome
  deltas, context-waste proxies, agent-config before-and-after deltas.
  Every insight ships with denominators and confidence. In-core is
  deliberate: it sidesteps the delivery-mechanism friction and proves
  the insights on our own fleet before any packaging work.

**Phase 4 — extension and regulation, later, each with its own payer.**

- Re-platform the deep engine as a Tier-1 observer once the global
  lifecycle stream exists (warren-f566 is payer #1, this is payer #2).
- Only then the decide and regulate rungs: recommendations first, then
  policy gates — the roadmap's named first payer for Tier-2 mutating
  hooks.

## 12. The judge layer — LLM judges beside the heuristics

Added 2026-08-12 from an owner conversation. Open question 3 asked
whether behavioral failure classification is mined heuristically or
LLM-judged over transcripts. The recorded answer is **both, as two
permanent layers**, not a staged migration — plus the coverage and
placement decisions below. As with the rest of this record, the
decisions are the owner's and the mechanism sketches are provisional.

### 12.1 Decisions recorded (2026-08-12, owner)

- **Both layers, every run.** Heuristics run on every run. They are
  near-free and already exist in embryo (`stuckScore`, retry
  clusters, the six insight callouts). Judges **also run on every
  run**, not a sampled subset. The corpus thesis (§1) is the reason:
  an unjudged run is a hole in the corpus, and the join only
  compounds if coverage is total. Cost is controlled by model
  choice, not by coverage — the judge defaults to a cheap model, and
  a transcript classification costs cents against a sandboxed run's
  dollars.
- **Extension first, with a named exit.** The judge ships inside the
  analytics observer extension (§6 layer 3), because PHILOSOPHY's
  litmus test sorts interpretation out of core and this direction
  should follow its own rules. The recorded caveat: if the analytics
  pillar turns out to have no batteries-included value without the
  judge — if warren-without-the-extension is not honestly useful —
  the executor moves in-core, the same posture as seeds-in-core
  against trackers-as-extensions. That call is deferred to the
  Phase 4 boundary. It partially answers open question 1.

### 12.2 The judge is a function, not a run

The tempting shape is a ninth builtin agent beside nightwatch and
bugwatch, dispatched through the run primitive. Rejected. The run
primitive exists to sandbox code execution against a repo: clone,
burrow or pod, branch push. A judge executes no code, touches no
filesystem, and needs no repo. Its input is a transcript warren
already holds, and its output is one structured verdict. Sandboxing
it is pure overhead, and judge runs would pollute the very corpus
they analyze (or need a recursion guard to exclude themselves).

The shape instead: a bounded agent loop — the pi SDK is the natural
in-ecosystem driver, though the loop is simple enough that any
provider SDK would serve — with the default tool set stripped to
nothing and replaced by:

- **Read tools, paging, read-only.** Run facts (outcome, failure
  reason, cost, PR state — the ground truth) and a cursor over the
  run's `NormalizedEvent` rows. Transcripts routinely exceed a
  context window, which is the one thing that stops the judge from
  being a single forced-tool-choice completion. As an extension,
  these tools are views over warren's published HTTP surface
  (`GET /runs/:id`, the events endpoint), never the DB — the
  extensions seam already forces the honest boundary.
- **One write tool.** `report_verdict`, schema-forced; calling it
  ends the loop. The verdict lands in the extension's own store,
  never in a core table.

The judge holds no mutation capability of any kind. The constraint
is the design: its entire tool surface is "page the transcript, emit
a verdict."

### 12.3 The verdict shape (locked v1, owner cut 2026-08-15)

A verdict is an interpretation, not a fact, so provenance is
mandatory:

- The taxonomy classes assigned — **multi-label**, a run can be
  `spin_loop` and `env_fumble` at once — each with a confidence.
  **Confidence is a band, not a float:** `low | medium | high`. A
  cheap judge does not own the calibration a 0–1 float pretends to,
  the Goodhart door (§12.5) only needs a high-confidence threshold,
  and the strong-model re-judge measures band agreement directly.
- `clean` is exclusive: a verdict that assigns it assigns nothing
  else, so every denominator exists without double counting.
- **Evidence pointers:** every assigned class except `clean` carries
  at least one event sequence range.
  "`spin_loop`, events 340–612" is auditable. A paragraph is not. A
  class may add one optional free-text note, capped at 200
  characters, as a human-review hint — the ranges remain the
  evidence, and a note never substitutes for them.
- **Provenance:** judge model id, rubric version (a hash of prompt +
  taxonomy), judged-at, and the cost of the judgment itself.
- Re-judging under a new rubric version **appends** a verdict, never
  overwrites one. Trend lines that mix rubric versions are suspect
  by default, and the version field is what lets a query refuse the
  mix.

### 12.4 Behavioral failure taxonomy — rubric v1 (owner cut 2026-08-15)

The owner pass ran on 2026-08-15 and kept **all fifteen classes** as
the rubric v1 launch list. The recorded rationale: maximum corpus
resolution from day one, accepting that the strong-model re-judge
(§12.5) will show more disagreement on the fine distinctions
(`wrong_approach` versus `misread_requirements`, `tool_misuse`
versus `env_fumble`) — that disagreement rate is itself the signal
that drives any future narrowing, and a narrowing is a new rubric
version, never an in-place edit. The classes are behavioral and
orthogonal to `RUN_FAILURE_REASONS` (infrastructure). Admission
rule: a class must be evidence-pointable to event ranges, or it does
not belong. Multi-label by design.

| Class | Meaning |
|---|---|
| `clean` | No behavioral failure. The baseline class, so every denominator exists. |
| `wrong_approach` | Coherent work aimed at a strategy the task does not support. |
| `misread_requirements` | Solved a different problem than the issue states. Distinct from `wrong_approach`: wrong target versus wrong route to the right target. |
| `spin_loop` | Repeated near-identical actions without state change. The judge-grade sibling of `stuckScore`. |
| `context_thrash` | Re-reads and re-derives the same information; the context fills with redundant tool output. The transcript-level cousin of the §4 context-waste insight. |
| `env_fumble` | Fought the sandbox or tooling rather than the task — missing deps, wrong commands, permission loops — while the infrastructure itself was healthy. |
| `tool_misuse` | Persistently malformed tool calls, wrong flags, or misread tool output. |
| `gate_flunk` | The work reached the quality gates, failed them, and the agent either stopped or shipped anyway. |
| `premature_success` | Declared done without verifying: pushed with failing or absent tests, or an empty push with dirty paths. |
| `scope_creep` | The task plus unrequested changes — drive-by refactors that bloat the diff and endanger the merge. |
| `scope_shortfall` | Stopped early with named requirements unaddressed. |
| `destructive_recovery` | Recovered from a mistake by destroying work — hard resets, wholesale rewrites — losing progress a cheaper correction would have kept (the warren-985e genre). |
| `hallucinated_state` | Acted on files, APIs, or repo facts that do not exist. |
| `steering_rescued` | Succeeded only after human steering redirected it. A positive signal for the §4 steering insight, not a demerit. |
| `steering_resistant` | Received steering and failed to incorporate it. |

The 2026-08-12 draft note said fifteen is more than a launch list
wants. The owner pass considered a 13-class and a 9-class cut and
rejected both — an unlogged class is a hole in the corpus the same
way an unjudged run is, and the calibration mechanics already exist
to measure whether the fine distinctions hold up.

### 12.5 Cost and validity mechanics

- **The operator's key, always.** Judges spend the deployment's own
  credential, so transcripts never leave the deployment. The §8
  self-hosted posture is non-negotiable here.
- **A cost cap.** A per-judgment analog of `maxCostUsd`, plus a
  fleet-level daily budget the extension refuses to exceed. When the
  budget is hit, judging skips and marks the run `unjudged` rather
  than degrading silently — a visible hole beats an invisible one.
- **Calibration by re-judge.** Full coverage by a cheap model
  inverts the usual sampling question: a periodic strong-model
  re-judge over a small random sample measures the cheap judge's
  agreement rate, and that disagreement rate is itself a tracked
  metric. A model or prompt change is a new rubric version (§12.3),
  never an in-place swap.
- **Goodhart, restated.** §9 already names it: once verdicts feed
  agent context, agents are measured by metrics they can read.
  Verdicts therefore never enter agent context raw. The curated
  mulch channel (§8) is the only door, and a human or a
  high-confidence threshold guards it.

### 12.6 What this changes in the sequencing sketch

Nothing moves in the phase order. The judge is a Phase 4 resident —
it lives in the observer extension and becomes a co-payer (payer #3,
after warren-f566 and the analytics engine) for the durable lifecycle
stream, the scoped observer credential, and the published wire-schema
artifact from `FRICTION.md`. It need not wait for that stream to
exist: the audit-log extension already tails runs against today's
HTTP surface with the friction logged, and the judge can be born the
same way. The verdict shape and the taxonomy wanted deciding before
the first judgment runs — a corpus of verdicts under a throwaway
schema is worth less than no corpus at all. That cut is now
recorded: §12.3 locks the verdict shape and §12.4 locks rubric v1
(2026-08-15), so nothing gates the judge's birth except someone
building it.

## Appendix — pointers into the code

Line numbers are as of 2026-08-11 and drift. Treat them as hints.

- Wire vocabulary: `src/core/wire.ts` (`RUN_FAILURE_REASONS` :219,
  states, trigger kinds, `KNOWN_RUNTIME_IDS` :344)
- Event envelope and usage: `src/core/event-envelope.ts`,
  `src/core/usage-shape.ts` (sapling absent :150)
- Analytics layer: `src/runs/analytics/` (`run-metrics.ts`,
  `command-mining.ts`, `insights.ts`, `run-metrics-token-series.ts`),
  `src/runs/cost-analytics.ts`,
  `src/server/handlers/runs/analytics.ts` (public allowlists :180-247)
- Lifecycle bus: `src/runs/lifecycle-bus.ts` (payloads :69-135),
  wiring `src/server/main/lifecycle-bus-wiring.ts`
- Plan-run merge polling to generalize: `src/plan-runs/pr-merge.ts`,
  `src/plan-runs/in-flight.ts`, `src/plan-runs/merge-gate.ts`
- Event reads and caps: `src/db/repos/events.ts`
  (`DEFAULT_TOOL_EVENT_CAP` :19)
- Extension friction spec: `extensions/audit-log/FRICTION.md`
- Related open issue: warren-f566, the global lifecycle stream for the
  UI
