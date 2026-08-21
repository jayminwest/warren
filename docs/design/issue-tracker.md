# IssueTracker Contract — Design Record

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-20
**Shipped:** v0.18.0
**Current truth:** `src/tracker/contract.ts`, `src/tracker/seeds-tracker.ts`, and `src/tracker/remote/`

Track B of plan pl-a37b (seed warren-bc61) closed. The seam is live:
`SeedsTracker` (implementation #1, in-core) and `RemoteTracker`
(implementation #2, the bridge to external containers speaking
`warren-tracker/v1`) boot-resolve per project from `.warren/config.yaml`.
The wire protocol stays **EXPERIMENTAL** until a foreign implementation
survives the conformance suite unchanged (PHILOSOPHY rule 4).
**Date:** 2026-08-20 (retrospective record; the code landed as seeds
warren-6c29, warren-5819, warren-2d98, warren-47b0, warren-6234,
warren-de42, warren-d3a9, warren-53ea).
**Companion:** [`ROADMAP.md`](../../ROADMAP.md) — "Issue tracker" seam
row, and the 2026-08-04 / 2026-08-18 decisions under "Decisions already
made". Modeled on [`forge-contract.md`](./forge-contract.md).

---

## 0. The test this contract must pass

No domain module may name seeds, `sd`, `.seeds/`, or a seeds CLI
envelope. If swapping the tracker forces a change in `src/runs/`,
`src/plan-runs/`, `src/triggers/`, or `src/server/handlers/`, the
abstraction failed. The one sanctioned remnant of the old fusion is the
`src/seeds-cli/` facade, which lives *behind* `SeedsTracker` as an
implementation detail.

The falsification test is conformance, not inspection: a server that
survives the published suite
(`extensions/tracker-conformance/`) conforms, whatever its internals.
Warren's own bridge is held to the same suite.

## 1. The interface

`src/tracker/contract.ts` declares the behavior surface; the neutral
DTOs live in `src/core/wire-tracker.ts` (re-exported through
`src/core/wire.ts`, guarded by `check:wire-types` under the tracker
stems).

```ts
interface IssueTracker {
  readonly capabilities: TrackerCapabilities;
  getIssue(ctx, issueId): Promise<Issue>;          // throws IssueNotFoundError on a missing id
  listIssueStatuses(ctx): Promise<Map<string, IssueStatus>>;
  closeIssue(ctx, issueId): Promise<void>;         // idempotent
}

interface TrackerCapabilities {
  readonly supportsPlans: boolean;
  readonly supportsMetadata: boolean;
  readonly supportsScheduledIssues: boolean;
  readonly isGitNative: boolean;
}
```

Three capability interfaces extend the base — `PlanCapableTracker`
(`listPlans` / `getPlan`), `MetadataCapableTracker`
(`mergeIssueMetadata`), `ScheduledIssueCapableTracker`
(`listScheduledIssues`). Callers branch on the flags, never on the
implementation class, so a tracker that lacks a capability fails loudly
("tracker does not support plans") instead of silently no-op-ing.

**Metadata merge semantics ARE the contract** (taken from seeds,
implementation #1): shallow merge — only keys present in the payload are
touched — and an explicit `null` clears a key. Implementations may
restrict the writable key set; a payload outside it fails with a
`TrackerError`.

**`TrackerContext`** carries `projectId` (the warren project id) plus an
optional `localPath` (the host clone root). `localPath` is meaningful
only to git-native trackers — seeds resolves `.seeds/` relative to cwd —
so it stays optional and a hosted tracker ignores it. `SeedsTracker`
treats its absence as a caller programming error.

**Error taxonomy:** every failure surfaces as a `TrackerError`
(`tracker_error`) or its subclass `IssueNotFoundError`
(`issue_not_found`) — the one reserved discriminator. A missing *plan*
id is deliberately a plain `TrackerError`, not `IssueNotFoundError`:
the contract reserves not-found semantics for `getIssue`, where callers
fail terminally instead of retrying a transient shell-out.

**Status normalization:** warren compares "is this issue closed?" and
nothing finer, so `IssueStatus` is `open | closed | other`, and raw
tracker statuses normalize at the implementation boundary
(`normalizeIssueStatus`). The bridge never asks a server to understand
warren's three-state vocabulary.

## 2. SeedsTracker — implementation #1

`src/tracker/seeds-tracker.ts` wraps the existing `src/seeds-cli/`
facade 1:1 — no new shell-outs, no changed envelope parsing:

| Contract | Facade |
|---|---|
| `getIssue` | `showSeed` (stderr not-found sniff stays in the facade) |
| `listIssueStatuses` | `listSeedStatuses` |
| `closeIssue` | `closeSeed` (idempotent in seeds) |
| `listPlans` / `getPlan` | `listPlans` / `showPlan` |
| `mergeIssueMetadata` | `updateExtensions` (warren-namespaced keys only) |
| `listScheduledIssues` | `listScheduledSeeds` |

All four capabilities are `true`. Facade `SeedNotFoundError` maps to
`IssueNotFoundError`; every other `SeedsCliError` maps to `TrackerError`
carrying the original as `cause` plus its recovery hint, so operators
keep the copy-paste diagnose command.

## 3. The `isGitNative` fence

Seeds' state lives in the project's git checkout; a hosted tracker's
state lives behind its API. Callers that need *clone-shaped* tracker
state are fenced behind `capabilities.isGitNative`:

- **close-child-seed git plumbing**
  (`src/plan-runs/close-child-seed.ts`): for a git-native tracker,
  merged-child closure authors a `chore(warren)` bot commit on a
  throwaway worktree and pushes it to the default branch. For a
  non-git-native tracker the whole module collapses to a single
  `tracker.closeIssue` call — no clone, no commit.
- **auto-plan-run** (`src/runs/reap/auto-plan-run.ts`): requires
  `isGitNative && supportsPlans` — re-dispatching a plan on merge
  reads plan state off the clone.
- **pre-walk clone refresh** (`src/plan-runs/create.ts`): only a
  git-native tracker benefits from refreshing the host clone before the
  walk; a remote tracker answers from its own host. (This is where
  ROADMAP predicted `refreshProjectFn` dies; it stays for
  `POST /projects/:id/refresh`, which is about the clone, not the
  tracker.)
- **`ProjectLacksTrackerError`** gate: a git-native tracker without
  `.seeds/` in the clone is a misconfigured project and plan-runs are
  refused; a remote tracker is never gated on clone contents.
- **tracker-neutral builtin prompts**
  (`src/runs/spawn/prompt-capabilities.ts`,
  `src/registry/prompt-gating.ts`): the `sd`/`ml`/`.seeds`/`.mulch`/
  quality-gate prompt fragments gate on
  `hasSeeds && isGitNative`, so a foreign repo with no `.seeds/` gets
  no false tooling assertions. A mirror of an external repo runs
  tracker-clean without editing agent definitions.

## 4. Ordered-issue-list plan-runs

The 2026-08-04 decision (warren-de42): `POST /plan-runs` accepts
either `planId` (requires a `supportsPlans` tracker, walks the plan) or
`issues: [id, ...]` — an explicit ordered list that any tracker with
the base contract can drive. `getPlan` is skipped entirely; each id is
validated via `tracker.getIssue` and the child sequence is synthesized
in list order with the same PR-merge gating. A tracker that cannot
group issues into plans still gets serial agent execution over a work
queue.

## 5. RemoteTracker — the bridge (implementation #2)

`src/tracker/remote/` speaks `warren-tracker/v1` to an external tracker
container over HTTP. Per-project activation is a `tracker` block in
`.warren/config.yaml`:

```yaml
tracker:
  url: http://tracker:8080
  tokenEnv: WARREN_TRACKER_BEARER   # optional
```

**Credential posture (blocker B1, dissolved):** the extension container
holds its own tracker credential (a GitHub token, a Linear key, …);
warren stores none. `tokenEnv` NAMES an environment variable — the
bearer is read from the operator's environment at build time and held
only in memory. A `tokenEnv` whose variable is unset fails loud at
boot: silently calling the container unauthenticated would surface as a
confusing 401 three layers away.

**Versioning:** capability discovery is `GET /capabilities`, which must
report `protocolVersion: "warren-tracker/v1"`. Negotiation is explicit
and boot-time — `RemoteTracker.connect()` runs once at wiring time, a
mismatch fails loud there, and every operation on an unconnected
tracker throws. Capabilities come from the remote, so a tracker without
plans fails with "tracker does not support plans" instead of a 404
shaped like a transient error.

**Endpoints:** `GET /issues/{id}`, `GET /issue-statuses`,
`POST /issues/{id}/close` (idempotent — closing twice is 2xx both
times), plus optional surfaces that exist only when the corresponding
flag is `true`: `GET /plans` + `GET /plans/{id}`,
`POST /issues/{id}/metadata`, `GET /scheduled-issues`. Every response
body is JSON; timestamps cross the wire as ISO-8601 and the bridge
converts to `Date`.

**Error taxonomy:** any non-2xx response carries
`{ error: { code, message } }`. `issue_not_found` is the one reserved
code; warren maps it to `IssueNotFoundError` and everything else to
`TrackerError`. A server MAY reject the bearer with 401; warren
surfaces that as a `TrackerError`.

**Caching and backoff (re-derived blockers B3/B4, bridge-side):** reads
are cached per `(projectId, operation, argument)` for a TTL (default
15s) so the ready-plans N+1 does not hammer the container; writes
invalidate the whole project's cache. 429/5xx and network failures
retry with exponential backoff honoring `Retry-After`, then surface as
`TrackerError`; other 4xx do not retry — they are the server's
considered answer.

**The sandbox stays `network: none` (B6):** agents never talk to the
tracker directly. Every tracker call proxies through warren, which
forwards to the container — the same posture as the forge.

## 6. The conformance suite

`extensions/tracker-conformance/` is the falsification test: a
standalone package (`@warren-ext/tracker-conformance`) a foreign
implementation runs against its own server — `bun run check <url>`. It
holds a server to protocol-version negotiation, the base contract
(especially idempotent close), the not-found taxonomy, and the optional
surfaces gated on declared capabilities, including the shallow-merge /
null-clears metadata semantics. FakeTracker, the in-memory reference
server (`src/fake-tracker/`, also vendored as an acceptance lib), seeds
from a JSON fixture and mirrors mutations to a state file so a harness
can assert what the tracker observed. In-core,
`src/tracker/conformance-parity.test.ts` pins the published protocol
copy to the canonical one.

Blocker B5 became this suite: a conformance suite, not a grep, proves
an implementation.

## 7. Public projection (B2)

Stated as the contract-time owner decision: **tracker data stays off
the public projection.** The read-only spectator surface
(`WARREN_AUTH=public`) serves warren's own runtime state only; issues,
plans, and tracker metadata never cross it. Acceptance scenario 39
remains the leak guard.

## 8. Status and what comes next

The TypeScript contract and the SeedsTracker path are done and dogfooded.
The wire protocol is versioned, documented, and exercised by the suite
against FakeTracker — but per the 2026-08-04 decision it is
**experimental until a foreign implementation survives it unchanged**.
Linear ships as the first external tracker extension in v0.19, on its
own release track; Jira, GitLab, and GitHub Issues follow the same path
without a core commit. The bridge is the last tracker core adds. The
2026-08-18 plan decision that scoped this release — full
bring-your-own-tracker story minus Linear, and no warren-side sidecar
table for issue metadata while capability flags suffice — is recorded
in ROADMAP's Decisions and in plan pl-a37b's alternatives.
