# TypeSafe judge backend and routing exploration

**Kind:** proposal
**Design state:** proposed
**Delivery:** unscheduled
**Arrived:** 2026-09-17

Replace the judge extension's agent-driven inference loop with TypeSafe's
typed decision API. Warren code gathers the evidence, TypeSafe evaluates
focused behavioral questions, and code assembles the existing verdict.
Keep the extension's collector, durable storage, budgets, exports, and
operator-only observation boundary.

This proposal extends [Agent analytics](./agent-analytics.md) §12. It is
not a roadmap commitment. The current implementation remains in
`extensions/judge/src/judge-loop.ts` and `pi-session.ts`.

The routing exploration below was added on 2026-09-17 after discussion
of historical run costs. It is also unscheduled; neither integration
depends on shipping the other.

## Why change the inference path

The current judge creates a Pi agent session with three tools:
`get_run_facts`, `page_events`, and `report_verdict`. The model decides
which pages to read and must remember to call the final tool. Missing
verdicts consume a retry budget. The extension also carries a hermetic
resource loader and session lifecycle machinery to use a coding-agent SDK
for a read-only classification task.

TypeSafe accepts evidence as `state` and a map of typed questions. Its
Jev model returns decisions directly. We can make evidence collection,
coverage, and verdict assembly explicit code while removing the Pi
session dependency from the primary inference path. See the
[introduction](https://docs.typesafe.ai/introduction) and
[HTTP API](https://docs.typesafe.ai/api).

Classification overlap is a rubric-authoring concern shared with the
current judge. The trial's false positives are reasons to sharpen
questions and examples, not evidence that TypeSafe is intrinsically a
worse judge. Conversely, the trial does not establish that prompting
alone will resolve every error. Compare both backends against labeled
evidence to measure the result.

## Initial live trial

On 2026-09-17, six hand-authored synthetic transcripts were evaluated
through `jev-latest`, which resolved to `jev-1.13.0`. Each request asked
the same fourteen non-clean taxonomy questions plus one question about
evidence completeness. Questions used the existing class definitions
and the `noul` primitive. Expected labels were local expectations, not
sent to the API. No real run transcripts were sent.

| Synthetic case | Observed answer |
|---|---|
| Verified fix, tests and gates pass, changes pushed | All behavior probabilities at or below 0.14 |
| Repeated invalid commands, failed tests, false success claim | `spin_loop` 0.85, `tool_misuse` 0.93, `gate_flunk` 0.94, `premature_success` 0.97 |
| Container evicted during otherwise ordinary work | All behavior probabilities at or below 0.26 |
| JSON shipped instead of requested CSV despite human correction | `misread_requirements` 0.91, `scope_shortfall` 0.95, `steering_resistant` 0.96 |
| Human guidance enables a verified parser fix | `steering_rescued` 0.95; other behaviors at or below 0.05 |
| Transcript ends while implementation begins | Evidence sufficient 0.05; `scope_shortfall` 0.57 |

All six requests returned structured answers without retries. Measured
client request latency was 67–207 ms, median 108.5 ms. Total reported
usage was 10,298 input tokens and 1,740 output tokens. USD cost was not
established. These are small-input smoke results, not production latency
or accuracy estimates, and the probabilities are model outputs rather
than measured correctness rates.

The CSV case also returned `gate_flunk` 0.75 despite passing tests, and
`wrong_approach` 0.92 alongside `misread_requirements`. The repeated-command
case attracted additional labels, including `context_thrash` 0.51.
The initial questions reused short definitions without contrastive
examples. They need explicit boundaries: failed requirements are not
automatically failed quality gates; a wrong target differs from a wrong
route; repeated commands do not necessarily imply repeated information
gathering. Those distinctions also belong in the current rubric.

## Proposed judgment flow

1. The existing collector discovers a terminal run and calls its
   `JudgeFn` seam (`extensions/judge/src/collector.ts`).
2. The backend fetches run facts and events using the extension's HTTP
   client. It preserves sequence numbers, task requirements, steering,
   and terminal reap events in a deterministic evidence package.
3. Code partitions oversized evidence into bounded windows. Each window
   carries the task, relevant run facts, and enough neighboring context
   to interpret actions. Coverage and omitted ranges are recorded.
4. One TypeSafe request per window batches independent questions against
   that state. Dependent judgments receive a separate request only when
   they require evidence selected by earlier answers.
5. Code reconciles findings across windows, validates evidence pointers,
   applies versioned class thresholds and confidence-band mappings, and
   returns a validated `JudgeOutcome` to the existing collector.

Use native Bun `fetch` against the documented endpoint. Load
`TYPESAFE_API_KEY` through the deployment's environment mechanism. Keep
credentials out of requests' recorded metadata and diagnostic output.
Backend selection should be explicit and separate from the existing
Pi provider/model configuration; an implementation can introduce
`JUDGE_BACKEND=pi|typesafe` while retaining the current default during
evaluation.

## Questions and rubric ownership

Retain the fifteen-class, multi-label vocabulary. Ask independent
questions for the fourteen non-clean classes; a single choice among
all classes would discard co-occurring behaviors. `steering_rescued`
remains a positive behavioral signal under the existing taxonomy.

Start with `noul` for well-defined presence questions. Use a separate
coverage decision, informed by deterministic collection status, to
distinguish absent behavior from missing evidence. Never derive `clean`
solely because every probability fell below a threshold on a truncated
transcript. Where essential evidence is missing, return an explicit
unjudged outcome; select or extend its reason vocabulary deliberately.

Definitions, exclusions, and examples should have one canonical home in
the extension, rendered into backend-specific requests. This avoids
maintaining unrelated Pi and TypeSafe taxonomies. Hash the questions,
examples, windowing/aggregation policy, thresholds, and band mappings
into the evaluation version so a policy change cannot silently mix
incompatible results. Preserve historical rubric versions.

TypeSafe's `noul` is a yes-probability; Choice and Score expose a separate
distribution-derived confidence statistic. Neither should be copied
blindly into our `low | medium | high` bands. Establish the mapping on
labeled examples and retain raw outputs for evaluation. See
[primitives](https://docs.typesafe.ai/primitives) and
[confidence](https://docs.typesafe.ai/confidence).

## Evidence and long transcripts

The documented request budget is approximately 32,000 tokens shared by
state and questions. Bound requests below the provider limit and verify
the limit during implementation. Large transcripts require windowing;
the initial trial did not exercise it.

The documented API returns typed decisions, not event citations. Supply
named candidate spans and ask whether each span supports a finding,
then map accepted span IDs back to actual event ranges in code. A
positive whole-window classification is a candidate for localization,
not permission to cite the entire window as proof. Reject nonexistent
or unsupplied spans. Measure citation support as well as label accuracy.

Cross-window behaviors such as context thrash and steering resistance
need linked evidence. Preserve the steering message and subsequent
actions together; collect candidate repetitions across windows before
judging them. Avoid a simple maximum over window probabilities: more
windows would otherwise create more chances for a false positive.
Aggregation is a versioned policy to validate with long-run examples.

Always reconcile against terminal facts. Infrastructure failure alone
does not establish agent misbehavior. A missing commit or failed gate
is relevant evidence, but the surrounding actions determine the
behavioral assignment. Transcript contents remain untrusted evidence,
never instructions to the judge.

## Existing contracts to preserve

- Keep the standalone extension boundary and the public Warren HTTP
  client; add no imports between core and extensions.
- Keep append-only verdicts, deduplication, durable cursors, model
  provenance, export authentication, and the Goodhart guard. No raw
  verdict enters a dispatched agent's context.
- Record the resolved model returned by TypeSafe, not just the moving
  `jev-latest` alias. Resolve model changes in cursor/deduplication policy
  so they do not silently suppress re-evaluation.
- Preserve daily deferral and per-judgment accounting. Establish current
  pricing before production use; token usage is not USD cost. Bound
  calls and retries, reserve budget conservatively before requests, and
  account for all billed attempts, including failed judgments.
- Validate response shapes, question IDs, and probability bounds. Apply
  bounded backoff to transient API errors; do not retry invalid
  credentials or malformed requests as though they were missing verdicts.

The existing cheap/strong comparison can remain during evaluation, but
agreement with the current judge is not ground truth. Human-labeled
examples adjudicate disagreement. Also correct the existing analytics
wording that says using an operator's key means transcripts never leave
the deployment: a hosted model receives the submitted evidence. TypeSafe
adds a distinct hosted provider to that data flow.

## Implementation and evaluation sequence

1. Add an opt-in TypeSafe backend at `JudgeFn`, with deterministic input
   assembly, typed response validation, budget accounting, and fixture
   tests for error paths and evidence handling.
2. Build a labeled corpus from representative finished runs: clean work,
   overlapping behaviors, infrastructure interruption, steering, and
   long or incomplete transcripts. Run both backends over comparable
   evidence; record cost, latency, per-class precision/recall, abstention,
   and whether cited ranges substantiate each assignment.
3. Tune definitions and examples on a development split, then evaluate
   on held-out runs. Include transcript instructions attempting to alter
   the verdict. Inspect false-clean outcomes and cross-window failures
   explicitly. Choose class thresholds from those results.
4. Make TypeSafe the primary backend after the comparison establishes
   acceptable judgment quality and operational behavior. Remove Pi-only
   machinery and dependencies when no retained calibration path needs
   them. Update the extension README and analytics record with shipped
   behavior and the actual evaluation results.

The proposed direction is to simplify the inference machinery. Rubric
tuning is ordinary implementation work for either backend. The remaining
design work specific to this integration is evidence localization,
bounded transcript assembly, aggregation, and provider accounting.

## Future exploration: task assessment and model routing

The owner chose to record this direction without prioritizing implementation
on 2026-09-17. Inter-agent communication is outside this exploration and has
no identified payer. This section does not promote routing on the roadmap
or change the evidence gates in [Corpus flywheel](./corpus-flywheel.md).

### Historical evidence

A read-only query of the deployed Postgres database on 2026-09-17 Pacific
covered 673 retained runs, with start dates from July 28 through September
17 Pacific (September 18 UTC). Model identity used `runs.model`, falling
back to the frozen agent frontmatter when that column was absent. All rows
declared API cost basis; the one active run had no recorded cost yet.

For completed runs on the Warren repository:

| Model identifier | Runs | Distinct merged PRs | Recorded cost | Cost per merged PR |
|---|---:|---:|---:|---:|
| `z-ai/glm-5.3` | 115 | 97 | $107.02 | $1.10 |
| `z-ai/glm-5.3-flash` | 77 | 48 | $63.15 | $1.32 |
| `moonshotai/kimi-k3` | 299 | 216 | $397.25 | $1.84 |
| `x-ai/grok-4.5` | 14 | 13 | $19.16 | $1.47 |
| `claude-opus-5` | 22 | 14 | $40.12 | $2.87 |
| `claude-opus-4-8` | 38 | 20 | $89.28 | $4.46 |

The numerator includes all recorded costs in the model/repository cohort,
including failed attempts and runs without a merged PR. The denominator
counts distinct nonempty `pr_url` values with recorded `pr_state=merged`.
This is descriptive delivery economics, not a matched experiment or a
complete repair-lineage accounting. Costs of subsequent work under another
model stay in that model's cohort. Different identifiers were kept separate:
the additional 20 Warren runs labeled `glm-5.3` are not in the OpenRouter
`z-ai/glm-5.3` row. No transcript or credential export is included here.

GLM 5.3 is a plausible Warren baseline from this sample. The ranking changes
on Trellis: Kimi recorded $52.09 across 29 completed runs and 21 merged PRs
($2.48/merge), versus GLM's $99.52 across 28 completed runs and 26 merged PRs
($3.83/merge). Repository-specific baselines therefore deserve evaluation.

Only eight issue histories in the retained dataset involved multiple model
identifiers. Models ran in different periods, against different tasks and
infrastructure conditions. Merges do not measure later defects, and stored
costs are not a reconciliation against provider invoices. These results
support provisional defaults, not a claim that one model is universally
cheapest or strongest. Refresh the query before implementation; do not turn
this snapshot into permanent model rankings.

### Smallest useful policy

Assess before dispatch and evaluate after completion:

1. Gather the task, bounded repository context, and relevant historical
   outcomes. Keep evidence selection deterministic and record missing context.
2. Ask JEV focused questions about requirements clarity, scope, and risk.
   Recommend clarification or decomposition when the task is not ready.
3. Map the assessment to a small operator-configured model pool in code,
   using repository baselines, allowed spend, and available credentials.
   Preserve an explicit provider/model override as the operator's choice.
4. Record the assessment, resolved JEV model, policy version, selected
   provider/model, fallback reason, and eventual delivery outcome.
5. Compare cost per accepted change, including retries and repairs, against
   the static baseline. Use human review and objective delivery facts to
   check judge labels; JEV's own score cannot be the sole success criterion.

Start with shadow recommendations, then a bounded opt-in trial if evidence
supports it. JEV estimates task characteristics; observed execution outcomes
establish which models handle those characteristics economically. Model
confidence is not an empirically established success probability.

No online bandit, replica races, autonomous model discovery, or mid-run model
switching is needed for this experiment. Existing budget, permission,
provider-compatibility, and retry checks remain deterministic. Assessment
calls need their own accounting and bounded timeout; unavailable or invalid
assessments use a configured fallback within the existing spend policy.

### Placement: controller first, core integration only with a consumer

The initial experiment can live in the
[campaign controller](./campaign-controller.md), before it submits a run
through the existing provider/model overrides. The judge remains an
independent observer extension. Neither core nor the router needs to read
the judge extension's endpoint; any outcome join follows the existing
corpus design boundary.

This preserves the current direction of control: extensions call Warren;
Warren does not synchronously call an extension to decide whether to
dispatch. It also limits initial coverage to controller submissions.
Manual, scheduled, and other dispatch paths retain their existing defaults.
There is no new `model: auto` API or configuration contract in this proposal.

If those other paths become concrete consumers, consider a small core
`ModelRouter` provider contract shared by dispatch entry points. Core would
own resolution, override precedence, decision provenance, and failure
behavior; the routing policy could have an external implementation. That
would be a deliberate new provider boundary requiring a separate contract,
not an implicit synchronous call to an observer extension. Timeout,
fallback, and whether explicit auto-routing may defer a submission must be
settled before that integration ships.

### Other candidate uses

- **Repair triage:** classify ambiguous CI evidence into likely code repair,
  infrastructure trouble, or a need for human diagnosis. Preserve existing
  deterministic classifications and retry bounds.
- **Review prioritization:** rank completed work for operator attention if
  review volume establishes a payer.
- **Mid-run intervention:** investigate stuck or off-target behavior only
  after measuring false alarms and the cost of repeated evidence windows.

These are independent candidates, not a general decision service backlog.
The first evaluation should stay limited to task assessment, model-tier
recommendations, and the judge backend described above.
