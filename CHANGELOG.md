# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases **0.9.10 and earlier** live in
[`docs/CHANGELOG-archive.md`](docs/CHANGELOG-archive.md).

## [Unreleased]

### Added

- **Azure DevOps Repos forge (GH#1172).** `WARREN_FORGE=ado` resolves
  `AdoForge` (`src/forge/ado/`), the second in-core arm of the `Forge`
  contract: clone-URL grammars for `dev.azure.com`, `ssh.dev.azure.com`
  and the legacy `visualstudio.com` host; a PAT credential from
  `WARREN_GIT_TOKEN`; pull requests over the Azure DevOps REST API with the
  409 duplicate resolving to the existing PR; Pipelines builds as check
  runs with the failed task's log as the job-log tail; branch deletion
  through the refs API. Every call carries a 30 s deadline and a 203
  sign-in page is read as a rejected credential. The contract gains one
  optional method, `repoLayout`, so a forge whose clone URLs carry a
  deeper coordinate than `<owner>/<name>` can name the on-disk layout
  itself; `parseProjectUrl` now lives once in `src/projects/url.ts` and
  the project re-clone healer uses it too — the healer also receives the
  boot-resolved forge and the minted credential, so a non-GitHub project
  whose clone vanished heals. A clone URL carrying a username
  (`https://<org>@dev.azure.com/…`) is refused at registration, because
  warren's credential rewrite never matches such an authority; a row
  registered before this rule keeps parsing on the heal path. The
  org/project on-disk fold is injective (doubled-dash escaping, content
  hashes for punctuated names), `listChecks` covers PR build-validation
  builds on `refs/pull/<id>/merge` and scopes its scan to the repository
  GUID, build results fold to the check-run conclusion vocabulary, and a
  2xx HTML sign-in page reads as a rejected credential.

### Changed

- **warren-tracker/v1: issue `status` fields must be `open`, `closed` or
  `other`.** The protocol text told servers to send their raw status
  string and promised the bridge would normalize it, but the bridge only
  recognized those three exact words and folded everything else to
  `other`, so a remote tracker's `Done` or `Closed` never read as closed:
  plan-runs never skipped finished children and auto-plan-run detection
  never fired. Servers now fold their own states, the bridge rejects any
  other string as a malformed payload, the conformance suite requires
  the vocabulary and checks that a closed issue reads `closed`, and
  `tracker-jira` maps Jira's `statusCategory` (`new` → open,
  `indeterminate` → other, `done` → closed). A server that still sends
  raw strings fails loud on its first read instead of silently never
  finishing.

## [0.19.0] — 2026-08-27

The operator-console release. The UI is rebuilt end to end on the
Direction C design — a new Operations index, an Event explorer, and a
full mobile pass — while a one-line installer and a guided `warren up`
give first-time users a working instance without touching a config
file. Around the core, the campaign controller opened its first live
upstream PR and Jira arrived as the first external tracker.

### Added

- **Operator console rebuild (pl-7e38).** Every page rebuilt on the
  Direction C design system: a new Operations page as the index route
  (backed by a new one-poll ops-overview API), an Event explorer backed
  by the new global events query endpoint (`GET /events`), an Instance
  facts page (`GET /instance`), and rebuilt Runs, Run detail, Plan
  runs, Plan run detail, Projects, Project detail, Dispatch, Dispatch
  plan, Telemetry (four tabs), and Login pages, with new tokens,
  typography, and a theme switch.
- **Mobile pass (pl-4ab6).** The console is now phone-usable: a
  bottom five-tab nav replaces the hamburger, dispatch becomes a
  card-per-section form, and every page — runs, run detail, plan runs,
  operations, telemetry, event explorer, instance — gets a conformant
  mobile arm.
- **Casual-user happy path (pl-26f3).** `scripts/install.sh` installs
  bun and the CLI in one line; `warren up` autodetects the runtime
  (sandbox-exec / bwrap / docker) and walks through credentials with a
  wizard; a single-use setup code minted at boot hands the browser an
  authenticated session; GitHub App credentials persist and
  hot-activate the forge; Add Project lists the App installation's
  repositories; a zero-project instance renders a setup checklist and
  offers a starter-task dispatch after the first project registers.
  The npm package now ships the built UI.
- **Campaign controller** (`extensions/campaign-controller/`) — a
  standalone upstream-contribution controller over warren's HTTP API:
  immutable campaign manifests, repository policy, SQLite action
  journal, read-only GitHub polling, and a dry-run operator CLI, then
  a single policy-gated create-PR mutation (Phase 2) with
  evidence-gate PR bodies. It opened its first live OpenClaw PR and
  deploys to GKE beside the judge.
- **Jira tracker extension** (`extensions/tracker-jira/`) — speaks
  warren-tracker/v1 against Jira Cloud with its own credential.
- **Judge export proxy** — an operator-gated warren route
  reverse-proxies the judge `/verdicts.jsonl` export, so the browser
  stays same-origin and `JUDGE_EXPORT_TOKEN` never reaches the client;
  the telemetry judge tab now classifies healthy-empty, misconfigured,
  and absent states honestly.
- **Honest cost display for subscription-auth runs** — a `costBasis`
  wire field distinguishes metered API spend from subscription usage.
- New operator knobs: `WARREN_GIT_TIMEOUT_MS` (host-clone git
  timeouts), `WARREN_K8S_MEMORY_REQUEST_MIB` / `_LIMIT_MIB` (run-pod
  memory), and a provisioned RWX repo-cache wired through the K8s
  deploy pipeline.

### Changed

- The built-in default run-branch prefix is now `warren/` instead of the
  legacy `burrow/` (warren-2de0). Fresh installs mint
  `warren/run_xxxxxxxxxxxx` branches; deployments that configured
  `runBranchPrefix` (project config or `WARREN_RUN_BRANCH_PREFIX`) are
  unaffected. Roll back with `WARREN_RUN_BRANCH_PREFIX=burrow`.
- The git credential path no longer assumes GitHub — the forge
  contract owns credential shape, clearing the road for non-GitHub
  forges.
- The auto-merge gate accepts a comma-separated `AUTO_MERGE_BOT_LOGIN`
  list, so App-authored and machine-account-authored run PRs both
  qualify.
- Provider retry is bounded and reports where it stopped; a retried
  run keeps its provider, model, and cost cap.
- README and docs repositioned: the casual install path sits above the
  fold and operator content moved to its own section.

### Fixed

- Direction C bug sweep (pl-3ce8): full-width topbar, doubled filter
  carets, frozen live durations (a shared `useNow` tick), overlapping
  event-kind labels and fixed-height event stream on run detail,
  telemetry meter-bar overflow and lost `toFixed` formatting, and the
  unreachable `/events` page now in the nav with the Operations events
  panel live.
- K8s: a run no longer zombies after a `stdin_hold_timeout` kill; the
  git-credential callback accepts a run-scoped token; the agent uid
  split works on containerd 2.x and deploys gate on it; placeholder
  Secret templates stay out of the kind and kustomize overlays.
- Install script: `apt-get update` runs before the prerequisite
  install, `unzip` is provisioned for the bun bootstrap, and the bun
  installer runs via a temp file so its bash shebang applies.
- CLI: `--url` overrides an empty `WARREN_BASE_URL`; `doctor` failure
  paths report the credential source they resolved.
- Release/deploy pipeline: a draft release resumes at the tagged SHA,
  and the gke-live overlay applies per resource with bounded retries.
- The sandbox git preflight verifies the resolved git actually
  executes inside the sandbox before a run starts.

## [0.18.0] — 2026-08-20

The any-setup release. Warren's issue queue is now a real provider seam:
Seeds remains built in, while external trackers connect through the
`RemoteTracker` bridge and the experimental `warren-tracker/v1` protocol.
The same release makes mirrored and third-party repositories practical with
base-commit pinning, serialized host-clone refreshes, per-project onboarding
context, and configurable multi-stack agent images. Runtime and judge
hardening close the loop around that wider deployment surface.

### Added

- **The IssueTracker cut** (plan pl-a37b, #1003–#1016) — a capability-flagged
  core contract, `SeedsTracker` implementation, `RemoteTracker` HTTP bridge,
  ordered issue-list plan-runs for trackers without plans, and a published
  conformance suite with a FakeTracker reference server. The protocol and
  deployment model are documented in `docs/design/issue-tracker.md`.
- **Dispatch-context analytics** (#987, #990, #993, #996, #998) — an
  insert-only SQLite/Postgres fact table records why each run was dispatched,
  which override won, and the runtime kind; `GET /analytics/dispatch` exposes
  the windowed report.
- **External-repository onboarding** (#1004, #1005, #1007, #1012) — project
  `repoContext`, per-project agent-image overrides, a Python/uv-capable default
  image, detached-HEAD-safe `baseCommit` dispatch, and serialized clone
  materialization.
- Per-run restricted-network loopback proxying (#999), a K8s run-pod
  `NetworkPolicy` (#1000), and a pre-push guard against corrupt Seeds JSONL
  (#1001).
- The judge extension now ships as a real GKE workload and release image, with
  append-only verdict detail and deployment manifests (#968, #972, #989).
- Reusable agent skills for release preparation, contributor issue filing,
  and the warren dogfood pipeline.

### Changed

- Builtin prompts are tracker-neutral and gate Seeds/Mulch instructions on
  project capabilities (#1008–#1011).
- Agent containers run non-root (#995); K8s now uses separate entrypoint and
  agent UIDs so agent code cannot forge the warren-owned event descriptor
  (#1027).
- Runtime ids are typed from the canonical union and protected by the new
  `check:runtime-ids` guard (#964).
- The README now leads with the control-plane quickstart, forge seam, and
  extension model; macOS setup no longer mounts a host Docker CLI that breaks
  dispatch (#966).
- Acceptance stub-agent scenarios use PATH shims instead of the retired shared
  shell fixture (#1025), and agent-image pins move to pi-coding-agent 0.84.2
  (#1024).

### Fixed

- Repair and reap accounting now distinguishes deliberate no-change runs from
  dropped commits, ignores harness-owned dirty files, and measures commits
  ahead from the pre-push origin tip (#992, #1019, #1022).
- Provider retry classification uses structured status/body evidence and keeps
  retry lineage; spawn-exec failures receive an honest terminal reason
  (#983, #985, #986).
- `warren run` waits for the real terminal event instead of exiting on a
  transient `state="running"` message, and credential diagnostics identify the
  winning token source (#981, #988).
- DockerProvider delivers the configured provider credential to the pi builtin
  (#1018), while K8s finalization accepts empty merged deltas and local cancel
  settles promptly (#984, #1002).
- Judge calibration defers work when daily or per-judgment budgets are
  exhausted, binds verdicts to ground truth, and mirrors the full canonical
  failure-reason vocabulary (#969–#971, #1021).
- Tool-shape analytics recognizes pi's nested `arguments` wrapper and can
  repair existing rollups (#967).
- DockerProvider finalization scopes Git's safe-directory override to the
  exact run workspace, preserving non-root agent isolation without mutating
  global Git config (warren-15f0).

## [0.17.0] — 2026-08-17

The absorption release. The **pl-3007 campaign** internalized the
sandbox substrate that warren previously delegated to the co-tenanted
burrow daemon: profile generation, harness adapters, the spawn path,
and preview sidecars are all warren-owned now. Warren no longer
spawns `burrow serve`, links `@os-eco/burrow-cli`, or talks to a
burrow socket — one process, one fewer moving part in every deploy.
Alongside the absorption, a new **DockerProvider** runs agents as
sibling containers, and plan-runs picked up retry and resume
machinery.

### Added

- **DockerProvider** (`WARREN_RUNTIME=docker`, warren-3732, #961) —
  a third runtime backend that runs each agent as a sibling container
  over the docker socket, between `local`'s in-process engine and
  `k8s`'s pods.
- `POST /plan-runs/:id/resume` restarts a plan-run that failed on a
  merge timeout, picking up from the next open child (warren-1eff,
  #942).
- Plan-runs retry a child once on `child_provider_error` instead of
  failing the whole plan (#933), and infra-lost runs
  (`burrow_run_lost`) auto-retry as one re-dispatched run (#937).
- `warren projects` lists registered projects from the CLI
  (warren-e127, #952).
- A provider → env-key registry in `src/core` gives both runtimes
  generic credential delivery, so adding a provider no longer means
  touching each runtime by hand (warren-fb8d, #948).
- Dispatch-time preflight compares the workspace's drizzle migration
  journal against the server's, failing fast on schema skew instead
  of mid-run (warren-1f03, #931).
- K8s `/readyz` reports `k8s_api_reachable` via the PodWatcher's
  sync state (#946).
- Acceptance scenarios pin the self-host paths: scenario 41 covers
  the local topology (warren-0f18, #953) and the container scenario
  proves the one-line fresh-host bring-up (#962).

### Changed

- **The burrow absorption (pl-3007).** bwrap/sandbox-exec/cgroup
  profile generation lifted into `src/sandbox/` (#934); the pi and
  claude-code harness adapters source-lifted into
  `src/runtime/adapters/` (#936); LocalProvider spawns through the
  internalized sandbox with an in-process run store (#947); preview
  sidecars and inbound port forwards re-homed onto it (#950); the
  K8s in-pod trio rewired off burrow (#943); the supervisor no
  longer spawns `burrow serve` — socket wait, restart budget, and
  token minting all deleted (warren-9a26, #955); `src/burrow-client/`
  deleted and `@os-eco/burrow-cli` dropped from the package
  (#959); and the burrow-shaped wire vocabulary renamed, migrating
  `runs.burrowId` (#963).
- **Sapling retired** as a builtin agent: the agent definition, the
  runtime id, and the adapter are gone (warren-f525, #932).
- Warren-authored PR bodies now carry the agent's own narrative —
  rationale, hazards, test notes — instead of a fully templated
  shell (#944).
- The GitHub App registration pages match the warren UI styling
  (#956).
- `docs/` paths are treated as a public surface: deleting or moving
  one requires a tombstone pointer in `docs/README.md` (warren-d602,
  #960).
- Guard hardening: `check:layers` walks the real module graph
  instead of line regexes (warren-d382, #957), the
  handlers-are-a-thin-surface rule actually bites now (#954), and a
  new UI-consumer seam rule pins what `src/ui/**` may import (#951).

### Fixed

- Plan-run children honor the plan's `ref` as the PR base, so
  chained children can accumulate on a shared branch (#945).
- A transient provider network error mid-run no longer kills the run
  without retry (#935), and the pi adapter surfaces the provider's
  actual error body instead of an opaque `Provider error` (#940).
- `POST /runs/:id/cancel` on K8s finalizes the run row instead of
  leaving it static after deleting the pod (#938).
- Pod warning events (`FailedAttachVolume` & co.) surface on the run
  stream instead of dying silently in the cluster (warren-32f8,
  #941).
- The GitHub App install flow no longer dead-ends on GitHub — the
  manifest carries a `setup_url` back to warren (#949).
- `warren login` warns when a stale `WARREN_API_TOKEN` from a cwd
  `.env` outranks the stored credential, and auth-rejection errors
  name the env as the token source (warren-8807, #928).
- Auto-merge re-arms after a conflict-repair push instead of
  stranding the PR (#926).
- CI self-healing: bundle-size autoheal fires on push-event failures
  too (warren-ffd2, #927), and seeds-merge-autoheal fires on
  `.seeds` pushes to main (warren-c84c, #925).
- Dispatch rejects known provider/model mismatches up front
  (warren-bad5, #924).
- Acceptance rot: scenarios 04/05/07/09/10 no longer call deleted
  plot-era APIs (#958).

## [0.16.1] — 2026-08-16

The dogfood release. Nearly every change here (#899–#923) was authored
by warren-dispatched agents working warren's own tech-debt backlog —
23 PRs dispatched, shepherded, and merged through the pipeline in a
single day, at about $13 of total agent spend.

### Added

- `warren show --summary` / `warren wait --summary` — a compact
  single-object projection of a run for scripts and agents
  (warren-8447, #923).
- `warren run --seed <id>` links the dispatched run to a seeds issue
  at dispatch time (warren-ca2f, #920).
- A machine-readable builtin-agents manifest, so downstream sites can
  derive the agent roster from the code instead of prose (#917).
- `gen:openapi` now emits `components:` response schemas in
  `docs/openapi.yaml` instead of inlining everything (#919).
- CI surfaces failing test names as GitHub annotations parsed from
  `junit.xml` (warren-3144, #907).
- `warren doctor` and the K8s dispatch path warn when
  `WARREN_GIT_AUTHOR_NAME` / `WARREN_GIT_AUTHOR_EMAIL` are unset, so
  agent commits don't silently attribute to the wrong identity
  (warren-e7b7, #915).
- `docker-compose.yml` host ports are env-parameterized for
  multi-instance hosts (warren-d915, #911).

### Fixed

- CLI commands now actually read the bearer token from
  `~/.warren/client.json` — `warren login` credentials were written
  but never used by subsequent commands (#899).
- `POST /runs` persists and echoes the requested `ref`, so
  dispatchers can verify what they asked for (#916).
- SDK and UI `RunRow` types carry the `provider` / `model` columns
  the server already sends (#918).
- The pre-auth preview-proxy preamble no longer runs on the public
  instance outside the uniform-401 contract (#914).
- Workspace GC converges: already-gone or destroyed burrows no longer
  re-strand the same workspaces every sweep (#913).
- The seeds JSONL merge driver auto-resolves timestamp-only conflicts
  by `max()` (warren-5f0d, #910) and no longer commits pure-`ours`
  content on an unresolvable conflict (#912).
- `check:coverage` no longer truncates bun test output on exit
  (warren-66a7, #906); the public-projections cost-leak test asserts
  structurally (warren-6163, #908); acceptance scenario 39 rides out
  the public instance's 10s healthz boot window instead of flaking
  (#909).
- Guard hardening: `check:wire-types` fails on a canonical wire name
  outside its stem list instead of silently unenforcing it (#905),
  and `check:layers` walks `scripts/` so forge-boundary hits there
  are caught (#904).

### Changed

- All 32 grandfathered PascalCase/camelCase filenames in `src/ui`
  renamed to kebab-case; the Biome exception list is now empty
  (#922).
- Operator docs: smoother GitHub App registration instructions
  (#903), an `AUTO_MERGE_BOT_LOGIN` step in the K8s App-mode
  migration runbook (warren-da62, #902), and forge-contract doc
  cleanups (#900, #901, #921).
- ROADMAP: the self-host push moves ahead of IssueTracker; new
  corpus-flywheel design records land under `docs/design/`.

## [0.16.0] — 2026-08-15

The analytics release. Warren now measures its own fleet: the
**agent-analytics campaign** (plan pl-103e) turns raw run events into
persisted facts and behavioral insights, and the new **judge
extension** (plan pl-17ca) reads finished runs and issues structured
verdicts against a 15-class behavioral rubric. Alongside the
campaign, the UI stops polling lists and rides a single **lifecycle
event stream**.

### Added

- **Agent analytics** (plan pl-103e). Dispatch-time facts become real
  columns — `runs.created_at` with queue-wait surfaced on
  `/analytics/runs` (#859), `runs.model` + `runs.provider` written at
  dispatch (#860), `events.origin` threaded through the stream (#861),
  and reap-time outcome facts persisted on runs (#862). On top of the
  facts: `toolShape` + `fileShape` registries in `src/core` (#865), a
  structured `tool_calls` rollup (#867), merged-PR rate per agent as
  landed-work semantics (#866), steering-outcome deltas and
  cost-per-merged-PR insights (#868), a per-directory difficulty map
  (#870), and a context-waste proxy — tool_result byte share against
  run context tokens (#872). The Run Analytics UI renders the new
  insight kinds plus a per-directory struggle view (#874).
- **The judge extension** (`extensions/judge/`, plan pl-17ca). A
  standalone package that consumes warren's HTTP surface only: read
  client with a fake-warren test double (#877), an append-only SQLite
  verdict store (#878), the rubric-v1 system prompt rendering the full
  15-class behavioral taxonomy (#879), a bounded pi-SDK judge loop
  (#880), a collector daemon with budget gates (#881), calibration
  re-judging with a band-agreement metric (#882), and a token-gated
  `GET /verdicts.jsonl` export with paging (#883).
- **Lifecycle event stream in the UI.** List pages subscribe to one
  global lifecycle stream instead of polling (#875); the merge watcher
  generalizes plan-run PR polling into a `post_reap` lifecycle hook
  (#864); the last per-row plan-run poll drops to the lifecycle
  fallback (#885, warren-f566).
- **`check:client-contract`** — a lint-gate guard proving every
  request path in the UI api client is served by `ROUTE_TABLE`
  (#869, warren-4d2d).
- **The agent-runtime adapter registry** (`src/runtime/adapters/`) —
  one module per known runtime id, keyed off `KNOWN_RUNTIME_IDS` so a
  new runtime cannot compile without an adapter. The harness-state
  prefixes and terminal provider-error envelope types move from
  hardcoded constants into per-adapter declarations, and a zero-commit
  pi run whose only dirty path is a `.pi/sessions/` transcript now
  reads as a deliberate no-op instead of a dropped commit
  (#887, warren-c80e).
- **`push_rejected_policy`** — a push the remote refuses on policy
  grounds (GitHub push protection, protected branches) splits out of
  `finalize_failed` into its own failure reason. A structured
  `reap.push_rejected` event carries the unblock URL and flagged
  paths to the operator, and the UI badge names the real failure
  (#884, warren-b68d).

### Changed

- The actor vocabulary moved into `src/core/wire.ts`, the canonical
  wire home, with the split modules guarded (#871).
- The UI design tokens live in their own stylesheet (#863).
- Fourteen grandfathered UI filenames renamed to kebab-case; the
  Biome filename-exception list shrinks from 30 entries to 16
  (#886, warren-4e87).

### Fixed

- The `tool_calls` FK references `runs` without the `public.`
  qualifier, so the Postgres migrations replay under RLS checks
  (#873).
- The two spectator dead ends in public mode are closed (#857).
- The plan-runs default filter means every state, not a subset
  (#856).
- The per-request idle timeout is bounded (#855).

## [0.15.0] — 2026-08-13

The Forge release (plan pl-d1c9, 19 steps). Every GitHub call warren
makes — opening PRs, checking merges, reading CI, pushing branches —
now goes through a single boot-resolved **Forge** seam, and warren can
authenticate as a **GitHub App** instead of a personal access token.
Alongside the campaign: mid-run salvage for provider failures, a
finalize-recovery path for K8s control-plane restarts, and honest
steering feedback for the pi agent.

### Added

- **The Forge seam** (`src/forge/`) — one contract in front of every
  GitHub interaction, resolved once at boot via `WARREN_FORGE` and
  threaded through `ServerDeps` (#831, #832, #833).
  - A shared `src/forge/github/` transport core replaces four drifted
    inline GitHub REST clients: `pr.ts`/`pr-checks.ts`,
    `pr-annotate.ts`, the CI-fixer's `check-runs.ts`, and acceptance
    scenario 35's inline client (#822, #824–#827).
  - The reap pipeline, plan-run merge gate, and CI-fixer + scheduler
    all consume the seam instead of raw tokens (#834–#836).
  - **FakeForge**, an in-memory provider with a state-file seam, plus
    acceptance scenario 40 — a full dispatch→PR roundtrip with no real
    GitHub — now wired into the nightly list (#831, #838).
  - A `check:layers` rule pair holds the boundary: nothing outside
    `src/forge/` may speak GitHub REST directly.
- **GitHub App mode** (forge phase 4). The `GitHubApp` provider mints
  installation tokens from an App JWT with an in-process cache and
  capability flags (#840). Per-spawn minted credentials close the
  three formerly credential-free push sites (#839). K8s clone and
  push windows mint fresh short-lived tokens at pod-spec time, with a
  gated static-token fallback (#841). A credential heartbeat probe
  runs inside warren (#843). A manifest-based registration flow with
  operator docs gets a new App set up in one pass (#842), requests
  `workflows:write`, and carries its state nonce as a query parameter.
  The base K8s Deployment wires the four App-mode env vars.

### Changed

- The supervisor no longer rewrites the global gitconfig with a
  static token; the old static-token config paths are deleted
  (forge phase 5, #844). Credentials are per-spawn and short-lived.
- The pull-request vocabulary (state, merge outcome) moved into
  `src/core/wire.ts` alongside the rest of the wire types (#823).
- The anonymous GitHub-App registration surface is existence-gated
  and its nonce store capped, so an unconfigured instance exposes no
  unbounded outbound conversion endpoint (warren-e320, #852).

### Fixed

- A run that fails with `provider_error` mid-work no longer discards
  its uncommitted changes: the K8s finalize path salvages the
  workspace and pushes what the agent had written (#850).
- A control-plane pod replacement mid-run no longer deadlocks the
  agent on finalize: a recovery path re-adopts orphaned finalize
  requests after restart (#853).
- `POST /runs/:id/steer` no longer reports `steer.sent` for the pi
  agent when nothing was delivered — the steering inbox vocabulary
  now distinguishes delivered from dropped (#854).
- PRs touching `.seeds/issues.jsonl` no longer sit CONFLICTING on
  GitHub: a driver-aware self-heal workflow merges them (#845), with
  its `gh` calls made repo-explicit via `GH_REPO` (#851), and a guard
  keeps `sd doctor` from re-adding the lossy `merge=union` attribute
  (#829, #830).
- Reap keeps the linked seed open when a run produced no commits, so
  empty runs stop silently closing tracker issues (#837).
- `identity.test.ts` no longer writes into the developer's real
  `.git/config` (warren-8664, #821).

## [0.14.1] — 2026-08-11

The extensions release (plan pl-116e). `extensions/audit-log/` lands as
the first flagship extension — a standalone Bun package inside the repo
that talks to warren only over the public HTTP API, with a hard
no-imports boundary in both directions. Alongside it: a spend cap on
every dispatch surface, and a round of K8s salvage and reap repairs.

### Added

- **`extensions/audit-log/`, the first flagship extension** (plan
  pl-116e). Six steps, each a standalone slice.
  - Scaffold and repo boundary (warren-0781) — own `package.json`,
    lockfile, tsconfig, and tests, with zero imports across the
    `src/` ⇄ `extensions/` seam in either direction, plus a
    `FRICTION.md` that logs what the extension surface still lacks.
  - Cursor-tailing collector (warren-a0ff) — polls `GET /runs` and
    tails each run's NDJSON stream with bounded `?since` / `?limit`
    pages, checkpointing a durable per-run cursor after the sink
    accepts each event. At-least-once delivery, exact resume across
    restarts, per-run failure isolation.
  - Audit store and normalization (warren-653a) — wire facts map to six
    audit event types (`run.dispatched`, `run.started`, `run.terminal`,
    `branch.pushed`, `pr.opened`, `run.steered`) and land in an
    append-only SQLite store under a deterministic dedupe key, so
    replay after a kill is an exact no-op.
  - Export and health surface (warren-9c7c) — `GET /audit-log.jsonl`
    pages oldest-first with no skips or duplicates across page
    boundaries (`X-Audit-Log-Max-Id` lets an empty page checkpoint);
    `GET /healthz` reports collector liveness and cursor lag without
    echoing credentials; retention prunes oldest-first via
    `AUDIT_LOG_RETENTION_MAX_ROWS` / `AUDIT_LOG_RETENTION_MAX_AGE_MS`.
  - Container image and env contract (warren-88b8), then an end-to-end
    smoke test with a golden export and the closing docs pass
    (warren-c8c3).
- **Per-dispatch USD spend cap** (warren-a63d). The mid-run cap is now
  settable from every dispatch surface: `POST /runs`, `POST
  /plan-runs`, `warren run --max-cost-usd`, `warren plan run
  --max-cost-usd`, and a project-wide `maxCostUsd` default in
  `.warren/config.yaml`. `resolveCapOverride()` in
  `src/runs/cost-cap.ts` is the single implementation of the precedence
  chain — dispatch override > agent `frontmatter.maxCostUsd` > project
  default — and freezes the resolved cap onto `rendered_agent_json`
  before the run row persists, so the event bridge sees one settled
  ceiling. A malformed agent cap still fails open and stays visible on
  the frozen frontmatter as evidence. Manual trigger fires and
  `cloneFromRunId` re-runs inherit the cap; the SDK rejects `NaN` and
  `Infinity` before serialization.
- **Bounded non-streaming event read** (warren-17c1). `?limit=N` on
  `GET /runs/:id/events` returns at most N events and closes, implying
  `follow=false` even against an explicit `?follow=1`. Zero, negative,
  and garbage values now 400 instead of hanging.
- **`check:rls`, a static RLS gate for Postgres migrations**
  (warren-3206). The script replays `src/db/migrations/postgres/*.sql`
  in journal order and fails any table still live at the end of the
  chain without `ENABLE ROW LEVEL SECURITY`. Dropped tables stop being
  audited at their `DROP`. It rides inside the `lint` gate, because the
  gate vocabulary is frozen. Migration `0032_enable_rls_run_inbox`
  brings `run_inbox` — shipped without RLS in `0023` and patched by
  hand in Supabase — back onto the migration path, so a fresh database
  is deny-all too.
- **`CODE_OF_CONDUCT.md`** (Contributor Covenant v2.1), with
  enforcement reports routed through the GitHub Security Advisories
  channel already documented in `SECURITY.md`. `AGENTS.md` gains an
  escape hatch telling contributors and agents without the `sd` / `ml`
  CLIs to skip the seeds/mulch bootstrap and proceed normally.

### Changed

- **`GET /runs/:id` wraps its resource in `{run}`** (warren-7d84).
  Detail GETs now wrap, matching that route's own `POST` and the
  plan-runs family, which was already internally consistent. The bare
  shape had cost duplicate dispatches twice, when a consumer guessed
  the wrong envelope and read all-null. **This is a wire-shape change.**
  Consumers of `GET /runs/:id` must unwrap.
- **The UI consumes the SDK's `readNdjsonStream`** (warren-53a7). The
  hand-rolled second NDJSON parser in `src/ui/src/api/client.ts` is
  gone; `readNdjsonStream` takes an injectable `errorFactory` so the
  UI keeps its `ApiError` / `UnauthorizedError` types and its 401
  token-clearing side effect.
- **`RunDetail.tsx` split along section boundaries** (warren-9679) into
  `run-detail-events`, `run-detail-preview`, `run-detail-cost`, and
  `run-detail-format`.
- **Auto-merge runs on a GitHub App installation token** (warren-2565).
  The static `AUTO_MERGE_PAT` expired silently and every PR after it
  needed a manual merge. All three consumers — `auto-merge.yml`,
  `bundle-size-autoheal.yml`, and `release.yml` — now mint a fresh
  token per run from `AUTO_MERGE_APP_ID` plus
  `AUTO_MERGE_APP_PRIVATE_KEY`. The release workflow's `pat-heartbeat`
  becomes `app-heartbeat`: a mint attempt is the whole proof, since app
  keys carry no expiry to count down. `docs/project-setup.md` §2
  documents the one-time app registration.
- **Biome config moves to JSONC** (`biome.jsonc`), so the complexity
  and filename-exception ratchets can document their own policies
  inline.
- **`deploy-gke.yml` threads `WARREN_GIT_AUTHOR_NAME` from repo vars**
  (warren-2900), the same way it already read the email, instead of
  hardcoding `warren`.
- **`CONTRIBUTING.md` corrections** (warren-a6db) — the npm-publish
  claim is accurate now, and the doc gained a dev loop and a
  good-first-issue pointer.
- Dependabot: `docker/login-action` 4.5.1 → 4.6.0.

### Fixed

- **A K8s run could hang in `running` forever after an agent exited
  without a terminal envelope** (warren-9a4a). A stdin-held `pi` run
  killed by the idle watchdog never emitted `agent_end`, so reap never
  fired and the pod polled finalize-intent indefinitely. `runAgent`
  now tracks terminal envelopes and synthesizes the missing
  `agent_end` post-exit, marked `synthesized: true` with a reason.
- **Salvage lost uncommitted work and could not push its rescue ref**
  (warren-6016). Two gaps: the salvage windows ran without a git
  credential, so the rescue-ref push was always skipped; and salvage
  bundled only `base..HEAD`, so a dirty tree produced "Refusing to
  create empty bundle". The agent container now references the
  `warren-git-token` Secret (scrubbed from the agent child's spawn
  env), and `collectSalvage` folds the dirty tree into the bundle.
- **Salvage intake had no rate limit or per-run quota** (warren-adc1).
  Intake is capped at one in-flight upload per run through the existing
  per-key limiter; a second concurrent POST for the same run gets the
  limiter family's 503 with `Retry-After`. Tmp-file staging is wrapped
  in `try`/`finally`, so a failed write or rename no longer leaks up to
  32MiB per attempt.
- **`WARREN_FINALIZE_MAX_WAIT_MS` outranked the heartbeat watchdog**
  (warren-9d24). The 3,000,000ms default sat above the 2,700,000ms
  watchdog budget, so a silent intent-waiting pod could be terminalized
  before its terminal `no_intent` salvage POST landed, which then 401'd.
  The default drops to 2,400,000ms, with a cross-budget test pinning
  the ordering.
- **Oversized pull request bodies are bounded** before they reach the
  GitHub API.
- **The registry admitted agent names every consumer refuses**
  (warren-2b75). Names were typed `z.string().min(1)`, so uppercase,
  spaces, and path separators all passed. `AGENT_NAME_PATTERN` /
  `AgentNameSchema` move to `src/registry/agent-name.ts` and are shared
  with the config layer's `RoleNameSchema`, so registry names and role
  names hold one grammar.
- **The planner system prompt still promised retired `.plot/` files.**
  Those promises are stripped.
- **UI nav labels disagreed with page titles** (warren-6b21). The run
  detail page also shows its project name now.
- **The Docker `ui-builder` stage missed the client SDK files**, so a
  UI build that imports from `src/client/` failed in CI.

## [0.14.0] — 2026-08-04

The agent-facing CLI release (plan pl-882c). The CLI becomes the
primary agent surface — scriptable, pollable, and self-priming the way
`sd prime` / `ml prime` are — and `@os-eco/warren-cli` publishes to
npm.

### Added

- **`@os-eco/warren-cli` installs from npm** (warren-58dd). `npm i -g
  @os-eco/warren-cli` on Bun v1.1+ — the package ships raw bun-shebang
  TypeScript with a `files` allowlist (`src/`, UI source excluded), an
  `exports` map so `import { WarrenClient } from
  "@os-eco/warren-cli/client"` resolves, and `publishConfig.access:
  public`. The release workflow gains an idempotent `publish` job
  ordered draft release → ghcr image → npm publish → promote, so an
  npm version can never exist without its matching container image.
  Supersedes the container-only distribution decision (mx-834a3a).
- **`warren show`, `warren wait`, `warren tail`, `warren cancel`**
  (warren-b048) — the poll/follow/steer command set agents drive a run
  with: point-in-time state, block-until-terminal with `--timeout`
  (default 1800s), event streaming that follows by default
  (`--no-follow` drains and exits, `--from-seq` replays), and
  idempotent cancellation with an optional `--reason`.
- **`warren login` and `warren prime`** (warren-fc12) — agent session
  bootstrap. `login` verifies the credential against `/whoami` and
  writes base URL + token to `~/.warren/client.json` (mode 0600, never
  a DB credential per D5). `prime` emits the session context document:
  command reference derived from the program definition, env contract,
  exit-code table, and workflows.
- **Agent-facing output contract** (warren-b61e) — global `--output
  ndjson|json|pretty` (ndjson default, machines first), a stable
  exit-code table, and D6 duration rendering. Every command emits
  machine-parseable output.
- **SDK completion** (warren-968c) — `WarrenClient` gains `cancelRun`
  and a server version probe, and re-exports the core envelope types.
- **Generated CLI reference** (warren-1caf) — `docs/cli-reference.md`
  derives from the commander program definition (`bun run
  gen:cli-ref`); `gen:cli-ref:check` rides the lint gate so it cannot
  drift.

### Changed

- **The CLI collapses onto HTTP** (warren-97a2, decision D3). `warren
  run` and `warren add-project` now call the HTTP API instead of
  touching the DB, so the CLI works against a remote instance with
  nothing but a URL and a token. Resolution precedence everywhere:
  flags > env > config file > built-in default (D5).
- **One event-envelope extractor in `src/core`** (warren-27b5).
  Terminal-detect, usage-aggregate, and provider-error all consume the
  same parser instead of three hand-rolled ones.
- **Typed usage readers over the core extractor** (warren-db2e) —
  `usageShape` replaces ad-hoc `Record` digging; the pi-wins tiebreak
  is preserved.
- **HTTP response envelopes live in `src/core/wire.ts`** (warren-42f1)
  and `check:wire-types` grows `project` and `seed` domain stems, so
  SDK/UI copies of those shapes now fail lint.
- **Plan-run orchestration moved into the `src/plan-runs` domain**
  (warren-e240); the HTTP handler is now a thin surface, per the
  single-source-of-truth rule.
- **Acceptance harness adopts SDK `waitForRun`** (warren-bb51) —
  scenario polling loops replaced; at most one raw sleep remains.
- **Single-source truth sweep** (warren-00df) — dead `/agents/refresh`
  caller removed, UI `readFrontmatter` call sites collapsed, false
  dups-allowlist why-strings corrected.

### Fixed

- **`GET /projects/:id` is registered** (warren-2a89), so SDK
  `getProject` resolves instead of 404ing.

## [0.13.2] — 2026-08-03

### Security

- **Agent output can no longer terminalize its own run** — stream
  events now carry a parse-boundary provenance tag (`origin`,
  `src/core/wire.ts`). The K8s pod-log parser classifies an
  unattributed NDJSON line as `origin: "agent"` and downgrades its
  self-declared `stream: "system"` to `"stdout"`, and terminal
  detection refuses agent-authored events outright — so a crafted
  `{"kind":"state_change","stream":"system","payload":{"type":"agent_end"}}`
  line printed at the pod log no longer reaps the run as `succeeded`.
  Warren's own in-pod emitter stamps the marker, so legitimate
  claude-code `result` / pi `agent_end` envelopes are unaffected
  (warren-6646).
- **Route params can no longer traverse out of a directory**
  (warren-7c1e). `matchRoute` percent-decodes every `:param`, but the
  `([^/]+)` capture constrains only the raw pathname and `URL.pathname`
  preserves `%2F` — so `POST /runs/..%2F..%2Fetc%2Fpwn/salvage` decoded
  to `../../etc/pwn`, which the salvage intake joined straight onto the
  salvage directory. Any bearer holding `dispatch` could write up to
  32 MiB of its own bytes to an arbitrary path. The router now refuses a
  param that decodes to a path separator or a NUL, and a new
  `salvageBundlePath` resolver re-checks containment at the sink.
- **A malformed percent-escape no longer crashes the request pipeline**
  (warren-7c1e). `/runs/%ZZ/cancel` raised `URIError` out of
  `matchRoute`, which `handleRequest` calls outside its try/catch, so
  the connection dropped instead of returning warren's error envelope.
  Such a path is now a plain 404.
- **Salvage events no longer publish the host bundle path to spectators**
  (warren-7c1e). `salvagePath` is a `REDACTED_RUN_FIELDS` member, but
  `reap.workspace_salvaged` and `reap.workspace_salvage_recorded` served
  the identical absolute path to anonymous readers as `bundlePath`, and
  `reap.workspace_salvage_failed` carried it again inside raw git stderr.
  `bundlePath` / `salvagePath` now censor on the key, and the
  salvage-failed payload joins the body/log split. `rescueRef` stays in
  the clear — it is a branch name holding the already-public run id.
- **Path-mode previews move to a dedicated origin** (warren-3f8a) so
  agent-authored preview code can no longer read the operator token out
  of the UI's `localStorage`. A dedicated listener on
  `WARREN_PREVIEW_PORT` (default bind port + 1) serves nothing but the
  preview proxy; the warren origin answers `/p/...` with a 308 redirect.
  The unix-socket transport keeps legacy same-origin mounting and warns
  at boot. `/preview/config` discloses the preview port so the UI and PR
  annotations render the real URL.
- **`targetBranch` on `POST /runs` is now a validated push target**
  (#754) — a dispatch-capable bearer can no longer aim a run's push at
  an arbitrary branch such as the project default.
- **`POST /runs/:id/steer` validates `priority`** against
  `INBOX_PRIORITIES` instead of casting an arbitrary string past the
  type (#757), and **agent runtime ids are validated against
  `KNOWN_RUNTIME_IDS`** so an unknown runtime can no longer slip through
  agent upsert (#758).
- **`.warren/config.yaml` fails closed** (#759) — one unknown key used
  to silently drop the whole config, including the admission caps it
  carried. Unknown keys now surface instead of erasing their siblings.
- **Security headers on every response** plus `Vary: Authorization` on
  projection-dependent routes (#750), and the **per-client event-stream
  cap no longer trusts client-supplied forwarding headers** for its
  client key (#751).
- **Public-projection leak sweep** — `reap_failed` / `spawn_failed`
  events no longer leak absolute host paths and raw subprocess stderr
  (#752); `reap.workspace_destroyed` and `watchdog.terminal_reconciled`
  payloads no longer re-leak `burrowId` / `burrowRunId` (#748, #749);
  `plan_runs` and `plan_run_children` are now field-projected for
  spectators instead of served whole (#747); and anonymous
  `GET /runs/:id/events` no longer materializes the entire run
  transcript in memory per request (#710). Acceptance scenario 39 grew
  matching assertions for plan-run fields and path-bearing event kinds
  (#753).

### Added

- **Seeds integrity guard** for `.seeds/issues.jsonl` (warren-a71f,
  #716), plus post-merge dedupe that keeps terminal states
  (warren-b3be, #761).
- **Alpha logo/icon branding variants** and generator updates
  (warren-1d14).

### Changed

- **SPEC.md is retired** (warren-6fe3, #720–#741). Its living contracts
  were salvaged into `docs/design/` records — preview environments,
  plan-run coordinator, scheduler, warren-config loader,
  runtime/supervisor/durability, agent composition + pi runtime — and
  its V1 goals and security posture folded into `ACCEPTANCE.md` and
  `SECURITY.md`. All code and doc references now point at the design
  records or `docs/http-api.md`.
- **`AGENTS.md` is the canonical agent instruction doc**; `CLAUDE.md`
  is now a symlink to it (warren-b771, #742). A docs dedup/conflict
  sweep aligned README, ROADMAP, PHILOSOPHY, and CONTRIBUTING (#743).
- **Cross-repo dispatch is fully removed** — plan-run coordinator and
  dispatch routing (warren-deed, #721), the dispatch-prompt builder
  (warren-702e, #724), `seedProjectId` in the spawn path (warren-fd42,
  #725), the target-project resolver and `extensions.repo` schema key
  (warren-2967, #727), the cross-repo UI surface (#729), and
  `execution_project_id` on `plan_run_children` (warren-7c67, #731).
- **Finalize contract cleanup** — dead `closeSeedId` deleted (#745) and
  the remaining holdouts generalized (#746).
- **`src/ui` migrated to TypeScript 7** and the jscpd duplication
  ratchet tightened from 3% to 1.3% (#744).
- **K8s repo-cache is opt-in, default off** (warren-554f, #719), and
  the event bridge drops the remaining per-delta noise events
  (warren-ef12, #714).
- **CI action bumps** — docker buildx/build-push/login/qemu and
  actions/checkout moved to their next majors (#700–#705).

### Fixed

- **In-pod salvage reaches the control plane again** (warren-7c1e).
  `POST /runs/:id/salvage` was missing from
  `RUN_CALLBACK_ROUTE_PATTERNS`, so the run-scoped token every pod
  carries (warren-57fd) was refused 403 on the one route that banks a
  run's otherwise-unrecoverable commits before the `emptyDir` dies. The
  route now sits in the allowlist, still pinned to its own run id and
  still refused once that run is terminal.
- **K8s pod-log follow honesty** — the follow's half-open blind window
  is bounded (warren-029d, #717) and the pod exits non-zero when the
  in-pod finalize never delivers (warren-4d6a, #718), closing the
  warren-3047 silent-discard root cause. `warren run` no longer races
  burrow finalize under the local runtime either (warren-2909, #713).
- **Healer routing and retry accounting** — `projectMapping` no longer
  routes by case-insensitive substring match, so a short project name
  can't shadow a longer one (#764), and the retry cap is no longer
  computed over only the 500 most recent `heal.dispatched` events
  (#762).
- **Plan-run correctness** — `promptTemplate` must contain `{seed_id}`
  or the dispatch is refused (warren-b3be, #761); `plan_run_children`
  and `run_previews` writes now go through transition tables instead of
  accepting any state jump (#760).
- **Reap PR seed attribution** no longer takes the first regex hit on
  the operator prompt (#765), and `writeSeedExtensions` no longer drops
  the trigger key for five of the eight trigger kinds (#763).
- **Finalize-wire stage validator** derives from the `FinalizeStage`
  union instead of hand-listing six of its seven values (#756).
- **UI**: burrow-labelled surfaces use runtime-neutral copy
  (warren-0965, #712) and Run analytics behavior sections gate on
  `readOperator` (warren-bba5, #711).
- **Analytics window is bounded when `to=` is supplied without `from=`**
  (warren-30cc, #709).

## [0.13.1] — 2026-07-31

### Security

- **Event-stream scrubber redacts URL userinfo, DSN passwords, and
  JWTs** — credential shapes that previously survived into persisted
  run events are now masked (warren-6fa0, #675). A follow-up widened
  the scrubber's coverage as part of the seam-precursors work
  (warren-9bbc, #683).

### Added

- **Nightly acceptance CI** — the remaining acceptance scenarios now
  run in CI on a nightly schedule (#694), and the suite was un-rotted
  after the pl-3a79 registry collapse (warren-e376, #695).
- **Operator-configurable bot identity** via `WARREN_BOT_NAME` /
  `WARREN_BOT_EMAIL` (default `warren <bot@warren.invalid>`), plus a
  loud warn-level fallback when the agent author identity is unset
  (warren-02cd, warren-6a28, #677).
- **Lifecycle bus production emits** for `run_started` and
  `event_emitted` (warren-28ca, #680), and seam precursors: a
  capability-flags module, a 429 `rate_limited` failure class, and
  wider wire-type guard stems (warren-9bbc, #683).
- **`warren doctor --verbose`** surfaces raw probe output
  (warren-2d14, #691).
- **K8s ephemeral-storage knobs** — pod ephemeral-storage
  requests/limits are now env-configurable (warren-4a95, #706).
- **Auto-merge admits the deployment bot** via the
  `AUTO_MERGE_BOT_LOGIN` repo variable (warren-980f, #679).

### Changed

- **js-yaml 4 → 5** — config parsing migrates to js-yaml v5
  (named `load`/`dump` imports, bundled types replace `@types/js-yaml`;
  warren-381c, #637). Empty or comment-only `.warren/*` YAML files still
  parse as "absent". v5's `load` uses the YAML 1.2 `CORE_SCHEMA` (no
  `!!merge` by default, `yes`/`no`/`on`/`off` are strings) and `dump`
  quotes per YAML 1.1, so `warren init` / `warren config migrate` output
  may differ cosmetically — semantics are unchanged.
- **K8s `GET /runs/:id/events` closes after replay** instead of
  following the live stream; the UI resumes via `sinceSeq` on
  lifetime-cap close and the stream lifetime cap defaults ON
  (#699, warren-3995, #693).
- **`GET /agents` row shape is canonical in `src/core/wire.ts`**
  (warren-4253, #688), and the UI dispatch dialogs migrated off
  `renderedJson.frontmatter` (#690).
- **Functional bwrap probe** — `/readyz` now proves bwrap can actually
  nest a sandbox instead of only checking `--version`, with honest
  sandbox reporting on macOS (#684).
- **The warren project itself defaults to
  `openrouter/moonshotai/kimi-k3`** on the pi harness (#681).
- **Rule-8 deletions** — dead `mergePullRequest` code and the pause
  machinery are gone (#682), and per-delta `message_update` telemetry
  was dropped from event persistence.

### Fixed

- **K8s finalize honesty** — the reaper now outlasts warren's slowest
  reap path, and `finalize_unposted` (agent never posted a result) is
  split from `finalize_failed` so silent work discard is visible
  (warren-5ea1, #698). `finalize_failed` runs are salvaged before their
  workspace is destroyed (warren-cd3b, #685).
- **Kubelet evictions surface as the run's failure cause** instead of a
  generic pod loss (warren-4a95, #706).
- **Ref-dispatch cuts the k8s workspace from the target ref**, not the
  project's default branch (warren-dac8, #697), and
  `spec.baseBranch` is forwarded in
  `LocalProvider.buildBurrowsUpInput`, unlocking custom base branches
  under the local runtime (#673).
- **`warren add-project` no longer bypasses the public org allowlist**
  — the CLI goes through the same `addProject` path as the API (#689).

## [0.13.0] — 2026-07-30

### Security

- **Per-run scoped tokens** — run pods no longer receive the
  full-capability operator token (`WARREN_API_TOKEN`). Each run gets its
  own scoped token instead (warren-57fd, #666).

### Added

- **Tier-1 observation event bus** on `RunEventBroker`
  (`warren-ext/v1`), wired into the run lifecycle, with the healer as
  its first proof consumer (warren-bb60 #653, warren-4e74 #655).
- **CI builds the container image on every PR** (warren-3380, #667), so
  an unbuildable commit can no longer reach a tagged release — the
  failure class behind the dead `v0.12.0`/`v0.12.1` tags.
- **Discord release announcements** — new releases are announced in the
  `#releases` channel (#648).
- **Multi-arch public image** — the `ghcr.io/…/warren` tags self-hosters
  pull are now built for `linux/amd64` and `linux/arm64`, fixing runs
  dying under emulation on Apple Silicon; GKE-internal Artifact Registry
  images stay amd64 (warren-fe9f, #671).

### Changed

- **Release ordering: draft until the image exists** — the release
  workflow now creates a *draft* GitHub release, waits for the deploy
  job to push `ghcr.io/…/warren:vX.Y.Z`, then promotes the draft and
  announces (warren-89f2, #668). A release is never public before its
  image is pullable.
- **Finalize contract generalized to opaque artifact deltas**;
  seed-close moved onto the observation bus (warren-df3e, #657).
- **Canopy tiers deleted** — the library tier (`CANOPY_REPO_URL` clone
  path, `POST /agents/refresh`, `warren register-agent`) (#646) and the
  project tier (#650) are gone; the agent registry is collapsed to the
  inline built-ins. Workspace seed drop moved off `.canopy/agent.json`
  (warren-5585, #654).
- **Audit Warden agents retired**; nightwatch stays as the example
  (#644). All scheduled agents are disabled by default in
  `.warren/triggers.yaml`.
- README container advice pinned to the first buildable image tag,
  `:v0.12.2` (#669).

### Fixed

- **Project delete cascades to runs and events** (warren-41b3, #651).
- **Article IX CI gate failed open on every PR** — it now reads the
  diff from git (#649).
- **Reap treats harness-owned scratch state as a no-op**, not a
  `dropped_commit` (#643).
- UI fixes for spectators/visitors: run analytics no longer crash on
  redacted cost fields (warren-e274, #665), empty-state copy is
  capability-aware (warren-b67b, #661), and the dead agent link is
  repaired with wire enums humanized (#664).

## [0.12.2] — 2026-07-28

**This is the first buildable 0.12 release.** `v0.12.0` and `v0.12.1`
are tagged but have no container image — each hit a different build
failure. Pin this one. The application code is identical to 0.12.0.

### Fixed

- **`fix(deps)`** — the root `bun.lock` is regenerated to agree with
  `package.json` (warren-1841). Dependabot raised `jscpd` to ^5.0.12 and
  `typescript` to ^7.0.2, but the lockfile still carried ^4.2.4 and
  ^6.0.3, so the image's `bun install --frozen-lockfile` refused. The
  gates never saw it: `check:all` runs against an already-installed tree
  and no gate installs from a frozen lockfile.

## [0.12.1] — 2026-07-28

`v0.12.0` is tagged but has no container image — its commit cannot be
built. This release carries the build fix, but is itself unbuildable for
a second, unrelated reason (see 0.12.2). Nothing in the application
changed.

### Fixed

- **`fix(docker)`** — the image's UI stage now copies `src/core` beside
  `src/ui` (warren-1841). warren-b229 moved the wire vocabulary into
  `src/core/wire.ts` and `src/ui/src/api/types.ts` imports it across that
  package seam, but the stage copied only `src/ui`, so the specifier
  pointed outside the build context and the build died with TS2307. All
  12 gates and `bun run build:ui` stayed green throughout, because a full
  checkout has the file — no gate builds the image, which is why the
  first sighting was a release build.

## [0.12.0] — 2026-07-28

The public-instance release. Warren can now serve a read-only audience
over the same routes an operator uses, without a second codebase and
without a reverse proxy in front. Anonymous callers get a capability set,
not a bypass: every route is classified, every response is projected, and
the instance refuses to boot if its registered projects fall outside the
allowlist.

Set `WARREN_AUTH=public` to turn it on. Absent or blank keeps the
instance private, which is what every existing deployment already has.

### Breaking

- **`@os-eco/warren-cli` SDK** — `RUN_TERMINAL_STATES` and
  `PLAN_RUN_TERMINAL_STATES` change from `ReadonlySet<RunState>` to a
  readonly tuple (warren-b229 / warren-c92a). The SDK used to keep its own
  `new Set([...])`; it now re-exports the one definition in
  `src/core/wire.ts`. Callers must move from `.has(x)` to `.includes(x)`
  and from `.size` to `.length`. `isTerminalRunState(state)` is unchanged
  and is the stable way to ask the question — prefer it over touching the
  collection.

### Added

- **`feat(auth)`** — `PublicReadProvider`, a third `AuthProvider` behind a
  `WARREN_AUTH` registry resolved once at boot (warren-851b). It fails
  closed: an unrecognized value refuses the boot rather than degrading to
  a permissive default, and there is no path from a malformed setting to
  `public`.
- **`feat(auth)`** — a declarative capability policy covering all 39
  `ROUTE_TABLE` entries (warren-b875). Classification is data, not a
  per-handler check, so a new route is unreachable anonymously until
  somebody classifies it. The steering inbox, finalize-intent, `/readyz`,
  `/metrics`, cost analytics, triggers and warren-config are hard-blocked.
- **`feat(server)`** — `GET /whoami` returns the caller's actor and
  capability set (warren-e195), which is what lets the UI render one
  build for both audiences.
- **`feat(server)`** — a public-instance allowlist enforced at two points
  (warren-ce9b). `WARREN_PUBLIC_ALLOWLIST` is a comma-separated list of
  owners (`os-eco`) and/or single repos (`some-owner/some-repo`). Boot
  holds every already-registered project to it and names the offenders
  rather than serving them; `POST /projects` refuses a non-allowlisted
  repo before any clone happens.
- **`feat(ui)`** — a capability layer: the `useCapabilities()` hook, an
  `OperatorOnly` wrapper over the ~20 mutation sites, route guards on
  `/runs/new` and `/plan-runs/new`, and nav filtering (warren-f53e). A
  logged-out visitor is shown no affordance it cannot use.
- **`feat(k8s)`** — a Cloud Armor security policy and `BackendConfig` on
  the GKE Ingress for L3/L7 abuse control (warren-48d3).
- **`feat(acceptance)`** — scenario 39, the public-exposure leak
  regression (warren-c405). It asserts no blocked route answers 200
  anonymously and no redacted field appears in any anonymous response.
  This is the only scenario wired into CI, because it is the one whose
  regression is silent.
- **`scripts/register-projects.ts`** — idempotent bulk project
  registration against a running warren (warren-1841). It reads
  `GET /projects` first and skips what is already there, so a run that
  dies halfway through a batch of clones resumes instead of failing on
  duplicates.
- **`feat(lint)`** — `check:prose`, an ASD-STE100 prose guard chained into
  `lint`.

### Changed

- **`refactor(auth)`** — `AuthOk` widens into a capability-carrying
  `Actor` threaded through `RouteContext` (warren-1ff0). Pure refactor,
  no behavior change; it is the seam the rest of the release hangs on.
- **`refactor(types)`** — the canonical wire vocabulary moves into
  `src/core/wire.ts`, a dependency-free kernel the SDK, the drizzle
  columns and the Vite-bundled UI all re-export (warren-b229). Three
  drifts died with it: `RunFailureReason` was missing `finalize_failed`
  and `evicted` in two copies, the UI still typed the deleted
  `interactive` run mode, and `RefreshAgentsResponse.removed` was
  `{name}[]` against a server truth of `string[]`.
- **`feat(lint)`** — `check:wire-types` forbids redeclaring a canonical
  wire name outside that kernel (warren-d371). It derives the enforced
  list from `src/core/wire.ts` at run time, because a hard-coded second
  list would itself be the drift class the guard exists to prevent.
- **`feat(gates)`** — the burrow-boundary guard generalizes into
  `check:layers`, a data-driven gate reading `scripts/layer-rules.json`
  (warren-89a6). Seven seams ship; a new one is a data edit and is born
  enforced.
- **`chore(gates)`** — `src/ui` comes under Biome, `check:size`,
  `check:debt` and knip (warren-c8bd). Its exclusion is why the three
  wire-type drifts above went unseen for months. Two bounded grandfather
  lists carry the pre-existing debt and only shrink.
- **`refactor(dups)`** — `defaultSpawn` is defined once instead of three
  times, and `check:dups` now sees cross-layer clones (warren-032a).
  Every copy carried a comment calling the duplication deliberate; the
  stated reason did not hold.
- **`docs`** — README truth pass with a ghcr.io quickstart and the
  deleted-feature content removed (warren-76c1); ROADMAP rewritten from
  91 KB to roughly 10 KB (warren-9600); a `docs/README.md` index plus
  three superseded design docs deleted (warren-c69e); type-placement
  guidance replaced with an explicit single-source-of-truth convention
  (warren-02f2).

### Security

- **`feat(server)`** — public projections for `GET /runs` and
  `GET /runs/:id` (warren-946f). `renderedAgentJson`, `burrowId`,
  `previewFailureMessage` and the instance-wide cost rollup are dropped;
  the prompt and the per-run cost stay, because watching what an agent
  was asked to do is the point of the demo.
- **`feat(server)`** — public projections for `GET /projects`,
  `GET /agents`, `GET /agents/:name` and `GET /analytics/runs`
  (warren-4f6c): `localPath`, `renderedJson` and `resolvedFrom` are
  dropped.
- **`feat(server)`** — a secret scrubber and public projection over the
  run event stream (warren-1cb7). `events.payload_json` holds raw agent
  transcripts, which is the largest single disclosure surface on a
  public instance.
- **`fix(server)`** — `POST /agents/refresh` no longer forwards the caught
  error's own text in its `projectErrors[]` rows (warren-bf4c). Those
  errors are canopy shell-outs, so the message carried `cn` / `git`
  stderr, the project's absolute `localPath`, and — on a clone failure —
  a remote URL with the embedded token. Each row now carries the same
  fixed stand-in the unhandled-500 path uses (warren-4385) plus the
  request id; the `code` is kept but must be identifier-shaped. The real
  message and stack go to the request logger under that id.

## [0.11.0] — 2026-07-27

The subtraction release. Two whole features — conversations (Leveret) and
plot — are deleted rather than deprecated (PHILOSOPHY rule 8), the
information-disclosure surface is closed across four routes, and the
release pipeline finally publishes a public image and tags itself.

### Breaking

- **`fix(preview)`** — preview login is now
  **`POST /runs/:id/preview/login`** with the bearer in the
  `Authorization` header (warren-e1b0). The old
  `GET /runs/:id/preview/login?token=<WARREN_API_TOKEN>` handed the
  warren token over in a query string — where it lands in browser
  history, in the `Referer` of every preview sub-resource, and in any
  proxy or analytics log on the path. The route's `isAuthExempt`
  carve-out is gone and it is auth-gated like every other `/runs/*`
  route; the handler signs the same scoped `warren_preview*` cookie but
  returns `{url}` instead of a 302 `Location`. The UI affordance becomes
  a button (tab opened synchronously, then pointed at the returned URL
  with `opener` nulled). **Any script calling the `GET …?token=` form
  must be updated.**
- **Conversations (Leveret) is deleted** (pl-3a79 phase A, #616–#620).
  Gone: the six `/conversations*` routes, `mode=conversation`, the
  `leveret` built-in agent, the conversation idle/rewake/merge
  detectors, the Chat + Shape UI surfaces, acceptance scenario 33, and
  the `conversation.idleTimeoutMs` config knob. Forward migrations drop
  the `conversations` and `messages` tables (sqlite
  `0030_moaning_tombstone`, postgres `0024_perfect_proteus`). The Audit
  Warden digest now delivers into seeds instead of a standing
  conversation (`docs/CONSTITUTION.md` amended).
- **Plot is deleted** (pl-3a79 phase B, #621, #622, #626–#628, #632).
  Gone: `src/plots/`, `src/plot-client/`, `handlers/plots/`, the twelve
  plot server routes, the plot↔plan-run bridges and the
  plot-plan-run synthesizer (SPEC §11.Q), the `PLOT_ID` / `PLOT_ACTOR`
  spawn injection, and the plot arms of `RuntimeProvider.finalize()` and
  the reap pipeline (`FinalizeIntent.commit` narrows to `"seeds"[]`).
  Forward migrations drop the `plots` table, `runs.plot_id`,
  `plan_runs.plot_id` and `projects.has_plot` (sqlite
  `0031_normal_johnny_blaze`, postgres `0025_black_santa_claus`).

### Added

- **`ci`** — the control-plane image is published to
  **`ghcr.io/jayminwest/warren`** (warren-26be), tagged `:vX.Y.Z`,
  `:X.Y` (withheld for prereleases), `:$SHA` and `:latest`, pushed from
  the existing build job under `permissions: packages: write` — no new
  secret. `docker-compose.yml` now *pulls*
  `ghcr.io/jayminwest/warren:${WARREN_IMAGE_TAG:-latest}` instead of
  building from source (the `build:` block is retained commented-out for
  contributors, and the acceptance harness re-adds it via its compose
  override). Images stay `linux/amd64`; multi-arch is out of scope.
- **`feat(release)`** — `bun run version:bump <major|minor|patch|X.Y.Z>`
  (`scripts/version-bump.ts`, warren-16b5) rewrites all four version
  sites in one shot — `package.json`, `src/index.ts`, `docs/openapi.yaml`
  (via a `gen:openapi` re-run) and the README `## Status` semver — and
  drafts an `[Unreleased]` CHANGELOG block from
  `git log <last-tag>..HEAD` fenced by a pair of `version-bump:draft`
  HTML comments. The draft is assistive only; curation stays human. Every
  rewrite is computed before any write, and a failure rolls all of them
  back.
- **`feat(release)`** — `bun run check:version-sync`
  (`scripts/check-version-sync.ts`, warren-0210), chained into
  `bun run lint`, asserts on every PR that the four version sites agree
  **and** that the `@os-eco/burrow-cli` pin agrees across the Dockerfile
  global install, the `package.json` range and every README mention. The
  README locator is imported from `version-bump.ts` so the bumper and
  the gate can never disagree. It caught a README pin that had drifted
  to 0.3.12 against a Dockerfile installing 0.3.15, and a stale README
  version tag (#633).

### Changed

- **`ci`** — the release job now runs `ui:install` + the **full**
  `check:all` manifest instead of a hand-picked 4 of 12 gates
  (warren-8b5f), so a release can no longer ship code CI would have
  rejected. A missing or empty `## [X.Y.Z]` CHANGELOG section is now
  **fatal** — the silent `--generate-notes` fallback is gone. Post-deploy
  verification additionally polls the ingress `/version` until it reports
  the released semver, and a sibling `pat-heartbeat` job turns an expired
  `AUTO_MERGE_PAT` (which silently stops merges, and therefore releases)
  into a red X without gating the release.
- **`ci`** — `deploy-gke.yml` drops its `push` trigger and its
  `k8s-migration` entries; `release.yml` is now the only automatic
  builder, so every release no longer builds twice (warren-8b5f).
- **`ci`** — `check:ci-parity` is bidirectional (warren-da69): as well as
  CI → local, every manifest gate must now be transitively invoked by
  some CI step, so a gate can never silently vanish from `ci.yml`.
  `gen:docs:check` and `gen:openapi:check` — in the manifest but never
  run by CI — are wired in. `scripts/ci-parity-config.json` gains a
  documented `localOnly` inverse of `ciOnly` (warren's is empty).
- **`docs`** — this file is split: `0.9.10` and earlier moved to
  [`docs/CHANGELOG-archive.md`](docs/CHANGELOG-archive.md), taking the
  live changelog from ~250 KB to under 20 KB (warren-222c). A Discord
  badge and section were added to the README (#623).

### Fixed

- **`fix(server)`** — unhandled throws no longer forward `err.message`
  verbatim in the 500 envelope (warren-4385), which leaked subprocess
  stderr (`sd` / `git`), filesystem paths and driver strings from every
  route. `renderError` splits body from log: `WarrenError` subclasses and
  backend code-passthrough envelopes are unchanged, any untyped throw
  renders a fixed `internal server error` plus the request's correlation
  id, and the full message + stack move to the server log under the same
  `request_id`.
- **`fix(diagnostics)`** — `GET /readyz` stopped publishing
  secret-adjacent detail (warren-51de): `WARREN_API_TOKEN`'s length, raw
  driver text naming the DB host/port/role, the canopy and project clone
  absolute paths, and the full `WARREN_DB_URL` on a `WARREN_DB_PATH`
  mismatch. New `src/diagnostics/redact.ts` is the single place an
  unvetted failure becomes a wire-safe reason code
  (`unreachable | auth_failed | migration_pending | unknown`), logging
  the raw text under the failing check's name — the same body/log split
  warren-4385 introduced.
- **`fix(server)`** — concurrent event-stream connections are capped
  (warren-25f6). `GET /runs/:id/events?follow=1` and its plan-run twin
  hold a connection open for the life of a run with the idle timeout
  disabled, which on a single-replica control plane was an unbounded
  connection-exhaustion vector. New `src/server/stream-limits.ts`
  enforces a per-client cap (`WARREN_MAX_EVENT_STREAMS_PER_CLIENT`,
  default 5) and an instance-wide cap (`WARREN_MAX_EVENT_STREAMS`,
  default 200); either refuses with a 503 + `Retry-After` and leaves
  attached streams untouched, `0` disables a cap. An optional
  per-connection lifetime (`WARREN_EVENT_STREAM_MAX_LIFETIME`) is off by
  default. `/metrics` gains a `warren_event_streams` saturation gauge.
- **`fix(ui)`** — `/#/runs/:id` and `/#/plan-runs/:id` served a blank
  white page in production (warren-1f12, #632). The plot deletion dropped
  `runs.plot_id` from the wire while the UI still guarded on
  `r.plotId !== null`; `undefined !== null` is TRUE, so the Plot MetaCard
  mounted and dereferenced `plotId.length`, and with no error boundary
  React unmounted the whole root. Fixed by deleting the plot UI surfaces
  outright.
- **`fix(k8s)`** — the pod watcher no longer leaves zombie runs
  (warren-4f2b, #625). A silently-stalled watch (or a missed `DELETED`
  whose resourceVersion aged out) left a phantom cache entry forever,
  masking a real pod termination from `K8sProvider.status()` and from the
  terminal-reconcile watchdog and wedging the run `running` for 30+ min.
  An independent resync timer
  (`WARREN_K8S_POD_WATCHER_RESYNC_MS`, default 5 min) force-relists in
  parallel with the watch loop and reconciles the cache against it.
- **`fix(k8s)`** — auto plan-runs no longer lose freshly created seeds
  (warren-486c, #631). On the K8s reap path the merged `.seeds`/`.mulch`
  rows were committed host-only and discarded by the next
  `git reset --hard`, so child pods cloned `origin/<ref>` and 404'd on
  seed ids that only ever existed on the host.
  `applyK8sCloneDeltas` now fast-forward-pushes the mirror commit to
  `origin/<defaultBranch>` before auto-dispatch, and a rejected push
  fails the dispatch loudly instead of silently.
- **`fix(plan-runs)`** — an empty push on a succeeded child is no longer
  scored as a trivial merge unless the child's seed still resolves
  (warren-2a8c, #630), which had conflated "the agent had nothing to
  commit" with "the agent could not find its seed and did no work".
- **`fix(ci)`** — GKE deploys actually fire on release (warren-cb81,
  #629). Releases are cut with the default `GITHUB_TOKEN` and GitHub
  suppresses workflow runs for `GITHUB_TOKEN`-created events, so
  `deploy-gke.yml`'s `release: [published]` trigger never fired and
  production stayed on the previous version. `release.yml` now calls
  `deploy-gke.yml` directly via `workflow_call` with the released SHA.

## [0.10.1] — 2026-07-21

Post-migration stabilization: closes out the k8s-migration plan
(pl-829f / warren-e176) — reap-hang fix, scheduler self-heal, and the
removal of the Fly.io hosting story.

### Fixed

- **`fix(k8s)`** — reap hang after pod exit (warren-c433): the
  post-terminal stream drain awaited `iterator.return()` on the pod-log
  stream, which could park forever and leave a completed run stuck in
  `running` with the in-pod finalize-intent poll deadlocked. The drain
  is now bounded (5s `DEFAULT_STREAM_TEARDOWN_MS`), reap parks the
  finalize intent when terminal is observed via pod exit (degrading to
  the documented finalize-timeout failure path when the pod's window
  lapsed), and a new terminal-reconcile watchdog net
  (`src/runs/watchdog-reconcile.ts`,
  `WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS`, default 120s) force-finalizes
  runs whose pod is terminal-or-gone but whose row stays non-terminal.
  Pod-log follow disconnects while a pod is still Pending now log
  quietly instead of warning every backoff.
- **`fix(scheduler)`** — self-heal missing project clones (warren-1ec7):
  a registered project whose host clone vanished (e.g. fresh PVC after
  redeploy) is re-cloned on demand (`src/triggers/project-heal.ts`)
  instead of failing every tick; failed re-clones back off (5m→1h) and
  per-project error notices (`project_failed`, `sd_list_failed`) are
  rate-limited to once per hour.
- **`fix(k8s)`** — host-side git ops authenticate without the supervisor
  (warren-57ad): bare `warren serve` (the K8s topology) injects the
  GitHub token via git `insteadOf` config for host-side clone/fetch/push
  instead of relying on supervisor-installed credentials.

### Changed

- **`chore(deploy)`** — Fly.io stripped from the hosting story
  (warren-b65c): `fly.toml` deleted, the `release.yml` flyctl deploy job
  and `FLY_API_TOKEN` removed, and README/SPEC/ACCEPTANCE/ROADMAP/env
  docs rewritten for GKE (docs/RUNBOOK-K8S.md is the canonical deploy
  procedure; `deploy-gke.yml` is the deploy automation). Historical
  references remain in CHANGELOG and the k8s-migration design docs; the
  Fly app itself is untouched as rollback.

## [0.10.0] — 2026-07-17

The Kubernetes migration release (k8s-migration branch, warren-e176):
warren now runs against a swappable runtime provider, with GKE as the
hosted topology and burrow-backed local execution unchanged as the
default.

### Added

- **`feat(runtime)`** — `RuntimeProvider` contract
  (`src/runtime/contract.ts`, docs/design/runtime-provider-contract.md):
  the warren domain depends on a provider seam resolved once at boot
  from `WARREN_RUNTIME` (`src/runtime/registry.ts`). Two backends:
  `LocalProvider` (`src/runtime/local/`, the default — wraps the
  co-tenanted burrow sandbox daemon; existing self-host/local behavior
  unchanged) and `K8sProvider` (`src/runtime/k8s/`,
  `WARREN_RUNTIME=k8s`) — each agent runs as a Kubernetes pod with no
  burrow at all; the pod boundary is the sandbox.
- **`feat(k8s)`** — public GKE exposure (warren-682a): the gke overlay now
  ships a GCE external Application LB — reserved global static IP
  (`kubernetes.io/ingress.global-static-ip-name: warren-ingress`),
  `ManagedCertificate` TLS, `FrontendConfig` HTTP→HTTPS redirect, and
  container-native load balancing (ClusterIP + NEG; no NodePort). The
  Ingress host / cert domain stay placeholders in the committed template;
  the gitignored live overlay patches in the real hostname.
- **`feat(k8s)`** — GKE Autopilot hosting: kustomize overlays under
  `deploy/k8s/`, admission gating (`admission.maxConcurrentRuns`,
  `WARREN_K8S_MAX_QUEUE_DEPTH`, `WARREN_K8S_MAX_PENDING_PODS`), pod
  watcher, in-pod finalize, and the `deploy-gke.yml` build-and-roll
  workflow. See docs/RUNBOOK-K8S.md.
- **`feat(reap)`** — dropped-commit guard (warren-495d): a finalize
  timeout or failed `branch_push` can no longer report `succeeded` and
  destroy the workspace; the run fails with an explicit
  `failureReason` and reap errors surface via `GET /runs/:id`.
- **`feat(reap)`** — seeded-artifact reset (warren-8d95): reap resets
  warren-seeded workspace paths (e.g. `.canopy/agent.json`) to base
  before `branch_push`, so seeded artifacts never ride along in agent
  PRs and trip protected-path automerge guards.
- **`feat(plan-runs)`** — deterministic child-seed closure
  (warren-3806): when a plan-run child's PR merges, warren closes the
  child seed host-side with the canonical bot identity instead of
  depending on agent initiative.

### Changed

- **Multi-worker retirement**: the single-container/one-volume Fly-era
  worker topology is retired in favor of the provider seam; under
  `WARREN_RUNTIME=k8s` there is no `burrow serve`, no unix socket, and
  `/readyz` drops the burrow/bwrap probes (warren-c128).
- **`fix(reap)`** — intentional no-commit runs are no longer
  misclassified as `dropped_commit`, and host-side seed closure never
  fires for runs that end failed/cancelled (warren-89b0).
- **`fix(server)`** — `/metrics` is no longer auth-exempt (warren-682a):
  behind a public Ingress the scrape surface leaks operational shape (run
  counts, pod phases, queue depth). The Prometheus ServiceMonitor now
  scrapes with the control-plane bearer via `authorization.credentials`
  (`warren-secrets/warren-api-token`). `/healthz` and `/version` remain
  the only auth-exempt API routes.
