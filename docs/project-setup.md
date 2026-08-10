# Making a repo warren-ready

Checklist for configuring a GitHub repository so warren can open PRs that auto-merge once CI passes, with branches cleaned up automatically.

## Prerequisites

- A GitHub App on your account with `contents:write` and `pull-requests:write`
  repository permissions (created in §2 — no PAT, nothing expires)
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

This enables GitHub's auto-merge on every non-draft PR authored by the repo owner. Other authors' PRs still run CI but require manual merge. Squash keeps main history linear.

The workflow authenticates with a GitHub App installation token instead of `GITHUB_TOKEN` so the merge commit triggers downstream workflows (CI, Publish, Release). GitHub deliberately suppresses `GITHUB_TOKEN`-authored pushes to prevent recursive loops. An App beats a PAT here. The workflow mints a fresh token on each run from a private key that never expires. A static PAT expires silently, and then merges and releases stop with no failed run to notice (warren-2565).

## 2. Create the auto-merge GitHub App and wire its credentials

One-time, in the browser: **Settings → Developer settings → GitHub Apps → New GitHub App** (<https://github.com/settings/apps/new>)

- **GitHub App name:** anything unique, for example `<owner>-warren-automerge`
- **Homepage URL:** the repo URL (a required field, not otherwise used)
- **Webhook:** uncheck **Active**
- **Repository permissions:** Contents — Read and write. Pull requests — Read and write
- **Where can this GitHub App be installed:** Only on this account

After you create the app, on its settings page:

1. Note the **App ID**.
2. **Generate a private key** — downloads a `.pem` file.
3. **Install App** → your account → **Only select repositories** → pick the repo.

Give the credentials to Actions (App ID is not a secret, so it goes in a variable):

```bash
gh variable set AUTO_MERGE_APP_ID --repo owner/repo --body '<app id>'
gh secret set AUTO_MERGE_APP_PRIVATE_KEY --repo owner/repo < path/to/downloaded-key.pem
```

There is no rotation cadence. The workflow mints a new installation token on each run, and the token expires after one hour on its own. The `app-heartbeat` job in `release.yml` mints a token on every release tick as proof that the credential is alive. A revoked key or an uninstalled app turns that job red before the merge queue can stall silently.

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

gh variable set AUTO_MERGE_APP_ID --repo "$REPO" --body '<app id>'
gh secret set AUTO_MERGE_APP_PRIVATE_KEY --repo "$REPO" < path/to/downloaded-key.pem
```

Then commit the workflow file and push.

## Verification

Open a test PR from the repo owner account. You should see:
1. CI triggers and runs
2. The auto-merge workflow enables squash merge
3. Once CI passes, the PR auto-merges
4. The head branch is deleted
