# UI visual gate and baseline approval

**Kind:** contract
**Design state:** approved
**Delivery:** mixed
**Arrived:** 2026-10-08

This record states the policy for the golden screenshot baselines in
`scripts/ui-visual/__golden__/` (plan `pl-10db`). The policy is short:
**baselines change only through a human approval.** An agent can
propose new baselines. Only a human can let them merge.

Without this rule the golden gate proves nothing. An agent that breaks
a page can regenerate the baselines in the same pull request, and the
comparison then passes against the broken render. The auto-merge
workflow would merge it on green CI. Pull request #1354, which added
the first baselines, merged that way: the workflow armed it, and it
merged on green CI with 61 baseline paths changed. No gate asked a
human to look at the pixels.

## Scope status

| Part | Seed | Delivery |
|---|---|---|
| Container-only golden generation and the `check:ui-goldens` manifest guard | `warren-a132` | `shipped` |
| Auto-merge refusal and the human approval label (this record) | `warren-4780` | `shipped` |
| Before/after/diff crops posted as a sticky PR comment | `warren-70d9` | `next` in plan `pl-10db` |
| `ui-visual` and `design-review` as required checks for `src/ui` PRs | `warren-dbef` | `shipped` |

Current truth for the shipped rows: `scripts/ui-visual/baseline-approval.ts`
(the approval gate), `scripts/ui-visual/required-checks.ts` (the merge
gate for the UI checks), `.github/workflows/auto-merge.yml` (the wiring),
`scripts/ui-visual/golden-manifest.ts` (the manifest guard), and
`scripts/ui-visual/README.md` (the operator steps).

## What needs an approval

The gate reads the three-dot diff of the pull request, the same way the
Article IX check does. A pull request needs an approval when it changes
any of these paths (`BASELINE_PATHS` in the gate):

- `scripts/ui-visual/__golden__/`, the PNGs and `manifest.json`
- `scripts/ui-visual/golden-cases.ts`, `golden.pw.ts`,
  `golden-manifest.ts`, `goldens.ts`, and `playwright.config.ts`
- `.github/workflows/ui-visual.yml`

The PNGs are not the only way to launder a regression. A looser
`maxDiffPixelRatio`, a dropped case, or a workflow that skips the
comparison does the same thing. So the files that decide how a render
compares are in the list too.

A pull request that changes a gate itself
(`scripts/ui-visual/baseline-approval.ts` or
`scripts/ui-visual/required-checks.ts`) never auto-merges. A human
merges it, as with an Article IX path.

## The approval signal

The approval is the `ui-baseline-approved` label, applied by a human
approver. The gate never trusts the presence of the label. It reads
three facts from sources that no bot can write.

1. **Who applied it.** The gate reads the issue events API and takes
   the latest `labeled` or `unlabeled` event for the label. The event
   must be `labeled`, and its actor must pass every check in the next
   section.
2. **What the approver saw.** The gate reads the repository activity
   API for the head branch. Each entry is a push that GitHub recorded,
   with a server timestamp. The head at approval time is the `after`
   commit of the last push strictly before the label event. Commit
   dates do not count, because the pusher sets them.
3. **Whether the baselines moved since.** The gate compares the git
   object ids of every baseline path at that head with the ids at the
   current head. Any difference voids the approval.

A later push that changes only other files keeps the approval. A
later push that changes a baseline voids it, and a human must remove
and re-apply the label after a new review.

### The actor checks

The approver list is the repository variable `UI_BASELINE_APPROVERS`, a
comma list of logins. When the variable is unset, the list is the
repository owner. The gate refuses the label event when any check
fails:

| Check | Identity it stops |
|---|---|
| Actor type must be `User` | The warren GitHub App installation token (`<slug>[bot]`), a workflow's `GITHUB_TOKEN` (`github-actions[bot]`), Dependabot |
| Login must not end in `[bot]` | Any App identity, whatever type the API reports |
| `performed_via_github_app` must be empty | An App that acts with a user-to-server token on behalf of an approver |
| Login must not be in `AUTO_MERGE_BOT_LOGIN` | The machine account that authors agent PRs (a `User`-type account such as `warren-run-bot`) |
| Login must be in the approver list | Every other collaborator |

The gate also refuses every approval when the approver list is empty
or names a bot login. A wrong configuration fails closed.

The warren GitHub App holds pull request write access, so it can add
the label. The machine account is a collaborator, so it can add the
label too. Both can. Neither can make the event name a listed human as
its actor.

### Why a label and not the alternatives

- **A pull request review approval from a code owner.** GitHub does not
  let an author approve their own pull request. The auto-merge workflow
  arms PRs that the owner authors, and this repository has one
  maintainer. The owner could never approve the baselines in their own
  PRs. A review also does not bind to content better than the activity
  check above.
- **Required code-owner review in branch protection.** It blocks every
  owner-authored PR that touches the baselines for the same reason. It
  also lives in repository settings, outside git, where no test can
  check it. `.github/CODEOWNERS` still routes a review request to the
  owner, but it enforces nothing.
- **An environment with required reviewers.** It gates a job, so each
  push queues a waiting deployment. The reviewers live in repository
  settings, outside git. An approver's personal token can approve a
  deployment through the API, so the trust is the same as the label.
- **`author_association` of the labeler (`OWNER` or `MEMBER`).** The
  issue events API does not report it. `MEMBER` would also admit a
  machine account that is a member of an organization.
- **A workflow that regenerates and commits the baselines when the
  label goes on.** The first draft of the seed asked for this. It puts
  the approval before the diff, so a human approves pixels they have
  not seen. It also adds a second writer to the PR branch. The human
  path below uses the existing dispatch mode and approves after the
  review.

## The approval workflow

1. **Regenerate in CI, never on a laptop.** Push the branch, then
   dispatch the ui-visual workflow in update mode:

   ```bash
   gh workflow run ui-visual.yml --ref <branch> -f update_goldens=true
   gh run list --workflow ui-visual.yml --branch <branch> --limit 1
   gh run download <run id> -n ui-goldens-<head sha> -D scripts/ui-visual/__golden__
   git add scripts/ui-visual/__golden__ && git commit && git push
   ```

   An agent may do this step. The gate does not care who regenerates.
2. **Review the diff.** On the PR, the `ui-visual` check compares the
   new head against the committed baselines. GitHub's rich diff shows
   each changed PNG side by side. Once `warren-70d9` lands, a sticky
   PR comment shows the before, after, and diff crops. The
   `ui-screenshots-<sha>` artifact holds the full set.
3. **Approve.** An approver applies `ui-baseline-approved` in the
   GitHub UI. The label event triggers `auto-merge.yml`, which checks
   the approval and arms auto-merge.
4. **If the baselines change again**, the next push refuses and
   disarms auto-merge. Review the new diff, remove the label, and apply
   it again.

To merge by hand instead, skip the label and merge the pull request
yourself. The gate only governs auto-merge.

## Fail-closed behavior

The step `UI baseline approval check` in `auto-merge.yml` writes
`hit=false` only when the gate exits 0 and its decision file says
`hit=false`. Every other outcome writes `hit=true`. The token mint and
the arm step both require `hit == 'false'` from the Article IX check
and from this step. These inputs all refuse:

- an unreadable or empty diff
- a base branch that has no copy of the gate script
- an API error, or more than 30 pages of events or activity
- a head branch in a fork, whose pushes are not in this repository's
  activity log
- no push before the label event, or a head that git cannot fetch

When the gate refuses, the step `Disarm auto-merge when a UI gate
refuses` turns off auto-merge if it is on. That covers a PR
that was armed before it gained a baseline change, or before its label
came off.

The arm step now also checks that the PR head is still the commit the
gates judged. When the head has moved, the arm waits for the run of the
newer push. The arm passes `--match-head-commit` for the same reason.

The workflow runs the gate script from the base branch tip
(`git show origin/<base>:scripts/ui-visual/baseline-approval.ts`), not
from the pull request. A PR that edits the gate cannot change how the
gate judges that PR.

## The merge gate

The golden comparison and the design review only protect `main` if a
UI pull request cannot merge before they pass. `warren-dbef` closes
that gap in `auto-merge.yml`. A pull request whose three-dot diff
touches `src/ui/` or `scripts/ui-visual/` arms auto-merge only when both
of these check runs report `success` on its exact head commit:

- `ui-visual`, the job in `.github/workflows/ui-visual.yml`.
- `design-review`, the check run that
  `.github/workflows/ui-design-review.yml` sets through the Checks API
  (see `ui-design-review.md` §7). It reports on every PR into `main`,
  and its "Skipped: no src/ui changes" success counts.

Any other pull request passes this gate untouched. The rules live in
`scripts/ui-visual/required-checks.ts`. The step `UI required checks
(ui-visual, design-review)` (id `ui_checks`) runs the base branch tip's
copy of it, with the same wrapper as the approval gate: only an explicit
`hit=false` from a gate that exited 0 lets the token mint and the arm
run.

### Which check runs count

A check run counts only when its source is the GitHub Actions app
(`app.slug` is `github-actions`). Commit statuses never count, and
neither does a check run from any other app. A `ui-visual` check run
counts only when its check suite belongs to a `pull_request` run of
`.github/workflows/ui-visual.yml` on the same head. That rules out a
second workflow with a job of the same name, and it rules out the
`update_goldens` dispatch, which reports `ui-visual` success without
running the comparison. Among the check runs that count, the newest one
decides, the same one the PR page shows.

### When it is judged

`auto-merge.yml` runs within seconds of a push, minutes before the
checks finish. So the first run after a push refuses while the checks
are pending, and it disarms auto-merge if an earlier head armed it.

The workflow also runs on `workflow_run` when a `UI design review` run
completes. One completes after every `ui-visual` run, success or
failure, because the design review's `prepare` job runs on that event.
The sweep (`required-checks.ts targets`) lists the open pull requests
that the `pull_request` path would admit and that are not armed yet:
not a draft, authored by the owner or an `AUTO_MERGE_BOT_LOGIN` login,
no `no-automerge` label. It keeps each one whose current head has both
checks green. It reads all of this from the API, never from the
triggering run's payload. The arm job then runs once per listed pull
request, as a matrix, with all three gates from scratch.

The other designs were weaker. A `check_run` trigger would miss the
`design-review` check: a workflow's `GITHUB_TOKEN` writes it, and
events that token causes do not start workflows. Polling from the first
run would hold a runner for the length of a design review, which can
take 30 minutes or more. Re-running the first run would replay its old
payload, including labels that have since changed.

### What the refusal says

The refusal names each required check and what is wrong with it, for
example `ui-visual concluded failure; design-review is queued on
<head>`. It appears in the step log, as a notice annotation on the
`enable-auto-merge` job, and in the job summary. A failed check needs a
fix and a new push. The `ui-visual` and `design-review` checks fail on
the PR itself, which is where the pr-fixer agent picks them up. A
pending check needs nothing: the sweep re-judges the PR when the design
review completes.

## Names that other steps depend on

These names are stable:

- The check `ui-visual`: the job and check name in
  `.github/workflows/ui-visual.yml`. The merge gate requires it.
- The check `design-review`, set by `.github/workflows/ui-design-review.yml`.
  The merge gate requires it, and its `workflow_run` trigger names that
  workflow's `name:`, `UI design review`.
- The jobs `targets` and `enable-auto-merge` in
  `.github/workflows/auto-merge.yml`. `targets` holds the admission
  `if:` and emits the PR list. `enable-auto-merge` is a matrix over it.
- The steps `Article IX check (constitution-protected paths)` (id
  `protected`), `UI baseline approval check` (id `baseline`), and `UI
  required checks (ui-visual, design-review)` (id `ui_checks`). Each
  writes `hit=true` or `hit=false`. A new gate adds a step with its own
  id and joins the `if:` of the token mint and the arm.
- The label `ui-baseline-approved`, declared in `.github/labels.yml`.

## Limits

- **An approver's own token is the approver.** GitHub cannot tell an
  agent that holds an approver's personal token from the approver. The
  gate stops the identities that warren hands to dispatched agents: the
  App installation token and the machine account. A local coding
  session that runs `gh` as the owner must not apply the label. Keep
  approver credentials out of agent environments.
- **The workflow file runs from the PR.** GitHub reads a
  `pull_request` workflow from the PR's merge commit. A PR that edits
  `auto-merge.yml` can remove this step for itself. Article IX covers
  that path, so such a PR needs a human merge anyway.
- **Warren-armed auto-merge does not run this gate.** A project that
  opts into `pr.autoMerge` (see `forge-auto-merge.md`) arms through the
  forge at reap time. Warren's own repository does not opt in today.
  If it does, add `scripts/ui-visual/__golden__/` and the other
  baseline paths to `pr.autoMerge.protectedPaths`. Arming then skips,
  and the label event still arms through this workflow.
- **A workflow can mint a `design-review` check.** The real one is
  created through the Checks API with a `GITHUB_TOKEN`, so it lands in
  an unrelated GitHub Actions check suite on the head, and nothing in
  it says which workflow wrote it. A workflow on a same-repository
  branch that holds `checks: write` can create a `design-review` check
  run as GitHub Actions too. The gate pins the app, which stops other
  apps and commit statuses. It cannot stop a workflow file in a branch
  of this repository. Review new and changed workflow files by hand.
- **Only PRs into `main` get the checks.** `ui-visual` and the design
  review run for pull requests into `main`. A UI pull request into any
  other base never sees both checks green, so it never auto-merges.
  Merge it by hand, or retarget it to `main`.
- **The sweep reports on `main`.** A `workflow_run` run belongs to the
  default branch's commit, so a refusal or an arm error from the sweep
  shows on `main`'s Actions page, not on the pull request.
- **Masks and the harness are outside the list.** A `data-visual-mask`
  attribute in `src/ui` or a change in `scripts/ui-visual/harness.ts`
  can hide a region from the comparison. Code review and the
  design-review evaluator cover those.

## Proposed Article IX wording

This record does not edit `docs/CONSTITUTION.md`. A human can add this
paragraph after the "Executable form" paragraph of Article IX:

> The golden screenshot baselines in `scripts/ui-visual/__golden__/`
> and the files that compare against them change only with a human's
> approval. The "UI baseline approval check" step in the same workflow
> refuses auto-merge on such a PR unless a human approver applied the
> `ui-baseline-approved` label to the baseline content the PR carries.
> An agent does not redraw the picture it is measured against.
