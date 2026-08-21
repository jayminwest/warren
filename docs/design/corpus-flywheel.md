# The corpus flywheel — dispatch data as an RL asset

**Kind:** direction
**Design state:** draft
**Delivery:** unscheduled
**Arrived:** 2026-08-15

No owner go is recorded. This record fixes vocabulary and sequence only.
It designs no schema, no store, and no extension package, per ROADMAP
rule 2. Nothing here is scheduled.
**Amended:** 2026-08-15, same day — the conversation continued.
Additions: the mission positioning (§0), mirrors instead of forks
(§3 step 3), the consent ladder and disclosure (§5), and historical
issue replay (§6). Risks and open questions grew to match.
**Amended:** 2026-08-16 — §9, the core/extension tripwire and the
join-ownership tension, from an owner conversation. Tracked as
warren-9236.
**Grounds:** [`agent-analytics.md`](./agent-analytics.md) §1 (the
corpus thesis), §8 (the closed loop), §12 (the judge layer);
[`PHILOSOPHY.md`](../PHILOSOPHY.md) rules 1, 2, and 5;
[ROADMAP.md](../../ROADMAP.md), the mirror-pilot `now` campaign, and
the Colonies entry (warren-2fa8).

---

## 0. What this cuts

[`agent-analytics.md`](./agent-analytics.md) argues that the telemetry
corpus is the durable asset and the dispatch loop is the commodity.
This record extends that thesis one step: the corpus is also
**training data for a dispatch policy**, and warren is positioned to
collect it, learn from it, and export it. The record lays out a
six-step direction and names the risks. It decides nothing that needs
an owner go.

**Positioning (owner, 2026-08-15).** Warren is not a product. The
owner expects the system to cost money, not earn it. The target is
repos that do real work — research-critical, under-maintained OSS —
selected like grants. The deliverable is refunded maintainer
attention, never consumed maintainer attention. This positioning
removes product pressure: no multi-tenant work, no growth features,
and no reason to revisit the deferred auth widening.

## 1. The thesis

Every warren run is an episode with a verifiable reward. The
transcript is the trajectory. The outcome — branch pushed, gates
passed, PR merged — is the reward. The judge verdict is a dense label
over the trajectory. Warren computes the join `trajectory × outcome ×
verdict`, and only a control plane can compute it. Current RL work on
agents wants exactly this shape: rubric-decomposed trajectories with
outcome-grounded rewards.

Three consumers follow from the join, in order of cost:

1. **A dispatch policy.** A learned model that decides, per issue,
   whether to dispatch, at what cost tier, with how many replicas,
   and with which agent. A contextual bandit is enough to start.
2. **A self-improvement loop.** Warren agents change the policy code,
   gated on counterfactual replay against the logged corpus.
3. **A trajectory export.** The corpus as a dataset for post-training
   work outside warren, in the genre of rubric-reward RL.

The one-line sequence: steps 1–2 below make the data clean, steps 3–4
make it big, steps 5–6 make it compound.

## 2. The dispatch decisions that matter

Frontier models converge on capability, so model identity is the
least valuable dimension to route on. It also decays fastest, because
model releases invalidate model comparisons within weeks. The
decisions that hold value are predictions about the **task**, not
about the model:

- **Dispatch or defer.** An issue predicted to fail must not burn a
  run. It must go to decomposition (`sd plan`) or to a human. This is
  the highest-return decision and needs no model comparison.
- **Cost tier.** Whether the issue needs a frontier model or a cheap
  model. At fleet volume this decision is the economics.
- **Replica count.** One frontier run, or several cheap runs with the
  best result kept.
- **Agent and prompt variant.** Which builtin, which prompt, and
  whether the run will need early human steering.

The durable learned asset is a difficulty model over issues and
codebase sections. Difficulty features describe the task, so they
survive model releases. A new model is a cold-start arm that a few
dozen runs re-estimate. A bandit also updates online — every reaped
run is an update — so there is no retrain cadence to schedule.

## 3. The six-step direction

**Step 1 — seam completion. Shipped.** The `IssueTracker` cut,
`AgentRuntimeAdapter` phases 1–2, and the burrow excision shipped by
v0.18.0. Cheap model, harness, and tracker switching now makes new
dispatch arms cheap to add. No new work enters the queue from this
step.

**Step 2 — record the dispatch context. Shipped.** Every dispatch logs
the issue features, chosen action, override sources, queue snapshot,
and normalized retry lineage. The rule that keeps the pipeline honest
remains: **facts are features, verdicts are labels.** Mechanical data —
outcomes, costs, tool calls, gate results, merge state — feeds the
policy as input. Judge verdicts ride along as labels for reward shaping
and review ranking, never as trusted input features.

**Step 3 — the mirror fleet.** Run warren hard against three to five
**detached public mirrors** of external OSS repos (candidates: an
nf-core module repo, CleanRL, a scverse repo). Mirrors, not GitHub
forks: in a fork, a commit that says `#123` resolves against the
upstream issue and lands a reference in the upstream timeline. In a
detached mirror, `#123` resolves locally and nothing pings upstream.
The one guard: strip full upstream URLs from agent commits. The
mirrors stay public for transparency. **No upstream PRs are planned
for this phase.** The goals are data collection, education, proof
that the system works, and discovery of what breaks on foreign
stacks. The fleet is also the payer for the fleet features warren
lacks: parallel dispatch waves, replica dispatch, and cross-project
scheduling — the Colonies entry (warren-2fa8) finally has a payer.

**Step 4 — the throughput layer.** At fleet volume the binding
constraint is human review, not compute. Two answers: a review queue
ranked by verdict (clean verdict, green gates, small diff first), and
more shepherd automation from the pr-fixer and healer builtins
(branch updates, conflict repair). Step 4 is what keeps step 3's
volume real, and it is the first consumer that proves the verdict
corpus pays rent.

**Step 5 — the router.** An extension that consumes step 2's log at
step 3's volume. Ship it in three stages: a descriptive report, then
shadow mode (log what it would have chosen), then live. Start with
the churn-proof decisions from §2 — dispatch-or-defer and cost tier.
Model identity comes last, if at all.

**Step 6 — close the loop.** Two ends. First, the self-improvement
loop: warren agents change the router policy, and the merge gate is
counterfactual replay — the candidate must beat the incumbent on the
logged corpus. The gate is deterministic and a bad candidate never
touches a live dispatch. Second, the export: `verdicts.jsonl` plus
the audit log plus the events stream as a self-hosted
post-training-grade dataset. The team's corpus never leaves their
deployment.

## 4. Core versus extension

The leaning, deliberately not decided here: everything past step 2 is
extension-tier, except the small dispatch-surface features that only
core can provide (replica dispatch, a defer hook, base-commit
pinning, cross-project scheduling). The router, the review queue, the
replay harness, and the export are readers of published surfaces, in
the posture the judge extension already proved. The decision point
arrives when the first of them becomes a seed.

## 5. Consent and disclosure

The mirror phase needs no consent — the licenses permit it and no
signal reaches upstream. Consent becomes real when work goes
upstream, which the owner has deferred until the system is proven or
OSS sentiment moves. The ladder, weakest to strongest:

1. **Detached mirror.** No consent needed, no signal emitted. The
   current tier.
2. **Policy-aware dispatch.** Warren reads the target repo's stated
   AI-contribution policy and refuses upstream dispatch where the
   policy forbids it. Consent becomes a checkable precondition — a
   defer rule inside the router's dispatch-or-defer decision.
3. **Explicit agreement, warren's operator drives.** Written scope
   with the maintainer: which labels, a PR volume cap, human review
   before anything posts, revocable at any time.
4. **The maintainer operates.** The maintainer runs warren on their
   own key. Consent is structural, because the operator is the
   maintainer. The self-host commitment makes this tier the natural
   end state.

**Disclosure.** Article VII already forbids a bot that poses as a
human. The stronger posture, held for the upstream phase: every
upstream PR links its run, its full trajectory, and its verdict. An
agent PR that is more auditable than a human PR is the trust wedge.

## 6. Historical issue replay

The mirror fleet can work **already-closed issues** and grade the
result against the fix that upstream merged. Each replay case is the
repo at the parent commit of the merged fix, plus the issue text as
it stood before the fix. This turns the data phase into a benchmark:
SWE-bench-shaped, but on the target repos, with real accepted fixes
as ground truth. Three traps, each with a mitigation:

- **Comment leakage.** Issue threads accumulate the solution over
  time. A replay case must snapshot the thread at a cutoff — the
  creation body plus pre-fix comments only.
- **Pretraining contamination.** Old fixes sit in every model's
  training data. Prefer issues closed after the dispatched model's
  cutoff. The match rate by issue age is itself a contamination
  probe: old issues that score higher than fresh ones show memory,
  not capability, and the gap is measurable.
- **Environment rot.** A checkout from years back has dead dependency
  versions and broken CI. This bounds the replay window to roughly
  the last year, on repos with real lockfiles. The bound agrees with
  the contamination mitigation, which also prefers recent issues.

**Grading.** The human patch is a reference solution, not the target.
Warren's fix will look different and can be better. If the fixing PR
added or changed tests, apply those tests to warren's patch — the
ground truth. Patch similarity is a weak secondary signal. A judge
comparison against the human patch rides along as a label only, per
the facts-versus-labels rule in step 2.

**What replay yields:**

- A scoreboard per repo — the evidence a tier-3 consent conversation
  needs ("on your last 200 closed issues, here is our match rate").
- An offline answer to the cold-start risk in §7. Replay produces
  hundreds of pre-labeled episodes per repo — known outcome, known
  human effort (time to fix, patch size, thread length) — so the
  difficulty model trains before the live fleet has volume.
- Cheap replica and cost-tier experiments with ground-truth grades —
  router training data at API cost.
- A benchmark that refreshes itself. Every newly closed upstream
  issue is a fresh, post-cutoff case. The artifact has value
  independent of warren.

**The warren-side gap is small.** Replay is ordinary dispatch plus
one feature: pin a run to a base commit, not only a branch. The case
miner, the grader, and the scoreboard fit one extension, which holds
its own forge token for mining and reads warren's published surfaces.

## 7. Risks

- **Goodhart, twice.** §12.5 of the analytics record already forbids
  raw verdicts in agent context. The router reads verdicts, so the
  rule now guards two doors: verdicts must not reach the judged
  agents, and routed agents must not read the routing features they
  are scored on.
- **Replay needs logged decisions.** Counterfactual evaluation is
  only as good as the decision log. Step 6 is unreachable until
  step 2 has accumulated volume, which is why step 2 starts first.
- **Confounded comparisons.** Merge rate is confounded by issue
  difficulty. Every policy claim ships with denominators and
  confidence, per §9 of the analytics record.
- **OSS etiquette.** Bot PRs to foreign repos burn trust. Mirrors
  first, the consent ladder before anything goes upstream, and the
  durable positioning is warren as a maintainer's own tool, not a
  bot that visits.
- **Low volume.** A bandit on three runs a day learns nothing. The
  live router (step 5) is worthless without the fleet (step 3).
  Historical replay (§6) is the offline mitigation, because it
  pre-labels episodes before live volume exists.

## 8. Open questions

1. What is the minimal feature set for the dispatch-context log, and
   does it live in core columns or in an extension store?
2. Where does replica dispatch sit — a dispatch-time parameter on
   `POST /runs`, or a coordinator like plan-runs?
3. Does cross-project scheduling become the Colonies noun, or policy
   on the event bus? (The warren-2fa8 spike question, now with a
   payer.)
4. Which mirrors make the first fleet, at what run cadence and
   budget, and against which selection criteria (impact,
   maintenance gap, lockfile health, CI quality)?
5. Does the trajectory export need a published wire-schema artifact
   beyond what `FRICTION.md` already specifies?
6. Does pre-dispatch mining of a mirror's full git history earn its
   cost? The recorded leaning: no generic mining pipeline. The
   replay case miner already collects the difficulty features
   (patch size, files touched, time to fix, thread length) as a
   side effect of its walk. The one cheap extra worth taking is a
   **file co-change map** per mirror — which files change together,
   from one `git log` pass — because it seeds directory-level
   difficulty priors. Raw code history is pretraining's food. The
   edge is outcome-joined runs, not git logs.
7. How does warren carry expertise into repos with no
   agent-readiness layer — no `AGENTS.md`, no gates over
   agent-facing docs? The recorded leaning, in three layers. First,
   the mirrors are ours, so onboarding runs build the readiness
   layer in each mirror (discover test commands, write the
   `AGENTS.md`, map upstream CI to a verify script), with a trellis
   audit as step zero. Second, replay checks out historical commits
   that predate any in-tree memory, so expertise must travel with
   warren — mulch records injected as dispatch context, not read
   from the tree. That is a small real feature on the dispatch
   path. Third, and sharpest: **replay makes memory measurable.**
   Run the same replay cases with and without the readiness layer,
   and with and without mulch injection, graded against the merged
   human fixes. Whether agent memory moves outcomes becomes an
   experimental result with ground truth — the §8 closed loop of
   the analytics record, finally testable. No new memory system.
   Mulch is the substrate, and the delivery path is the gap.

## 9. The tripwire — core never reads an extension endpoint

Added 2026-08-16 from an owner conversation. Tracked as warren-9236.

§1 claims warren computes the join `trajectory × outcome ×
verdict`, and only a control plane can. But verdicts live in the
judge extension's own store. Both statements cannot stay true: if
core computes the join, core reads verdicts. The failure mode to
refuse is the middle state — a core reader (UI included) pointed at
an extension's endpoint, degrading when the extension is absent.
That state has neither the clean kernel nor the integrated feature,
and `check:layers` cannot see it, because the dependency is HTTP,
not an import.

The rule, effective now: **no core code reads from an extension
endpoint.** Until the decision below, the judge stays export-only
and every verdict consumer lives outside core.

The decision, deferred to a named trigger: when the first join
consumer becomes a seed — the §3 step 4 review queue, the step 5
router, or the step 2 dispatch-context log — the verdict ingest
surface is decided **as one cut**, choosing between:

- **Ingest-surface promotion.** Core owns a verdict/annotation fact
  table and a `POST` endpoint under the locked §12.3 shape. The
  judge becomes one pluggable producer among possible others
  (strong-model re-judge, human review). An absent judge is an
  empty table, the same way an absent `.seeds/` is an empty queue.
  Core computes nothing and depends on nothing; it offers a typed
  shelf. This puts interpretation *rows* in a core table — a
  conscious PHILOSOPHY amendment, small because §12.3 locked the
  shape like a wire contract precisely so this promotion would not
  need a schema rethink.
- **The §12.1 in-core move.** The whole executor moves into core.
  Note the true cost: warren's pod then holds an LLM credential and
  spends provider money on interpretation, where core today spends
  only on sandboxed runs the operator dispatched.

The recorded leaning is the promotion, matching §4's split (core
provides the small dispatch surfaces only core can; extensions
interpret) and the shape open question 1 is circling for the
dispatch-context log. The corpus collected in the meantime is the
evidence the cut wants: whether the verdicts are good enough to
build core surfaces on.
