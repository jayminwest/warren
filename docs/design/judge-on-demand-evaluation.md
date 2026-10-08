# Judge on-demand evaluation

**Kind:** proposal
**Design state:** proposed
**Delivery:** unscheduled
**Arrived:** 2026-10-08

This record is the investigation and plan for seed `warren-eeff`. It asks
whether the judge extension (`extensions/judge/`) is worth its cost.
It also sets out what an on-demand, budget-bounded evaluation system
would look like if we keep it. It is grounded in the source at
`origin/main` on 2026-10-08 and in the 2026-09-15 live audit recorded in
the seed.

It amends nothing by itself. The owner decisions in §14 are proposals.
[Agent analytics](./agent-analytics.md) §12 remains the recorded
direction until the owner accepts or rejects them.
[TypeSafe judge backend](./typesafe-judge.md) is a sibling proposal
about the inference backend. This record is about when the judge
spends, what evidence it reads, and how anyone can tell whether it
helped. The two can ship in either order.

## Constraints this record preserves

- **Calibration stays paused.** On 2026-09-15 the owner cleared
  `JUDGE_CALIBRATION_MODEL` in the live `warren/judge` Deployment and in
  the gitignored `gke-live-judge` overlay. `resolveCalibration` returns
  `null` for an empty model, so the strong-model loop never starts
  (`extensions/judge/src/config.ts:127-131`, `index.ts:95-142`). Nothing
  here resumes it.
- **No paid calls, no dispatches.** This investigation read source and
  the seed's audit evidence only. It made no LLM calls and no warren
  dispatches, and it did not touch the deployment or the judge config.
- **First-pass judging is still live but idle.** At audit time the
  Gemini collector had 602 terminal runs and 602 current. It spends
  again on the next terminal run, and it re-spends on the whole history
  after any rubric or model change (finding F5). Export-only mode
  (§6) is a proposal. It does not exist yet.

## 1. Summary and recommendation

**Keep the stored corpus and the export. Stop all automatic paid
evaluation. Rebuild the paid path as operator-approved cohorts. Decide
retention on measured incremental value.** Put plainly:

1. Ship an explicit `export-only` mode as the default. Then set the live
   judge to it and remove the "blank the model env" pause (§6).
2. Fix the dashboards so they count distinct runs within one explicit
   model and rubric cohort (§7). Today they count verdict rows across
   models and rubrics, so a calibration pass moves the "pass rate"
   without a single new run.
3. Move what code can decide out of the LLM. That covers uncommitted
   work, session-file commits, repeated tool errors, and infrastructure
   failure (§9). Give the LLM a compact, deterministic evidence package
   instead of a paging tool it must budget itself (§8).
4. Build a $0 offline reference set from the existing 408 GLM-5.3
   verdicts and their first-pass pairs. Adjudicate it by hand, and
   measure precision, a recall bound, and incremental actionable
   findings before any paid experiment (§11).
5. Only then, run paid evaluation as bounded cohorts. Each cohort gets a
   total budget, atomic spend reservations, durable claims, and a
   restart-safe schedule (§10).

**Retain the paid judge only if** the offline set shows these four
results. First, flagged-verdict precision of at least 0.6. Second, at
least one actionable finding per $10 of judge spend that the
deterministic detectors did not already catch. Third, a 95% upper bound
on the missed-actionable-finding rate below 10% on the clean sample.
Fourth, operator review time per actionable finding under 15 minutes.
The thresholds are owner decisions (D7). If those results are not met,
retire the paid path. Keep the export, the stored corpus, and the
deterministic detectors. §15 states the full conditions.

The audit is the main evidence for this position. It triaged 22 flagged
verdicts. The actionable findings it surfaced were the committed
session files, which had already been fixed elsewhere (warren-194a), and
a real prompt deviation. Several other flags were mislabels or judgments
the cost cap had truncated. Deterministic facts already on the run row
or in the reap events cover most of the useful signal.

## 2. The system as built

| Mechanism | Where | Behavior |
|---|---|---|
| Two loops, one process | `index.ts:176-213` | `Promise.all` runs the first-pass collector and the calibration loop concurrently, sharing one SQLite ledger |
| Discovery | `collector.ts:100-109`, `:160-179` | Every cycle (`JUDGE_POLL_INTERVAL_MS`, default 30 s, `config.ts:109`) re-lists all runs and judges every terminal run whose cursor does not match the current rubric and model, oldest first |
| Re-judge trigger | `cursor-store.ts:76-80` | `needsJudgment` compares the `(rubricVersion, judgeModelId)` pair. Any rubric edit or model change makes the whole history eligible again |
| Judgment | `judge-loop.ts:164-305` | A Pi agent session with `get_run_facts`, `page_events`, and `report_verdict`. Up to `JUDGE_MAX_RETRIES + 1` attempts (default 3) |
| Run facts | `warren-wire.ts:105-119`, `:212-229` | Parses only state, failure reason, cost, PR facts, and timestamps out of `GET /runs/:id` |
| Paging | `judge-tools.ts:152-228` | Model-chosen `since` and `limit` (up to 500 events, default 200 from `config.ts:117`), with a hard page cap (`JUDGE_MAX_PAGES`, default 40) |
| Per-judgment cap | `judge-tools.ts:175-195`, `judge-loop.ts:282-292` | Checked when the model asks for the next page, and between attempts |
| Daily budget | `collector.ts:183-197`, `calibration.ts:347-366` | Each loop reads `spendForDay`, clamps its cap to the remainder, then judges. Spend lands in the ledger after the judgment (`collector.ts:147`, `calibration.ts:407`) |
| Ledger | `spend-ledger.ts:21-59` | Append-only `(day, cost_usd)` rows. There are no reservations |
| Calibration | `calibration.ts:296-306`, `:333-433`, `:450-460` | Samples cheap-judged runs that have no strong-model row, re-judges them, and recomputes exact band agreement. The loop runs a pass, **then** sleeps |
| Store | `verdict-store.ts:78-93`, `:213-228` | Append-only rows, deduplicated on `runId \| rubricVersion \| judgeModelId` |
| Export | `server.ts:90-112`, `:114-145` | Bearer-gated `/verdicts.jsonl` (`since`, `limit`, `order` only) and `/agreement` |
| Core proxy | `src/server/handlers/judge-proxy.ts:32-45`, `route-table.ts:161-168` | Operator-gated reverse proxy to the judge export (warren-1b40) |
| UI consumers | `judge-verdicts.ts:93-153`, `judge-tab.tsx`, `economics-tab.tsx:115-133`, `telemetry-metrics.tsx:113-122` | The Judge tab, the Economics "judge pass" column, and the telemetry "judge pass" cell |
| Deploy | `.github/workflows/deploy-gke.yml:583-601`, `deploy/k8s/extensions/judge/deployment.yaml:20` | Each release runs `kubectl set image` on the judge. The `Recreate` strategy replaces the pod |

Nothing else in core or the other extensions reads verdicts. There is
no review queue, no router, and no dispatch-context consumer. The three
UI surfaces are the whole consumer set.

## 3. Measured evidence (from the 2026-09-15 audit)

These numbers come from the seed. This investigation did not re-query
the live ledger.

- **Spend.** The ledger held $172.47 across all judge activity since
  2026-09-01. On 2026-09-15 it recorded 50 judgments for $20.10, a mean
  of $0.40 each. On 2026-09-14 it recorded 40 for $11.90, a mean of
  $0.30. **The mean judgment cost more than the $0.25 per-judgment cap
  on both days**, so the cap behaves as advisory (warren-dfce).
- **Cadence.** The live config ran 10 samples per pass on OpenRouter
  GLM-5.3 at $20 per day and $0.25 per judgment. A 24-hour interval was
  configured, but pod replacements re-ran calibration on boot (F1).
- **Agreement is not accuracy.** 408 GLM-5.3 verdicts: 386 clean, 22
  flagged. Over matching run and rubric pairs, 266 matched exactly, 118
  differed only in confidence, and 24 differed in label set. That gives
  65.2% exact and 94.1% label-set agreement. Both legs are models, so
  neither figure measures correctness.
- **Flag triage (22 flagged, bounded cited ranges).** This did not
  establish recall and did not audit the clean verdicts. The seed names
  these cases:

| Case | What the audit found | Value |
|---|---|---|
| Repeat-edit friction (`run_bf3q998xp735`, `run_qg6wyekv65ex`, `run_xt8wgpxzn72f`) | Real, often recovered within successful runs | Low. Deterministically detectable (§9) |
| Session files committed (`run_wxzase8mcy6t` seq 653) | Real | Already fixed structurally. `src/runtime/adapters/pi.ts:66,73` and `src/workspace/git/exclude.ts` exclude `.pi/sessions/` (warren-194a). Deterministically detectable |
| Misleading blame (`run_650bzvr6g69d` seq 2004/2007) | Judge cited early activity and missed the tail. Reap showed `dirtyPaths=[.warren/]` | Wrong. Tail truncation |
| Qualified accusation (`run_d738mxdwk3tp`) | Prompt deviation is real. A security regression is unsupported | Partly actionable |
| `run_w81eccy5nr7a` seq 569 | Honest report of missing prerequisites, labeled `scope_shortfall` | Mislabel. An honest blocker is not a shortfall |
| `run_8a5b6pf07m9s` | Labeled `steering_resistant`, but delivery of the steer is unproven | Unsupported |
| `run_ks6sqre5jt5r` reap seq 9921/9922 | Uncommitted code, zero commits. Not a success claim | Mislabel. Platform facts already say it |
| `run_ywv0dx8tb3sc` seq 28315 | Fix landed after the judged failure range | Wrong. Tail truncation |

Several verdicts state that the cost cap stopped them before the tail.
The rubric tells the model that `dropped_commit` is `premature_success`
territory (`rubric.ts:102-106`). That merges platform non-delivery into
a behavioral claim.

## 4. Findings in current source

Each finding cites `origin/main` as of 2026-10-08.

**F1 — Calibration runs on every boot.** `runCalibrationLoop` calls
`calibrateOnce` before its first `sleep`
(`extensions/judge/src/calibration.ts:450-460`). The collector loop has
the same shape (`collector.ts:247-258`). Each release replaces the judge
pod (`.github/workflows/deploy-gke.yml:583-601`, `Recreate` strategy at
`deploy/k8s/extensions/judge/deployment.yaml:20`). So every release,
reschedule, or crash starts a fresh pass, and nothing persists the last
pass time. The configured interval is therefore a minimum gap within one
process lifetime, not a cadence.

**F2 — The daily budget has no reservation, and the two loops race.**
Both loops run concurrently (`index.ts:176-213`). Each does
read-remaining, judge, then record (`collector.ts:183-199` with `:147`,
`calibration.ts:347-407`). Two in-flight judgments can each clamp to the
same remainder, so the day can overshoot by up to one extra remainder,
plus each judgment's own overshoot (F3). The collector's header says
sequencing is serial and the gate is race-free (`collector.ts:31-33`).
That stopped being true when calibration began sharing the ledger.

**F3 — The per-judgment cap only acts between pages and attempts.** The
cap is checked when the model calls `page_events`
(`judge-tools.ts:175-195`) and after an attempt
(`judge-loop.ts:282-292`). A page can carry up to 500 events
(`judge-tools.ts:171-174`). That page's tokens are billed on the next
model turn, and every later turn re-sends it as context. The
audit's mean of $0.30–$0.40 against a $0.25 cap is the result
(warren-dfce). The cap is also clamped to the remaining daily budget
(`collector.ts:123`), so it cannot stop a turn that is already in
flight.

**F4 — Cost-truncated verdicts look complete.** `page_events` sets
`state.costCapHit` (`judge-tools.ts:107-108`, `:181`). The loop copies
only `pagesRead` and `pageCapHit` into stats and provenance
(`judge-loop.ts:237-238`, `:250-252`), and the wire shape has no
cost-cap field (`wire.ts:91-101`). A verdict the model wrote after the
cap refused the tail is indistinguishable from a full-transcript
verdict. Two of the eight named audit cases missed the tail. Their
provenance cannot say whether the cost cap caused it, and that gap is
the defect.

**F5 — Any rubric or model edit re-drains the whole history.**
`needsJudgment` compares the stored pair
(`cursor-store.ts:76-80`), and discovery walks every terminal run oldest
first (`collector.ts:160-179`). A one-word edit to `CLASS_DEFINITIONS`
forks `rubricVersion` (`rubric.ts:204-207`). A changed `JUDGE_MODEL`
changes the model id. Either one makes every historical run a paid
candidate, limited only by the daily budget. warren-8cff's
"rubric-fork re-drain" of about 334 runs was this mechanism. Any
evidence or rubric improvement in §8 would trigger it again.

**F6 — The judge does not get the task or the measured outcome.**
`parseRunDetail` keeps nine fields (`warren-wire.ts:212-229`).
`GET /runs/:id` also returns `prompt`, `agentName`, `seedId`,
`commitsAhead`, `filesChanged`, `insertions`, `deletions`, and `baseSha`
(`src/client/types.ts:88-174`, measured at reap per
`src/runs/reap/outcome-facts.ts:1-19`). The judge must find the task and
the reap tail by paging. The rubric tells it to read the tail
(`rubric.ts:98-101`), but the cost cap often stops it first (F3, F4).

**F7 — The rubric conflates non-delivery with misbehavior.**
`rubric.ts:102-106` maps `failureReason: dropped_commit` to
`premature_success`. The reap pipeline already classifies an empty push
deterministically as `droppedCommit` or `noChanges`, and records
`dirtyPaths` (`src/runs/reap/util.ts:261-287`,
`src/runs/reap/pipeline.ts:245-263`). Asking a model to re-derive a
recorded fact costs money and adds a failure mode.

**F8 — Nobody checks the evidence ranges against what the judge read.**
`validateReportVerdictArgs` checks range shape and order only
(`report-verdict-tool.ts:104-123`). A cited range the judge never paged
is accepted. Auditors can catch it only by hand.

**F9 — The dashboards count rows, not runs.**

- `summarizeJudgeVerdicts` counts every row in the newest 500 export
  rows (`src/ui/src/pages/telemetry/judge-verdicts.ts:71`, `:100`,
  `:189-221`). That mixes first-pass and calibration models, every
  rubric version, and unjudged markers from any model. One run can
  count three or more times.
- `computeAgentPass` counts each row as one of `total`. It includes
  unjudged markers and calibration rows, and only clean verdicts count
  as pass (`economics-tab.tsx:115-133`). A calibration marker therefore
  lowers an agent's "judge pass" with no new run. The join covers only
  the newest 200 runs (`runs-join.ts:10`), while the table's run counts
  use the telemetry time window (`economics-tab.tsx:214-237`).
- The "Merged, then failed the judge — REVIEW THESE FIRST" panel
  (`judge-tab.tsx:353`) lists every verdict with a non-clean class
  (`:301-306`). It never filters on PR state. `steering_rescued` is a
  positive class per `rubric.ts:63-65`, but it still counts as "fail"
  (`judge-verdicts.ts:202-206`).
- "fail" here means "the judge flagged something for review". It does
  not mean the run failed. The run's own state already says that.
- The UI's verdict type drops `pagesRead` and `pageCapHit`
  (`judge-verdicts.ts:40-46`). A capped verdict cannot be marked even
  where the export carries the flag.

**F10 — The export has no cohort filters.** `/verdicts.jsonl` accepts
only `since`, `limit`, and `order` (`server.ts:90-112`). Every consumer
must download rows and filter by model and rubric itself. Today none
does.

**F11 — A $0 failure loops with no bound.** The warren-d8df fix
correctly skips a $0 failure without writing a marker
(`collector.ts:126-132`, `calibration.ts:381-395`). But the collector
then retries that run every 30 s indefinitely, and `index.ts` never
wires `onZeroCostSkipped` for either loop. So the skip is silent in the
pod log too. A dead credential spins quietly at $0 and hits the
provider every cycle.

**F12 — The warren-9236 tripwire is already crossed.**
`docs/design/corpus-flywheel.md:305-307` says no core code, the UI
included, reads from an extension endpoint. warren-1b40 then added
`GET /extensions/judge/verdicts.jsonl` to core
(`src/server/handlers/judge-proxy.ts:32-45`). The UI reads it in three
places (§2). That is the "middle state" §9 of that record names: a core
reader that degrades when the extension is absent. Any plan that keeps
the dashboards must either decide warren-9236 or remove them.

**F13 — The calibration metric measures model agreement only.**
`computeAgreement` scores exact band equality between two models
(`calibration.ts:90-134`). It cannot detect the shared blind spots the
audit found, such as both legs missing a truncated tail. It is a
consistency signal, not a validity signal.

## 5. Product purpose and consumers (scope 1)

| Candidate purpose | Consumer today | What would make it pay |
|---|---|---|
| Operator diagnosis of one run ("why did this go wrong?") | None automated. The operator reads the transcript | Faster triage than reading the transcript, with cited ranges a human can check in a minute |
| Finding platform defects across runs | The audit itself | Findings that become seeds, such as session files committed or harness traps |
| Pre-merge review triage | None. The "merged" panel does not filter merges (F9) | Flags that change a merge decision, with tolerable false positives |
| Aggregate quality score per agent or harness | Economics and telemetry "judge pass" | A validated label with known precision. Today's rows-not-runs math (F9) makes it unusable |
| Corpus labels for the flywheel (router, reward shaping) | None. warren-9236 has not triggered | Labels with a measured error rate. Agreement (F13) is not enough |

**Proposed purpose.** Treat the judge as an operator diagnostic and
defect-finding tool. Do not treat it as a quality score. A score needs
validated precision and recall per class, which nobody has measured.
Operator diagnosis and defect finding can justify cost run by run. Each
useful finding becomes a seed, and the value is countable (§11).

**Can we keep the exports and the UI but disable automatic evaluation?**
Yes. Section 6 makes that the default mode. The stored corpus has no
ongoing cost, apart from the PVC and one idle pod. The dashboards stay
useful only after the F9 fixes, and only under a warren-9236 decision
(D5).

## 6. Operating modes (scope 2)

Today the only off switch is to blank model env vars. That depends on an
untracked overlay and is reversed by any overlay edit. Replace it with
one explicit mode variable, resolved in `config.ts`:

| `JUDGE_MODE` | Collector | Calibration | Cohorts | Export | Model credential needed |
|---|---|---|---|---|---|
| `off` | no | no | no | no | no |
| `export-only` (proposed default) | no | no | no | yes | no |
| `on-demand` | no | no | approved cohorts only | yes | yes |
| `continuous` (today's behavior, legacy) | yes | if configured | yes | yes | yes |

Rules:

- In `export-only` and `off`, boot builds no Pi session factory
  (`index.ts:67-70`, `:111-114`) and requires no provider key. A mode
  that cannot spend should not hold a credential that can.
- **Read access and spend access are different permissions.** The
  `JUDGE_EXPORT_TOKEN` and warren's operator proxy grant read access to
  stored reports only. Approving a cohort is a separate act with its own
  credential, `JUDGE_ADMIN_TOKEN`. It goes on a separate route,
  `POST /cohorts` on the judge itself, and is never proxied through
  warren core (keeps F12 from growing). The approval records who
  approved it, when, and the budget.
- `continuous` stays available for a deployment that wants today's
  behavior. But the default changes, and every F-fix in §10 applies to
  it too.
- Boot logs the mode and the budget state on one line. An operator
  reading `kubectl logs` must see "export-only: no spend possible"
  without inferring it from missing env.

## 7. Dashboard corrections (scope 3)

The unit of every judge figure is **a distinct run within one explicit
cohort**. A cohort is `(judgeModelId, rubricVersion)`, plus the
evaluation-policy version once §8 lands.

1. **Cohort selection.** Default to the first-pass cohort with the most
   runs in the window. Show calibration and other models as an explicit
   selector, never mixed in. Add `judgeModelId`, `rubricVersion`, and
   `kind` filters to `/verdicts.jsonl` (F10) so the UI stops downloading
   a mixed page and filtering it locally.
2. **Distinct runs.** Collapse rows to one per `runId` within the cohort.
   Within one cohort the store dedupe key already makes that unique.
   Coverage is cohort verdicts divided by terminal runs in the same
   window, not rows divided by rows.
3. **One window.** Bound the verdicts and the runs join by the telemetry
   window, not "newest 500 rows" against "newest 200 runs".
4. **Rename the semantics.** Say "flagged for review", not "fail".
   Report `steering_rescued` separately as a positive signal. Show run
   failure from run state, never from a verdict.
5. **Fix the merged panel.** Either filter on `prState === "merged"` or
   retitle it "Flagged verdicts".
6. **Mark partial evidence.** Carry `pagesRead`, `pageCapHit`, and the
   new `costCapHit` (F4) into the UI type. Mark truncated verdicts, and
   exclude them from rates by default.
7. **Unjudged means this cohort.** Count only markers of the selected
   cohort. A calibration marker never touches a first-pass figure.
8. **Economics.** Drop the "judge pass" column until the offline
   evaluation (§11) gives it a known error rate. A per-agent rate over a
   few dozen runs with an unknown labeler error is noise presented as a
   metric.

These are UI changes plus extension-owned export filters. None of them
spends money. Items 1–7 need D5 settled, because they deepen the core
UI's reliance on an extension endpoint.

## 8. Evidence selection (scope 4)

Replace "model pages until the cap" with a **deterministic evidence
package**. Code assembles it in a fixed order and a known size before any
model call:

1. **Task.** `prompt`, `seedId`, `agentName` (already on
   `GET /runs/:id`, dropped by F6).
2. **Measured outcome.** `state`, `failureReason`, `commitsAhead`,
   `filesChanged`, `insertions`, `deletions`, `prState`, `prMergedAt`.
3. **Reap tail.** Every `reap.*` event payload, which includes
   `reap.empty_push` with `dirtyPaths`, `droppedCommit`, and
   `noChanges` (`src/runs/reap/pipeline.ts:254-262`).
4. **Final statement.** The last assistant message, truncated to a byte
   budget.
5. **Compact failures.** Tool calls with `isError`, shown as
   `seq · tool · command or path · first error line`, with repeats
   grouped.
6. **Steering.** Each steer with its delivery evidence and the next
   actions, kept together.
7. **Detector output (§9).** Facts, not conclusions, with their `seq`.
8. **Requested windows.** Only then, bounded windows around detector
   hits and the final 2 × N events. Every included range is recorded, so
   coverage is explicit.

The judge then classifies the run into **one outcome category** before
any behavior class:

| Category | Source | LLM needed? |
|---|---|---|
| Infrastructure failure | `failureReason` in the infra set (`rubric.ts:107-111`) | No |
| Platform non-delivery | `reap.empty_push` with `droppedCommit`, push or PR failure | No |
| Recovered friction | Detector hits followed by green gates and a delivered commit | Mostly no. LLM only to say whether the friction mattered |
| Honest blocker | Final statement names a missing prerequisite, and nothing claims success | Yes, short |
| Unsupported success claim | Final statement claims success and the facts contradict it (no commits, failing gates) | Detector proposes, LLM confirms |
| Behavioral failure | The rest: rubric classes over the evidence package | Yes |

`premature_success` should mean a *claim* the facts contradict, not
"no commit landed" (F7). Changing that is a rubric fork. F5 must be
fixed first (§10), or the fork re-drains history at full price.

## 9. Deterministic detectors (scope 5)

Spend LLM calls only on interpretation. Each detector emits
`{detector, seq range, fact}` with no judgment attached.

| Detector | Inputs | Existing code to reuse | Takes over from |
|---|---|---|---|
| Uncommitted work at end | `reap.empty_push.dirtyPaths`, `commitsAhead = 0` | `classifyEmptyPush` (`src/runs/reap/util.ts:261-287`) | `premature_success` on `dropped_commit` |
| Harness or bookkeeping files committed | Committed path list against `harnessStatePrefixes` and `commitExcludes` (`src/runtime/adapters/pi.ts:66,73`) | The exclusion lists. A committed path list is **not** recorded today. It needs `git diff --name-only` at reap or the forge PR file list | The session-file audit finding |
| Repeated tool errors | `tool_calls` rows (`src/db/schema/sqlite.ts:486`) with `isError` and the same normalized command | `stuckScore` and retry clustering (`src/runs/analytics/command-mining.ts:36-43`, `:310`) | `spin_loop` and `tool_misuse` candidates |
| Repeated edit failures on one path | Edit-class tool calls with `isError` grouped by path | `src/runs/analytics/tool-call-extract.ts` | The repeat-edit friction findings |
| Success claim against the facts | Final-message success phrases combined with `commitsAhead = 0` or a failing gate result | New, small | Candidate unsupported success claim |
| Steering receipt | Steer events and inbox delivery or acknowledgement | `buildSteeringSignals` (`src/runs/analytics/insights.ts:416`) | Precondition for `steering_resistant` |
| Infrastructure cause | `failureReason` | `RUN_FAILURE_REASONS` (`src/core/wire.ts`) | Behavior classes on infra runs |

**Placement.** Build the detectors in the extension first, over the
public HTTP surface (events, run facts). That needs no new core surface
and keeps them removable. No run-scoped route serves the `tool_calls`
rollup today (`route-table.ts:284-351` lists the `/runs/:id` routes), so
the extension recomputes from events. That gap belongs in
`extensions/audit-log/FRICTION.md` when the work starts. Promote a detector into core only if a core consumer needs it.
Heuristics are the near-free core layer per
[agent analytics](./agent-analytics.md) §12.1, so a promotion does not
breach the tripwire.

The committed-path detector is the one that needs a core change. A
reap-time `files` fact, or an event carrying the name list, is a small
additive outcome fact in the warren-ab2b mold.

## 10. Bounded cohorts (scope 6)

A **cohort** is the only way the judge spends in `on-demand` mode.

### 10.1 Shape

```text
cohort {
  id, createdAt, approvedBy, approvedAt,
  selector: explicit runIds | {window, project, agent, state} frozen to runIds at approval,
  evaluationVersion, provider, model,
  limits: { totalUsd, perJudgmentUsd, maxCalls, maxTokens, maxWallMs,
            perItemZeroCostRetries, consecutiveFailureStop },
  status: approved | running | paused | done | stopped(reason)
}
cohort_item { cohortId, runId, state: pending|claimed|done|unjudged|blocked,
              attempts, zeroCostFailures, leaseUntil, reservedUsd, spentUsd }
spend_reservation { id, cohortId, runId, reservedUsd, createdAt, settledAt, actualUsd }
judge_schedule { name, lastStartedAt, lastCompletedAt, nextDueAt }
```

The selector freezes to explicit run ids at approval. A rubric fork then
cannot widen a cohort, which fixes F5 for on-demand mode. In
`continuous` mode, F5 needs an explicit "re-judge history" cohort rather
than an implicit re-drain.

### 10.2 Atomic spend reservations

The judge is one process with one writer per SQLite file
(`Recreate`, one replica). Use `BEGIN IMMEDIATE` for every reservation:

1. Compute committed spend for the day and the cohort, plus every open
   reservation.
2. If committed plus open plus `reserveUsd` exceeds the daily budget or
   the cohort total, refuse. The item stays `pending` and the cohort
   pauses with the reason recorded.
3. Otherwise insert the reservation and mark the item `claimed` with a
   lease, then commit.
4. After the judgment, settle in one transaction. Record the actual
   cost, close the reservation, and update the item.
5. On boot, an expired lease with an unsettled reservation is settled
   **at the reserved amount**. The provider may have billed it, so the
   conservative assumption is that it did. The item returns to
   `pending`.

`reserveUsd` is `perJudgmentUsd + overshootAllowance` (§10.4). Both the
collector and calibration go through this path, which fixes F2.

### 10.3 Restart-safe schedule

Store `lastStartedAt` and `nextDueAt` durably. On boot, a loop sleeps
until `nextDueAt` and does not run immediately (fixes F1). A pod roll
mid-cohort resumes from the item table. Leases stop a second process
(during a botched rollout) from double-judging. In `on-demand` mode no
schedule exists at all. Approval starts the cohort, and the cohort ends
when its items or limits run out.

### 10.4 What the dollar cap can and cannot promise

A perfect dollar cap is not achievable, and the design should say so.

- **The judge knows cost only after a turn.** The provider bills input
  tokens for the context it was sent. The cost appears in session stats
  only after the turn returns.
- **One turn carries the whole context.** A turn after a 500-event page
  can cost more than the remaining cap by itself (F3).
- **Prices can be wrong.** USD comes from the SDK's price table. A stale
  table, cache pricing, or provider-side retries make the figure an
  estimate.

So the design bounds the overshoot instead of denying it:

- **Bound the input.** With the §8 evidence package, the request size is
  known before the call. Refuse the call if the projected input plus
  maximum output cost exceeds the remainder (fixes warren-dfce). In the
  paging backend, size pages by bytes, not by event count, and project
  each page's cost before serving it.
- **Bound the output.** Set a `maxTokens` output limit per turn and a
  maximum turn count per judgment.
- **Bound time.** Set a wall-clock `AbortSignal` per judgment.
- **Reserve the residual.** `overshootAllowance` is one maximum turn's
  cost at list price. The reservation covers it, so the daily total
  overshoots by at most the price-table error. It never overshoots by a
  whole extra judgment.

### 10.5 Bounded retries for zero-cost failures

A $0 failure stays out of the verdict store (warren-d8df). It still
increments `cohort_item.zeroCostFailures`:

- After `perItemZeroCostRetries` (proposed 2), the item becomes
  `blocked` in the cohort table. It stays out of the verdict store, so
  the dedupe key remains free (fixes F11).
- After `consecutiveFailureStop` (proposed 3) consecutive $0 failures
  across items, the cohort stops with `credential_or_model_unreachable`.
  A dead key then costs three provider calls, not one per cycle forever.
- Wire the skip callbacks so every skip logs.

### 10.6 Provenance additions

Add `costCapHit`, `evidencePolicyVersion`, the evidence byte size, and
`cohortId` to provenance (F4). Validate that each cited range lies
inside an included evidence range (F8). Reject the verdict, or drop the
class, if it does not.

## 11. Offline evaluation before paid experiments (scope 7)

All of this phase costs $0 in model spend. It uses verdicts already in
the store, and it costs human time.

### 11.1 Reference set

Use stratified draws from the existing store under the GLM-5.3 rubric
cohort and the matching first-pass rows:

| Stratum | Size | Why |
|---|---|---|
| All 22 GLM-flagged verdicts | 22 | Precision of flags |
| Label-set disagreements between the two models | 24 | Where at least one model is wrong |
| Random GLM-clean verdicts | 60 | Bound the miss rate |
| Infrastructure-failure and `dropped_commit` runs | up to 20 | F7 and outcome categories |
| Long runs with `pageCapHit` or a cap note | up to 20 | Truncation effects |

Strata overlap, so the total is at most about 146 runs. Freeze the
run ids and the verdict row ids in a fixture file before any labeling.

### 11.2 Adjudication protocol

For each run, one adjudicator records the following from run facts, the
reap tail, and the cited plus final ranges:

- the outcome category (§8);
- for each assigned class: correct, wrong, or not decidable from the
  evidence;
- any **actionable finding**, meaning something that would produce a
  seed, a fix, a PR rejection, or a prompt change, and whether a
  deterministic detector (§9) already surfaces it;
- the minutes spent.

A second adjudicator re-labels a 20% overlap to measure their own
agreement. Disagreements go to the owner.

### 11.3 Measures

- **Flag precision.** Correct and actionable flags over all flags, with
  a Wilson 95% interval. With 22 flags the interval is wide, roughly
  ±0.2 near 0.5. Report the interval, not only the point.
- **Recall bound.** With 60 clean verdicts and *k* missed actionable
  findings, report the exact binomial 95% upper bound on the miss rate.
  With k = 0 that is about 3/60, or 5% (rule of three). With 30 it is
  about 10%. True per-class recall is out of reach at this size, and the
  record says so rather than inventing it.
- **Incremental value.** Actionable findings that no detector surfaces.
  This is the number that justifies an LLM.
- **Cost per useful finding.** Historical spend for the sampled
  judgments divided by incremental actionable findings. Report the
  ledger mean and the provenance `costUsd` sum side by side.
- **False-positive load.** Operator minutes spent on wrong flags per
  week at the expected run volume.

### 11.4 Then, and only then, a paid pilot

If the owner approves after §11.3, run **one cohort** over the frozen
reference set with the §8 evidence package and the §10 limits. The
proposed limits are $5 total and $0.15 per judgment. Compare the result
against the human labels, not against the other model. If TypeSafe
(see [typesafe-judge.md](./typesafe-judge.md)) is evaluated, run it over
the same set and the same evidence.

## 12. Existing seeds (scope 8)

This record closes none of them.

| Seed | Status | Re-verified on `origin/main` | Relationship |
|---|---|---|---|
| warren-dfce: per-judgment cap fires only between pages | open | Still true (`judge-tools.ts:175-195`, `judge-loop.ts:282-292`). Audit means of $0.30–$0.40 exceed $0.25 | Absorbed by §10.4. Keep it open as the defect record. It can be retitled "projected-cost gate before each turn" |
| warren-8cff: drop the daily budget toward $5 | open | The budget lives in the gitignored overlay, which this investigation did not read. The base manifest says 5 (`deployment.yaml:83-84`) | Superseded in intent by `export-only` (§6). Owner decides whether to close or retarget it (D9) |
| warren-0528: surface provider errors as `judge_error` | closed | Verified. `getLastError` ends the judgment on the first attempt (`judge-loop.ts:227-233`, `:264-272`) | Done. §10.5 extends it to cohort-level stop |
| warren-d8df: no marker for a $0 attempt | closed | Verified (`collector.ts:126-132`, `calibration.ts:381-395`) | Done. Residual F11 (unbounded retry, unwired callbacks) is new work |
| warren-9236: core never reads an extension endpoint | open | Already crossed by warren-1b40 (`judge-proxy.ts`, F12) | Must be decided before §7 items 1–7 (D5) |
| warren-194a: session files committed | closed | Verified (`src/runtime/adapters/pi.ts:66,73`, `src/workspace/git/exclude.ts`) | Do not re-file. §9 adds a detector to catch a regression |

## 13. Alternatives considered

| Option | Cost | What it gives | Assessment |
|---|---|---|---|
| A. Retire the judge (delete extension, proxy, UI) | None. Saves the pod and the PVC | Nothing. The corpus is lost | Premature. The offline set is free and decides this |
| B. Export-only permanently | Near zero | A frozen corpus and dashboards over it | The right **interim** state. Only an end state if §11 fails |
| C. On-demand cohorts plus detectors (recommended) | Build cost, small bounded spend | Spend tied to a question, with measured value | Recommended, gated on §11 |
| D. Continuous judging with the F-fixes | Today's spend, bounded better | Coverage per §12.1 | Not justified while no consumer uses coverage and precision is unmeasured |
| E. Swap the backend (TypeSafe) | Separate | Possibly cheaper and more structured | Orthogonal. Evaluate with the same reference set |
| F. Detectors only, no LLM | Build cost, $0 run cost | The audit's most useful findings | Strong fallback. Ships first anyway |
| G. Move the executor into core (§12.1 exit) | Core holds an LLM credential | An integrated feature | Rejected now. The value is unproven, and the move makes core spend on interpretation |

## 14. Owner decisions

- **D1 — Purpose.** Accept "operator diagnosis and defect finding" as
  the judge's purpose, and drop "quality score" until §11 validates it?
- **D2 — Amend §12.1 "judges run on every run".** Replace it with
  "judges run on approved cohorts, coverage is a cohort property"? The
  original rationale was corpus completeness, which no consumer uses
  today (§5).
- **D3 — Default mode.** Make `export-only` the default and switch the
  live judge to it, ending the env-blanking pause?
- **D4 — Spend authority.** Is a separate `JUDGE_ADMIN_TOKEN` on the
  judge the right approval surface? Or must cohort approval go through
  warren's own auth (which grows the core proxy)?
- **D5 — warren-9236.** The proxy already crossed the tripwire. Choose
  one: (a) accept the proxy as the sanctioned read path and amend
  `corpus-flywheel.md` §9; (b) execute the ingest-surface promotion now;
  (c) remove the judge UI from core and serve it from the extension.
- **D6 — Detector placement.** Extension first, as proposed, with a
  core reap fact for committed paths only?
- **D7 — Retention thresholds.** Confirm or change the §15 numbers:
  precision ≥ 0.6, ≥ 1 incremental actionable finding per $10, miss
  bound < 10%, < 15 min review per finding.
- **D8 — Pilot budget.** Approve, change, or refuse the §11.4 pilot
  cohort ($5 total, $0.15 per judgment), and only after §11.3 reports.
- **D9 — warren-8cff.** Close it as superseded by D3, or keep it for
  `continuous` deployments?
- **D10 — Rubric fork.** Allow a rubric v2 (outcome categories,
  `premature_success` redefined) once F5 is fixed? Should it also
  re-judge history, as an explicit cohort with its own budget?

## 15. Retention recommendation

Retain the **corpus, the export, and the deterministic detectors**
unconditionally. They cost almost nothing and the detectors carry most
of the audit's useful signal.

Retain the **paid LLM path** only if the §11 offline evaluation, and
then the §11.4 pilot, show all four of these:

1. Flag precision of at least 0.6, with the Wilson lower bound above
   0.4.
2. At least one incremental actionable finding per $10 of judge spend,
   counting only findings that no deterministic detector already
   surfaces.
3. A 95% upper bound on the missed-actionable-finding rate below 10%
   over the clean sample.
4. Median operator time per actionable finding under 15 minutes,
   including time spent on false positives.

If any condition fails, retire the paid path. Keep the export. Then
remove the Pi session dependency from the extension, or delete the
extension and keep a final export snapshot. Re-run the decision when a
real join consumer (warren-9236's trigger) appears, because that
consumer brings its own precision requirement.

## 16. Recommended order, costs, and risks

| Step | Spend | Depends on | Notes |
|---|---|---|---|
| 1. `JUDGE_MODE` with `export-only` default, boot without credentials (§6) | $0 | D3 | Smallest change that makes the pause structural |
| 2. Persisted schedule, no run on boot (F1) | $0 | — | Also protects `continuous` deployments |
| 3. Provenance `costCapHit`, range-in-evidence validation (F4, F8) | $0 | — | Additive to the wire shape. Refresh the goldens |
| 4. Export cohort filters plus dashboard denominators (§7, F9, F10) | $0 | D5 | UI and extension, with tests in `judge-verdicts.test.ts` |
| 5. Deterministic detectors in the extension (§9) | $0 | D6 | Committed-path fact is a small core follow-up |
| 6. Offline reference set and adjudication (§11.1–11.3) | $0, about 10–15 h human | 3, 5 | Produces the retention evidence |
| 7. Evidence package and outcome categories (§8) | $0 to build | 5 | A rubric fork. Needs step 8 first |
| 8. Cohort engine: reservations, claims, leases, zero-cost bounds (§10) | $0 to build | 1, 2 | Fakes only. `fake-warren.ts` already exists |
| 9. Paid pilot cohort (§11.4) | ≤ $5 | D8, 6, 7, 8 | The first spend this plan authorizes, and only with approval |
| 10. Retain or retire decision (§15) | — | 9 | — |

**Costs.** Steps 1–8 are engineering only. The largest are the cohort
engine (8) and the evidence package (7). Step 6 is human time. The only
model spend is step 9, capped at the approved total.

**Risks.**

- *The reference set is small.* Intervals stay wide. The plan reports
  them and does not claim per-class accuracy.
- *Adjudicator bias.* One owner-labeled set can encode one view. The 20%
  double-label overlap measures it.
- *Rubric fork cost.* Without step 8 first, any rubric change re-drains
  history (F5). The order above prevents that.
- *Price-table error.* The cap can still drift by the SDK's pricing
  error (§10.4). Compare the ledger with provider invoices once per
  pilot.
- *Tripwire drift.* Steps 4 and 7 deepen the core UI's dependence on the
  extension unless D5 is decided first.
- *Sunk-cost pull.* $172 spent so far is not a reason to keep spending.
  §15 is the gate.

## Not authorized by this record

Resuming calibration, any paid model call, any warren dispatch, any
change to the live judge Deployment or overlay, and closing any seed.
Each needs the owner's explicit approval.
