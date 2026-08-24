# @warren-ext/tracker-jira

A **warren-tracker/v1** server backed by the **Jira Cloud REST API**
(warren-27d9). It runs out of process, holds its own Jira credential, and
warren stores none of it.

Warren reaches it through the per-project `tracker:` block in
`.warren/config.yaml`:

```yaml
tracker:
  url: http://tracker-jira:8080
  tokenEnv: WARREN_TRACKER_BEARER   # optional
```

## Capabilities

```json
{ "supportsPlans": false, "supportsMetadata": false,
  "supportsScheduledIssues": false, "isGitNative": false }
```

Base contract only, which is what Jira maps onto without inventing
anything.

- **No plans.** Jira has no object warren could walk as a plan. Drive
  serial execution with `POST /plan-runs` and an explicit ordered
  `issues: ["WAR-12", "WAR-13"]` list, which the base contract is enough
  to serve (docs/design/issue-tracker.md §4).
- **No metadata.** Storing warren's keys would need a Jira custom field
  per key, and which field is a decision only the site admin can make.
- **No scheduled issues.** Jira has a due date, but whether a due date
  means "warren should pick this up then" is a convention, not a fact
  about the field.
- **Not git-native.** Jira issues and the repository are separate
  systems, which is exactly the shape the bridge was built for.

## Configuration

All configuration is environment. Missing or contradictory values fail at
boot with the variable named, rather than surfacing as an upstream error
inside a run.

| Variable | Required | Meaning |
|---|---|---|
| `JIRA_BASE_URL` | yes | Site root, no trailing slash: `https://acme.atlassian.net` |
| `JIRA_EMAIL` + `JIRA_API_TOKEN` | yes* | Atlassian account email plus an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_BEARER` | yes* | An OAuth access token, instead of the pair above |
| `JIRA_JQL` | yes | The query that decides which issues warren sees at all |
| `JIRA_DONE_TRANSITION` | no | Transition name used to close. Unset picks the first `done`-category one |
| `JIRA_BLOCKED_BY_INWARD` | no | Inward link description for a blocker. Default `is blocked by` |
| `JIRA_SEARCH_PAGE_SIZE` | no | Issues per search page. Default 100 |
| `JIRA_MAX_SEARCH_PAGES` | no | Pagination backstop. Default 50 |
| `TRACKER_PORT` | no | Listen port. Default 8080 |
| `TRACKER_BEARER` | no | The token **warren** must present to this server |

\* Exactly one of the two auth modes. Setting both is refused rather than
resolved by precedence.

`TRACKER_BEARER` and the Jira credential are unrelated. One is what
warren shows this container, the other is what this container shows Jira.

## Run it

```bash
bun install
JIRA_BASE_URL=https://acme.atlassian.net \
JIRA_EMAIL=bot@acme.example \
JIRA_API_TOKEN=... \
JIRA_JQL='project = WAR AND labels = warren' \
bun run start
```

In docker, which builds from this directory alone:

```bash
docker build -t warren-ext-tracker-jira .
docker run --rm -p 8080:8080 \
  -e JIRA_BASE_URL=https://acme.atlassian.net \
  -e JIRA_EMAIL=bot@acme.example \
  -e JIRA_API_TOKEN=... \
  -e JIRA_JQL='project = WAR AND labels = warren' \
  warren-ext-tracker-jira
```

## How each operation maps

| warren-tracker/v1 | Jira |
|---|---|
| `GET /capabilities` | nothing; answered locally, so a boot probe costs no round trip |
| `GET /issues/{key}` | `GET /rest/api/3/issue/{key}?fields=summary,description,status,issuelinks` |
| `GET /issue-statuses` | `GET /rest/api/3/search/jql` over `JIRA_JQL`, every page |
| `POST /issues/{key}/close` | read the issue, then a workflow transition if it is not already terminal |

`status` on the wire is Jira's raw status name. Warren normalizes to its
own three-state vocabulary at its bridge, so this server never guesses.

`description` arrives as an Atlassian Document Format tree on v3 and is
flattened to text. A plain string passes through, which is what v2 and
some proxies return.

`blockedBy` reads the **inward** side of a link (`is blocked by`), which
is the blocker. The outward side is the issue this one blocks, and it is
deliberately not reported.

### Close, and why it reads first

Jira has no close verb, only workflow transitions, and a workflow usually
offers no transition out of a terminal status. So close reads the issue
first: if Jira already considers it terminal (`statusCategory.key` is
`done`), the read is the whole answer and nothing is transitioned.
Closing twice is 200 both times, which the protocol requires.

If the issue is open and the workflow offers no way to a terminal status,
the answer is `409 no_close_transition`. That is a configuration answer
rather than a transient one, and warren does not retry a 4xx.

### Failure mapping

| Jira | This server | Why |
|---|---|---|
| 404 | `404 issue_not_found` | the one reserved protocol code |
| 401 / 403 | `502 upstream_unauthorized` | **this container's** Jira credential was rejected. Passing 401 through would send an operator to warren's bearer, the wrong secret |
| 429 | `429 upstream_rate_limited`, `Retry-After` passed through | warren's bridge already backs off on 429 and honors the header |
| 5xx or unreachable | `502 upstream_error` / `upstream_unreachable` | the tracker answered; the system behind it did not |
| n/a | `400 invalid_issue_id` | the path segment is not valid percent-encoding, so there is no id to look up |

There are no retries in this container. A second, unsynchronized backoff
underneath warren's own would only make the wait harder to predict.

## Scope

**Jira Cloud, REST v3.** Jira Server and Data Center are not covered.
Their search endpoint (`/rest/api/2/search`, offset paginated) and their
auth (a personal access token as a bearer) both differ, and shipping an
untested second path would be a guess wearing a feature's clothes. The
pieces that would need to change are `JiraClient.issueStatuses` and the
API version in the four paths in `src/jira/client.ts`.

## Tests

```bash
bun test
bun run typecheck
```

The interesting one is the protocol suite, which needs a Jira on the
other side. `src/fake-jira.ts` is that Jira: a `fetch`-shaped stub of the
four endpoints this tracker calls, transcribed from Atlassian's
documented v3 response shapes. `bun run dev-server` serves the real
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
warren-tracker/v1 conformance: 7 case groups against http://127.0.0.1:8792
```

followed by the suite's pass line and exit code 0.

**Not verified.** No call has ever reached a real Jira. FakeJira is a
statement of what this tracker EXPECTS Jira to return, not evidence of
what it does return. The first live run against a real site is what
confirms or corrects it, and the places it would show up are narrow: the
ADF shape of `description`, the `issuelinks` inward description on a site
whose admin renamed the link type, and the `nextPageToken` pagination of
`/search/jql`.

## Friction

Four things the protocol left to the server author, in rough order of how
long each took to decide.

1. **A tracker with no close verb.** The idempotent-close rule is the
   right rule and it is the one that took the most thought here, because
   Jira cannot express it directly. A protocol that had modeled close as
   "set the status to X" would not have been implementable at all. Worth
   keeping.
2. **The retry contract is documented from warren's side only.**
   docs/design/issue-tracker.md §5 says warren retries 429 and 5xx and
   does not retry other 4xx. A server author has to read that and infer
   "so a permanent refusal must be a 4xx", which is how
   `no_close_transition` became a 409. Stating it as a rule for servers
   would save the inference.
3. **Nothing says what to do when the server's own upstream rejects
   it.** The protocol covers the bearer warren presents, and 401 is
   documented for that. It says nothing about the other credential, and
   the naive answer, passing the upstream 401 through, points the
   operator at the wrong secret. This one deserves a line in the
   protocol.
4. **`issue_not_found` is the only reserved code**, which is a good
   minimum, but it leaves every other code as a per-server invention.
   Two servers will spell the same failure differently. Not urgent while
   warren maps everything else to one `TrackerError`.

Nothing here required a warren surface that does not exist.
