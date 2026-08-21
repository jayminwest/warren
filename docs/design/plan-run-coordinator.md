# PlanRun Coordinator + Ready-to-Dispatch Surface

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-01
**Shipped:** v0.3.17; ready-to-dispatch followed in v0.9.4
**Current truth:** `src/plan-runs/`

> **Salvage provenance:** lifted from the retired top-level spec §11.P (PlanRun: serial
> plan execution, pl-a258) and §11.R (ready-to-dispatch surface,
> pl-3fc4) as part of the SPEC retirement plan `pl-1717` (step
> `warren-dc11`). The wording below is the live contract — the
> coordinator's unit tests narrow against the `AdvanceResult`
> discriminated union, and acceptance scenario 26 asserts the
> round-trip — so edit it only in lockstep with the code it describes.
> References to retired sections (the Plot composition §11.P.Plot /
> §11.O, the org-readiness §11.J) were dropped during the lift;
> cross-references to surviving SPEC sections are repointed by the
> later sweep steps of `pl-1717`.

## PlanRun: serial plan execution (pl-a258, 2026-05-18)

PlanRun is a dispatch mode, not a fifth bundled feature. The substrate
is the existing single-run primitive — `spawnRun`, the events bus, the
runs/projects/agents repos — composed by a second tick loop that takes
a [seeds](https://github.com/jayminwest/seeds) plan and walks its
children sequentially, one warren run per child, gated on each child's
PR merging before the next dispatches. No new sandbox shape, no new
agent contract, no new burrow surface: PlanRun is warren orchestrating
itself.

A project lights it up by shipping a `.seeds/` directory. Projects
without one return a typed 400 from `POST /plan-runs` and never see
the dispatch path.

**Data model.** Two tables, both dialect-polymorphic across SQLite and
Postgres (`src/db/schema/sqlite.ts`, `src/db/schema/postgres.ts`):

- `plan_runs` — one row per dispatch. Columns: `id` (PK), `plan_id`,
  `project_id` (FK), `agent_name`, `prompt_template` (defaults to
  `'work on sd {seed_id}'`), `ref`, `provider_override`,
  `model_override`, `dispatcher_handle`, `trigger`, `state`
  (`queued`|`running`|`succeeded`|`failed`|`cancelled`),
  `failure_reason`, `created_at`, `started_at`, `ended_at`. Indexes on
  `(project_id, state)` and `state` cover the coordinator's
  `listActive()` and the UI's per-project list.
- `plan_run_children` — one row per child step. Composite PK
  `(plan_run_id, seq)`; `seed_id`, `run_id` (FK SET NULL to `runs`),
  `state` (`pending`|`dispatched`|`running`|`pr_open`|`merged`|`failed`|`skipped`),
  timestamps, `pr_merged_at`, `failure_reason`. The parent row + N
  child rows land in a single transaction via the adapter's `tx`
  helper, so a constraint violation mid-tx leaves no orphan children.

The **sequencing contract** is strict: `seq` is monotonically increasing
from `1`; the coordinator advances by selecting the lowest-seq child
whose state ∈ {`dispatched`,`running`,`pr_open`} as the in-flight slot,
and only spawns the next child when that slot transitions to `merged`
or `skipped`. There is never more than one in-flight child per
PlanRun.

**Coordinator state machine.** `advancePlanRun` in
`src/plan-runs/coordinator.ts` is a pure function over a stub-injected
deps bag (repos, `showPlan`, `showSeed`, `checkPrMerged`, `spawn`,
`now`, `emit`). It returns a discriminated union of 7 shapes — the
load-bearing contract the tick wrapper, the unit tests, and the
event-emit seam all narrow against:

```ts
type AdvanceResult =
  | { kind: 'dispatched'; childRunId: string }
  | { kind: 'waiting_for_run' }
  | { kind: 'waiting_for_merge' }
  | { kind: 'advanced'; mergedChildSeq: number; dispatchedChildSeq?: number }
  | { kind: 'plan_failed'; failedSeq: number; reason: string }
  | { kind: 'plan_succeeded' }
  | { kind: 'noop'; reason: string }
```

Transitions, per advance call:

1. If `planRun.state === 'queued'` → transition to `running`, stamp
   `startedAt`, fall through.
2. If there is an in-flight child:
   - linked run non-terminal → `waiting_for_run`;
   - linked run terminal-succeeded and child.state ≠ `pr_open` →
     decide pr_open vs trivial-merge (see below);
   - child.state === `pr_open` → call `checkPrMerged(run.prUrl)`:
     `merged` flips child to `merged` and falls through to dispatch
     the next; `open` → `waiting_for_merge`; `closed_unmerged` or
     `http_error` 4xx → `plan_failed` with reason
     `pr_closed_without_merge`;
   - linked run terminal-failed/cancelled → `plan_failed` with
     reason `` `child_${reason ?? 'failed'}` `` — UNLESS the failure
     cause is retryable and the child still has its one automatic
     retry left (see the child-retry rule below).
3. If no in-flight child, call `pickNextPending`:
   - null → `plan_succeeded` (transition the parent row, stamp
     `endedAt`);
   - non-null → call `showSeed(child.seedId)`; `status === 'closed'`
     → flip child to `skipped` (resume semantics, below) and loop;
     `status === 'open'` → spawn via `dispatch.ts`, persist
     `child.runId` + `child.state='dispatched'` + `child.startedAt`,
     return `dispatched`. A `RunSpawnError` becomes `plan_failed`
     with reason `` `dispatch_failed:${err.message}` ``.

Every transition is mirrored as a system event on the most-recently-
dispatched child run via the existing emit seam — kinds: `plan_run.advanced`,
`plan_run.dispatched`, `plan_run.waiting_for_merge`, `plan_run.merged`,
`plan_run.failed`, `plan_run.succeeded`, `plan_run.child_retried`.

**Automatic child retry (warren-6de9).** A child run that terminalizes
`failed` with a retryable failure cause gets ONE automatic re-dispatch —
a fresh run, same seed, same rendered prompt — before the coordinator
declares the plan-run failed. The retryable-cause list lives in
`src/plan-runs/retry.ts` (`RETRYABLE_CHILD_FAILURE_REASONS`, today just
`provider_error`: a transient upstream 5xx says nothing about the
workspace, prompt, or seed, so a fresh run has a real chance). The
decision is two pure predicates — `isRetryableChildFailure(reason)` and
`hasChildRetryBudget(child)` — so a second cause (warren-4af7,
infra-lost runs) joins by appending to the list. The budget is
per-child (`MAX_CHILD_RETRIES = 1`), persisted on
`plan_run_children.retry_count`, so a coordinator restart or re-driven
tick never grants a fresh retry; a second consecutive provider error on
the same child fails the plan-run with `child_provider_error` as before.
The re-dispatch re-points the child's `run_id` at the new run and emits
`plan_run.child_retried` on the NEW run id (payload: `previousRunId`,
`failureReason`, `retryCount`) so the plan-run event tail — which fans
out over current child run ids — keeps the retry visible on the UI
timeline. A spawn failure during retry falls back to the ordinary
`dispatch_failed:` terminal path.

**Trivial-merge advance rule.** A child run that succeeded but produced
no commits is treated as merged without ever opening a PR. The signal
is the `reap.empty_push` system event (`commitsAhead === 0`) that
reap emits when the workspace branch is identical to its base. When
the coordinator sees `run.prUrl === null` AND the
`reap.empty_push` event is present on the child run, it advances the
child straight to `merged` (no GitHub poll, no `pr_open` intermediate
state). This is the docs-only / no-op-step case — without this rule a
plan whose middle step had nothing to push would deadlock waiting for
a PR that never opens.

**PR-merge polling contract.** `src/runs/pr.ts` `checkPullRequestMerged`
hits the GitHub REST API directly (`GET /repos/:owner/:repo/pulls/:number`,
`Accept: application/vnd.github+json`, `Authorization: Bearer
<GITHUB_TOKEN>`) and returns a discriminated union: `{kind:'merged',
mergedAt}` | `{kind:'open'}` | `{kind:'closed_unmerged'}` |
`{kind:'missing_token'}` | `{kind:'http_error', status, message}`.
`mergedAt` is GitHub's `merged_at` field — non-null `merged_at` is the
truth source; `state:'closed'` with `merged_at:null` is
`closed_unmerged`. The coordinator (via the `pr-merge.ts` retry
wrapper) treats `missing_token` as a no-op (logged, plan stalls until
the operator sets `GITHUB_TOKEN`) rather than failing the plan, since
the operator can recover by adding the token without losing progress.
GHE-hosted PRs whose URL does not match the regex in
`parsePullRequestUrl` return null — the coordinator treats them as
"cannot verify merge" and waits indefinitely on the operator to merge
manually rather than auto-failing.

**Resume semantics on re-dispatch.** A second `POST /plan-runs`
against the same `planId` after some children have been closed
out-of-band (`sd close` from a human, from another agent, from a
parallel plan-run) is a first-class flow. The new PlanRun row is
independent — it has its own `id`, its own children enumerated fresh
from `plan.children`. As the coordinator walks the new children, any
child whose `showSeed` returns `status:'closed'` flips to `skipped`
without dispatching a run; the coordinator loops to the next pending
child. This makes PlanRun safe to re-invoke as a "resume from the
next open child" operation without bookkeeping about which previous
plan-run owned which child.

**Resume semantics on the same row (warren-1eff).** Re-dispatch does
not fit the merge-timeout failure shapes: when a child's PR waits on a
human merge past the merge-wait budget (`child_pr_merge_timeout`), the
child's seed is already CLOSED while its PR is still unmerged, so a
fresh `POST /plan-runs` would skip it and bypass the merge gate.
`POST /plan-runs/:id/resume` re-drives the SAME plan-run row instead.
It accepts only the two human-merge-stall failure reasons —
`child_pr_merge_timeout` and `parent_pr_merge_timeout`; any other state
or failure reason gets a typed 409 with no state change. For the child
shape the timed-out child flips `failed → pr_open` preserving its
`runId` (and thereby its `prUrl`); for the parent shape no child exists
yet, so only the plan-run row resets. Either way the plan-run goes
`failed → running` with its `resumed_at` column stamped to the resume
moment — the merge clock derives from the later of `run.endedAt` and
`planRun.resumedAt` (`mergeWaitBaseline`), so the wait budget re-arms
instead of instantly re-timing out on the stale `run.endedAt`. The
coordinator's next tick then re-polls the EXISTING PR: merged → advance
to the next child (no new run for the completed one); still open → wait
within the fresh budget. `pr_closed_without_merge`, `dispatch_failed`,
and `child_seed_not_found` remain genuine failures and are not
resumable.

**Server API.**

```
POST   /plan-runs                 dispatch (rejects without project.hasSeeds)
GET    /plan-runs                 list (filter by project / state)
GET    /plan-runs/:id             detail + fanned-out child runs[]
POST   /plan-runs/:id/cancel      sets state='cancelled', cancels in-flight run
POST   /plan-runs/:id/resume      re-drives the same row after a merge timeout (warren-1eff)
GET    /plan-runs/:id/events      tails the union of every child run's events
```

The dispatch handler rejects in this order: (1) project not found →
404; (2) `!project.hasSeeds` → `ProjectLacksTrackerError` (typed 400, wire code `project_lacks_seeds` unchanged,
recoveryHint references adding `.seeds/`); (3) plan status ∉
{`approved`,`active`,`done`} or empty children → `ValidationError` /
`PlanHasNoOpenChildrenError`; (4) every child already closed → also
`PlanHasNoOpenChildrenError` (the resume case where there's nothing
left to do). Side-effect-free until all gates pass.

**Env vars.**

| Variable | Default | Effect |
|---|---|---|
| `WARREN_PLAN_RUN_TICK_MS` | `10000` (10s) | Coordinator tick interval. Faster than the scheduler's 60s because in-flight plans are typically short-lived dispatch chains. |
| `WARREN_PLAN_RUN_DISABLED` | unset | When set (`1`/`true`), `bootPlanRunCoordinator` skips boot — same shape as `WARREN_SCHEDULER_DISABLED`. Useful for diagnostic warren instances that should serve the API but not advance plans. |

The coordinator uses the same single-flight wrapper shape as
`bootScheduler` (`src/server/scheduler.ts`) — overlapping ticks are
dropped, not stacked, and a per-PlanRun catch ensures one bad row
cannot tear down the loop.

**Acceptance.** Scenario 26
(`scripts/acceptance/scenarios/26-plan-run-roundtrip.ts`) covers the
round-trip end-to-end against a live warren+burrow stack: three-child
plan including one docs-only child that exercises the trivial-merge
branch; assertions on terminal state (`succeeded`, all children
`merged`); a second dispatch against the same plan id after closing
one child out-of-band, asserting the close advances to `skipped`
without a new run; the PR-merge poll ran against FakeForge
(`WARREN_FORGE=fake`, warren-2600) so the harness stays deterministic.

## Ready-to-dispatch surface (pl-3fc4, 2026-06-20)

A read-only, operator-gated companion to the PlanRun dispatch
path above. It answers one question for the operator: *which approved
plans are actually ready to become a PlanRun right now?* — and
surfaces them as a one-click dispatch list. It mints nothing on its
own: there is no background loop, no auto-dispatch, no new sandbox or
burrow surface. The operator stays in the loop; the surface only
computes and displays.

**Read-on-demand, not a dispatcher (Approach A deferred).** Two shapes
were considered. *Approach A* — a background worker that polls plans
and auto-dispatches anything that becomes ready — is **explicitly
deferred**: it would dispatch real sandboxed runs (cost, side effects,
branch churn) with no human in the loop, contradicting warren's
operator-gated posture (the no-half-spawned-state policy embodied by
PlanRun's `.seeds/` gate). *Approach B* — the shipped design —
computes readiness only when the operator reads the endpoint, so the
same request that surfaces a ready plan is the one the operator chose
to make. Dispatch remains the unchanged, explicit `POST /plan-runs`
call, fired from the one-click button.

**Endpoint.** `GET /projects/:id/ready-plans` — per-project (readiness
is seeds-scoped, so the surface is too). Gated exactly like
`GET /projects/:id/seed-plans` (`listProjectSeedPlansHandler`): project
404 → 404; project lacking `.seeds/` → typed 400; no seeds-cli
configured → typed 400. No new auth or sandbox surface — it composes
existing host-side `sd` readers plus one dedup query. Response is
`{ plans: ReadyPlan[] }`, each entry `{ id, name?, status,
openChildCount }`.

**Readiness criteria.** A plan is *ready to dispatch* iff all three
hold (the pure `computeReadyPlans` filter, `src/plan-runs/ready-plans.ts`,
mx-3b5b7c):

1. **approved** — `status === 'approved'`. Draft / unapproved plans
   are never dispatch candidates.
2. **has at least one open child** — at least one child seed is
   non-closed (`openChildCount ≥ 1`). A plan whose children have all
   merged/closed has nothing left to dispatch and is excluded. The
   per-seed status map comes from `listSeedStatuses` (`sd list
   --format json`, warren-6807).
3. **not already dispatched** — the plan id is absent from
   `PlanRunsRepo.listDispatchedPlanIds(projectId)` (the
   `SELECT DISTINCT plan_id` dedup primitive, warren-34df). Once any
   `plan_run` row exists for the plan it drops off the surface, so the
   operator never double-dispatches the same plan from this list.

**Composition.** The handler (`listReadyPlansHandler`,
`src/server/handlers/projects.ts`) orchestrates only existing readers:
`listPlans` → filter to `approved` → resolve each approved plan's
children via `showPlan` → build the status map via `listSeedStatuses`
→ fetch dispatched ids via `repos.planRuns.listDispatchedPlanIds` →
return `computeReadyPlans(...)`. Typed client facades:
`client.listReadyPlans` (`src/client/`) and `projectsApi.readyPlans`
(`src/ui/src/api/`), mirroring the `seedPlans` facade shape.

**UI surface.** `PlanRuns.tsx` gains a *Ready to dispatch* tab beside
the existing plan-runs table. For the selected project it polls
`projectsApi.readyPlans` (5s refetch) and renders the ready plans;
each row's one-click Dispatch button opens the generalized
`DispatchPlanDialog` (warren-585d) pre-filled with that plan id +
project. Dispatch still goes over `POST /plan-runs` unchanged.
Because readiness is per-project, the tab prompts the operator to pick
a project when none is selected. An acceptance scenario proves the
round-trip: an approved plan with one open child surfaces with
`openChildCount` 1, then disappears once a `plan_run` is dispatched
(dedup confirmed).

**Deferred.**

- Approach A background auto-dispatch (above) — the operator-gated
  read-on-demand model is the V1 contract; auto-dispatch is out of
  scope until there is a human-in-the-loop policy for unattended
  cost/side-effects.
- Cross-project / global ready-plans aggregation — the surface is
  per-project by construction; a fan-out view stays deferred until
  multi-project operation is in scope.
