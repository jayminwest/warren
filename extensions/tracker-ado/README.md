# @warren-ext/tracker-ado

A **warren-tracker/v1** server backed by the **Azure DevOps Boards REST
API**. It runs out of process, holds its own Azure DevOps credential, and
warren stores none of it.

Warren reaches it through the per-project `tracker:` block in
`.warren/config.yaml`:

```yaml
tracker:
  url: http://tracker-ado:8080
  tokenEnv: WARREN_TRACKER_BEARER   # optional
```

Issue ids on the wire are work item numbers: `warren run --seed 96379`
dispatches work item 96379.

## Capabilities

```json
{ "supportsPlans": false, "supportsMetadata": false,
  "supportsScheduledIssues": false, "isGitNative": false }
```

Base contract only, which is what Azure DevOps maps onto without
inventing anything.

- **No plans.** A feature's child links are a hierarchy, not an ordered
  walk. Drive serial execution with `POST /plan-runs` and an explicit
  ordered `issues: ["96379", "96380"]` list, which the base contract is
  enough to serve (docs/design/issue-tracker.md §4).
- **No metadata.** Storing warren's keys would need a custom field per
  key in the process template, and which field is a decision only the
  organization admin can make.
- **No scheduled issues.** Work items have a start date and a target
  date, but whether either means "warren should pick this up then" is a
  convention, not a fact about the field.
- **Not git-native.** Boards and the repository are separate systems,
  which is exactly the shape the bridge was built for.

## Configuration

All configuration is environment. Missing or contradictory values fail at
boot with the variable named, rather than surfacing as an upstream error
inside a run.

| Variable | Required | Meaning |
|---|---|---|
| `ADO_ORG_URL` | yes | Organization root, no trailing slash: `https://dev.azure.com/acme` |
| `ADO_PROJECT` | yes | Team project name or id. Every work item route is scoped to it |
| `ADO_PAT` | yes* | A [personal access token](https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate) with **Work Items (Read & Write)** |
| `ADO_BEARER` | yes* | An Entra ID access token, instead of the PAT. Read once at boot and never refreshed: when it expires, restart the container with a fresh one |
| `ADO_WIQL` | yes | The [WIQL](https://learn.microsoft.com/azure/devops/boards/queries/wiql-syntax) query behind `GET /issue-statuses`, which is the list warren claims work from. Flat queries only (`FROM WorkItems`); a tree or one-hop query answers with relations instead of ids and is refused |
| `ADO_DONE_STATE` | no | State name set on close. Unset picks the first `Completed`-category state of the work item's type |
| `ADO_BLOCKED_BY_LINK` | no | Link type whose target is a blocker. Default `System.LinkTypes.Dependency-Reverse` |
| `ADO_BATCH_SIZE` | no | Ids per batch read. Default and maximum 200 |
| `ADO_MAX_WIQL_RESULTS` | no | Backstop on the query's result count. Default 5000 |
| `ADO_TIMEOUT_MS` | no | Deadline per Azure DevOps call, headers and body included. Default 30000 |
| `TRACKER_PORT` | no | Listen port. Default 8080 |
| `TRACKER_BEARER` | no | The token **warren** must present to this server |

\* Exactly one of the two auth modes. Setting both is refused rather than
resolved by precedence. The PAT is the mode for a deployment: it lives as
long as its expiry on the Azure DevOps side and needs no refresh flow.
`ADO_BEARER` exists for a setup that already mints Entra ID access tokens
(a smoke test, a short-lived job); such a token lasts about an hour, this
server never refreshes it, and after expiry every call answers
`502 upstream_unauthorized` until a restart supplies a fresh one.

`TRACKER_BEARER` and the Azure DevOps credential are unrelated. One is
what warren shows this container, the other is what this container shows
Azure DevOps.

**What the query does and does not scope.** The query feeds
`GET /issue-statuses` only, and that map is what warren discovers and
claims work from. A read or a close of a specific id
(`GET /issues/{id}`, `POST /issues/{id}/close`) goes straight to the work
item: warren asks for ids it was handed directly too, through
`POST /plan-runs` with an explicit issue list or a dispatch that names
one, and those may lie outside the query on purpose. The access boundary
is therefore the credential's scope and `ADO_PROJECT`, not the query. A
work item the PAT can reach inside the project can be read and closed by
whoever can call this server, which is why `TRACKER_BEARER` matters.

A query that scopes warren's pick-up list to what the deployment may
work on looks like:

```sql
SELECT [System.Id] FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.AreaPath] UNDER 'Platform\Growth'
  AND [System.Tags] CONTAINS 'warren'
  AND [System.State] <> 'Removed'
```

## Run it

```bash
bun install
ADO_ORG_URL=https://dev.azure.com/acme \
ADO_PROJECT=Platform \
ADO_PAT=... \
ADO_WIQL="SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS 'warren'" \
bun run start
```

In docker, which builds from this directory alone:

```bash
docker build -t warren-ext-tracker-ado .
docker run --rm -p 8080:8080 \
  -e ADO_ORG_URL=https://dev.azure.com/acme \
  -e ADO_PROJECT=Platform \
  -e ADO_PAT=... \
  -e ADO_WIQL="SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS 'warren'" \
  warren-ext-tracker-ado
```

## How each operation maps

| warren-tracker/v1 | Azure DevOps (REST 7.1, all under `{org}/{project}/_apis/wit`) |
|---|---|
| `GET /capabilities` | nothing; answered locally, so a boot probe costs no round trip |
| `GET /issues/{id}` | `GET /workitems/{id}?$expand=relations`, then `GET /workitemtypes/{type}/states` (cached per type) |
| `GET /issue-statuses` | `POST /wiql` over `ADO_WIQL` for the ids, then `POST /workitemsbatch` for `System.State` and `System.WorkItemType`, 200 ids at a time, then `GET /workitemtypes/{type}/states` once per type seen (cached) |
| `POST /issues/{id}/close` | read the work item, `GET /workitemtypes/{type}/states` (cached per type), then `PATCH /workitems/{id}` with a JSON patch on `System.State` if it is not already terminal |

`status` on the wire is warren's own `open | closed | other`, never the
raw `System.State`. The fold goes by the state's *category* in the work
item type's process, so it holds for any process template and any
spelling:

| State category | `status` | Why |
|---|---|---|
| `Proposed` (`New`, `To Do`, `Approved`, …) | `open` | the only category warren may claim work from |
| `InProgress`, `Resolved` | `other` | someone has it; neither claimable nor finished |
| `Completed`, `Removed` (`Closed`, `Done`, `Removed`, …) | `closed` | finished, or taken off the backlog |
| a state the process does not define | `other` | cannot be shown closed, and claiming it would be a guess |

The protocol text says a server may send its raw status and warren
normalizes at the bridge, but the bridge only recognizes these three
exact spellings and folds everything else to `other`, so a raw `Closed`
would never read as closed and the plan-run coordinator would never skip
a finished work item. See friction point 6.

`description` is assembled from the rich-text fields the process template
splits the narrative across: `System.Description`, then
`Microsoft.VSTS.TCM.ReproSteps` (an Agile bug's narrative) under a
`Repro steps:` label, then `Microsoft.VSTS.Common.AcceptanceCriteria`
under `Acceptance criteria:`. Each is HTML in Azure DevOps and is
flattened to text.

`blockedBy` reads the **reverse** side of a dependency link
(`System.LinkTypes.Dependency-Reverse`, shown as *Predecessor* on the
board), which is the blocker. The forward side is the work item this one
blocks, and it is deliberately not reported.

### Close, and why it reads first

Which states are terminal is a property of the process template, not of
Azure DevOps: Agile closes into `Closed`, Scrum and Basic into `Done`,
CMMI into `Closed`, and an inherited process can rename any of them. So
close reads the work item and its type's states first. If the current
state's category is `Completed` or `Removed`, the read is the whole answer
and nothing is patched. Closing twice is 200 both times, which the
protocol requires.

`Removed` counts as terminal on purpose. A removed work item was taken off
the backlog by someone on the board, and moving it to `Closed` just to
satisfy a close would undo that decision.

If the type defines no `Completed`-category state, or `ADO_DONE_STATE`
names a state the type does not have or one outside the `Completed` and
`Removed` categories, the answer is `409 no_close_state`. A close into a
non-terminal state would never read as closed, so a second close would
repeat it.
That is a configuration answer rather than a transient one, and warren
does not retry a 4xx.

### Failure mapping

| Azure DevOps | This server | Why |
|---|---|---|
| 404 on the work-item read | `404 issue_not_found` | the one reserved protocol code |
| 404 anywhere else (a type's states, the close PATCH) | `502 upstream_error` | those calls name a type or a state, not the issue, so a 404 there is Azure DevOps misbehaving |
| 412 on the close PATCH, twice | `502 upstream_error` | the revision moved under the close twice in a row; once is re-read and retried |
| 2xx with a payload missing the id, state or list the call reads | `502 upstream_error` | a proxy or a changed API answered; passing it on would read as an empty status |
| an id that is not a number | `404 issue_not_found`, without a call | no work item can have it; Azure DevOps would answer 400 |
| 401 / 403 | `502 upstream_unauthorized` | **this container's** credential was rejected. Passing 401 through would send an operator to warren's bearer, the wrong secret |
| 203 with a sign-in page | `502 upstream_unauthorized` | what Azure DevOps actually serves for a bad or expired PAT on many routes |
| 429 | `429 upstream_rate_limited`, `Retry-After` passed through | warren's bridge already backs off on 429 and honors the header |
| 5xx or unreachable | `502 upstream_error` / `upstream_unreachable` | the tracker answered; the system behind it did not |
| a WIQL result past `ADO_MAX_WIQL_RESULTS` | `409 query_too_broad` | a configuration answer that stays wrong on a retry, so warren must not repeat the query |
| no answer within `ADO_TIMEOUT_MS` | `504 upstream_timeout` | a stalled connection or body would otherwise hold the handler open, and warren's backoff cannot start until this call ends |
| n/a | `400 invalid_issue_id` | the path segment is not valid percent-encoding, so there is no id to look up |

There are no retries in this container. A second, unsynchronized backoff
underneath warren's own would only make the wait harder to predict.

## Scope

**Azure DevOps Services, REST 7.1.** Azure DevOps Server (on-premises)
is not covered. Its organization url has a collection segment
(`https://tfs.example/tfs/DefaultCollection`) and its API version
ceiling depends on the installed release. The url shape probably works
as-is through `ADO_ORG_URL`, and `ADO_API_VERSION` in
`src/ado/types.ts` is the one constant to lower, but nothing here has
been run against a server install.

## Tests

```bash
bun test
bun run typecheck
bun run lint
```

The interesting one is the protocol suite, which needs an Azure DevOps on
the other side. `src/fake-ado.ts` is that Azure DevOps: a `fetch`-shaped
stub of the five routes this tracker calls, transcribed from Microsoft's
documented 7.1 response shapes. `bun run dev-server` serves the real
handler, the real client and the real mapping over it, so the suite
judges this package end to end:

```bash
bun run dev-server --port 8080
# in another shell
cd ../tracker-conformance && bun run check http://127.0.0.1:8080
```

## What is and is not verified

**Verified.** The tracker passes
`@warren-ext/tracker-conformance` unchanged, in both auth modes:

```
warren-tracker/v1 conformance: 7 case groups against http://127.0.0.1:8793
PASS — the server conforms to warren-tracker/v1 (experimental)
```

**Verified live.** A smoke run against a real Azure DevOps Services
organization (Agile process, uncustomized link types) exercised every
route with three throwaway work items: a User Story with an HTML
description and acceptance criteria, a Task carrying a
`System.LinkTypes.Dependency-Reverse` link to that story, and a Bug
moved to `Closed` beforehand. What it established:

- `GET /issues/{id}` flattens the stored HTML as intended. The service
  rewrites the markup it saves, padding closing tags with spaces
  (`</li> </ul><p>`), which surfaced as a leading space on the next line
  until the flattener started trimming both ends of every line.
- The predecessor link comes back with the `rel` spelling this tracker
  assumes, so `blockedBy` carries the story's id.
- `POST /issues/{id}/close` moves a `New` Task straight to `Closed`, and
  on an already-`Closed` Bug it makes no PATCH and returns the item.
- Every work item payload, the batch read included, carries `rev`. A
  PATCH whose `test` op names a stale `/rev` answers **412** with
  `VS403351 TestPatchOperationFailedException`, which is the status the
  close path re-reads and retries on.
- A bad PAT never arrives as a 401. Both `dev.azure.com/{org}` and
  `{org}.visualstudio.com` answer 302 to a sign-in page, which `fetch`
  follows into a 203 with `text/html`. The tracker reports it as 502
  `upstream_unauthorized` with the page title in place of its markup.
- Both hostnames serve the REST routes identically with a valid PAT.

**Not verified.** A project whose admin customized link types (the
`ADO_BLOCKED_BY_LINK` knob exists for that), a WIQL result past
`ADO_MAX_WIQL_RESULTS`, a 429 from the real service, and Azure DevOps
Server (on-premises), whose sign-in behaviour may differ.

## Friction

The second foreign implementation of warren-tracker/v1, after Jira.
Nothing here required a protocol change, and the suite passed unchanged
on the first run. What the build surfaced:

1. **The Jira friction list still stands.** Its four points (a tracker
   with no close verb, the server-side retry contract, what to do when
   the server's own upstream rejects it, and `issue_not_found` being the
   only reserved code) all applied here word for word, and this server
   made the same four calls: 409 for a permanent refusal, 502 for the
   upstream credential, and its own spellings for every non-reserved
   code. Two servers agreeing on the same inventions is the argument
   for writing them into the protocol.
2. **Terminal is per type, not per tracker.** Jira answers "is this
   done?" on the issue itself (`statusCategory`). Azure DevOps answers
   it on the work item *type*, one extra round trip away, so an
   idempotent close costs a read plus a states lookup before it knows
   whether to patch. The states are cached per type for the life of the
   process, which is the right trade until a process edit needs a
   restart to notice. The protocol's idempotent-close rule was still
   implementable; it just cost more than the rule implies.
3. **Issue ids are typed on one side only.** Warren treats an issue id as
   an opaque string, which is right for the protocol. Azure DevOps ids
   are integers, so this server has to decide what `GET /issues/WAR-1`
   means. It answers `issue_not_found` without a call, on the argument
   that no work item can have that id. A protocol note that a server MAY
   answer not-found for an id that is malformed *for that tracker* would
   make the choice explicit.
4. **The status map is two calls, not one.** WIQL returns ids only, so
   `GET /issue-statuses` is a query plus N/200 batch reads. Warren's
   15-second bridge cache makes that fine in practice, but a tracker
   whose list endpoint cannot return status inline pays more per poll
   than the protocol's single-endpoint shape suggests.
5. **The narrative lives in three fields.** Jira has one description.
   Azure DevOps splits it across description, repro steps and
   acceptance criteria depending on the type, so this server labels and
   concatenates them. The protocol's single `description` string is
   still the right shape for an agent prompt; it just means the server,
   not warren, decides the labeling.

6. **"Warren normalizes raw statuses at the bridge" is not true.**
   `src/tracker/remote/protocol.ts` and the issue-tracker design record
   both say a server sends its raw status string and warren folds it.
   The bridge's fold (`normalizeIssueStatus` in `src/core/wire-tracker.ts`)
   recognizes only the literal strings `open` and `closed`; every other
   spelling becomes `other`, which is neither closed nor claimable. A
   server that follows the protocol text therefore produces a tracker
   whose finished work never reads as finished, and the conformance
   suite does not catch it because it accepts any non-empty string. The
   bridge does pass a status through when it already is one of the three
   words, so this server speaks that vocabulary itself. The protocol
   should say so, the conformance suite should require it, and
   `tracker-jira` (which sends the raw Jira status name) has the same
   defect.

Nothing here required a warren surface that does not exist.
