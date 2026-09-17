# Warren-armed auto-merge

**Kind:** contract
**Design state:** approved
**Delivery:** now
**Arrived:** 2026-09-17
**Companion:** [`forge-contract.md`](./forge-contract.md), the seam this record extends.
**Plan:** seeds plan `pl-92a3`, eight children under seed `warren-081c`, implements it.

Warren arms GitHub auto-merge itself, through the Forge seam, right after
reap opens a pull request. GitHub still merges it once the required
checks pass. A project opts in with one `pr.autoMerge` block in
`.warren/config.yaml`. After that, a project needs no per-repo workflow,
repository variable, or secret.

**Grounds:** the trellis outage observed 2026-09-15 to 2026-09-17
(warren-081c), the warren-2565 precedent on warren's own repo, and the
warren-4681 lesson about asynchronous mergeability.

---

## 0. Problem

Plan-runs gate each child on the previous child's pull request merging,
but warren does not control the thing that makes a pull request merge.
Arming lives in a per-repo GitHub Actions workflow
(`.github/workflows/auto-merge.yml`) that holds its own credential:
`AUTO_MERGE_PAT`, or `AUTO_MERGE_APP_ID` plus a `.pem`-backed
`AUTO_MERGE_APP_PRIVATE_KEY`.

That is a second credential per repository, outside warren and invisible
to it. The observed cost on the trellis deployment, 2026-09-15 to
2026-09-17:

- The PAT expired around 2026-09-05. The arm step then failed 21 of 21
  times with HTTP 401.
- Two plan-runs died with `child_pr_merge_timeout`
  (`plnr_69vndy4khkrz`, `plnr_jhwe4vq4p14p`) on pull requests whose CI
  passed (trellis #14 and #34).
- Six more fleet repositories carry PATs minted in 2026-05, and two of
  them already fail.

The same failure hit warren's own repository on 2026-08-07 (warren-2565):
a dead static credential failed silently, and merges and releases
stopped with no failed run to notice. Nothing tells the operator when
arming breaks. The plan-run fails hours later at the merge deadline with
no diagnosis.

Meanwhile warren already holds a credential that can do the job. The
manifest-registered forge App requests `contents: write` and
`pull_requests: write` (`GITHUB_APP_MANIFEST_PERMISSIONS`), which is
what the arming mutation needs. The operator experience should be:
install the App, set one config block, done.

## 1. Decision: warren arms, GitHub merges

After reap opens the pull request, warren arms auto-merge through the
boot-resolved Forge with GitHub's `enablePullRequestAutoMerge` mutation
(GraphQL). GitHub merges the pull request after the required checks pass.
Warren never merges and never evaluates checks.

`src/forge/contract.ts` says there is deliberately no
`mergePullRequest`. This record does not contradict that note. The deleted
method merged. `armAutoMerge` arms. GitHub keeps owning required-check
evaluation, branch protection, and merge-queue semantics.

A merge method would give the seam a capability with no caller, and it
would move check evaluation into warren, the exact move the no-merge
decision refuses. Arming delegates all of it to GitHub.

The forge App already requests the permissions the mutation needs, so no
new credential or permission appears. An App installation token is not
`GITHUB_TOKEN`, so the merge push still triggers CI and Release (the
warren-a2dc concern holds).

The feature is opt-in per project. With `pr.autoMerge` absent, behavior
stays byte-identical, and deployments that arm through a workflow keep
their workflow untouched.

## 2. The seam

### 2.1 Method and types

```ts
interface ForgeCapabilities {
  // ...existing flags...
  /** GitHub enablePullRequestAutoMerge reachable (AdoForge, FakeForge: false) */
  autoMergeArm: boolean;
}

type AutoMergeMethod = "squash" | "merge" | "rebase";

type ArmAutoMergeRefusalReason =
  | "repo_auto_merge_disabled"
  | "clean_status"
  | "insufficient_permission"
  | "mergeability_unsettled"
  | "not_open"
  | "unsupported_forge"
  | "unknown";

type ArmAutoMergeOutcome =
  | { readonly outcome: "armed" }
  | { readonly outcome: "already_armed" }
  | {
      readonly outcome: "refused";
      readonly reason: ArmAutoMergeRefusalReason;
      readonly message: string;
    };

interface Forge {
  // ...existing methods...
  armAutoMerge(
    ref: RepoRef,
    pr: PullRequestRef,
    input: { method: AutoMergeMethod },
  ): Promise<ForgeResult<ArmAutoMergeOutcome>>;
}
```

A refusal is a successful call with a semantic answer, not a transport
error, so all three outcomes ride the `ok: true` arm of `ForgeResult`.
Transport failures ride `ok: false` with `ForgeError`, unchanged.

- `armed`: the mutation armed the pull request.
- `already_armed`: the pull request already carries an auto-merge
  request. The provider detects it and skips the mutation. This is the
  idempotency contract.
- `refused`: GitHub answered no. The reason comes from the closed
  vocabulary above, and `message` carries GitHub's own words, redacted.
- `not_open`: the pull request is closed, merged, or a draft at arm
  time. The provider checks state first and never attempts the mutation
  on a pull request it cannot arm. This covers the race where a human or
  another armer merges between the open and the arm.

`PullRequestState` gains one required field:

```ts
interface PullRequestState {
  lifecycle: PullRequestLifecycle;
  mergedAt: number | null;
  headCommit: string;
  baseBranch: string;
  autoMerge: "armed" | "unarmed" | "unknown";
}
```

The GitHub provider maps the GraphQL `autoMergeRequest` (or the REST
`auto_merge` object) onto `armed` and `unarmed`. ADO and the fake report
`unknown` where they cannot tell. An honest `unknown` matters: the stall
warning in §7 keys on this field, and a forge that guesses `unarmed`
would fire the warning falsely.

### 2.2 Capability matrix

| Forge | `autoMergeArm` |
|---|---|
| GitHubApp | `true` |
| GitHubPat | `true`. Works when the token carries the scope, otherwise the call refuses with `insufficient_permission`. |
| AdoForge | `false`. Never called. |
| FakeForge | `false` in the default mode. An explicit non-default mode may arm for acceptance scenarios, and the default stays `false`. |

`HotForge` delegates the whole contract by construction, so an activated
App answers without a special case.

### 2.3 Where the vocabulary lives

The seam DTOs (`AutoMergeMethod`, `ArmAutoMergeRefusalReason`,
`ArmAutoMergeOutcome`) live in `src/forge/contract.ts`, beside `CheckRun`
and `PullRequestState`. Nothing in this plan enters `src/core/wire.ts`:
no SDK or UI type renders these values as an enum today, and the events
of §5 carry them as payload fields. `DOMAIN_STEMS` stays unchanged, so
`check:wire-types` passes with no allowlist or stem widening.

The GraphQL transport lands in a new file under `src/forge/github/`,
because `provider.ts` sits at exactly 500 lines. The transport reuses
the existing token source, retry policy, and error classifier, and a
`stub-server.ts` route covers it so tests never touch the network. The
config schema of §3 lands in a new file under `src/warren-config/`,
because `schema.ts` has eight lines of headroom.

### 2.4 The mergeability bound

GitHub computes mergeability after a push, so a single attempt at
PR-open time can fail spuriously. In warren-4681 the workflow's arm
fired exactly once against an `UNKNOWN` state and failed permanently.
The provider absorbs that inside `armAutoMerge`:

1. Read the pull request's mergeable state first.
2. While it reads `UNKNOWN`, wait and re-read on the schedule 1s, 2s,
   4s, 8s. Four waits, so the arm adds at most about fifteen seconds to
   reap.
3. When the state stays `UNKNOWN` past the schedule, return `refused`
   with reason `mergeability_unsettled`.
4. A `CONFLICTING` pull request classifies as `unknown` with GitHub's
   message preserved. Warren does not repair conflicts here. The healer
   and fixer paths own repair, and a later re-reap sweep arms the pull
   request once it settles, because find-then-open resolves the existing
   PR and the arm step runs again.

The bound is part of the contract: no code path in this plan may delay
reap past it or change the terminal state of a run.

## 3. The config contract

```yaml
pr:
  autoMerge:
    method: squash
    protectedPaths:
      - docs/CONSTITUTION.md
      - .warren/triggers.yaml
      - src/registry/builtins/
      - .github/workflows/auto-merge.yml
```

- The block is the switch. `pr.autoMerge` absent, or the whole `pr` block
  absent, means off. There is no `off` literal and no `enabled` flag.
- `method`: `squash`, `merge`, or `rebase`. Default `squash`.
- `protectedPaths`: a list of strings, default empty, holding path
  prefixes or globs.
- `.warren/config.yaml` is always implicitly protected. The list does
  not carry it, and the list cannot remove it.
- Matching: an entry with glob metacharacters matches changed paths as a
  glob. A plain entry matches as a path prefix, so
  `src/registry/builtins/` covers the directory and
  `docs/CONSTITUTION.md` covers the file and anything named after it.
  Failing closed on a near match is correct here.

### 3.1 Policy source: the base branch, never the run branch

The agent authors the run branch. A policy the agent can edit in the
same pull request is not a policy, so the arm step resolves the policy
from the PR's base ref and never reads the run branch's config.

The step reads `.warren/config.yaml` at the base ref, in the project
clone warren already holds. For a normal run the base ref is the project
default branch. For a chained plan-run child it is the previous child's
branch.

One guard closes the bypass the base-ref rule leaves open for chained
children: a pull request whose diff touches `.warren/config.yaml` never
arms (skip reason `config_changed`, §4). A config edit therefore cannot
ride an armed PR into the next child's base.

## 4. The arming policy (fail closed)

The arm step engages only when the project's `.warren/config.yaml`, the
file warren already loads per run from the project clone, carries a
`pr.autoMerge` block. With the block absent the step never runs: no arm
call, no new events, byte-identical behavior and test expectations.

Once engaged, the step evaluates in this order and emits exactly one
event per run:

1. The trigger is the CI-fixer: skip `ci_fixer_run`. A CI-fixer run
   pushes onto an existing armed PR head, so there is nothing new to
   arm. This mirrors the `reap.pr_open_skipped` self-skip.
2. Resolve the policy from the base ref (§3.1). The base ref resolves
   the block absent while the project config carried it: skip `off`.
   This is the divergence event. It tells the operator that the working
   tree said on and the base ref this pull request targets said off.
3. `capabilities.autoMergeArm === false`: skip `unsupported_forge`. The
   domain never calls past a false flag.
4. Diff policy. Read the changed-file list from git in the project
   clone, base ref against the pushed run branch. Never read it from
   the forge files API: the warren-7b2f bypass was one wrong API field
   name away from a silent permit, and a git read cannot key the wrong
   field.
   - The list is empty: skip `empty_diff`. Fail closed, never arm blind.
   - The list is unreadable: skip `diff_unreadable`. Fail closed.
   - A changed path matches a `protectedPaths` entry: skip
     `protected_path`, with `paths` naming the changed files that
     matched.
   - The diff touches `.warren/config.yaml`: skip `config_changed`, with
     `paths: [".warren/config.yaml"]`.
5. Call `armAutoMerge` with the resolved `method`. `ok: true` emits
   `reap.auto_merge_armed`. A refusal or a transport failure emits
   `reap.auto_merge_not_armed`.

The arm sub-step runs last in the reap PR-open phase, after
`reap.pr_opened` and the preview annotate, so its bounded latency never
delays them. Arming is best-effort: no outcome fails the run, delays
reap past the fifteen-second ceiling, or changes the run's terminal
state. A re-reap sweep runs the step again against the same PR, and
`already_armed` keeps that safe.

## 5. Event vocabulary

| Kind | Payload | Fires |
|---|---|---|
| `reap.auto_merge_armed` | `{ prUrl, outcome, method }` | The arm succeeded. `outcome` is `armed` or `already_armed`. `method` mirrors the config. |
| `reap.auto_merge_skipped` | `{ reason, paths? }` | Arming never started. `reason` is one of `off`, `unsupported_forge`, `protected_path`, `config_changed`, `empty_diff`, `diff_unreadable`, `ci_fixer_run`. `paths` carries the changed files on `protected_path` and `config_changed`. |
| `reap.auto_merge_not_armed` | `{ reason, message }` | The forge refused or the transport failed. `reason` is the closed refusal vocabulary of §2.1. `message` is the forge's redacted text, and a transport failure names its `ForgeErrorKind` in `message` with reason `unknown`. |
| `plan_run.merge_stalled` | `{ planRunId, seq, prUrl, checksPassing, autoMerge, waitedMs }` | See §7. |

All four are best-effort system events on the run's stream. They render
through the Event explorer's default arm today, a truncated JSON dump,
so label entries ride the step that ships the events if the default
reads poorly.

## 6. Repo prerequisites and the clean_status trap

A repository that wants warren-armed auto-merge needs:

- **Allow auto-merge** enabled, under Settings, General, Pull Requests.
- A **protected base branch with at least one required check**.

GitHub refuses `enablePullRequestAutoMerge` with "Pull request is in
clean status" when the pull request is immediately mergeable with
nothing pending. That is every repository without a required check. The
refusal surfaces as `clean_status` in `reap.auto_merge_not_armed`, never
as a run failure and never as a silent skip.

Warren never falls back to merging on `clean_status`, for two reasons.
A fallback merge would merge a pull request that no protection rule
covers, and it would move required-check evaluation into warren, the
exact move §1 refuses. The operator fix is repository configuration: add
a required check, then let the next arm or the next re-reap sweep arm
the pull request.

PAT mode: arming works when the token carries the needed scope. When it
does not, the refusal is `insufficient_permission`, the same event, and
never a run failure.

## 7. The stall warning

The observability hole closes regardless of who arms. When a plan-run
child sits in `waiting_for_merge` with passing checks and no armed
auto-merge, the coordinator emits `plan_run.merge_stalled` once per
child, well before the merge deadline.

- **Grace period: five minutes.** The clock is the same baseline as the
  merge timeout: `mergeWaitBaseline`, the later of the child run's
  `endedAt` and the plan-run's `resumedAt`.
- **Env knob: `WARREN_PLAN_RUN_MERGE_STALLED_WARNING_MS`**, default
  `300000`, named after `WARREN_PLAN_RUN_MERGE_TIMEOUT_MS`. The value
  `0` disables the warning.
- **One-shot.** The coordinator scans the child's run events for a
  prior `plan_run.merge_stalled` before it emits, the same scan shape
  as `hasEmptyPushEvent`. Exactly one event per child.
- **Payload:** `{ planRunId, seq, prUrl, checksPassing, autoMerge,
  waitedMs }`. `autoMerge` carries the PR-state value of §2.1, and it
  reads `unarmed` or `unknown` here, because an armed PR does not stall
  this way.

The `child_pr_merge_timeout` failure payload gains `checksPassing` and
`autoMerge` beside `prUrl`, so the terminal failure states whether checks
passed and what the `autoMerge` field read at the deadline.

The warning does not require the `pr.autoMerge` config. A project that
keeps a per-repo workflow gets the same early signal when its workflow
breaks, which is the trellis failure mode in §0.

## 8. Migration and the double-armer period

Both armers are idempotent, so the migration period is safe:

- warren: `already_armed` is success.
- the workflow: the warren-4681 fix made its arm a no-op when auto-merge
  already holds.

A project that opts in while its workflow still runs gets two armers
and at most one extra no-op. The removal order for an operator:

1. Set `pr.autoMerge`, with `protectedPaths` covering the Article IX
   paths, and confirm `reap.auto_merge_armed` events on new runs.
2. Delete `.github/workflows/auto-merge.yml`, the `AUTO_MERGE_APP_ID`
   variable, the `AUTO_MERGE_APP_PRIVATE_KEY` secret, and any
   `AUTO_MERGE_PAT` secret.
3. Keep `protectedPaths`. The starter list in §3 is the recommended
   minimum: the constitution, the triggers file, the builtin agent
   definitions, and the auto-merge workflow itself.

Warren's own repository keeps its workflow until an operator follows
up. The workflow file is an Article IX protected path, no step of this
plan may touch it, and a pull request that touches it cannot auto-merge
by design. Turning the feature on for warren's own repository is that
human follow-up, not a plan step.

## 9. Non-goals

- **Direct merge.** `mergePullRequest` stays gone. Warren arms, GitHub
  merges.
- **Merge-queue management.** GitHub owns the queue and its semantics.
  Warren reads state and arms.
- **ADO auto-complete.** `AdoForge` reports `autoMergeArm: false` and
  `autoMerge: "unknown"`. A later provider may map `armAutoMerge` onto
  Azure DevOps auto-complete. That provider is not this plan.
- **Enabling on warren's own repository.** Operator follow-up, held back
  by Article IX.

## 10. Numbers this record settles

Later steps read these from here and do not re-decide them:

| Number | Settled value |
|---|---|
| Mergeability wait schedule inside `armAutoMerge` | `1s, 2s, 4s, 8s`, at most about fifteen seconds, then refusal `mergeability_unsettled`. |
| Plan-run stall grace period | Five minutes. |
| Stall-warning env knob | `WARREN_PLAN_RUN_MERGE_STALLED_WARNING_MS`, default `300000`, `0` disables. |
