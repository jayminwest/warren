# Campaign controller

**Kind:** direction
**Design state:** approved
**Delivery:** next
**Roadmap order:** 1
**Arrived:** 2026-08-20

This direction record defines the durable controller extension that moves
long-running Warren campaigns off an operator's laptop and into the deployment.
It fixes the extension kind, responsibility boundary, safety posture, and
implementation sequence. Roadmap promotion on 2026-08-20 commits Phase 1 only;
later phases remain evidence-gated. It does not approve a database schema, a
public manifest format, autonomous upstream contributions, or a learned router.

**Grounds:** [`PHILOSOPHY.md`](../PHILOSOPHY.md),
[`extensions.md`](./extensions.md),
[`plan-run-coordinator.md`](./plan-run-coordinator.md),
[`external-repository-mirror-pilot.md`](./external-repository-mirror-pilot.md),
[`corpus-flywheel.md`](./corpus-flywheel.md), and the current
`warren-dogfood-pipeline` skill.

---

## 0. The decision

Warren will support a third extension kind: a **controller**.

A controller is a long-running Tier-1 service that owns durable workflow state,
observes Warren through published read surfaces, and invokes Warren's existing
public command APIs under an explicit operator-approved policy. Warren never
imports the controller, calls it, waits on it, or reads its endpoint.

The division of responsibility is:

> **Warren executes agents. A campaign controller executes policy.**

The first controller is a narrow generic controller with a dogfood adapter. An
operator approves a bounded issue campaign, may close the laptop, and the
controller uses Warren's run and plan-run primitives to carry it forward. It
survives its own restart, enforces campaign budgets, stops at unsafe states,
and produces a final report.

Historical replay is the second intended controller workload. It has a
separate trust boundary because it handles detached mirrors, sanitized case
origins, hidden graders, and a strict no-upstream-contact policy.

A controller is not a persistent LLM supervisor. Its reconciliation and policy
decisions are deterministic code. An LLM may propose a campaign or perform a
bounded repair inside an ordinary Warren run. It does not receive an unbounded
mutation tool loop over the control plane.

## 1. Why this exists

Today the complete dogfood workflow is driven by a skill running inside a Pi
or Claude Code session on the operator's laptop. The session:

- audits and orders issues;
- dispatches runs;
- waits for terminal state;
- checks merge gates;
- inspects pull-request checks and mergeability;
- requests branch updates;
- dispatches conflict and CI repair runs;
- watches auto-merge;
- reconciles tracker state; and
- reports cost and outcomes.

That workflow has run for more than 15 hours. Agent execution already happens
inside Warren's deployment, but orchestration liveness still depends on a
laptop process, a terminal session, and ambient operator credentials. This is
the wrong durability boundary for campaigns that may last hours or days.

Plan-runs solve an important inner loop: serial issue execution, child retry,
merge gating, and restart recovery. They do not own campaign admission,
operator approval, campaign-wide budgets, PR shepherd policy, historical case
provisioning, or a cross-run human-attention queue. The controller composes
plan-runs rather than replacing their coordinator.

The desired operator experience is:

```text
operator drafts and approves campaign
                  │
                  ▼
       durable campaign controller
        ├── dispatches Warren work
        ├── reconciles durable state
        ├── reserves and accounts budget
        ├── performs only approved actions
        ├── launches bounded repair runs
        └── pauses on ambiguity
                  │
                  ▼
             Warren runs
```

The laptop becomes an approval and status client. It is no longer the process
keeping the campaign alive.

## 2. Extension taxonomy

Extension **tiers** answer where code runs and who trusts it. Extension
**kinds** answer which way calls flow.

### Observer

An observer consumes facts and never participates in the run. Audit log,
judge, metrics, notifications, and dashboards are observers. Failure or
absence cannot alter run progression.

### Provider

A provider implements a contract that Warren calls and waits on. External
trackers behind `RemoteTracker` are the first out-of-process provider shape.

### Controller

A controller is an external operator:

- it reads Warren's published state;
- it invokes published mutations;
- it owns its own workflow state and policy;
- it can be absent without preventing ordinary Warren operation; and
- Warren core has no dependency on it.

A controller is not an observer because it dispatches and cancels work. It is
not a provider because Warren never calls it. It does not require Tier-2
in-process mutating hooks: it uses the same HTTP commands an operator uses.

Calling a controller an observer would quietly weaken the observe-only
contract. Moving it into Warren core would violate the minimal-kernel and
feature-as-extension decisions.

## 3. Core boundary

The controller may use only published Warren surfaces. It owns:

- campaign manifests and approval records;
- campaign and work-item state;
- action intent and outcome journals;
- leases and restart reconciliation;
- budget reservations and campaign spend;
- attention items and notifications;
- controller-specific forge credentials, when approved; and
- campaign reports.

Warren continues to own:

- project and agent registries;
- run and plan-run rows;
- sandbox/runtime provisioning;
- event normalization and storage;
- run-level cost caps;
- steering and cancellation;
- reap and branch push;
- the Forge and IssueTracker contracts; and
- plan-run child sequencing and merge gates.

The controller never imports `src/**` or `scripts/**`. It ships as a standalone
container with its own package, lockfile, tests, image, configuration, and
storage. It may use a published Warren client package; gaps may temporarily use
raw HTTP against the documented API.

Warren core must never call the controller or read its API, including from the
core UI. A separate controller UI, CLI, or operator proxy may call both
systems. This preserves the extension-endpoint tripwire recorded in
[`corpus-flywheel.md`](./corpus-flywheel.md) §9.

## 4. Logical components

Two controllers may share a small client and reconciliation library, but their
credentials, databases, deployment identities, and mutation policies remain
separate.

### 4.1 Dogfood controller

The first component executes tracker-linked Warren work:

- accepts an explicit ordered issue list or approved plan;
- dispatches a plan-run where possible;
- monitors plan and run state;
- enforces campaign budgets;
- pauses at merge or policy ambiguity;
- later performs bounded GitHub shepherd actions; and
- produces issue → run → PR → merge → cost reporting.

The first version does not perform thematic backlog audit. A human or
short-lived audit agent produces the candidate manifest. The long-running
controller executes only the approved result.

### 4.2 Replay controller

The replay controller executes immutable historical cases:

- verifies project, detached namespace, historical ref, parent SHA, model,
  agent, and cap against the approved manifest;
- dispatches one case at a time;
- records experiment-arm provenance;
- monitors result branches;
- hands terminal results to isolated graders; and
- produces scorecards and friction reports.

It holds no upstream-write credential and no hidden reference patch. Mirror
creation, license review, case mining, and sanitized-origin validation remain
outside its first version.

### 4.3 Isolated grader

A replay grader runs as a separate short-lived sandbox or Kubernetes Job. It:

- receives one result branch and one hidden-test bundle;
- executes untrusted repository tests under explicit resource and time limits;
- records factual grading results with a stable grader version; and
- cannot dispatch, steer, merge, or access Warren's operator credential.

Hidden tests and reference patches never mount into the controller or agent
workspace. Grading writes are idempotent on a key such as
`(case_id, run_id, grader_version)`.

### 4.4 Campaign proposal

A later audit or planning agent may propose an ordered campaign manifest. Its
output always lands in `awaiting_approval`. The model cannot approve its own
proposal or directly invoke controller mutations.

## 5. What existing Warren surfaces support

A controller can already perform the narrow execution loop through HTTP:

- list projects and agents;
- dispatch runs;
- supply `ref`, `baseCommit`, `targetBranch`, provider/model overrides, and
  per-run cost caps;
- inspect, steer, and cancel runs;
- tail per-run events;
- create ordered issue-list or tracker-plan plan-runs;
- inspect and cancel plan-runs;
- resume merge-timeout plan-runs;
- read analytics and terminal cost; and
- use `GET /events/stream` for low-latency wake-ups.

The plan-run coordinator already owns serial child dispatch, merge gating,
restart recovery, one bounded retry for named transient failures, and
merge-timeout resume semantics. The dogfood controller treats a plan-run as
one work item and does not recreate the child state machine.

A bounded repair can use an ordinary run pinned to the pull-request branch:

```json
{
  "ref": "warren/run_xxx",
  "targetBranch": "warren/run_xxx",
  "prompt": "Repair the approved pull request failure and run the gate.",
  "maxCostUsd": 5
}
```

The current global lifecycle stream is an optimization only. It is in-memory,
non-replayable, and may drop buffered notifications. Every wake-up is followed
by authoritative `GET /runs/:id`, `GET /plan-runs/:id`, and forge
reconciliation.

## 6. Campaign state model

The following states fix behavior, not database schema.

### 6.1 Campaign

```text
draft
  → validating
  → awaiting_approval
  → approved
  → running
      ↔ paused_operator
      ↔ paused_budget
      → needs_attention
  → completed | failed | cancelled
```

Rules:

- only an approved immutable manifest enters `running`;
- changing any approved field invalidates approval;
- restart never invents or widens approval;
- budget exhaustion pauses future dispatches;
- ambiguous side effects enter `needs_attention`; and
- cancellation prevents new work and best-effort cancels active work according
  to the approved policy.

### 6.2 Work item

```text
candidate
  → admitted
  → ready
  → dispatch_intent
  → dispatched
  → running
  → terminal
  → pr_open
  → checks_pending
  → merge_ready
  → merged
  → verifying
  → completed
```

Failure and repair paths include:

```text
dispatch_intent → dispatch_uncertain → needs_attention
running → retry_pending → dispatched
terminal → repair_pending → repairing → running
checks_pending → repair_pending
any active state → paused | failed | cancelled
```

A plan-run hides its child detail behind Warren's plan-run state. A replay case
usually uses one run because a detached historical origin may have no tracker.

### 6.3 Action journal

Every external side effect has a persisted action before the request is sent:

```text
planned → executing → succeeded
                   ↘ uncertain
                   ↘ retryable_failure
                   ↘ permanent_failure
```

An action records at least:

- deterministic action key;
- campaign and work-item ids;
- exact request body or digest;
- approved-policy digest;
- reserved budget;
- attempt number;
- start and settlement times;
- resulting run, plan-run, branch, or PR id; and
- structured error classification.

This journal is the restart boundary. Logs are not workflow state.

## 7. Approval envelope

A campaign approval binds an immutable manifest containing:

- project and repository allowlist;
- issue or replay-case set and order;
- allowed agent, provider, and model;
- prompt template or prompt digest;
- per-run cap;
- campaign and daily cap;
- maximum concurrent runs;
- maximum attempts and repair runs;
- allowed refs and target branches;
- allowed pull-request actions;
- protected paths;
- upstream-contact policy;
- grading policy, where relevant; and
- approval expiration.

The controller stores the manifest digest with every action. Editing a bound
field returns the campaign to `awaiting_approval`.

### 7.1 Pull-request permission ladder

Controller policy uses explicit levels:

1. `observe_only`
2. `update_branch`
3. `dispatch_repairs`
4. `enable_auto_merge_if_eligible`
5. `merge_mirror_only`

The first release supports `observe_only`. Detached mirror campaigns may later
reach `merge_mirror_only`. Upstream repositories remain `observe_only` during
the mirror pilot.

Protected paths, including Warren's Article IX paths, always force
`needs_attention` unless the approval explicitly includes them. A controller
never infers standing merge authority from possession of a credential.

### 7.2 Human judgment boundary

Through the pilot, humans approve:

- theme, priority band, and candidate work;
- issue dependency order;
- agent, provider, model, prompts, and budgets;
- project registration and configuration changes;
- mirror selection, licensing, and attribution;
- historical case admission and exclusion;
- sanitized-origin and leakage validation;
- network policy;
- hidden-test handling;
- unexpected branch, conflict, or CI repair;
- issue re-scoping after agent refusal;
- protected-path changes;
- final scientific or API correctness review;
- benchmark publication; and
- every upstream communication or contribution.

Unknown agent questions and design conflicts become durable attention items.
The controller does not fabricate steering responses.

## 8. Budget and concurrency

Warren's `maxCostUsd` remains the hard per-run cap. The controller adds a
campaign ledger and reserves the full cap before dispatch:

```text
available = campaign_cap - terminal_spend - active_reservations
```

A run starts only if its reservation fits. On termination, actual recorded
cost replaces the reservation. If cost is unknown, the conservative
reservation remains until an operator resolves it.

The controller also enforces:

- daily campaign budget;
- total campaign budget;
- maximum non-terminal runs;
- maximum attempts per work item;
- maximum repair runs per work item and PR; and
- maximum consecutive infrastructure failures.

A controller-local ledger follows the judge extension's durable-spend pattern.
It does not pretend to be a deployment-wide quota: multiple controller
instances or unrelated manual dispatches remain outside that ledger until
Warren exposes server-enforced campaign identity and budget.

### Circuit breakers

The controller pauses automatically on:

- dispatch ambiguity;
- repeated infrastructure failure;
- unexpected provider or model;
- missing cost after a declared grace period;
- exhausted repair count;
- unexpected repository, ref, or branch;
- protected-path changes;
- an upstream URL or remote where policy forbids it;
- controller/Warren protocol incompatibility;
- grader or case-provenance failure; or
- any action outside the approval envelope.

## 9. Crash recovery and idempotency

The initial deployment is one controller replica with extension-owned SQLite
on a persistent volume. It uses WAL mode, transactional state changes, leased
work claims, and an append-only campaign event log.

On boot, the reconciler:

1. expires abandoned leases;
2. loads non-terminal campaigns;
3. inspects unfinished action rows;
4. reconciles known run ids through Warren;
5. reconciles known plan-run ids;
6. re-reads PR and check state when applicable;
7. reconstructs budget reservations;
8. retries only effects proven safe; and
9. moves ambiguous effects to `needs_attention`.

Safe replay rules:

- reads retry freely;
- cancel is treated as idempotent and re-read afterward;
- known run or plan-run ids reconcile rather than redispatch;
- forge mutations re-read state before retry;
- grading is idempotent by case/run/grader version; and
- notifications deliver at least once with dedupe ids.

### Dispatch ambiguity

`POST /runs` supports `Idempotency-Key`, but Warren's store is in-memory,
expires after ten minutes, and is cleared by restart. `POST /plan-runs` has no
equivalent durable key.

If Warren accepts a dispatch but the response is lost, the controller cannot
always prove whether retrying will duplicate paid work. The first controller
therefore writes `dispatch_intent` before the request, uses a stable
idempotency key where supported, and enters `dispatch_uncertain` rather than
blindly retrying after an ambiguous response.

Durable server-side correlation is a high-priority surface the controller may
pay for after the first implementation proves the requirement.

## 10. Pull-request shepherding

The first version observes PR state and stops when intervention is required.
It does not update branches, enable auto-merge, resolve conflicts, or merge.

A later GitHub-specific shepherd may hold a repository-scoped GitHub App
credential and, under explicit campaign permission:

- inspect mergeability and check runs;
- list changed files;
- enforce protected-path rules;
- request an update branch;
- enable auto-merge;
- dispatch bounded repair runs; and
- re-read every mutation after completion or restart.

This initially lives behind an extension-local forge interface. Warren's
current `Forge` contract deliberately has no merge, update-branch, auto-merge,
or mergeability operation. The controller must not expand that core contract
speculatively. Real shepherding friction determines whether any operation is
provider-neutral enough to promote.

The controller reuses Warren's existing healer and CI-fixer behavior wherever
it already applies. It does not build a parallel repair engine merely because
it can call GitHub.

## 11. Historical replay boundary

The replay controller consumes only approved, reproducible cases from
[`external-repository-mirror-pilot.md`](./external-repository-mirror-pilot.md).
Each case identifies:

- detached project and allowed origin;
- local case id;
- historical ref and exact parent SHA;
- fixed agent/provider/model/cap;
- immutable prompt digest;
- grader version and artifact reference; and
- declared network and data policy.

The controller does not hold an upstream-write token. The grader does not hold
Warren credentials. The agent cannot access hidden tests or future Git
history.

Replay-grade network isolation is not yet guaranteed by Warren's Kubernetes
`restricted` mode, which permits external `0.0.0.0/0` egress. Sanitized Git
history alone cannot stop an agent from searching upstream for the accepted
solution. Trustworthy replay therefore requires an audited egress boundary,
such as an allowlisting proxy, an internal detached forge/domain, or an
FQDN-aware CNI policy. Prompt instructions are not a leakage control.

## 12. Controller API and operator surface

A controller needs its own authenticated operator API. The eventual resource
names may differ, but the capabilities are:

```text
create campaign draft
list and inspect campaigns
stream campaign events
approve a manifest digest
pause, resume, or cancel a campaign
list attention items
inspect budget and action history
probe health and readiness
```

A standalone CLI or UI may consume that API. Warren's core UI must not fetch
it. A future operator console may compose Warren and controller APIs from
outside both processes.

Extension API authentication remains an ecosystem gap. Until Warren can mint
or validate scoped extension-surface credentials, each controller must use a
separate strong operator credential and remain inaccessible by default.

## 13. Kubernetes deployment

The first controller follows the successful judge deployment shape:

- one `Deployment` replica;
- `Recreate` strategy;
- one RWO PVC;
- non-root user;
- dropped Linux capabilities;
- `RuntimeDefault` seccomp;
- no service-account token unless a replay worker requires narrowly scoped
  Kubernetes Job access;
- explicit CPU and memory limits;
- `/healthz` and `/readyz`;
- graceful SIGTERM; and
- a ClusterIP service for the operator API.

Controller secrets are created imperatively or through an external secret
operator. Placeholder secret manifests do not belong in a Kustomize resource
list; the open judge issue `warren-0812` is the pattern to avoid.

Replay graders run in a separate namespace with:

- one Job per grade;
- default-deny ingress and egress;
- strict time and resource limits;
- no Warren or forge mutation token;
- one-time hidden-artifact access;
- TTL cleanup; and
- a ServiceAccount limited to the exact Job operations the controller needs.

Arbitrary project tests never execute inside the controller pod.

## 14. Missing Warren surfaces

The first controller can ship with documented restrictions. The following
surfaces are likely paid by real operation.

### 14.1 Scoped service credentials

Extensions currently use the full operator token. A mutating controller needs
a project-limited service actor with only the reads and commands its policy
requires. It must not inherit project deletion, agent administration, GitHub
App registration, finalize callbacks, or unrelated project access.

This is the largest security gap for unattended use.

### 14.2 Durable dispatch correlation

Runs and plan-runs need durable external action ids or idempotency keys that
survive Warren restart, plus a query that resolves a controller action to the
existing resource. Until then ambiguous dispatch fails closed.

### 14.3 Remote project configuration

Warren exposes project config reads but no sanctioned remote overlay write.
A separate controller cannot set `agentImage`, `repoContext`, `qualityGate`,
or resources in Warren's host clone without shared filesystem access.
Detached mirrors may commit a declared readiness patch; otherwise setup stays
manual until repeated friction pays for a config-overlay design.

### 14.4 Durable lifecycle delivery

The global stream is useful for wake-up but not truth. A durable, replayable,
globally sequenced cursor would reduce reconciliation cost. Correctness does
not wait on it.

### 14.5 Provider-neutral shepherd actions

Only actions proven by the GitHub shepherd should be considered for the Forge
contract or a public admin API. The extension-local implementation comes
first.

### 14.6 SDK completeness

The published client needs convenient methods for lifecycle streaming,
plan-run resume, filtered discovery, dispatch metadata, and idempotency
headers. Raw HTTP is an acceptable first-party extension workaround, not a
pleasant third-party contract.

### 14.7 Replay-grade egress control

Historical replay needs policy that distinguishes allowed package/model/mirror
hosts from upstream solution sources. Coarse open egress is insufficient.

## 15. Delivery sequence

Approval of this record does not place these phases on the roadmap.

### Phase 1 — durable dogfood coordinator

Build only:

- explicit campaign manifest;
- approval digest;
- budget and reservations;
- plan-run dispatch, monitoring, cancel, and resume;
- persistent action journal and restart reconciliation;
- attention queue;
- health/status API and notifications; and
- final issue → run → PR → cost report.

PR mutations remain manual.

Acceptance milestone:

> Approve one campaign, close the laptop, let the controller drive its
> plan-run, restart the controller during execution, enforce the campaign
> budget, stop at every unsafe PR state, and produce the same final report as
> the current dogfood skill.

### Phase 2 — bounded GitHub shepherd

Add repository-scoped GitHub credentials, mergeability and check inspection,
protected-path enforcement, update-branch, bounded repairs, and auto-merge
only under standing campaign approval.

### Phase 3 — audit-to-campaign proposal

A short-lived audit/planner run produces a candidate manifest. The controller
validates it and stops at `awaiting_approval`. Execution starts only after the
operator approves the immutable digest.

### Phase 4 — replay controller

Add immutable historical case execution, Snakemake campaign configuration,
isolated grader Jobs, scorecards, and structured friction reporting. Case
mining and sanitized-origin creation remain pre-provisioned.

### Phase 5 — replay-lab automation

After manual replay proves the method, add case mining, issue metadata
archival, sanitized-origin provisioning, baseline reproducibility validation,
and hidden-artifact management.

### Phase 6 — broader autonomy

Only after enough clean campaign data exists:

- descriptive dispatch recommendations;
- shadow routing;
- dispatch/defer policy;
- cost-tier selection;
- cross-project scheduling; and
- replica experiments.

A general autonomous LLM supervisor is not a phase.

## 16. Relationship to adjacent records

### Extensions

[`extensions.md`](./extensions.md) owns the ecosystem taxonomy and packaging
direction. This record defines the controller kind and its first payer.

### Plan-runs

[`plan-run-coordinator.md`](./plan-run-coordinator.md) owns serial child
execution and merge gating. The controller composes it and handles the wider
campaign lifecycle.

### External-repository mirror pilot

[`external-repository-mirror-pilot.md`](./external-repository-mirror-pilot.md)
is the replay controller's first research workload. The pilot's no-upstream,
hidden-grader, fixed-arm, and human-review rules all remain in force.

### Resumable agent environments

[`resumable-agent-environments.md`](./resumable-agent-environments.md) solves
workspace, service, and compute continuity. Campaign durability does not
require resumable agent compute. A controller can dispatch multiple immutable
runs across days while every individual run retains today's lifecycle.

### Corpus flywheel

[`corpus-flywheel.md`](./corpus-flywheel.md) describes review throughput and a
future router. The controller provides durable campaign execution and clean
action records. It does not implement learned routing in its first phases.

### Scheduler

[`scheduler.md`](./scheduler.md) fires project cron and scheduled issues. A
campaign has approvals, budgets, work-item state, and reconciliation semantics
that do not belong in the scheduler. The controller owns its own loop.

## 17. Non-goals

This direction does not approve:

- moving campaign orchestration into Warren core;
- converting audit-log or judge into mutating extensions;
- an always-running LLM with unrestricted Warren or forge tools;
- automatic upstream issues, PRs, comments, reviews, or merges;
- automatic merge or repair without campaign permission;
- project deletion or arbitrary administration;
- controller-driven hidden-test exposure;
- treating the lifecycle notification stream as durable truth;
- blind retry after ambiguous dispatch;
- high availability before one-replica correctness;
- a general controller plugin protocol;
- cross-project scheduling, replica waves, or learned routing; or
- using Environment state to keep the controller's orchestration alive.

## 18. Risks and tripwires

- **Credential blast radius.** Until service actors exist, a controller token
  is over-privileged. Isolation reduces but does not remove the risk.
- **Duplicate spend.** Lost dispatch responses can create an uncertain state
  that current idempotency cannot resolve across restart.
- **Controller split-brain.** Two replicas or two databases may run the same
  campaign. V1 is one replica with one persistent store.
- **Unbounded repair.** Every repair and retry consumes a declared finite
  budget and count.
- **Tracker drift.** Terminal success does not by itself prove tracker truth.
  Merge and post-campaign reconciliation remain explicit.
- **Governance bypass.** Protected paths and merge permissions are policy
  inputs, never inferred from token authority.
- **Prompt injection.** Repository and issue text are untrusted. They cannot
  mutate controller state except through an approved ordinary Warren run
  whose output is treated as a proposal.
- **Replay leakage.** Hidden artifacts and upstream access require technical
  isolation, not instructions.
- **Core dependency.** No Warren route, UI component, or boot path may require
  the controller to exist.

## 19. Promoted v1 boundary

Roadmap promotion on 2026-08-20 commits the smallest coherent v1: approved
plan-run campaigns, durable reconciliation, budget control, fail-closed
attention, and reporting, with all PR mutations manual. The mirror pilot begins
manually, so controller delivery does not block the first Snakemake cohort.

The owner recorded these implementation choices:

1. the initial package is a narrow generic controller with a dogfood adapter;
2. operators authenticate to the controller API with a separate strong
   controller credential;
3. v1 may use Warren's current operator token only against a dedicated Warren
   deployment, rather than waiting for scoped service actors; and
4. durable Warren dispatch correlation is not a prerequisite. An ambiguous
   response enters `dispatch_uncertain` and fails closed instead of retrying.

Repeated operation may pay for scoped service actors and durable server-side
correlation. Neither is speculative Phase 1 work.
