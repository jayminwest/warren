# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases **0.9.10 and earlier** live in
[`docs/CHANGELOG-archive.md`](docs/CHANGELOG-archive.md).

## [Unreleased]

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
