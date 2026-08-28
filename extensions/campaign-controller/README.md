# @warren-ext/campaign-controller

Warren's first **controller** extension (plan
[pl-91b6](../../docs/design/campaign-controller.md)): a dry-run-only
upstream-contribution campaign controller. Where the
[audit-log](../audit-log/README.md) and [judge](../judge/README.md)
extensions are observers, a controller owns durable workflow state, drives
warren through its published HTTP command APIs under an explicit
operator-approved policy, and never receives a call back from warren.

V0 target ([OpenClaw](https://github.com/openclaw/openclaw) as repository
data, not hard-coded behavior): dispatch explicit approved issue work to
warren against the bot-owned fork, render cross-fork pull-request intents
without ever posting them, poll upstream review/check/comment state
read-only, deduplicate it into durable events, and journal every action
intent before any I/O. No GitHub mutation method exists in the V0 transport
at all — dry-run is enforced by absence, not by convention.

Packaged on the audit-log/judge conventions: a fully standalone Bun package
against warren's published HTTP surface only. It imports nothing from
warren's `src/` or `scripts/` (enforced in both directions by
`scripts/check-layers.ts`), and warren core never imports it.

## Status

Scaffold (plan pl-91b6 step 1, warren-772a). This step lands the package
boundary every later step builds on: own manifest, lockfile, strict
TypeScript config, Biome config, source/test tree, container image, and
this README. The only source it ships is the shared primitives downstream
issues depend on:

- [`src/clock.ts`](src/clock.ts) — injectable `Clock` and `IdGenerator`
  interfaces plus production defaults (`SystemClock`, `UuidIdGenerator`) and
  deterministic fakes (`FixedClock`, `SequentialIdGenerator`), so the
  fake-infrastructure tests never race wall time or entropy.
- [`src/errors.ts`](src/errors.ts) — the `CampaignControllerError` base
  with a stable machine-readable `code`, and the
  `ValidationError` / `ConfigError` / `StateError` / `BoundaryError`
  hierarchy every later step throws through. Error messages never carry
  secrets by construction.
- [`src/manifest.ts`](src/manifest.ts) — the runtime-validated V0 campaign
  manifest schema (warren-5055): upstream/fork coordinates, default branch,
  ordered explicit issues, warren dispatch identity, prompt or prompt digest,
  layered USD caps, concurrency, expiry, and the approval envelope whose
  digest must recompute over the normalized manifest. Unknown keys,
  malformed coordinates/refs, duplicate issues, unlayered or over-limit
  caps, expiry, and digest mismatches fail closed with actionable errors.
- [`src/repository-policy.ts`](src/repository-policy.ts) — the
  runtime-validated repository-policy snapshot schema (warren-5055):
  provenance (source URL, fetched-at, sha256), staleness bound,
  issue-first and AI-disclosure/evidence requirements, allowed work types,
  forbidden/protected paths, the upstream observed open-PR limit, the
  controller's stricter caps, required checks, and every mutation flag —
  all of which must be present and `false` in V0.
- [`src/mutations.ts`](src/mutations.ts) — the frozen GitHub mutation-flag
  vocabulary. Dry-run is enforced by the schema: any enabled flag is a
  validation error.
- [`src/github-grammar.ts`](src/github-grammar.ts) — GitHub owner/repo and
  git refname grammar, shared by both schemas.
- [`src/digest.ts`](src/digest.ts) — canonical-JSON (recursively key-sorted)
  sha256 digests, so approval binding never depends on key order or
  timestamp spelling.
- [`profiles/`](profiles/) — the committed OpenClaw example data: the repository
  policy profile (pinning the upstream 20-open-PR limit with the stricter
  controller caps 5 / 2 per day) and a digest-bound example campaign
  manifest. OpenClaw lives here as data, never as controller conditionals.
  Golden tests ([`src/openclaw-profile.test.ts`](src/openclaw-profile.test.ts))
  pin the round-trip and the limits.
- [`src/store/`](src/store/) — the controller-owned SQLite state store and
  action journal (plan pl-91b6 step 3, warren-2853): `bun:sqlite` with WAL,
  explicit transactional migrations, injected clock/ids, campaigns with
  immutable manifest digests, ordered work items, the
  `planned → executing → succeeded|uncertain|retryable_failure|permanent_failure`
  action journal written `planned` before any I/O, deterministic action keys,
  one active attempt per work item, Warren run correlation, prospective
  cross-fork PR identity, GitHub events deduplicated by stable node id,
  attention items, leases, and the budget reservation ledger. No column in
  the schema can hold a secret, token, or credential — a schema-inspection
  test proves it against the live database.
- [`src/github/`](src/github/) — the extension-local, structurally
  read-only GitHub V0 client (plan step 5, warren-33aa):
  [`client.ts`](src/github/client.ts) (narrowed GET/HEAD reads of
  repository metadata, file content, issues, pull requests,
  participating notifications, issue comments, reviews, review comments,
  check runs, and combined statuses, with conditional ETag/Last-Modified
  requests and bounded pagination),
  [`http-transport.ts`](src/github/http-transport.ts) (real fetch, one
  `read` operation that hard-fails any non-GET/HEAD method),
  [`pr-request.ts`](src/github/pr-request.ts) (pure, deep-frozen
  cross-fork PR-intent rendering — never posted),
  [`dedupe.ts`](src/github/dedupe.ts) (stable node-id deduplication),
  [`redact.ts`](src/github/redact.ts) (credential scrubbing), and
  [`fake-server.ts`](src/github/fake-server.ts) (a deterministic
  in-process fake GitHub that records every request, paginates, serves
  duplicate node ids, and simulates primary and secondary rate limits).
  There is no GitHub mutation operation anywhere on the production
  surface.

Landed in plan step 4 (warren-a732): the minimal V0 Warren HTTP client and
its deterministic fake —

- [`src/admission.ts`](src/admission.ts) and
  [`src/admission-errors.ts`](src/admission-errors.ts) (plan step 6,
  warren-a252): campaign import (immutable digest-keyed manifest, ordered
  work items, changed-field invalidation back to `awaiting_approval`),
  explicit digest-bound approval, and the per-item admission gate —
  expiry, policy freshness and digest binding, ordered membership,
  upstream/fork allowlist, all-false mutation flags, warren identity and
  caps, campaign and daily budget reservation, concurrency, one active
  attempt, and protected-path fail-closed attention. Every refusal names
  its invariant; no network call can occur before admission succeeds.
- [`src/warren-client.ts`](src/warren-client.ts) — `WarrenClient` over
  warren's published surface (`GET /whoami`, `POST /runs`, `GET /runs/:id`,
  all `{run}`-enveloped). Dispatch carries a caller-owned stable
  `Idempotency-Key` and is NEVER retried: an ambiguous outcome (network loss
  after send, 5xx) fails closed as `DispatchUncertainError` because warren's
  idempotency store is not durable across restart. Safe reads retry
  429/5xx/network honoring `Retry-After`, bounded. The bearer token lives
  only in the `Authorization` header — no error, log, or payload embeds it.
- [`src/warren-fake.ts`](src/warren-fake.ts) — `FakeWarrenServer`, an
  in-process fake speaking the same documented envelopes through the same
  `fetch` seam (no production shortcut). It records every request, models
  accepted-response-loss (`dropNextResponses`), rate-limited reads with
  `Retry-After`, malformed envelopes (`respondOnceWith`), and restart
  (`restart()` wipes the non-durable idempotency store while runs survive).

Landed in plan step 7 (warren-2a0a): durable Warren dispatch and restart
reconciliation —

- [`src/dispatch/dispatcher.ts`](src/dispatch/dispatcher.ts) —
  `WarrenDispatcher` converts one admitted work item into a Warren run
  without duplicate paid work. In ONE transaction it reserves the full
  per-run cap and journals a deterministic `warren_dispatch` action with
  the exact request digest BEFORE any I/O; the action key is the stable
  `Idempotency-Key` sent to warren. A confirmed POST persists the run
  correlation and the only warren call from then on is the safe, retryable
  `GET /runs/:id` until terminal. An ambiguous POST with no known run
  settles `uncertain`, moves the work item to `dispatch_uncertain`, creates
  an attention item, keeps the reservation conservative, and is NEVER
  re-POSTed — by this process or after a restart. Restart reconciliation
  (`reconcileAfterRestart`) expires leases, resumes known-run reads to
  terminal, settles the ACTUAL cost when known (unknown cost keeps the full
  reservation active), and fails closed every unfinished action with no
  correlated run. Terminal success records the pushed branch/ref;
  failure records the structured outcome (`run_failed` + state + failure
  reason) without advancing. No PR intent is rendered and no GitHub
  mutation exists here (later steps).

Landed in plan step 9 (warren-323d): read-only upstream PR reconciliation —

- [`src/reconcile/`](src/reconcile/) — `UpstreamPrReconciler` reconciles one
  already-known upstream PR identity. Participating notifications are
  wake-ups only (never a source of state); the authoritative pull request,
  reviews, issue comments, review comments, check runs, combined status,
  and an optional watched policy file are re-read through GET/HEAD and
  normalized into durable events keyed by repository + event kind + node
  id + content digest — so reordered pages, replayed wake-ups, edits, and
  controller restarts land exactly once. Attention items (requested
  changes, actionable maintainer comments, failing checks, policy
  changes, human takeover, stale author action, unresolved ambiguity) are
  derived deterministically and stored through a deduplicating write.
  Comment and review text is untrusted data, never a controller command;
  the reconciler performs no GitHub mutation, dispatch, reply, resolve,
  or rerequest.

Landed in plan step 8 (warren-fb4f): dry-run cross-fork PR-intent
rendering and journaling —

- [`src/pr-intent/intender.ts`](src/pr-intent/intender.ts) — given an
  approved campaign and a SUCCEEDED run against the bot-owned fork, derives
  the exact upstream pull-request request (head `<fork>:<run-branch>`, base
  the upstream default branch), renders a policy-compliant title and body,
  and journals its digest as a `planned` dry-run action BEFORE the result is
  emitted. It performs no I/O; the request is evidence, never transport.

Landed in plan step 10 (warren-d050): the composed dry-run tick and the
operator CLI —

- [`src/tick/tick.ts`](src/tick/tick.ts) — `runTick` executes one
  deterministic, bounded, restart-safe dry-run pass over one campaign in the
  fixed order **lease → validate/admit → reserve/journal → Warren dispatch
  or reconcile → render dry-run PR intent → read-only GitHub reconcile →
  settle/report**. One campaign lease refuses a concurrent tick; at most
  ONE new dispatch leaves any tick; the post-loop restart sweep resumes
  known runs and fails closed every unconfirmed dispatch (never a re-POST);
  every stage lands as a JSON-safe outcome record.
- [`src/cli/`](src/cli/) — the operator CLI
  ([`src/cli/main.ts`](src/cli/main.ts), testable seam
  [`runCli`](src/cli/run.ts)): `manifest validate` / `manifest import`,
  `amendment validate` / `amendment apply` (warren-35c4: digest-bound,
  owner-approved manifest amendments applied in place — append issues,
  adjust budget, update prompt — with no superseded campaign row and no
  superseded attention item), `approve`, `tick`, `status`, `journal`, and
  `attention list` / `ack`.
  NDJSON is the default output (`--format human` for readable text), and
  the exit-code table in [`src/cli/exit-codes.ts`](src/cli/exit-codes.ts)
  is stable: 0 ok, 1 usage, 2 invalid input, 3 invalid config, 4 refused
  (including concurrent tick), 5 upstream failure. Configuration comes only
  from explicit flags and the named `CAMPAIGN_*` / `WARREN_BASE_URL` /
  `WARREN_API_TOKEN` / `GITHUB_TOKEN` / `GITHUB_API_BASE` variables; the
  two credential variables are the only way a secret enters, and every
  emitted line is scrubbed against them. No command posts a PR or comment,
  mutates GitHub, discovers GKE secrets, or enables a live mode
  (`--live`/`--execute` are refused as usage errors).

## Layout

```
src/
  clock.ts             injectable clock + id interfaces, prod defaults, test fakes
  digest.ts            canonical-JSON sha256 digests
  errors.ts            campaign-controller error base types
  github-grammar.ts    GitHub owner/repo + git refname grammar
  manifest.ts          V0 campaign manifest schema + validation
  mutations.ts         frozen mutation-flag vocabulary (all false in V0)
  repository-policy.ts V0 repository-policy snapshot schema + validation
  admission.ts         campaign import, digest approval, per-item admission
  store/     SQLite state store: schema, migrations, action journal, budget, leases
  dispatch/  durable Warren dispatch + restart reconciliation state machine
  reconcile/ read-only upstream PR reconciliation and attention derivation
  pr-intent/ dry-run cross-fork PR-intent rendering + journaling
  github/    structurally read-only GitHub client, PR-intent renderer,
             dedupe/redaction helpers, and the fake GitHub server
  tick/      the composed dry-run tick (lease → admit → dispatch/reconcile
             → PR intent → read-only GitHub reconcile → settle/report)
  cli/       the operator CLI: run/main, config, output envelopes, exit codes
  warren-client.ts minimal V0 Warren HTTP client (dispatch, detail, retries)
  warren-fake.ts   deterministic in-process fake Warren server
  index.ts   package identity + public re-exports
profiles/
  openclaw.repository-policy.json         committed OpenClaw policy profile
  openclaw.campaign-manifest.example.json committed digest-bound example manifest
```

## Development

See [RUNBOOK.md](RUNBOOK.md) for the operator boundary, commands, evidence
checklist, restart recovery, stop conditions, and the separate explicit
authorization each live action needs.

```bash
bun install        # from THIS directory — the package owns its lockfile
bun test           # standalone test suite
bun run acceptance  # the OpenClaw V0 end-to-end dry-run scenario
bun run typecheck  # strict tsc, noEmit
bun run lint       # biome check src
```

## Operator CLI

```bash
bun run src/cli/main.ts <command> [flags]   # NDJSON by default

manifest validate [--manifest <p>] [--policy <p>]   validate a manifest (+ policy)
manifest import --manifest <p> --policy <p>         import the immutable campaign
amendment validate --amendment <p>                  validate a manifest amendment
amendment apply --amendment <p>                     apply an approved amendment in place
approve --campaign <id> --digest <sha256> --by <n>  approve a manifest digest
tick --campaign <id> [--dry-run]                    one dry-run reconciliation tick
status [--campaign <id>] [--work-item <id>]         campaign / work-item status
journal [--campaign <id>] [--work-item <id>]        the durable action journal
attention list --campaign <id> [--all]              open attention items
attention ack --campaign <id> --id <id>             acknowledge an attention item
```

Paths come from flags or `CAMPAIGN_DB_PATH`, `CAMPAIGN_MANIFEST_PATH`,
`CAMPAIGN_POLICY_PATH`, `CAMPAIGN_BOT_GRAMMAR_PATH`, `CAMPAIGN_SUMMARIES_PATH`,
`WARREN_BASE_URL`,
`GITHUB_API_BASE`. The Warren credential comes only from
`WARREN_API_TOKEN` and the optional GitHub credential only from
`GITHUB_TOKEN`; neither is ever echoed, journaled, or accepted as a flag.

## Container

```bash
docker build -t warren-ext-campaign-controller .
```

The image builds from this directory alone and runs the operator CLI
(`src/cli/main.ts`). The controller owns its storage on `/app/data`
(`CAMPAIGN_DB_PATH`); the container contract is dry-run only — there is no
live mode to enable.
