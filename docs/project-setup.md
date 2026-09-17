# Making a repo warren-ready

Checklist for configuring a GitHub repository so warren can open PRs that
auto-merge once CI passes, with branches cleaned up automatically.

Warren can arm GitHub auto-merge itself, right after reap opens the pull request. A project opts in with one `pr.autoMerge` block in `.warren/config.yaml`. GitHub merges the pull request once the required checks pass.

After the opt-in, a project needs no per-repo workflow, repository variable, or secret.

This page documents that path first. The per-repo GitHub Actions workflow survives as a labeled legacy alternative in §6, for repos that cannot move yet.

## Prerequisites

- A GitHub App on your account with `contents:write` and
  `pull-requests:write` repository permissions. This is the forge
  credential warren already opens PRs with, and it needs no extra
  permission to arm auto-merge.
- The repo has a CI workflow (for example `.github/workflows/ci.yml`)
  that runs on pull requests.
- `gh` CLI authenticated, for the settings calls below.

## 1. Repo settings

Three settings, plus one guard on branch protection.

**Allow auto-merge.** Settings → General → Pull Requests → Allow
auto-merge (checkbox). Or via CLI:

```bash
gh api --method PATCH repos/OWNER/REPO -f allow_auto_merge=true
```

**Protect the base branch with at least one required check.** Settings →
Branches → Branch protection rules. Require the CI check (for example
`ci`) before merging.

The required check matters more than it looks.

GitHub refuses the arming mutation with "Pull request is in clean status" under one condition: the pull request is immediately mergeable and nothing is pending.

Every repo without a required check hits that refusal, because CI never reports a pending state on the PR.

Warren records it as `clean_status` in `reap.auto_merge_not_armed` and never falls back to merging.

Add a required check, then let the next arm attempt or the next re-reap sweep arm the pull request.

**Delete head branches automatically.** Settings → General → Pull
Requests → Automatically delete head branches (checkbox). Or via CLI:

```bash
gh api --method PATCH repos/OWNER/REPO -f delete_branch_on_merge=true
```

**Remove the review requirement, if branch protection carries one.**
Required approving reviews block warren PRs. Remove the rule:

```bash
gh api --method DELETE repos/OWNER/REPO/branches/main/protection/required_pull_request_reviews
```

Warren arms only the PRs it opens itself, so external PRs never
auto-merge through warren, and a repo without the review rule stays
safe.

## 2. Opt the project in — the `pr.autoMerge` block

Write the block into `.warren/config.yaml` on the project's default
branch:

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

Fields:

- `method`: `squash`, `merge`, or `rebase`. Default `squash`.
- `protectedPaths`: repo-relative path prefixes or globs (for example
  `docs/` or `src/forge/**`), default empty. A plain entry matches as a
  path prefix, so `src/registry/builtins/` covers the directory and
  everything under it. An entry with `*`, `?`, or `[` matches as a glob.
  An unparseable glob matches everything, which fails closed.

Two rules hold regardless of the list:

- `.warren/config.yaml` itself is always protected. The list cannot
  remove it.
- The policy resolves from the pull request's base branch, never from
  the run branch. The agent authors the run branch, so it must not edit
  its own merge policy.

Off is silent. With `pr.autoMerge` absent, warren arms nothing, emits no
auto-merge events, and keeps today's behavior byte for byte. A CI-fixer
run also skips arming, because it pushes onto an existing armed PR head
that something already armed.

## 3. Verify — read the events

Every opted-in run that opens a PR emits exactly one arming event on its
stream, right after `reap.pr_opened`. Watch it live with
`warren tail <run-id>`, or read the run's event stream in the console.

| Kind | Payload | Meaning |
|---|---|---|
| `reap.auto_merge_armed` | `{ prUrl, prNumber, method, outcome }` | Warren armed the PR. `outcome` is `armed` or `already_armed`. The second value covers a re-reap sweep and the double armer during migration. |
| `reap.auto_merge_skipped` | `{ reason, paths? }` | Arming never started. `paths` names the matched files on `protected_path` and `config_changed`. |
| `reap.auto_merge_not_armed` | `{ reason, message }` | The forge refused. `reason` is a stable code from §4, and `message` carries the forge's own words. |
| `plan_run.merge_stalled` | `{ planRunId, seq, seedId, prUrl, checksPassing, autoMerge, waitedMs, hint }` | A plan-run child sits on a green PR with no armed auto-merge. One warning per child, five minutes after the merge wait starts. |

The stall warning fires regardless of who arms.

A project that keeps the per-repo workflow gets the same early signal when that workflow breaks.

`WARREN_PLAN_RUN_MERGE_STALLED_WARNING_MS` tunes the grace period (default `300000`, `0` disables it).

The `child_pr_merge_timeout` failure payload carries the same diagnosis: whether checks passed, and what the auto-merge state read at the deadline.

## 4. Troubleshooting — by reason code

Skip reasons, from `reap.auto_merge_skipped`:

| Reason | Cause | Fix |
|---|---|---|
| `off` | The base branch of this PR carries no `pr.autoMerge` block | Add the block on the base branch, or merge this PR by hand |
| `unsupported_forge` | The forge reports no arming capability (ADO, the fake forge in its default mode) | Use the GitHub forge, or arm through the legacy workflow |
| `protected_path` | The diff touches a `protectedPaths` entry | Intended behavior. Merge the PR by hand |
| `config_changed` | The diff touches `.warren/config.yaml` | Intended behavior. Merge the PR by hand |
| `empty_diff` | The changed-path list came back empty | Check the project clone. A real PR always changes at least one file |
| `diff_unreadable` | The diff read failed (bad ref, timeout, missing branch) | Check the project clone and the pushed run branch |
| `ci_fixer_run` | The run is a CI-fixer push onto an armed PR head | None needed. The existing armer covers it |

Not-armed reasons, from `reap.auto_merge_not_armed`:

| Reason | Cause | Fix |
|---|---|---|
| `repo_auto_merge_disabled` | The repo setting "Allow auto-merge" is off | Turn it on (§1) |
| `clean_status` | The PR is immediately mergeable and nothing is pending | Add a required check (§1) |
| `insufficient_permission` | The credential lacks the permission or scope | Check the App permissions, or the PAT scope |
| `mergeability_unsettled` | GitHub never settled mergeability within about 15 seconds | Usually transient. The next re-reap sweep arms the PR |
| `not_open` | The PR closed, merged, or turned draft before the arm | None. A human or another armer won the race |
| `unsupported_forge` | The forge answered "no arming capability" at call time (the policy normally skips earlier with the same reason) | Same fix as the skip reason of the same name |
| `unknown` | A transport failure or an unexpected error | Read `message`. On transport failures it names the `ForgeErrorKind` |

No arming outcome fails a run. A refused arm leaves the PR open and the
run terminal state untouched. Merge the PR by hand, fix the cause, or let
the next re-reap sweep try again.

## 5. Migration off the per-repo workflow

Both armers are idempotent, so the migration period is safe. A project
that opts in while its workflow still runs gets two armers and at most
one no-op. Warren answers `already_armed` when the workflow wins the
race, and the workflow's arm step is a no-op when warren wins.

The removal order:

1. Set `pr.autoMerge`, with `protectedPaths` covering the Article IX
   paths. The starter list in §2 is the recommended minimum.
2. Dispatch a real run and confirm a `reap.auto_merge_armed` event on
   its stream.
3. Delete `.github/workflows/auto-merge.yml`, the `AUTO_MERGE_APP_ID`
   repository variable, the `AUTO_MERGE_APP_PRIVATE_KEY` secret, any
   `AUTO_MERGE_PAT` secret, and the `AUTO_MERGE_BOT_LOGIN` variable.
4. Keep `protectedPaths`. The list is the guard that keeps protected
   changes out of auto-merged PRs.

Warren's own repository keeps its workflow for now.

The workflow file is an Article IX protected path. No warren-authored PR may touch it, and a PR that touches it cannot auto-merge by design.

Turning the feature on for warren's own repository needs a human to port the Article IX paths into `protectedPaths` and merge that change by hand.

## 6. Legacy alternative — the per-repo auto-merge workflow

The path every warren project used before `pr.autoMerge`: a per-repo GitHub Actions workflow that holds its own credential.

It works, but it carries a second credential per repository, outside warren and invisible to it. Nothing tells the operator when it breaks.

A plan-run then fails hours later at the merge deadline with no diagnosis.

Create `.github/workflows/auto-merge.yml`:

```yaml
name: auto-merge

on:
  pull_request:
    types: [opened, ready_for_review, reopened, synchronize]

permissions:
  contents: write
  pull-requests: write

jobs:
  enable-auto-merge:
    runs-on: ubuntu-latest
    if: >-
      !github.event.pull_request.draft &&
      github.event.pull_request.user.login == github.repository_owner
    steps:
      - name: Mint app installation token
        id: app-token
        uses: actions/create-github-app-token@v3.2.0
        with:
          app-id: ${{ vars.AUTO_MERGE_APP_ID }}
          private-key: ${{ secrets.AUTO_MERGE_APP_PRIVATE_KEY }}

      - name: Enable auto-merge (squash)
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          PR_URL: ${{ github.event.pull_request.html_url }}
        run: gh pr merge --auto --squash "$PR_URL"
```

This arms auto-merge on every non-draft PR authored by the repo owner.

Other authors' PRs still run CI but require manual merge. Squash keeps main history linear.

The workflow authenticates with a GitHub App installation token instead of `GITHUB_TOKEN`, so the merge commit triggers downstream workflows (CI, Publish, Release).

GitHub deliberately suppresses `GITHUB_TOKEN`-authored pushes to prevent recursive loops. An App beats a PAT here.

The workflow mints a fresh token on each run from a private key that never expires. A static PAT expires silently, and then merges and releases stop with no failed run to notice (warren-2565).

Create the auto-merge GitHub App and wire its credentials. One-time, in
the browser: **Settings → Developer settings → GitHub Apps → New GitHub
App** (<https://github.com/settings/apps/new>)

- **GitHub App name:** anything unique, for example
  `<owner>-warren-automerge`
- **Homepage URL:** the repo URL (a required field, not otherwise used)
- **Webhook:** uncheck **Active**
- **Repository permissions:** Contents with Read and write. Pull requests with Read and write
- **Where can this GitHub App be installed:** Only on this account

After you create the app, on its settings page:

1. Note the **App ID**.
2. **Generate a private key**, which downloads a `.pem` file.
3. **Install App** → your account → **Only select repositories** → pick
   the repo.

Give the credentials to Actions (App ID is not a secret, so it goes in a
variable):

```bash
gh variable set AUTO_MERGE_APP_ID --repo owner/repo --body '<app id>'
gh secret set AUTO_MERGE_APP_PRIVATE_KEY --repo owner/repo < path/to/downloaded-key.pem
```

There is no rotation cadence. The workflow mints a new installation token on each run, and the token expires after one hour on its own.

The `app-heartbeat` job in `release.yml` mints a token on every release tick as proof that the credential is alive. A revoked key or an uninstalled app turns that job red before the merge queue can stall silently.

The older `AUTO_MERGE_PAT` variant carried the opposite contract: a static secret with an expiry date and no heartbeat. It died silently when it lapsed (warren-2565 retired it, and warren-beb3 closed as moot).

## 7. Discord release announcements (optional)

The `announce` job in `.github/workflows/release.yml` posts each new
release to a Discord channel. It reads the notes back from the GitHub
release, so Discord shows the same curated `CHANGELOG.md` section.

In Discord, make the webhook:

**Server Settings → Integrations → Webhooks → New Webhook**

Point it at the `#releases` channel, name it `warren`, then copy the
webhook URL.

Give the URL to GitHub:

```bash
gh secret set DISCORD_RELEASES_WEBHOOK --repo owner/repo
```

The job skips with a warning when the secret is absent, so a fork without
a Discord server still releases. A webhook that Discord rejects fails the
job.

## Quick setup script

For a new repo, run all the API calls at once:

```bash
REPO="owner/repo"

gh api --method PATCH "repos/$REPO" \
  -f allow_auto_merge=true \
  -f delete_branch_on_merge=true

gh api --method DELETE "repos/$REPO/branches/main/protection/required_pull_request_reviews" 2>/dev/null
```

Then set the `pr.autoMerge` block from §2 in the project's
`.warren/config.yaml` and dispatch a run.

## Verification

Open a test PR from a dispatched run (or the repo owner account). You
should see:

1. CI triggers and runs
2. The run's event stream carries `reap.auto_merge_armed`
3. GitHub marks the PR as auto-merge enabled, with the squash method
4. Once CI passes, the PR auto-merges
5. GitHub deletes the head branch
