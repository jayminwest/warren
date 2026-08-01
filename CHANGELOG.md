# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases **0.9.10 and earlier** live in
[`docs/CHANGELOG-archive.md`](docs/CHANGELOG-archive.md).

## [Unreleased]

### Changed

- **js-yaml 4 → 5** — config parsing migrates to js-yaml v5
  (named `load`/`dump` imports, bundled types replace `@types/js-yaml`;
  warren-381c, #637). Empty or comment-only `.warren/*` YAML files still
  parse as "absent". v5's `load` uses the YAML 1.2 `CORE_SCHEMA` (no
  `!!merge` by default, `yes`/`no`/`on`/`off` are strings) and `dump`
  quotes per YAML 1.1, so `warren init` / `warren config migrate` output
  may differ cosmetically — semantics are unchanged.

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
