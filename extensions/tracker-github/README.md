# GitHub Issues and Projects tracker

A standalone `warren-tracker/v1` adapter for GitHub repository issues and
**Projects v2** owned by either an organization or a user. One adapter supports
both sources. Seeds is not required. No GitHub credentials enter Warren.

Manual dispatch is the default. Optional automatic pickup uses Warren's same
issue-dispatch endpoint and a persistent, conservative dispatch journal.

## Select a queue

Run `bun install --frozen-lockfile` in this directory. Supply a GitHub token
through the environment or a mounted secret file, never committed config.

Repository-only queue:

```bash
export GITHUB_REPOSITORY=acme/web
export GITHUB_LABELS='["ready-for-agent"]'
# Export GITHUB_TOKEN securely, or set GITHUB_TOKEN_FILE to a mounted secret.
bun run start
```

Project queue (organization example):

```bash
export GITHUB_PROJECT_OWNER=acme
export GITHUB_PROJECT_OWNER_TYPE=organization
export GITHUB_PROJECT_NUMBER=3
export GITHUB_PROJECT_STATUS_FIELD=Status
export GITHUB_READY_STATUSES='["Ready for Development"]'
export GITHUB_LABELS='["agent-approved"]'  # optional
bun run start
```

Set `GITHUB_PROJECT_OWNER_TYPE=user` for a personal Project. Its number is the
number in `/users/<login>/projects/<number>` or `/orgs/<login>/projects/<number>`,
not an issue number. Project names are not globally unique, so owner + type +
number identify the Project.

- Set **either** repository or Project scope, or both. With both, repository
  membership AND Project membership are required.
- Without a repository restriction, a Project may span repositories. Issue ids
  are always `owner/repo#number`, so issue #12 in two repositories cannot collide.
- Ready statuses match options in the configured **Project's own single-select
  field**, not a repository label and not another Project's status. Multiple
  ready statuses mean OR. An unknown field/option is an error, not an empty queue.
- Labels combine with scope/status using AND. All specified labels are required
  by default; `GITHUB_LABEL_MODE=any` means any listed label. Empty labels impose
  no label restriction. Label matching is case-insensitive; status names are exact.
- Only open repository issues are eligible. Project drafts, pull requests,
  archived items, inaccessible/redacted items and items outside the scope are
  not executable. A closed Project is refused.
- Without ready statuses, all open issues matching the other filters qualify.
  No status name such as `Ready` or `Done` is hard-coded.
- A Project's status is not an issue's lifecycle: an open issue in `Done` remains
  open and is simply ineligible unless that option was explicitly selected.

## Connect to Warren

On the **Warren server**, explicitly allow the adapter endpoint. Repository
config cannot grant itself access to arbitrary host URLs or environment secrets:

```bash
export WARREN_TRACKER_ALLOWED_URLS='["http://tracker-github:8080"]'
# Set WARREN_TRACKER_BEARER securely, matching the adapter's TRACKER_BEARER.
```

In each participating repository, commit `.warren/config.yaml`:

```yaml
tracker:
  url: http://tracker-github:8080
  tokenEnv: WARREN_TRACKER_BEARER
```

Then refresh that project's clone. Warren resolves the tracker per project;
projects without this block retain Seeds. A changed endpoint is reconnected on
config refresh. Custom credential variable names also require the operator's
`WARREN_TRACKER_ALLOWED_TOKEN_ENVS` JSON allowlist (default contains only
`WARREN_TRACKER_BEARER`). Endpoints must not contain credentials/query/fragment;
redirects are refused. Use HTTPS or an isolated trusted container network.

The project detail page displays **Ready issues**, filtered to that Warren
project's repository. Select **Dispatch**, review the description, select an
agent and cost cap, then confirm. Already-dispatched issues link to their run.
A multi-repository Project can connect to multiple Warren projects without
accidentally dispatching an issue against another repository's checkout.

The public API is:

- `GET /projects/:id/issues` — operator-only issue list with run links.
- `POST /projects/:id/issues/dispatch` — body `{ "issueId": "acme/web#12",
  "agent": "pi", "maxCostUsd": 3 }`. Starts one run, or returns the existing
  persisted run receipt. Issue ids are in the body because Warren's router
  deliberately forbids path separators in decoded route parameters.

The domain checks current eligibility and repository identity before execution,
including after clone refresh. It embeds the issue title/body in the agent task.
No merge or deployment is requested by this flow. PR creation remains governed
by Warren's existing project/run policy.

## Opt in to automatic pickup

On the **adapter**, in addition to its GitHub/tracker credentials:

```bash
export AUTO_DISPATCH_ENABLED=true
export WARREN_BASE_URL=https://warren.example.com
# Export WARREN_API_TOKEN securely; requires Warren dispatch access.
export WARREN_AGENT=pi
export WARREN_PROJECT_MAP='{"acme/web":"prj_example","acme/api":"prj_other"}'
export AUTO_STATE_PATH=/state/dispatches.sqlite
export AUTO_MAX_COST_USD=3
export AUTO_DAILY_BUDGET_USD=15
export AUTO_MAX_CONCURRENT=1
export AUTO_POLL_SECONDS=60
```

All credentials, the map, persistent state path, agent and both budget values
are required for automatic mode. `TRACKER_BEARER` is also mandatory in this mode.
Unmapped repositories are skipped, never guessed. The adapter verifies each
mapped Warren project's actual repository before submitting work.

### Dispatch safety and recovery

- One durable automatic attempt per issue, not one per poll. The controller
  first verifies the read-only Warren queue connection, then reserves budget in
  SQLite **before** the dispatch mutation. Startup/ingress read failures can retry
  without consuming a reservation. A restart does not erase a mutation reservation.
- Manual queue dispatch and automatic pickup use the same Warren endpoint. The
  persisted run row prevents a second queue dispatch after response loss or a
  Warren restart. Concurrent requests are serialized by the existing project
  clone lock. This assumes Warren's supported single control-plane process;
  multiple independent Warren servers must not share a queue/project database.
- Eligibility is re-read before dispatch. A user editing a Project after that
  read can race a run already starting; GitHub and Warren have no cross-system
  transaction. Moving status is not a cancellation command—cancel the run in Warren.
- Unknown dispatch outcomes are journaled `uncertain`, never blindly retried,
  and block new automatic pickups. A crash with a `reserved` entry retains its
  concurrency and budget reservation. A failed run poll retains the known run.
- Failed/cancelled runs and explicit HTTP refusals are not automatically retried.
  Review the run in Warren and explicitly use its ordinary retry/continuation
  controls. Do not delete journal entries to clear an uncertain network result.
- Inspect `GET /dispatches` on the adapter (tracker bearer required when set).
  Reconcile unknown outcomes against Warren's persisted issue/run record before
  administrative journal repair. Keep the state volume across upgrades.
- Daily reservations use **UTC days**. A completed run retains at least its full
  reserved cap for that day; unknown/active work carries its reservation across
  midnight. This intentionally under-utilizes budgets rather than guessing.
- Cost limits use Warren's reported/estimated USD usage, not a guaranteed billing
  ceiling. Cancellation and provider reporting can lag. These are runaway brakes.
- The adapter does not move Project statuses or edit labels. Those remain the
  operator's workflow. GitHub issue closing is separately opt-in below.

## Configuration reference

| Variable | Default / requirement |
|---|---|
| `GITHUB_TOKEN` / `GITHUB_TOKEN_FILE` | Exactly one; file is reread per request for externally rotated installation tokens |
| `GITHUB_REPOSITORY` | Optional `owner/repo`; required without a Project |
| `GITHUB_PROJECT_OWNER`, `GITHUB_PROJECT_NUMBER` | Required together for Project scope |
| `GITHUB_PROJECT_OWNER_TYPE` | `organization`; or `user` |
| `GITHUB_PROJECT_STATUS_FIELD` | `Status` |
| `GITHUB_READY_STATUSES` | JSON array; omitted means no status restriction |
| `GITHUB_LABELS` | JSON array; omitted means no label restriction |
| `GITHUB_LABEL_MODE` | `all`; or `any` |
| `GITHUB_API_URL` | `https://api.github.com` |
| `GITHUB_GRAPHQL_URL` | API URL + `/graphql`; set explicitly for GHES, typically `https://host/api/graphql` |
| `GITHUB_MAX_PAGES` | 100, applied to every connection; exhaustion fails rather than truncating |
| `GITHUB_TIMEOUT_MS` | 15000 |
| `GITHUB_ALLOW_CLOSE` | `false`; set `true` only to authorize GitHub issue-closing requests |
| `TRACKER_PORT` | 8080 |
| `TRACKER_BEARER` | Optional for read-only mode; strongly recommended even on private networks |
| `AUTO_DISPATCH_ENABLED` | `false`; only literal `true` enables it |
| `AUTO_MAX_CONCURRENT` | 1 |
| `AUTO_POLL_SECONDS` | 60 |

GitHub REST reads require access to Issues; closing requires write permission.
Projects v2 reads also require Projects access. Use the least-privileged token
appropriate to the repository/Project owner; the adapter does not mint installation
tokens. A token file can be rotated by an external credential manager. Never put
GitHub tokens in `.warren/config.yaml`.

For GHES, configure REST and GraphQL URLs on the same HTTPS origin. API behavior
varies by server version; Projects v2 support is required. GitHub.com and user/
organization Project behavior are covered by recorded-shape tests; GHES is not
live-qualified. Classic Projects are not supported.

## Protocol and errors

Base contract plus additive `supportsIssueListing: true` (`GET /issues`). Plans,
metadata writes and scheduled-issue timestamps are not fabricated. `/issues`
returns the filtered ready queue; `/issue-statuses` retains lifecycle states for
all readable, non-archived issues within repository/Project scope, even when
labels/status no longer make them ready. Individual reads also retain those
issues with `ready: false` so a workflow change is not mistaken for completion.

`POST /issues/{encoded-id}/close` reads first and is idempotent for already-closed
issues. Otherwise closing is refused unless `GITHUB_ALLOW_CLOSE=true`. Closing
never modifies the Project's status. The default read-only deployment deliberately
refuses a mutating conformance probe; run full conformance only on disposable
issues with closing explicitly enabled.

GitHub permissions failures become `502 upstream_unauthorized` (not a misleading
Warren-auth 401); rate limits become 429 with Retry-After. Partial GraphQL data,
unknown option names, pagination exhaustion and malformed responses fail closed.
Upstream response bodies, credentials and transport errors are not echoed.

## Build and validate

```bash
bun test
bun run typecheck
docker build -t warren-ext-tracker-github .
# Mount persistent /state if automatic pickup is enabled.
```

`src/dev-server.ts` is a disposable fake-GitHub adapter for tests only. It prints
its ephemeral port; the published conformance CLI can test that port without
contacting GitHub. Never run the conformance CLI against real work: it closes an
issue as part of its protocol proof.

Primary API references: [GitHub repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues),
[Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects).

## Friction found

The v1 contract could read an issue by id but could not list issue descriptions
for an operator queue. Its additive listing capability avoids imposing a new
endpoint on existing adapters. Production startup also did not consume the
per-project `tracker` block; the per-project resolver and operator allowlists
make the existing documented configuration usable without granting a repository
control over host credentials. Neither capability is GitHub-specific.
