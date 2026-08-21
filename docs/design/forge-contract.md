# Forge Contract — Design Spike

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-11
**Shipped:** v0.15.0
**Current truth:** `src/forge/contract.ts` and `src/forge/registry.ts`

The Forge campaign (pl-d1c9) closed 19/19. Owner approval was recorded
2026-08-11. The seam is live: GitHubForge (PAT), GitHubApp (installation
tokens), and FakeForge boot-resolve via `WARREN_FORGE`, with the boundary
held by a `check:layers` rule pair.
**Date:** 2026-08-08. **Amended:** 2026-08-11, from an eight-track audit of
HEAD that re-verified every §6 claim and settled the four design questions
the first draft left to house style (§1.1, §2.1, §2.2, §7).
**Companion:** [`ROADMAP.md`](../../ROADMAP.md) Next item 1 — the campaign this seam serves.
Modeled on [`runtime-provider-contract.md`](./runtime-provider-contract.md).
**Grounded in:** a full call-site audit of warren's GitHub and git-credential
surface, 2026-08-08, plus GitHub's App and fine-grained-PAT permission
references read the same day.

---

## 0. The test this contract must pass

The domain must never leak `api.github.com`, a bearer token, the literal
`x-access-token`, an owner/repo pair parsed out of a GitHub URL, a PR number
joined to a `github.com` path, or a check-run id across the seam. If a swap of
the forge forces a change in `src/projects/*`, `src/runs/*`, `src/plan-runs/*`,
`src/triggers/*`, or `src/ci-fixer/*`, the abstraction failed (design bible:
*"if swapping the framework requires rewriting the domain, the domain wasn't
separated"*).

The list above is derived from the live consumers of the boot-resolved
`Forge` instance, audited 2026-08-16, not from memory. `src/projects/`
(`manage.ts`, `url.ts`) routes repo-URL parsing through `forge.parseRepoRef`
at the registration boundary. `src/runs/` and `src/plan-runs/` consume forge
data through dispatch, reap, and the merge gate. `src/triggers/ci-fixer-pass.ts`
and `src/ci-fixer/` invoke check-run methods against the project's forge.
`src/projects/`, `src/triggers/*`, and `src/ci-fixer/*` were absent from the
original list, which is how the pl-d1c9 falsification test (warren-27e3)
surfaced that registration was still GitHub-only.

ROADMAP Next item 1 fixes two falsification tests, and this contract adopts
both without amendment:

1. A FakeForge-owned project registers (`POST /projects` on a forge-owned
   clone URL) and completes dispatch → reap → push → PR with zero domain-code
   changes. Registration is named explicitly: it is domain code that must not
   know which forge owns a URL, and it was the first boundary scenario 40 hit
   (warren-27e3).
2. Acceptance scenario 39, the public-instance leak guard, stays green at every
   commit of the campaign.

Everything below comes from what warren does to GitHub today, not from what the
GitHub API affords. The contract is warren's need. Providers satisfy it.

---

## 1. The interface

```ts
interface Forge {
  readonly capabilities: ForgeCapabilities;

  // Parse a project's clone URL into an opaque, forge-neutral ref.
  // Replaces the five URL grammars audited in §6.3.
  // NEVER throws. A URL this forge does not own returns null, and the
  // registry tries the next forge in its fixed boot order (§1.1).
  parseRepoRef(cloneUrl: string): RepoRef | null;

  // Mint a git-over-HTTPS credential for one operation.
  // The load-bearing method — see §4. Callers invoke it immediately before
  // the git process spawns and MUST NOT hold the result across an await
  // that can outlast `expiresAt`.
  // (GitHubApp: POST /app/installations/:id/access_tokens; GitHubPat:
  // returns the static secret with expiresAt null.)
  gitCredential(ref: RepoRef): Promise<ForgeResult<GitCredential>>;

  // Open a pull request. Idempotent by contract: a forge that reports a
  // duplicate MUST resolve it to the existing PR rather than surface a
  // conflict. GitHub's 422-then-search dance stays inside the provider.
  openPullRequest(ref: RepoRef, req: PullRequestDraft): Promise<ForgeResult<PullRequestRef>>;

  // Find an open PR for a head/base pair. Returns ok with a null value when
  // none exists. A missing PR is not an error.
  findPullRequest(ref: RepoRef, q: PullRequestQuery): Promise<ForgeResult<PullRequestRef | null>>;

  // Read PR lifecycle state. The plan-run merge gate and the merge-watcher
  // are the two consumers. `mergedAt` is required, not optional — the
  // analytics campaign blocks on it (see §7).
  getPullRequest(ref: RepoRef, pr: PullRequestRef): Promise<ForgeResult<PullRequestState>>;

  // Rewrite a PR body. The domain composes the body; the forge only
  // transports it (see §3).
  setPullRequestBody(ref: RepoRef, pr: PullRequestRef, body: string): Promise<ForgeResult<void>>;

  // Read CI state for a commit. Gated by capabilities.checkRuns — a
  // fine-grained PAT cannot reach this API at all (§5, §6.7).
  listChecks(ref: RepoRef, commit: string): Promise<ForgeResult<CheckSummary>>;

  // Tail a failing job's log. Best-effort by contract: a forge that cannot
  // supply logs returns ok with null, not an error.
  fetchJobLogTail(ref: RepoRef, jobId: string, maxBytes: number): Promise<ForgeResult<string | null>>;

  // Delete a branch ref. Used by the acceptance harness only. Present on
  // the contract so FakeForge can satisfy the same cleanup path.
  deleteBranch(ref: RepoRef, branch: string): Promise<ForgeResult<void>>;

  // The identity that authored commits should carry. Authorization and
  // authorship are separate concerns on every forge (§6.8).
  botIdentity(): Promise<ForgeResult<GitIdentity>>;
}
```

Ten methods. `parseRepoRef`, `openPullRequest`, `findPullRequest`,
`getPullRequest`, `setPullRequestBody`, `listChecks`, `fetchJobLogTail`, and
`deleteBranch` are firm — each one replaces a call site that exists today, and
the audit grounds every signature. `gitCredential` is the method whose *shape*
carries the §4 decision. `botIdentity` is the least certain: warren sets the
author identity from env today, and a forge-supplied identity only earns its
place once App mode ships.

There is no `mergePullRequest`. The old one was dead code and is already
deleted. Warren merges through GitHub's auto-merge workflow, not through the
API, and a merge method would give the seam a capability with no caller.

### 1.1 Registry semantics (decided 2026-08-11)

The first draft implied a try-the-next-forge chain without saying how it
squares with the house style's boot-resolved registry (`src/runtime/registry.ts`,
planning record §7: one registry, resolved once, unknown selections fail
loudly). Settled as follows:

- **One registry, resolved once at boot**, exactly like `resolveRuntimeProvider`.
  The kind vocabulary is `FORGE_KINDS = ["github", "app", "fake"]` (the
  `app` arm landed in warren-f8df) with
  `DEFAULT_FORGE_KIND = "github"`. `WARREN_FORGE` selects; blank means the
  default; anything else throws `UnknownForgeError` at boot. No silent
  fallback, no plugin discovery.
- **`parseRepoRef` chaining operates over the boot-registered forges in
  their fixed registration order**, and only there. It is how the registry
  routes a clone URL to the forge that owns it — not a runtime discovery
  mechanism. With one real forge registered, the chain has length one.
- **FakeForge is production code under `src/forge/fake/`**, selected by
  `WARREN_FORGE=fake`. It must not live in a `test-helpers` file: the layer
  and wire gates exempt test paths, so a fake there would be invisible to
  the very rule phase 2 exists to prove. FakeForge subsumed and deleted the
  old GitHub-fetch-override env hack (acceptance scenarios 26 and 36
  migrated onto it in warren-2600).
- Boot and registry failures **throw** (`UnknownForgeError` extending
  `WarrenError`, mirroring `UnknownRuntimeError`). Seam methods never throw;
  they return `ForgeResult` (§2.2).

---

## 2. Types

```ts
// Opaque handle — the domain compares and passes these, and reads nothing
// out of them. A GitHubForge packs owner/repo/host; FakeForge packs a
// directory path. NOTHING outside the provider destructures a RepoRef.
interface RepoRef {
  readonly forge: string;  // registry key: "github" | "fake"
  readonly key: string;    // provider-private, stable, safe to log
}

// Opaque PR handle. `key` is provider-private. `webUrl` exists ONLY so the
// UI and PR bodies can render a link, and no code parses it.
interface PullRequestRef {
  readonly forge: string;
  readonly key: string;
  readonly number: number;   // display + tracker cross-reference
  readonly webUrl: string;
}

// A credential valid for ONE git operation. See §4.
// `username` is provider-chosen: GitHub Apps use "x-access-token", and no
// domain code ever names that string.
interface GitCredential {
  readonly username: string;
  readonly secret: string;
  readonly expiresAt: number | null;  // epoch ms; null = no known expiry (PAT)
}

// Provider-neutral INTENT. The domain composes title and body, including the
// 64KB clamp, and hands over finished text (see §3).
interface PullRequestDraft {
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  draft?: boolean;
}

interface PullRequestQuery {
  headBranch: string;
  baseBranch: string;
  state?: "open" | "closed" | "all";  // default "open"
}

// Lifecycle vocabulary. These names belong in src/core/wire.ts, because the
// UI and the SDK both render them (AGENTS.md, "The wire vocabulary").
type PullRequestLifecycle = "open" | "merged" | "closed_unmerged";

interface PullRequestState {
  lifecycle: PullRequestLifecycle;
  mergedAt: number | null;   // epoch ms — required for the merge-watcher
  headCommit: string;
  baseBranch: string;
}

// CI rollup. `conclusion` is the domain's decision input; `runs` carries
// enough detail for the CI-fixer prompt and nothing more.
interface CheckSummary {
  conclusion: "pending" | "passing" | "failing" | "unknown";
  runs: CheckRun[];
}

interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  jobId: string | null;      // feeds fetchJobLogTail; opaque
  detailsUrl: string | null;
}

interface GitIdentity { name: string; email: string; }

// ONE result shape for the whole seam. Warren has three today (§6.4).
type ForgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ForgeError };

interface ForgeError {
  kind: ForgeErrorKind;
  status?: number;         // transport status, for logs only
  retryAfterMs?: number;   // set on rate_limited when the forge knows
  detail: string;          // redacted, safe to persist on a run row
}

// The taxonomy the domain switches on. Every arm has a live call site.
type ForgeErrorKind =
  | "no_credential"    // nothing configured — the domain skips the step
  | "unauthorized"     // 401: expired or wrong credential
  | "forbidden"        // 403 that is not a rate limit
  | "not_found"        // 404/410: fatal for a merge gate (see merge-gate.ts)
  | "conflict"         // 409/422 the provider could not resolve
  | "rate_limited"     // 403/429 with rate-limit semantics
  | "push_protected"   // secret-scanning block; detail carries the unblock URL
  | "unsupported"      // this forge/credential mode cannot do this (§5)
  | "network"          // no HTTP response
  | "http_error";      // everything else

interface ForgeCapabilities {
  checkRuns: boolean;                              // GitHubPat: FALSE (§6.7)
  jobLogs: boolean;                                // log tail available
  pullRequestBodyEdit: boolean;                    // preview annotation
  branchDelete: boolean;                           // acceptance cleanup
  botIdentity: boolean;                            // forge names its bot
  credentialLifetime: "static" | "short-lived";    // drives the §4 re-mint
}
```

### 2.1 Wire-vocabulary mechanics (decided 2026-08-11)

`PullRequestLifecycle` lands in `src/core/wire.ts` in the house shape —
tuple, type, guard (`PULL_REQUEST_LIFECYCLES` as const, the derived union,
`isPullRequestLifecycle`) — not as the bare type alias sketched above.
Every arm of `ForgeErrorKind` that lands in the canonical home gets the
`RUN_FAILURE_REASONS`-style doc block: one paragraph per arm naming its
detection site and what it is distinct from.

`scripts/check-wire-types.ts` gains the stems `pull` and `forge`. Not `pr`:
stem matching is substring-based, and `pr` would silently widen enforcement
over `Provider`, `Preview`, `Priority`, and `Project`. One known collision:
`CheckRun` already matches the `run` stem, and `src/ci-fixer/check-runs.ts`
declares a local `CheckRun` today — the moment the canonical name lands, the
ci-fixer copy must become a re-export (phase 3 carries that edit). UI label
maps in `src/ui/src/lib/labels.ts` and the `src/ui/tsconfig.app.json`
include list follow as usual.

### 2.2 One result shape, and where throwing is still right (decided 2026-08-11)

`RuntimeProvider` — this contract's declared model — throws typed
`WarrenError` subclasses with a code→HTTP-status table
(`src/runtime/errors.ts`). The forge seam deliberately does not copy that:
`ForgeResult<T>` is the convention of the exact code being replaced
(`OpenPullRequestResult`, `CheckPrMergedResult`, `FetchCheckRunsResult` are
all result unions today), and §6.4's three-taxonomies problem is a
result-shape problem. The split is:

- **Seam methods return `ForgeResult<T>` and never throw.** The domain
  switches on `ForgeErrorKind`; nothing catches across the seam.
- **Boot-time failures throw** — `UnknownForgeError` and provider
  construction errors, mirroring the runtime registry.
- A small `FORGE_ERROR_HTTP_STATUS` table (modeled on
  `RUNTIME_BACKEND_STATUS_BY_CODE`) lets `src/server/errors.ts` render a
  `ForgeError` into a neutral envelope without importing provider classes.

---

## 3. What stays in the DOMAIN — the anti-leak guardrail

The temptation with a forge seam is to push work across it because the work
touches a PR. The line is that the forge owns *transport and credentials*, and
the domain owns *meaning*.

- **PR body composition stays in `src/runs/pr-template.ts`.** The 64KB clamp
  lives in `composeBody`, never in the provider. A clamp inside
  `openPullRequest` would conflict with this relocation; PR #805 and record
  mx-026320 already settled the placement for that reason. (The first draft
  cited warren-8ec1 here — that id does not exist; the citation was a
  phantom.) One hole the audit found: `annotatePrPreview` PATCHes a body it
  never re-clamps, so a near-limit body plus a failure tail 422s today. The
  fix is a domain fix — the annotate path re-clamps before calling
  `setPullRequestBody` — and it rides phase 3.
- **Issue-close-on-merge stays domain orchestration.** `Forge` owns the
  branch's fate. `IssueTracker` owns the work item. Neither seam calls the
  other (ROADMAP, Decisions already made).
- **Semantic retry stays in the domain. Transport retry moves to the forge.**
  A 429 with a `Retry-After` is transport, and the provider absorbs it. A
  merge gate that waits an hour for a human to press merge is meaning, and
  `src/plan-runs/merge-gate.ts` keeps it. This replaces three unshared retry
  policies with one of each kind (§6.5).
- **Run and plan-run state machines stay in the domain.** The forge reports
  `PullRequestLifecycle`. The domain decides what a merged PR means for the
  next child.
- **Redaction stays in the domain.** `src/observability/log-redact.ts` and the
  event-projection scrubber keep working on whatever the forge returns. A
  provider that redacts is welcome. A domain that trusts it is not.

**The kernel-boundary question stays open, deliberately.** PHILOSOPHY says the
kernel's guaranteed output is a pushed branch, and that opening a PR is
extension behavior. This contract puts `gitCredential` (kernel) and
`openPullRequest` (post-kernel) behind one seam anyway, because both need the
same credential and splitting them now would mint the credential twice.
`extensions.md` §5 parks forge extensions for the same reason. Keeping the two
together gives a future bridge one attachment point instead of two.

---

## 4. The load-bearing decision: credentials are minted, never held

**The problem the ROADMAP names but no design has answered.** Every GitHub
credential in warren today is a static string captured once at boot.
`loadAutoOpenPrConfigFromEnv` reads `GITHUB_TOKEN` at
`src/server/main/index.ts:169` and fans it by value into the scheduler, the
plan-run coordinator, and roughly ten handlers. An installation token expires
one hour after minting, and an expired token returns 401 with no grace period.
The worst offender is `createPrMergeChecker`: a multi-hour plan-run holds one
token across every poll — and its retry policy treats 401/403 as
keep-waiting, not fatal (`src/plan-runs/pr-merge.ts`), so under App mode an
expired hourly token would silently stall the plan until the merge-wait
budget expires rather than failing loudly. A static token threaded through
66 files cannot express hourly expiry, which is exactly why the App pays for
the campaign.

**Rejected: `Forge.token: string`, refreshed by a background timer.** The type
invites capture. Every call site that copies the string into a config object
re-creates today's bug, and no gate can catch it.

**Rejected: a global git credential helper.** The supervisor used to write an
`insteadOf` rewrite into `$HOME/.gitconfig` once at boot (deleted in phase 5,
warren-5497). That mechanism had no refresh point, and it was a no-op under
`WARREN_RUNTIME=k8s`, where no supervisor runs.
A helper would also have to shell back into warren from inside a pod.

**DECIDED (2026-08-08): `gitCredential(ref)` returns a value with an
expiry, and callers re-mint per operation.** Three consequences the campaign
must carry:

1. **No configuration object holds a token.** `AutoOpenPrConfig.token` and
   `.gitToken` are deleted (phase 5, warren-5497); callers reach the `Forge`
   handle instead. The value moves from data to a call.
2. **Mint immediately before the git process spawns, not once per run.**
   `githubCredentialGitEnv` (`src/workspace/git/credential-env.ts`) is already
   the right shape — it renders the rewrite as per-spawn `GIT_CONFIG_*` env,
   so the secret never reaches argv and `origin` stays clean. That per-spawn
   boundary becomes the re-mint boundary.
3. **A capability flag, not a conditional.** `credentialLifetime` tells the
   domain whether re-minting is free or pointless. PAT mode reports `static`
   and the domain skips the re-mint path.

**Provider split:**

- **GitHubApp:** signs an RS256 JWT from the deployment's private key, calls
  `POST /app/installations/:id/access_tokens`, and MAY down-scope the mint to
  the single repository and the minimum permission set. It caches a token
  until `expiresAt` minus a safety margin, then re-mints. Shipped as
  `GitHubAppForge` (warren-f8df), selected by `WARREN_FORGE=app` and
  configured by `WARREN_GITHUB_APP_ID` / `WARREN_GITHUB_APP_INSTALLATION_ID`
  / `WARREN_GITHUB_APP_PRIVATE_KEY`; the shipped margin is five minutes and
  the mint is not down-scoped — the single installation id bounds it.
- **GitHubPat:** returns the configured secret with `expiresAt: null` and
  reports `credentialLifetime: "static"`.

### 4.1 The run that outlives its token

An agent run can exceed one hour, and the K8s path mounts `WARREN_GIT_TOKEN`
into a pod at creation. GitHub documents no refresh recipe for a git operation
that spans an expiry, so warren owns the loop. Three windows exist, and each
gets its own mint:

1. **Init-container clone** — mint at pod-spec time. Short window, low risk.
   Closed in warren-c9ac: `K8sProvider.create` mints a fresh credential through
   the boot-wired `mintGitCredential` seam (`mintGitCredentialSecret` over the
   resolved forge) and injects it as a plain `WARREN_GIT_TOKEN` env value,
   which `buildInitEnv` prefers over the static `warren-git-token` Secret ref —
   under App mode the pod never references the long-lived Secret.
2. **Finalize push** — mint after the agent exits. The *pod* side was already
   refresh-ready (the credential rides the intent over the authenticated
   callback), but the *control-plane* side was not: an earlier revision of
   this section claimed the whole window was refresh-ready, while
   `K8sProvider.finalize` still fell back to the static
   `WARREN_GIT_TOKEN` / `GITHUB_TOKEN` env — under App mode exactly the
   hourly-expiring credential this campaign eliminates. Closed in warren-c9ac:
   `resolveK8sPushToken` (`src/runtime/k8s/git-tokens.ts`) prefers the
   per-spawn minted `intent.gitToken` and gates the static env fallback on
   `allowStaticPushTokenFallback`, which boot wires off when the forge reports
   `credentialLifetime: "short-lived"`. An App-mode run never depends on the
   static fallback; a missing mint fails the push closed.
3. **Reap-side fetch and PR open** — mint in the reap process, per step.

**DECIDED (2026-08-12, warren-c9ac): the Secret-mounted fallback routes
through the authenticated callback.** The remaining hazard was the fallback at
`src/runtime/k8s/finalize-entrypoint.ts:145` and the salvage push, both
reading a long-lived Secret. `finalize-entrypoint` runs inside the pod and
cannot hold an App private key, so the pod asks the control plane instead:
`POST /runs/:id/git-credential` mints a fresh credential off the boot-resolved
forge over the same run-scoped-token channel the intent poll already uses, and
the salvage window (`salvage-post.ts`) tries that mint before falling back to
the pod-carried env token. The static Secret value remains only as the
PAT-mode last resort for an unreachable control plane (a rollout is exactly
the `no_intent` case). The rejected alternative — a documented static-Secret
PAT-only degradation as the primary path — is retired.

---

## 5. Capability degradations the domain must handle

Every declared flag gets a stated fallback. `unsupported` is the error kind a
provider returns when the domain calls past a false flag.

| Capability | GitHubApp | GitHubPat | FakeForge | Domain behavior when absent |
| --- | --- | --- | --- | --- |
| `checkRuns` | yes | **no** | yes | CI-fixer poller stays idle and logs one notice per project. No run dispatches. |
| `jobLogs` | yes | yes | synthetic | CI-fixer prompt omits the log tail and says so. |
| `pullRequestBodyEdit` | yes | yes | yes | Preview annotation sub-step reports `skipped`, and the reap continues. |
| `branchDelete` | yes | yes | yes | Acceptance cleanup logs and moves on. Never fails a scenario. |
| `botIdentity` | yes | no | yes | Fall back to `WARREN_GIT_AUTHOR_*`, which is today's only source. |
| `credentialLifetime` | `short-lived` | `static` | `static` | Re-mint path skipped when static. |

**`checkRuns` is the one that hurts, and it is not a warren limitation.** A
fine-grained personal access token cannot call the Checks API. GitHub's own
limitations list names it, and the fine-grained permission reference has no
Checks section at all. The fallback, `GET /repos/:o/:r/commits/:ref/status`, is
blind to GitHub Actions, because Actions reports as check runs and not as
statuses.

This is the strongest argument in the whole design for the capability-flag
house style over a boolean conditional. ROADMAP holds that PAT mode is a
permanent peer and never a legacy path. That claim survives only if the domain
reads a flag and degrades. It does not survive a `hasApp` check scattered
through the CI-fixer.

---

## 6. Corrections this contract bakes in (from ground truth)

The 2026-07-29 planning record sized this campaign from a partial audit. The
2026-08-08 call-site audit corrects it. Every number below is a file-and-line
count, not an estimate.

1. **Four GitHub REST clients, not three.** `src/runs/pr-checks.ts` (with
   `pr.ts` re-exporting it), `src/runs/pr-annotate.ts`, `src/ci-fixer/check-runs.ts`,
   and `scripts/acceptance/scenarios/35-ci-fixer-roundtrip.ts`. Each carries its
   own `GITHUB_API_BASE`, `USER_AGENT`, `buildHeaders`, `readJson`, `readText`,
   and `truncate` — but the copies have drifted, so consolidation is a
   reconciliation, not a mechanical merge: `check-runs.ts` omits
   `content-type` from its headers, only `pr-checks.ts` carries a
   `Retry-After` parser, and scenario 35 has an inline header literal and no
   readers at all.
2. **Sixty-six non-test files touch GitHub or git-host credentials**, not
   thirty. One hundred and twenty-seven with tests. The earlier count caught the
   core logic and missed the token threading through `src/server/handlers/*`,
   `src/runtime/k8s/*`, and `scripts/acceptance/*`.
3. **Five URL grammars with three failure conventions, not three with two.**
   `src/projects/url.ts:31` throws and hard-rejects any host other than
   `github.com`. `src/runs/pr-checks.ts:174` returns null and accepts web URLs
   only (query/fragment tolerated, `https` only). `src/runs/pr-annotate.ts:146`
   returns null and accepts API URLs too (`http` allowed, no query
   tolerance). Scenario 35 adds two more: `parseRepoSlug` throws
   `AcceptanceError`, and a bare `/\/pull\/(\d+)/` extraction. The grammars
   disagree in practice: `https://github.com/o/r/pull/7?diff=split` parses
   in pr-checks — the merge poller and CI-fixer act on it — but returns
   `bad_url` in pr-annotate, so preview annotation silently skips the same
   PR.
4. **Three error taxonomies for the same endpoint.** `GET /pulls/:n` is called
   from three places. One classifies 429, one does not, and one handles nothing.
5. **Four unshared retry policies, and two disagree in direction.**
   `src/plan-runs/pr-merge.ts` (note the path — not `src/runs/`) retries
   twice at 500ms, honors `Retry-After`, and treats network/0/5xx/429 as
   transient but 4xx as fatal. `src/runs/reap/pr-open.ts` uses 1s, 2s, 4s
   and does the inverse: it retries any `http_error` including 4xx but
   never retries `network`. The CI-fixer poller has no retry at all, and
   neither does `pr-annotate.ts` — on the same `GET /pulls/:n` that
   pr-merge retries.
6. **Four git-credential mechanisms, and one of them supplies no credential.**
   The four: the supervisor's global `insteadOf` rewrite (deleted in phase 5,
   warren-5497), the per-spawn `GIT_CONFIG_*`
   env (`src/workspace/git/credential-env.ts:34`, three callers), the
   URL-embedded userinfo of `authenticatedCloneUrl`
   (`src/workspace/git/clone-url.ts:25`, four callers across K8s and reap),
   and no-credential-at-all: `clone-apply.ts:191`, `salvage.ts:69`, and
   `local/finalize.ts:401` push while relying on the supervisor's global
   rewrite, so they break under K8s today. The literal
   `x-access-token@github.com` is hardcoded in three places.
7. **A fine-grained PAT cannot read check runs.** Confirmed against GitHub's
   limitations list and against the absence of a Checks section in the
   fine-grained permission reference. This drives §5.
8. **The token authorizes. It does not name the author.** Nothing in GitHub's
   documentation sets a commit author from an installation token. Local git
   config decides authorship, which is what `bundle-size-autoheal.yml` already
   encodes by hand. Git-pushed bot commits also never show as verified.
9. **Installation tokens are no longer a fixed 40 characters.** GitHub began a
   staged rollout of a stateless `ghs_APPID_JWT` format in April 2026. Warren
   holds no length assumption today, and the campaign must not add one.
10. **`mergePullRequest` is already gone.** The planning record's "delete, do
    not wrap" instruction is done, and no merge method belongs on the contract.
11. **`WARREN_GITHUB_TOKEN` does not exist.** The live variables are
    `GITHUB_TOKEN` and `WARREN_GIT_TOKEN`, with the second falling back to the
    first.
12. **Warren already mints App installation tokens for its own CI.** PR #818
    replaced `AUTO_MERGE_PAT` with `actions/create-github-app-token`, storing the
    App id in a repo variable and the private key in a secret. That work also
    supplies the campaign's liveness lesson: a dead static credential failed
    silently for a day, so the App mode needs a heartbeat probe. As of
    2026-08-11 the App (id 4523930) is installed on the repo and proven
    end-to-end: green `app-heartbeat`, first App-token auto-merge on PR #821.
13. **`findExistingPr` cannot see cross-fork duplicates.** The 422-recovery
    search hardcodes `head: ${owner}:${head}` (`src/runs/pr.ts:164`), so a
    duplicate PR whose head lives on a fork is never found and the open
    degrades to an opaque `http_error`. The provider's idempotent
    `openPullRequest` must not inherit this assumption.
14. **The acceptance harness never passes `GITHUB_TOKEN` into the warren it
    boots.** `bootInProc` composes the child env from an allowlist
    (`scripts/acceptance/lib/inproc.ts:247`) that does not include
    `GITHUB_TOKEN`, and the runner's `extraEnv` adds only stub knobs. So
    even an operator who exports `GITHUB_TOKEN` boots a warren whose
    auto-open-PR config is empty — scenario 35's opener assertion cannot
    pass in in-proc mode as written. CI has never noticed because it
    provisions neither of the scenario's secrets, so it always records
    `skipped`. The fix rides plan pl-d1c9 child warren-2740. The
    credential story must state, per scenario, which side owns the token.

---

## 7. Next step

The campaign runs in five phases, and the first two carry almost all the risk
reduction for almost none of the behavior change.

1. **Consolidate.** Collapse the four clients into `src/forge/github/` —
   a directory, not a file: the naive union of the four already exceeds the
   500-line budget, so the tree arrives decomposed (http core, error
   classifier, retry policy as separate modules). One header builder, one
   reader set, one retry policy, one `ForgeError` taxonomy. No contract
   yet, no behavior change. Article II applies: nothing is grandfathered at
   birth, and the tests land in the same PR — the coverage ratchet
   (91.85% lines) does not fund an untested tree. The consolidated client
   keeps the injected-`fetch` convention the four clients already share,
   and the shared `recordingFetch` test helper is promoted with it.
2. **Cut the contract.** Land `Forge`, `ForgeCapabilities`, the registry
   (§1.1), and `FakeForge` as implementation #2 in the same PR as the
   `check:layers` rule pair — a `forbidPattern` rule on the
   `api.github.com` literal and a `forbidImports` twin, modeled on the
   burrow boundary pair — that fails direct GitHub access outside
   `src/forge/`. PHILOSOPHY rule 4 holds that a seam is not done until a
   gate enforces it. Note `check:layers` walks `src` and `extensions` only:
   scenario 35 must migrate onto the seam or `WALK_ROOTS` must widen, but
   the literal in `scripts/` cannot be left silently unenforced.
3. **Migrate the call sites.** Move the wire vocabulary into `src/core/wire.ts`
   (per §2.1, including the `CheckRun` re-export fix in the CI-fixer),
   thread `Forge` through the reap pipeline, the plan-run coordinator, and
   the CI-fixer. The `checkRuns: false` degradation needs a new CI-fixer
   skip reason plus a once-per-project notice — today an unsupported forge
   is indistinguishable from a network blip. Article VI applies: this phase
   moves files that Dockerfile entrypoints, workflow YAML, and supervisor
   spawn paths reference, and green gates are not a working deployment.
4. **Ship the credential story.** `GitHubApp` and `GitHubPat` as peers, the §4
   re-mint boundary, the manifest registration flow, and a heartbeat probe.
5. **Delete the old paths.** Remove the supervisor's global rewrite and drop
   the static-token config fields. (The three no-credential push sites were
   already closed in phase 4, warren-4e1c.)

**The four phase-4 questions, answered empirically (2026-08-11).** The spike
ran against a throwaway App (id 4560297) and a scratch repo, per seed
warren-bc4c. GitHub documents none of these, so each answer carries its
observed evidence:

- **Q1 — loopback `redirect_url`: YES.** A manifest with
  `redirect_url: http://127.0.0.1:8377/callback` was accepted. After "Create
  GitHub App" the browser landed on the loopback with `?code=…&state=…`, and
  the state round-tripped intact. Self-hosted registration behind NAT works.
  *Amended 2026-08-13:* the round-trip holds only for `state` passed as a
  query parameter on the create URL (`/settings/apps/new?state=…`). A
  `state` key INSIDE the manifest JSON is refused by the live create page
  (`"state" is not a permitted key` — the manifest schema is closed), which
  the first real registration against app.warren.run hit; fixed in
  `0deb9511`.
- **Q2 — conversion auth: NONE, and the code is single-use.**
  `POST /app-manifests/{code}/conversions` with no Authorization header
  returned 201 with the full credential set: id, slug, pem, client id and
  secret. The identical second call returned 404. The registration flow has
  no credential chicken-and-egg.
- **Q3 — fine-grained PAT reaches merge: YES.** `PUT /pulls/:n/merge` with a
  fine-grained PAT returned 200 `merged: true`, and
  `X-Accepted-GitHub-Permissions: contents=write` — the merge endpoint
  demands only contents write, not pull-requests write.
- **Q4 — an App approving its own PR: NO.** The App-authored PR refused the
  App's own approval: 422, "Review Can not approve your own pull request."
  Any future auto-approve flow needs a second credential.

Two bonus observations from the same spike. A live installation token
arrived in the stateless `ghs_` format at 383 characters, so §6.9's
no-length-assumption rule is already load-bearing. And the App installation
token read `GET /commits/:ref/check-runs` with 200 — the §6.7 Checks
asymmetry confirmed from the App side.

**One thing this document does not decide.** Whether forges eventually follow
trackers through the bridge stays parked (§3, `extensions.md` §5). The K8s
Secret-fallback question is RESOLVED (§4.1, warren-c9ac): the pod re-mints
over the authenticated callback; the static Secret is the PAT-mode last
resort only.

**The go/no-go: decided.** ROADMAP Next item 1 held that implementation
starts on an explicit owner decision; the owner recorded **GO on
2026-08-11**, after an eight-track audit of HEAD re-verified this document's
§6 ground truth (the corrected file count held at 66, and the PAT Checks gap
stands). The campaign's work queue is seeds plan pl-d1c9, created the same
day: nineteen forward-chained children under umbrella seed warren-3fe7.

**Downstream consumer.** The analytics campaign blocks on this seam by the
2026-08-08 decision, and its merge-watcher is the first non-plan-run consumer
of `getPullRequest`. `PullRequestState.mergedAt` exists for it, and the field
is required rather than optional for that reason.
