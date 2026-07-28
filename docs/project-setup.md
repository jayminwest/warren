# Making a repo warren-ready

Checklist for configuring a GitHub repository so warren can open PRs that auto-merge once CI passes, with branches cleaned up automatically.

## Prerequisites

- A GitHub PAT with `contents:write` and `pull-requests:write` scopes
- The repo has a CI workflow (e.g. `.github/workflows/ci.yml`) that runs on pull requests
- `gh` CLI authenticated

## 1. Add the auto-merge workflow

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
      - name: Enable auto-merge (squash)
        env:
          GH_TOKEN: ${{ secrets.AUTO_MERGE_PAT }}
          PR_URL: ${{ github.event.pull_request.html_url }}
        run: gh pr merge --auto --squash "$PR_URL"
```

This enables GitHub's auto-merge on every non-draft PR authored by the repo owner. Other authors' PRs still run CI but require manual merge. Squash keeps main history linear.

The workflow uses `AUTO_MERGE_PAT` instead of `GITHUB_TOKEN` so the merge commit triggers downstream workflows (CI, Publish, Release). GitHub deliberately suppresses `GITHUB_TOKEN`-authored pushes to prevent recursive loops.

## 2. Add the `AUTO_MERGE_PAT` secret

**Settings → Secrets and variables → Actions → New repository secret**

- Name: `AUTO_MERGE_PAT`
- Value: your GitHub PAT

Or via CLI:

```bash
gh secret set AUTO_MERGE_PAT --repo owner/repo
```

## 3. Enable auto-merge on the repo

**Settings → General → Pull Requests → Allow auto-merge** (checkbox)

Or via CLI:

```bash
gh api --method PATCH repos/OWNER/REPO -f allow_auto_merge=true
```

## 4. Enable branch auto-delete

**Settings → General → Pull Requests → Automatically delete head branches** (checkbox)

Or via CLI:

```bash
gh api --method PATCH repos/OWNER/REPO -f delete_branch_on_merge=true
```

## 5. Remove review requirement (if present)

If branch protection requires approving reviews, warren PRs will be blocked. Remove it:

```bash
gh api --method DELETE repos/OWNER/REPO/branches/main/protection/required_pull_request_reviews
```

This is safe because the auto-merge workflow already scopes to `github.repository_owner` only — external PRs can't auto-merge.

Keep the required status check (e.g. `ci`) so PRs still must pass CI before merging.

## 6. Add the `DISCORD_RELEASES_WEBHOOK` secret (optional)

The `announce` job in `.github/workflows/release.yml` posts each new release to a Discord channel. It reads the notes back from the GitHub release, so Discord shows the same curated `CHANGELOG.md` section.

In Discord, make the webhook:

**Server Settings → Integrations → Webhooks → New Webhook**

Point it at the `#releases` channel, name it `warren`, then copy the webhook URL.

Give the URL to GitHub:

```bash
gh secret set DISCORD_RELEASES_WEBHOOK --repo owner/repo
```

The job skips with a warning when the secret is absent, so a fork without a Discord server still releases. A webhook that Discord rejects fails the job.

## Quick setup script

For a new repo, run all the API calls at once:

```bash
REPO="owner/repo"

gh api --method PATCH "repos/$REPO" \
  -f allow_auto_merge=true \
  -f delete_branch_on_merge=true

gh api --method DELETE "repos/$REPO/branches/main/protection/required_pull_request_reviews" 2>/dev/null

gh secret set AUTO_MERGE_PAT --repo "$REPO"
```

Then commit the workflow file and push.

## Verification

Open a test PR from the repo owner account. You should see:
1. CI triggers and runs
2. The auto-merge workflow enables squash merge
3. Once CI passes, the PR auto-merges
4. The head branch is deleted
