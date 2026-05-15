# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.8] — 2026-05-15

Users can now override the OS theme from within warren.

### Added

- **`feat(ui)`** — sidebar light/dark/system theme toggle
  (`warren-d340`). New `useTheme` hook persists the user's choice to
  `localStorage.warren.theme`, writes `data-theme` on `<html>`, and only
  listens for `prefers-color-scheme` flips while in System mode. New
  `ThemeToggle` component sits directly above Log out in
  `Layout.tsx`, cycling Light → Dark → System with a Sun/Moon/Monitor
  icon and an `aria-label` describing the next state. `index.css`
  refactors the dark token block out of `@media (prefers-color-scheme:
  dark) { @theme { … } }` into a pair of selectors
  (`:root[data-theme="dark"]` for explicit overrides;
  `@media (prefers-color-scheme: dark) :root:not([data-theme])` for the
  default OS-following path) so the same tokens are reachable from
  either trigger — oklch values unchanged. An inline FOUC-guard script
  in `src/ui/index.html` reads `localStorage` and sets `dataset.theme`
  synchronously before React paints.

## [0.3.7] — 2026-05-14

Claude-code joins pi on the cost/token tracking surface, the UI gets a
visible version badge plus an autoscroll fix, this repo's own `.warren/`
config moves off the legacy JSON layout, and CI stops re-running the
full lint/test trinity on every doc/seed-sync commit.

### Added

- **`feat(runs)`** — claude-code cost tracking (#11, `warren-a7dc` /
  `warren-87f9`). `src/runs/stream.ts` gains `extractClaudeUsage`, which
  shape-sniffs the terminal `result` envelope's `total_cost_usd` +
  `usage.*_tokens` (single-shot — claude-code emits cumulative totals
  once at end). `persistInStreamPiUsage` is renamed
  `persistInStreamUsage` with a runtime tag; on terminal, pi wins if
  observed, else fall back to claude. 4 new tests cover single-shot
  extraction, malformed-result null parity, `is_error=true` still
  recording cost, and pi-winning when both shapes appear. SPEC §11.K
  broadened past pi-only with shape-sniff dispatch and pi-wins fallback
  documented.

- **`feat(ui)`** — warren version badge in sidebar (#10, `warren-6ea5`).
  New auth-exempt `GET /version` route returns `{version: VERSION}`;
  `src/ui/src/components/Layout.tsx` renders it as a muted monospace
  `vX.Y.Z` tag next to the "warren" title. The UI fetches once via
  React Query (`staleTime: Infinity`) since the value is stable for the
  process lifetime. Tests cover the route, auth exemption, and
  UI-vs-API fallback.

- **`test(acceptance)`** — scenario 21 claude-code cost smoke
  (`warren-87f9`). New `scripts/acceptance/scenarios/21-claude-code-cost-smoke.ts`
  stubs the claude-code runtime in burrow (`burrow-with-stub.ts` Map.set
  override on `AgentRegistry`), emits a stream-json result envelope, and
  asserts all five cost/token columns are non-null after the run
  terminates.

- **`branding`** — warren logo (burrow network) + README banner
  (`062aaf1`). Grayscale mark matching the UI palette: a 6-node hex
  burrow network around a central control-plane node, with one bright
  node + spoke indicating an active run. Includes the generator script
  (`branding/generate-logo.py`), 1x/2x banners, and a square icon.

### Changed

- **`config`** — this repo's own `.warren/` migrated off the legacy
  `defaults.json` layout to `config.yaml` + `preview.yaml`
  (`60318d0`, `warren-5840`). Stops the deprecation warning from firing
  in `doctor`/`readyz`. Every `DefaultsConfig` / `PreviewConfig` /
  `TriggersConfig` knob is scaffolded as a commented example in-file so
  customizing further is just an uncomment. Activates
  `runBranchPrefix=warren` so burrow branches land under
  `warren/<run-id>` instead of the built-in `burrow/<run-id>`.

- **`ui`** — autoscroll no longer turns off during event bursts
  (`339ff96`). Programmatic scrolls fire `scroll` async; during bursts
  the handler ran after more content appended and read a stale
  (non-bottom) position, silently disabling autoscroll. Re-enable only
  from `scroll`; disable via wheel-up / touch-move user intent.

- **`ci`** — scope release + postgres workflows so they don't run on
  every commit (`a27c114`). `release.yml` gains a paths filter on
  `package.json` / `CHANGELOG.md` so only version-bump commits trigger
  it (`workflow_dispatch` unchanged). `ci-postgres` split into its own
  workflow file, PRs only, with a paths filter for `src/db/**`,
  `src/preview/**`, `package.json`, `bun.lock`, and the workflow itself.

### Removed

- **`docs`** — `.warren/MIGRATION.md` and its inbound references
  (`db52729`). The guide was only useful for the one-time
  `defaults.json` → YAML transition; `warren config migrate` (in-tree)
  does the actual conversion and is enough for stragglers. README,
  SPEC, and the `init`/`config-migrate` `config.yaml` headers no
  longer point at the deleted file.

## [0.3.6] — 2026-05-14

Path-based preview mode (SPEC §11.L addendum, `warren-f4d7` / `pl-f4ea`).
The R-19 preview surface gains a second routing mode, **path mode**,
that reuses warren's single hostname + cert instead of requiring a
wildcard DNS record and DNS-01 wildcard cert. Path mode is now the
**default** for new installs; subdomain mode remains the opt-in for
multi-tenant operators (`WARREN_PREVIEW_MODE=subdomain`). A
zero-domain `fly deploy` of warren can now serve per-run previews at
`https://<warren-host>/p/<run-id>/` end-to-end on a fresh box.

### Added

- **`feat(preview)`** — `WARREN_PREVIEW_MODE=path|subdomain` env
  selector (`warren-fcb7`, `pl-f4ea` step 2). New `PreviewModeSchema`
  enum + `DEFAULT_PREVIEW_MODE = 'path'`; `loadPreviewLaunchConfigFromEnv`
  reads the env var and projects can pin a mode in
  `.warren/preview.yaml` (env wins on conflict). Invalid env values
  silently fall back to the default so operator typos never block boot.
  Downstream consumers (proxy preamble, cookie scope, PR annotator, UI
  badge) all branch on this single discriminator.

- **`feat(preview)`** — path-mode proxy preamble (`warren-8085`,
  `pl-f4ea` step 3). `PreviewProxyConfig` becomes a discriminated union
  on `mode`: subdomain mode keeps the existing `Host: run-<id>.<host>`
  match, path mode adds a sibling `^/p/<runId>(/<rest>)?$` match that
  strips the prefix before forwarding. Both branches share one inner
  pipeline (run lookup, R-12 501, 503 not-live, 426 WS, 401 cookie,
  debounced `last_hit_at`, 502 unreachable). `previewUnauthorized`'s
  401 hint is mode-aware. `parsePreviewPathPrefix` is exported
  alongside the existing `parseRunIdFromHost`.

- **`feat(preview)`** — HTML rewrite middleware for path mode
  (`warren-ab3a`, `pl-f4ea` step 4). Path-mode proxy applies two
  best-effort transforms after the upstream fetch resolves: a
  `<base href="/p/<runId>/">` injection on `text/html` responses, and
  a `Location:` header rewrite on 3xx responses with same-origin
  absolute paths. Subdomain mode and non-HTML content types pass
  through byte-for-byte. Root-relative dev-server URLs (`/assets/foo.js`,
  `Location: /signin`) now resolve correctly under the `/p/<run-id>/`
  prefix instead of 404'ing against warren's UI/API routes.

- **`feat(preview)`** — path-scoped signed cookies (`warren-edff`,
  `pl-f4ea` step 5). In path mode `signCookie` emits
  `Path=/p/<runId>/` with no `Domain` attribute, so a reviewer can hold
  simultaneous sessions for sibling runs on the same warren host.
  `previewLoginHandler` validates redirects against the inbound origin
  under `/p/<id>/` and no longer requires `WARREN_PREVIEW_HOST` when
  `WARREN_PREVIEW_MODE=path`. Subdomain mode's `Domain=.<warren-host>;
  Path=/` scope is unchanged.

- **`feat(preview)`** — mode-aware PR annotation URL shape
  (`warren-c3c4`, `pl-f4ea` step 6). `formatPreviewUrl` gains a
  `PreviewMode` arg: subdomain keeps the `https://run-<id>.<host>`
  shape, path emits `https://<host>/p/<id>/` with a load-bearing
  trailing slash so the reviewer's browser resolves root-relative
  HTML under the proxy prefix. reap's `pr_annotate_preview` branch
  threads `previewLaunchConfig.mode` through both the live-state
  annotate call and the `previewUrl` returned in the reap result.
  `WARREN_PREVIEW_HOST` is still required in both modes for annotation
  (the proxy can derive origin from inbound `Host:`, but GitHub PR
  comments need an absolute URL).

- **`feat(ui)`** — RunDetail honors path/subdomain mode (`warren-016d`,
  `pl-f4ea` step 7). New `GET /preview/config` returns `{mode, host}`
  so the UI can render the canonical preview URL string and adapt the
  teardown tooltip without duplicating server-side URL-formatting
  rules. `PreviewCard` caches the config indefinitely (only a warren
  restart changes it), surfaces a mode badge + URL line, and labels
  the teardown button with mode-specific copy.

- **`test(acceptance)`** — scenario 20 path-mode sibling
  (`warren-7b3c`). New `scripts/acceptance/scenarios/20-preview-path.ts`
  locks down the `pl-f4ea` acceptance contract end-to-end: a
  fresh-install warren with `WARREN_PREVIEW_MODE=path` and no
  `WARREN_PREVIEW_HOST` serves a working preview at
  `<warren-host>/p/<run-id>/` with anonymous 401, `/preview/login`
  cookies scoped to `Path=/p/<runId>/`, and the injected
  `<base href="/p/<runId>/">` from the `warren-ab3a` HTML rewriter.
  Skips on darwin (`mx-1d31f0`) and postgres (`mx-b82a55`) for the
  same reasons scenario 20 does.

### Changed

- **`docs(spec)`** — SPEC §11.L "Routing modes — path vs subdomain"
  addendum (`warren-1cce`, `pl-f4ea` step 1, PR #9). Locks in the URL
  contract, path-prefix preamble, HTML rewrite, cookie scope, PR
  annotation, and doctor-check behavior across both modes. The
  existing §11.L "Routing" and "Auth" paragraphs gain forward
  cross-links so the doc reads cleanly in either direction. Subdomain
  mode is preserved as the multi-tenant opt-in; eviction, port
  allocator, and reap sub-steps remain mode-agnostic.

- **`docs(readme)`** — CI auto-deploy recipe under "Deploy to Fly.io".
  Captures the `deploy` job pattern shipped in v0.3.5's `release.yml`
  so operators wiring their own warren install can copy it directly.
  Covers the one-liner token provisioning (`fly tokens create deploy
  ... | gh secret set`), the workflow snippet with the
  `needs: release` + `outputs.release` gate and named concurrency
  group, and the single-app token scope. Closes phase 4 of
  `warren-ac54`.

- **`docs(env)`** — `.env.example` documents the new
  `WARREN_PREVIEW_MODE` knob and the path-mode relaxation: when
  `WARREN_PREVIEW_MODE=path` (the default since `warren-fcb7`),
  `WARREN_PREVIEW_HOST` can be left unset and previews still resolve
  on the same host warren already binds.

## [0.3.5] — 2026-05-15

Patch release that closes the loop on `warren-ac54`'s phase-4 work
(CI auto-deploy for the `warren-deployed.fly.dev` dogfood) and folds
in a small Postgres-init migration fix that surfaced through the
ci-postgres matrix added in v0.3.4.

### Added

- **`ci`** — auto-deploy to Fly on release. `.github/workflows/release.yml`
  gains a `deploy` job that runs `flyctl deploy --remote-only --app
  warren-deployed` after the `release` job tags + publishes a GitHub
  release. Gated on `needs.release.outputs.release == 'true'` so it
  only fires when `package.json`'s version is a fresh tag (no-op pushes
  to `main` don't redeploy). Uses `superfly/flyctl-actions/setup-flyctl@master`
  + a `FLY_API_TOKEN` repo secret scoped to `warren-deployed` only. A
  named concurrency group (`fly-deploy-warren-deployed`) serializes
  overlapping releases without cancelling them. This wires the
  jayminwest/warren-deployed.fly.dev dogfood to be hands-off across
  the release flow; per-operator auto-deploy stays opt-in via each
  operator's own workflow.

### Fixed

- **`fix(db)`** — strip `"public".` qualifier from FK references in
  the pg init migration (`src/db/migrations/postgres/0000_init.sql`).
  The five `ALTER TABLE … REFERENCES "public"."<table>"` statements
  bypassed `search_path`, so the ci-postgres test matrix (which runs
  every case inside an isolated `warren_test_<hex>` schema via
  `src/db/testing.ts`) failed every `withDb()` with `relation
  "public.runs" does not exist` — 30+ failures across `testing.test.ts`,
  `port-allocator.test.ts`, `eviction.test.ts`, `triggers.test.ts`,
  and others. Unqualified names resolve via `search_path` cleanly in
  both production (default `public`) and tests (isolated schema).
  Drizzle's migrate runner skips already-applied migrations by
  `folderMillis`, so existing deployments where `0000_init` already
  applied won't try to re-run.

## [0.3.4] — 2026-05-14

Cleanup release on top of v0.3.3 — finishes the dialect-polymorphic
repo migration started under R-13 by porting the two preview modules
the original plan had deferred (`PreviewPortAllocator`, `RunPreviewsRepo`),
closes the Supabase RLS advisory on the live dogfood by enabling
row-level security on all seven public tables, bakes `pnpm` and `npm`
into the runtime image so non-bun preview sidecars can boot, and
locks in the Fly + Supabase dogfood that proved the v0.3.3 Postgres
path end-to-end.

### Fixed

- **`fix(db)`** — complete R-13 end-to-end Postgres support (`pl-f1be`,
  follow-up to `pl-f17e` / v0.3.2). v0.3.2 announced bring-your-own
  database, but the seven repos in `src/db/repos/*` were still
  sqlite-coupled internally — 15 `.get()`, 23 `.run()`, 14 `.all()`,
  and 4 sync `db.transaction()` calls across the repo layer.
  `WARREN_DB_URL=postgres://...` would boot, run migrations, and serve
  `/healthz`, then crash the moment any repo method was invoked;
  fail-fast guards in `createReposForDialect` (`src/server/main.ts`)
  and `withCliDb` (`src/cli/context.ts`) backstopped the gap with a
  pointer to this plan. New `src/db/repos/drizzle-adapter.ts`
  (~50 LOC) maps sqlite's sync `.get()` / `.run()` / `.all()` and sync
  `db.transaction()` to dialect-agnostic async equivalents (`pickOne`
  / `pickAll` / `runWrite` / `runInTransaction`); all seven repos
  (`Agents`, `Burrows`, `Projects`, `Events`, `Triggers`, `Workers`,
  `Runs`) now go through it. `createRepos` is widened to `AnyWarrenDb`
  and both dialect guards are deleted. CI grows a `ci-postgres` job
  (`.github/workflows/ci.yml`) running `bun test` against
  `postgres:16`, so the per-PR matrix exercises both dialects on every
  push. Acceptance scenario 19 (`warren-on-postgres`) now passes
  end-to-end against a real Postgres rather than skipping on missing
  `WARREN_TEST_PG_URL`. Closes `warren-5549`.

- **`fix(preview)`** — port allocator + `RunPreviewsRepo` to the
  dialect-polymorphic adapter (`warren-adfb`). The R-13 plan deferred
  these two modules from the dialect-aware repo migration; until now
  `src/server/main.ts` only constructed them when
  `db.dialect === "sqlite"`, so a pg-deployed warren silently skipped
  `preview_launch` in reap and never emitted any preview events for
  projects with `.warren/preview.yaml`. Both modules now take a
  `DrizzleAdapter` and run on either backend: `PreviewPortAllocator`
  uses `runInTransaction` with a per-instance Promise-chain mutex
  (`allocateChain`) for in-process serialization plus
  `pg_advisory_xact_lock` inside the tx for cross-process serialization
  on pg; `createRunPreviewsRepo` evicts via single-statement CAS
  (`UPDATE ... WHERE state IN ('starting','live') RETURNING {id}`) and
  serializes `claimTeardown` via `SELECT ... FOR UPDATE` on pg + the
  natural single-connection serialization on sqlite. The dialect-skip
  branches in `previewPortAllocatorReadyzCheck`,
  `previewMaxLiveReadyzCheck`, and `cli/commands/doctor.ts` are
  removed; tests for both modules now follow the dialect-polymorphic
  pattern (`mx-1d9f7a`) and run against pg when `WARREN_TEST_PG_URL`
  is set. Unblocks `warren-724e` (per-run preview sidecar dogfood on
  jayminwest.com).

- **`fix(db)`** — enable RLS on Postgres tables (`warren-b778`).
  Closes the Supabase "RLS not enabled" advisory on the
  warren-deployed dogfood. Hand-rolled migration
  `src/db/migrations/postgres/0002_enable_rls.sql` runs
  `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for the 7 public tables
  (`agents`, `burrows`, `events`, `projects`, `runs`, `triggers`,
  `workers`). Warren itself connects as the postgres superuser via
  `WARREN_DB_URL` and bypasses RLS for owners/superusers (no
  `FORCE ROW LEVEL SECURITY`), so app code is unaffected; PostgREST
  anon/authenticated traffic now sees deny-all (zero policies, RLS on).
  SQLite path is untouched — RLS is pg-only. The drift test
  (`src/db/schema/drift.test.ts`) passes because it compares column
  shape, not policies. Already applied to live Supabase (project
  `biaxgkadzaruhrqsjnmi`); the boot-time migrator will no-op on next
  redeploy since pg treats `ENABLE ROW LEVEL SECURITY` as idempotent.

### Changed

- **`build`** — bake `pnpm` and `npm` into the warren `Dockerfile`
  (`warren-810f`). Preview sidecars (R-19 / SPEC §11.L) run
  user-defined commands like `pnpm dev` / `npm run dev` inside the
  burrow sandbox. The image only shipped `bun`, so projects that
  don't use bun (e.g. `jayminwest.com` under `warren-724e`) couldn't
  boot a preview. Adds `pnpm@11.1.2` and `npm@11.14.1` to the
  existing `bun install -g` line alongside the other JS CLIs; they
  reuse the `/usr/local/bin/node` bun-shim already installed for pi
  compat (`mx-27f385`).

- **`chore(dogfood)`** — Fly + Supabase dogfood lockdown (`warren-f451`,
  `pl-f1be` step 10): `warren-deployed.fly.dev` redeployed with
  `WARREN_DB_URL=postgres://...supabase.co` set as a Fly secret;
  `/readyz` reports `db_reachable.dialect=postgres` and `ok:true`
  across all 11 checks. Test run `run_3s5gx3t1d3t1` (claude-code on
  `jayminwest/warren`) dispatched, completed in ~4s with
  `state:succeeded`, `branchPushed:true`, `commitsAhead:0`, mulch
  sync read 407 records, and `reap.empty_push` correctly surfaced
  the no-commit shape (the observability fix from `warren-f3bb` /
  §11.G). End-to-end pg path through `ProjectsRepo`, `RunsRepo`,
  `EventsRepo`, `AgentsRepo`, `BurrowsRepo` validated against real
  Supabase. Operator gotcha logged: `CANOPY_REPO_URL=file:///canopy-source`
  carried over from local `docker-compose` had to be `fly secrets
  unset` on the Fly app — that path only exists inside the compose
  bind-mount, not on Fly Machines.

## [0.3.3] — 2026-05-14

R-19 (per-run preview environments) ships. Plan `pl-2c59` closed all
11 implementation steps on top of the SPEC §11.L design lock.
Operators set `WARREN_PREVIEW_HOST=preview.<your-host>` and point a
wildcard CNAME at warren; projects opt in by adding a `preview` block
to `.warren/preview.yaml` (or the legacy nested `preview:` field in
`.warren/config.yaml` / `defaults.json`). Reap's 5th best-effort sub-step launches
`preview.command` as a burrow sidecar in the same workspace, allocates
a port from the SQLite-backed `WARREN_PREVIEW_PORT_RANGE`, and waits
for readiness; a 6th sub-step patches the PR body's
`<!-- warren:preview-start --> ... <!-- warren:preview-end -->`
fragment with the live URL or the failure tail. The idle-TTL /
max-lifetime / LRU eviction worker keeps long-tail dev servers from
exhausting container memory. Browsers authenticate via a domain-scoped
signed `warren_preview` cookie issued from
`GET /runs/:id/preview/login?token=…&redirect=…`; the HMAC key is
derived from `WARREN_API_TOKEN` so operators don't manage a second
secret. RunDetail UI surfaces a status badge, an "Open ↗" link, the
failure tail when applicable, and a manual teardown button.

### Added

- **`feat(config)`** — `.warren/` YAML reorg + `warren config migrate`
  (warren-5840, follow-up under `pl-2c59`). The canonical layout is now
  one file per concern: `triggers.yaml`, `config.yaml` (global defaults),
  `preview.yaml` (hoisted from the legacy `preview:` block in defaults),
  and `pr-template.md`. The loader prefers per-concern YAML files, falls
  back to `config.yaml`, then falls back to `.warren/defaults.json`
  while appending a non-fatal `warnings[]` entry with code
  `warren_config_deprecated`. `warren init` scaffolds the YAML layout
  directly. `warren config migrate [--cwd PATH | --project ID]` reads
  the legacy `defaults.json`, hoists any `preview` block into
  `preview.yaml`, writes the rest to `config.yaml`, and deletes the
  legacy file in place. `warren doctor` / `/readyz` add a
  `warren_config_deprecations` informational check that names the
  offending file and the one-shot migration command without flipping
  red. `GET /projects/:id/warren-config` surfaces the new `warnings`
  field alongside the existing `errors`. `.warren/MIGRATION.md` ships
  with field-by-field before/after examples.

- **`feat(preview)`** — per-run preview environments (R-19, `pl-2c59`).
  Migration `0009_*.sql` adds five columns to `runs` (`preview_state`,
  `preview_port`, `preview_started_at`, `preview_last_hit_at`,
  `preview_failure_message`) in lockstep across SQLite and Postgres
  schema modules; `RunsRepo.attachPreview` mirrors `attachStats`'s
  partial-input semantics. New `PreviewConfigSchema` discriminated
  union (`type: server | static`) lives in `src/warren-config/`;
  `type: static` parses but the launcher returns a "not yet
  implemented" error pointing to the follow-up seed.
  `src/preview/port-allocator.ts` is SQLite-backed and restart-safe —
  in-use ports are derived from
  `runs.preview_state IN ('starting','live')` rather than in-memory
  state. The reap-time `preview_launch` sub-step (`src/runs/reap.ts`)
  mirrors `pr_open`'s `mx-05abb2` pattern (only `succeeded` runs,
  never fails the run, best-effort `reap_failed` event on error);
  the 6th sub-step `pr_annotate_preview` patches the PR body's
  `preview_url_or_placeholder` fragment idempotently. Idle TTL,
  max-lifetime ceiling, and global LRU cap drive the eviction worker
  in `src/preview/eviction.ts`; all eviction paths emit
  `preview_evicted` events with `reason` set. The host proxy preamble
  in `src/preview/proxy.ts` runs before the API/UI routes; cookie
  auth lives in `src/preview/cookie.ts` (HMAC key derived from
  `WARREN_API_TOKEN`). `POST /runs/:id/preview/teardown` is
  bearer-required + idempotent, emits a `preview_torn_down` audit
  event, and releases the port via the same CAS the eviction worker
  uses. RunDetail UI surfaces a `PreviewCard` keyed off `previewState`
  (`starting | live | failed | torn-down`), with the failure tail
  inlined when applicable. Acceptance scenario `20-preview.ts` runs
  on Linux (happy-path + idle-TTL eviction, both DB backends per
  `mx-1d31f0`); macOS skips per the same record. Doctor checks
  `preview_port_allocator` saturation, `preview_max_live` headroom,
  and `WARREN_PREVIEW_HOST` ↔ `WARREN_API_TOKEN` consistency. Cross-
  host routing (R-12) is explicitly deferred — the proxy preamble
  returns 501 with an R-12 deferral message for non-local workers.
- **`docs(preview)`** — operator setup section in [README](README.md)
  (wildcard CNAME, Caddy DNS-01 snippet, lifecycle knob table); SPEC
  §11.L marked shipped with cross-references to README +
  `.env.example`; ROADMAP R-19 transitioned `[in flight]` → `[shipped]`
  with Wave 3 entry updated. New env vars documented in
  `.env.example`: `WARREN_PREVIEW_PORT_RANGE`,
  `WARREN_PREVIEW_IDLE_TTL`, `WARREN_PREVIEW_MAX_LIFETIME`,
  `WARREN_PREVIEW_MAX_LIVE`, `WARREN_PREVIEW_EVICTION_TICK_MS`,
  `WARREN_PREVIEW_EVICTION_DISABLED`.

## [0.3.2] — 2026-05-14

> **Correction (2026-05-14):** This release announced R-13 as shipped,
> but the repo layer in `src/db/repos/*` was still sqlite-coupled at
> the implementation level — `WARREN_DB_URL=postgres://...` would boot
> and run migrations cleanly, then crash the moment any repo method was
> invoked. The async-everywhere refactor, schema split, per-dialect
> migrations, dialect-aware `openDatabase`, and `migrate-to-postgres`
> porter described below all landed as advertised; the dialect-
> polymorphic repo layer that makes them actually work against
> Postgres ships under plan `pl-f1be` — see the [Unreleased] entry
> above and `warren-5549`.

R-13 ships: warren now supports Postgres as an opt-in backend via
`WARREN_DB_URL=postgres://...` (default stays sqlite). The work
landed across nine sequenced steps in plan `pl-f17e` — async-everywhere
repo layer, schema split into a shared columns module + parallel
sqlite/postgres tables, per-dialect drizzle configs with an initial
pg migration set, dialect-aware `openDatabase` + URL parsing, env
plumbing through server / CLI / doctor / readyz, an env-gated
`withDb()` test helper, acceptance scenario 19 (warren-on-postgres,
twin of scenario 06), and a `warren db migrate-to-postgres` one-shot
porter for existing sqlite operators. R-12 also picks up its real
end-to-end acceptance harness in scenario 18 (multi-worker affinity,
drain failover, cross-worker fan-out). R-19 (per-run preview
environments) reaches design lock in SPEC §11.L; no runtime code
yet.

### Added

- **`feat(db)`** — bring-your-own database backend (R-13, `pl-f17e`).
  `WARREN_DB_URL` selects the dialect (`sqlite://path` or
  `postgres://...`); the legacy `WARREN_DB_PATH` synthesizes into
  `sqlite://` and a conflict between the two surfaces as a
  `logger.warn` plus a `warren_db` doctor failure. `parseDatabaseUrl`
  (`src/db/url.ts`) is the single seam — `openDatabase` now returns
  the union `AnyWarrenDb` for `{ url }` callers and narrows on
  `dialect`. SQLite stays the zero-config default; Postgres uses
  `pg.Pool` with drizzle's `node-postgres` adapter. Schema lives in
  parallel modules (`src/db/schema/sqlite.ts`,
  `src/db/schema/postgres.ts`) over a shared `columns.ts` (enum
  tuples, type unions, table + index name constants). Drift between
  the two is enforced by `src/db/schema/drift.test.ts` — byte-
  identical column lists, nullability, PKs, FK targets + onDelete,
  and index names + columns; sanctioned dialect-specific bits
  (`jsonb`, `doublePrecision`, `serial`) are intentionally not
  compared. The repo layer (`src/db/repos/*`) is now async-everywhere
  — every public method on the 7 repos plus `WarrenDb.close()`
  returns a `Promise`; ~51 production call sites and ~30 test files
  picked up `await`, and cascading consumers (placement,
  `BurrowClientPool`, `bootBridges`, `recoverActiveRunStreams`,
  `buildTriggerSummaries`, `mergeMulchFile`, `seedBuiltinAgents`,
  `listProjects`) became async too.
- **`feat(cli)`** — `warren db migrate-to-postgres --from <sqlite>
  --to <pg-url>` (`warren-14ac`). Copies a populated sqlite
  `warren.db` into a fresh Postgres database with `INSERT ... ON
  CONFLICT DO NOTHING`, preserving PKs byte-for-byte and advancing
  the events serial sequence so subsequent warren-on-pg appends
  don't collide with seeded rows. FK-safe table walk:
  `agents → projects → workers → burrows → runs → events → triggers`.
  Source opens with `skipMigrations:true` (read-only intent); target
  migrates on open so a fresh empty pg DB is a valid `--to` target.
  Cross-dialect row passthrough works field-for-field because the
  drift test keeps the schemas byte-identical at the column-list
  level.
- **`feat(diagnostics)`** — `db_reachable` check in `warren doctor`
  and `/readyz` (`warren-e2ea`). `pingDatabase` issues a trivial
  `SELECT 1` (sqlite) or `SELECT 1` over `pg.Pool` (postgres) and
  reports the active dialect in the result. Replaces the implicit
  "db is reachable iff openDatabase didn't throw at boot" posture.
- **`feat(db,test)`** — dialect-aware `withDb()` helper
  (`src/db/testing.ts`, `warren-c823`). Opens an isolated,
  freshly-migrated database for one test and returns a handle with
  `Symbol.asyncDispose`. SQLite path uses `:memory:`; Postgres path
  mints a unique `warren_test_<8hex>` schema, appends `options=-c
  search_path=<schema>` to the pool URL, and pins drizzle's
  `__drizzle_migrations` into the same schema so `DROP SCHEMA
  CASCADE` reaps everything on close. Env-gated on
  `WARREN_TEST_PG_URL` — local dev stays on sqlite, CI matrix opts
  in.
- **`test(acceptance)`** — scenario 18: real multi-burrow R-12
  acceptance (`warren-82ea`). Boots its own warren +
  alpha-burrow + beta-burrow stack via a new `bootInProcMulti`
  helper, then drives the three R-12 criteria through warren's HTTP
  API end-to-end: project-affinity (P-affinity = alpha → next P
  lands on alpha, unaffinitized Q goes to beta via least-loaded),
  failover-on-drain (`POST /workers/alpha/drain` forwards
  `/admin/drain`; the next P run fails over to beta; sticky-by-
  burrow still routes `GET /burrows/<alpha-pinned>` to draining
  alpha), and cross-worker fan-out (`GET /burrows` unions both
  workers; SIGKILL alpha surfaces it in `workerErrors`). Stretch:
  alpha-unreachable → `GET /burrows/<id>` returns 503
  `sticky_worker_unreachable` instead of silent re-placement.
- **`test(acceptance)`** — scenario 19: warren-on-postgres
  (`warren-480a`). Twins scenario 06 (restart-recovery) but writes
  to Postgres. Skip-gated on `WARREN_TEST_PG_URL` via a new
  `ScenarioSkipped` + `skipScenario(reason)` harness primitive so
  env-gated scenarios record as `status=skipped` (not `failed`).
  Per-scenario isolation uses a fresh `CREATE DATABASE` on a
  maintenance connection so warren's drizzle bookkeeping lives
  inside the per-scenario DB and is reaped by `DROP DATABASE …
  WITH (FORCE)`. Adds `bootInProc.dbUrl` so scenarios can point a
  spawned warren at a non-default URL.

### Changed

- **`refactor(db)`** — schema split into shared columns + parallel
  dialect tables (`warren-c8d1`). The runtime import surface is
  unchanged — `src/db/schema.ts` re-exports `columns.ts` +
  `sqlite.ts` so every existing repo / consumer import keeps
  working. New code targets `src/db/schema/{sqlite,postgres}.ts`
  directly via the per-dialect drizzle configs (`warren-373e`):
  `db:generate:sqlite` and `db:generate:postgres` write under
  `src/db/migrations/{sqlite,postgres}/` with independent histories
  (sqlite walks 0000-0008 including the 12-step ALTER in 0003 with
  no pg analogue; postgres starts at a single 0000_init that builds
  the final state). `src/db/migrations/migrations.test.ts` is the
  parity smoke test (journal well-formedness + idx contiguity).
- **Docs**: SPEC §3.2 strikes the "no bring-your-own database" V1
  non-goal; §6 Tech Stack lists both backends; §10.1 / §10.2 /
  §11.J document the `WARREN_DB_URL` flip and the
  migrate-to-postgres porter. README and ROADMAP flip R-13 to
  shipped. `docker-compose.yml` and `fly.toml` comments call out
  the dual-backend story so operators see Postgres as the org-
  scale path.
- **Docs (R-19 design lock)**: SPEC §11.L lands the per-run preview
  environments design (`pl-2c59`) — same-sandbox not forked, signed-
  cookie auth, in-process Bun proxy with `last_hit_at` update-
  before-response, restart-safe SQLite port allocator keyed off
  `runs.preview_state`, idle-TTL as primary kill-rule + max-lifetime
  ceiling + global LRU + manual teardown, two best-effort reap sub-
  steps (`preview_launch` + `pr_annotate_preview`) with a
  `<!-- warren:preview-placeholder -->` fragment so PR open never
  blocks on preview ready. No runtime code yet — implementation
  follows in subsequent releases.

### Build

- **`deps`** — adds `pg ^8.13.1` and `@types/pg ^8.11.10` (R-13).
  SQLite remains the default; the pg driver is loaded lazily by
  `openDatabase` only when `WARREN_DB_URL` resolves to a postgres
  URL, so sqlite-only installs incur no runtime cost.

## [0.3.1] — 2026-05-13

Patch follow-through on the 0.3.0 multi-worker substrate plus a UI
polish pass on cost / events / agents. The remaining per-resource
burrow calls (cancel / steer / reap / bridges) now route through
`BurrowClientPool.clientFor` so control-plane ops hit the worker that
actually owns each burrow; the legacy `deps.burrowClient` singleton and
`pool.singleton()` scaffolding are gone. `bootBridges` no longer
crash-loops the supervisor on pre-`pl-9ba1` placement orphans. The pi
cost / tokens columns introduced in 0.1.7 (warren-17a4) get scenario-16
acceptance coverage end-to-end, and the Runs page now defaults the
Cost column on. Burrow CLI bumps `0.2.12 → 0.3.0` for the multi-worker
wire pieces (`--bind-host`, `POST /admin/drain`, `GET /burrows/:id/files`).

### Added

- **`feat(ui)`** — Cost column on `/runs` is on by default (warren-a7ec).
  Pi runs (the common runtime) reliably hydrate `costUsd` via in-stream
  extraction (`warren-17a4`), so the column carries signal for most
  installs. The Show cost toggle remains as a hide option; localStorage
  persists the choice. Card header now shows a total-of-loaded-runs
  aggregate next to the run count. On `/runs/:id`, the small header
  cost badge with a hover-only token tooltip is replaced by a dedicated
  `CostCard` inside the meta grid that renders `formatCostUsd(costUsd)`
  in `font-mono text-lg` and the in/out/cache-r/cache-w breakdown inline.
- **`feat(reap)`** — structured auto-PR title and body (warren-9ee3).
  Title precedence: seed title → first commit subject → first prompt
  line → synthetic fallback. Body adds Summary, Run, Seeds, Commits,
  and Files-changed sections; the original prompt now lives in a
  collapsed `<details>` block so the audit trail survives without
  dominating the PR. `reap.ts` gathers commits via
  `git log --reverse <base>..HEAD`, files via `git diff --stat`, and an
  optional seed title via `sd show <id> --format json` before calling
  `buildPrContent`. Each sub-call swallows errors so a missing `sd` CLI
  or bad base ref degrades to a less-rich body rather than failing the
  `pr_open` step.
- **`test(burrow-client)`** — cross-process two-burrow integration test
  for R-12 (`src/burrow-client/integration.cross-process.test.ts`).
  Spawns two real `burrow serve` subprocesses on unix sockets with bearer
  auth, builds a real `BurrowClientPool.fromConfig` over them, and
  asserts the wire pieces that in-process stubs can't prove: `pool.probe()`
  round-trip, authenticated `burrows.list` via shared `BURROW_API_TOKEN`,
  anonymous client rejected with 401, `fanOutAcrossWorkers` unioning
  burrows from both workers, `client.setDrain(true)/(false)` against
  the real `POST /admin/drain`, partial-failure surfaces as
  `worker_unreachable`, and sticky-by-burrow against a killed worker
  raises `StickyWorkerUnreachableError` (placement risk #5, fail loudly).
  Cross-host topology (TLS, network partitions) remains the territory of
  acceptance scenario 18 (`warren-82ea`).
- **`test(acceptance)`** — scenario 16 asserts non-null pi cost/token
  columns end-to-end after a pi run (`warren-17a4`). New
  `scripts/acceptance/lib/stub-agent/pi-agent.sh` fixture emits pi v0.74
  RPC JSONL (response → `agent_start` → `turn_start` → user/assistant
  `message_start`/`end` → `turn_end` with `message.usage.cost.total` +
  tokens → `agent_end`). `burrow-with-stub.ts` registers a custom `pi`
  `AgentRuntime` by spreading the declarative config and overriding
  `parseEvents` with `parsePiEvents` from `@os-eco/burrow-cli`, bypassing
  burrow's `outputFormat` enum (`raw-text` / `stream-json` /
  `jsonl-claude`) with zero burrow changes.

### Changed

- **`refactor(runs,server)`** — route cancel / steer / reap / bridges
  via `BurrowClientPool.clientFor({burrowId})` so control-plane ops
  hit the worker that actually owns each burrow (`warren-c0c9`).
  `cancelRun` / `steerRun` / `reapRun` / `bridgeRunStream` +
  `recoverActiveRunStreams` (`src/runs/`) now take a
  `BurrowClientPool` instead of a `BurrowClient`. `bridgeRunStream`
  input grew a `burrowId` field; `BridgeRegistry.start` signature
  gained a third `burrowId` arg (handlers, scheduler, `bootBridges`
  thread it through). `/readyz` uses `checkBurrowPoolReachable`
  (aggregates `pool.probe()` across workers); `warren doctor` keeps
  the single-client `checkBurrowReachable`.
  `StickyWorkerUnreachableError` propagates as-is (already 503-mapped).
  `deps.burrowClient` is removed from `ServerDeps` and
  `pool.singleton()` is deleted — every consumer now resolves a client
  via `placeFor` or `clientFor`. The CLI `warren run` fan-outs across
  `pool.entries()` for the burrow-run state lookup (single-worker
  today; correct under multi-worker too).
- **Burrow CLI bumped `0.2.12 → 0.3.0`** — burrow v0.3.0 lands the
  multi-worker substrate (`--bind-host`, `POST /admin/drain`,
  `GET /burrows/:id/files`). Additive: warren's defaults and
  single-host posture are unchanged. Pin bumped in all three lockstep
  locations (`package.json` + `bun.lock` + `Dockerfile` global
  install — see CLAUDE.md "Relationship to burrow"). Mulch + seeds
  Dockerfile pins stay at `0.9.0` / `0.4.3` (next public versions not
  released yet).

### Fixed

- **`fix(server)`** — stop `bootBridges` crash-looping on burrow
  placement orphans (`warren-018a`). Two layers landed: (1)
  `bootBridges` now pre-flights `repos.burrows.get(burrowId)` and
  skips pre-`pl-9ba1` orphans with `reason='no_placement'`, mirroring
  the existing `no_burrow_id` / `no_burrow_run_id` skip patterns. (2)
  `registry.start` chains `.catch` before `.finally` on the
  fire-and-forgotten `done` promise — defends against **all**
  bridge-startup throws (placement, transient pool errors, etc.) so
  the supervisor no longer crash-loops under docker
  `restart: unless-stopped`. The throw is surfaced as a
  `kind='bridge_fatal'`, `stream='system'` event so the UI shows why
  the bridge stopped.
- **`fix(ui)`** — one-line-per-event with expand on run detail
  (`warren-3ad4`). The Events card rendered each event as a stringified
  payload inline, so a 300+ event pi run became a wall of escaped
  JSON. Render each event as a single-line `<details>` summary
  (`seq · HH:MM:SS · kind · stream · derived summary`) with
  click-to-expand pretty-printed JSON. `summarizeEvent()` defensively
  probes payload shape per kind so `state_change` / `turn_end` shows
  `message (toolCall: X) · usage in/out · $cost`, `reap.*` surfaces
  `branchPushed` / `commitsAhead` / `prUrl`, and `tool_*` / `text`
  fall back to `name+exit` / first-text. Unknown shapes degrade to a
  truncated JSON dump — full payload is still one click away.
- **`fix(ui)`** — wrap agent panel content and render definition
  structurally (`warren-f755`). Long system prompts in the Agents page
  expanded row used to widen the table and trigger page-level
  horizontal scroll. Replace the raw `JSON.stringify <pre>` with a
  structured `AgentDefinitionPanel`: metadata grid
  (name / version / source / provider / model / tags), `resolvedFrom`
  breadcrumb, each `sections.*` as a collapsible `<details>` with the
  system prompt expanded by default, and a "View raw JSON" toggle for
  parity. All `pre`/text blocks use `whitespace-pre-wrap` +
  `break-words` inside a `max-w-0` cell, so the panel wraps at the
  row width instead of widening the table.

### Build

- **`ci(auto-merge)`** — `.github/workflows/auto-merge.yml` enables
  GitHub's built-in auto-merge (squash) on PRs authored by the repo
  owner so they merge the moment the `ci` check is green. Outside
  contributors' PRs are skipped by the author guard — they still run
  CI but require a manual merge action. Pairs with the repo-side
  changes already applied (`allow_auto_merge=true`,
  `delete_branch_on_merge=true`; branch protection on `main` with
  required reviews dropped, `ci` check still required with strict
  mode).

## [0.3.0] — 2026-05-13

Lands the multi-worker placement substrate (`pl-9ba1`, parent
`warren-6747`) end-to-end — workers + burrows tables, a placement helper,
`BurrowClientPool` replacing the `fromEnv` singleton, fan-out + sticky
reads, a probe loop with a `/workers/:name/drain` admin API, a TOML
`[workers]` block in `warren.toml`, and a two-worker integration test
asserting the full round-trip. Pi gains real per-run cost + token
accounting via in-stream `turn_end` usage extraction (warren-17a4) — no
out-of-band RPC fetch. Spawn now composes the burrow workspace branch as
`${prefix}/${run.id}` so PR-review breadcrumbs back-reference the warren
run row instead of an opaque `burrow/<id>` (warren-9993). The pi
`agent_end` predicate is repaired to match burrow's real wire shape
(warren-36c0).

### Added

- **`feat(db)`** — `workers` table (drizzle migration 0007) keyed by
  `name`, with `url`, `state` enum (`healthy` / `draining` /
  `unreachable`, default `healthy`), and `addedAt`. Bearer token
  intentionally omitted — the pool shares a single `BURROW_API_TOKEN`
  across every worker (`pl-9ba1` alternative #3). `WorkersRepo` gains
  `upsert` / `setState` / `get` / `require` / `listAll` / `delete`;
  `upsert` preserves existing state when the patch omits it so config
  reloads don't clobber probe / drain-derived liveness, and preserves
  `addedAt` while updating `url` (`warren-b0a3`, `pl-9ba1` step 1).
- **`feat(placement)`** — `burrows` table as the source of truth for
  `{burrow_id → worker_id}`, plus a denormalized `runs.worker_id`
  column for join-free routing on stream / cancel / steer paths. Two
  pure helpers in `src/runs/placement.ts`: `placeForProject` runs
  project-affinity → least-loaded round-robin with alphabetical
  tiebreak, excluding `draining` + `unreachable` workers;
  `placeForBurrow` is sticky-by-burrow and fails loudly on an
  unreachable pin rather than silently migrating (`pl-9ba1` risk #5).
  `RunsRepo` grows the column-family for `worker_id` (`warren-135b`,
  `pl-9ba1` step 2).
- **`feat(burrow-client)`** — `BurrowClientPool` replaces
  `BurrowClient.fromEnv()` as the multi-worker successor. Holds
  `Map<workerName, BurrowClient>`; `placeFor({projectId})` and
  `clientFor({burrowId})` wrap the placement primitives from step 2.
  Today's zero-config boot synthesizes a single `local` worker row
  from `WARREN_BURROW_*` env vars; `[workers]` blocks register
  additional entries. `pool.singleton()` is back-compat scaffolding
  `bootServer` uses to derive the legacy `burrowClient` variable for
  bridges / scheduler until subsequent steps migrate them off
  (`warren-41a2`, `pl-9ba1` step 3).
- **`feat(runs)`** — `SpawnRunInput.burrowClient` becomes
  `burrowClientPool: BurrowClientPool` so each new burrow is placed on
  a worker **before** the warren run row is created. `spawnRun`
  persists `runs.worker_id` and the `burrows` row mapping in the same
  atomic flow so sticky-by-burrow (cancel / steer / reap / fan-out
  via `pool.clientFor`) has a durable record. `ServerDeps` +
  `bootScheduler` + CLI `runRun` thread the pool through; legacy
  single-client callers continue to work via `pool.singleton()`
  (`warren-39c3`, `pl-9ba1` step 4).
- **`feat(burrows)`** — `GET /burrows` fans out across every healthy
  worker in the pool (parallel, with partial-failure tolerance);
  `GET /burrows/:id` resolves the owning worker via the `burrows`
  table and routes through `pool.clientFor` so the read is sticky and
  hops at most once. Unreachable owners surface as a clean 502 rather
  than a 500 (`warren-14ad`, `pl-9ba1` step 5).
- **`feat(workers)`** — background probe loop pings every registered
  worker on a configurable cadence (`WARREN_WORKER_PROBE_MS`), flipping
  state between `healthy` and `unreachable` based on a successful
  `GET /healthz`. A new admin route `POST /workers/:name/drain` marks
  a worker `draining` so `placeForProject` stops routing new burrows
  there while existing burrows continue to be reachable via
  sticky-by-burrow. `POST /workers/:name/undrain` reverses the
  transition. Probes coexist with the supervisor single-flight
  scheduler guard already in place (`warren-0f0c`, `pl-9ba1` step 6).
- **`feat(server-config)`** — new `src/server-config/` module loads a
  per-deployment `warren.toml` (no project clone involved; sits next
  to the SQLite file). Mirrors `src/warren-config/`'s layout
  (`errors` / `config` / `schema` / `load` / `index`); the loader
  emits the same missing-vs-malformed envelope so a half-written
  config never throws at boot. `[workers]` blocks register additional
  worker rows with `name` / `url` and require the deployment-wide
  shared bearer token to be set; sole-`[workers]` deployments without
  a shared token fail loud at boot (`warren-3909` + `warren-272c`,
  `pl-9ba1` step 7).
- **`feat(runs)`** — `bridgeRunStream` extracts pi cost + token totals
  directly from the event stream. Pi v0.74 emits per-turn usage inline
  on every `turn_end` envelope
  (`message.usage.{input,output,cacheRead,cacheWrite,cost.total}`); the
  bridge accumulates them across the run and persists run-level totals
  via `RunsRepo.attachStats` at the first `agent_end` /
  `terminalDetected`. `PiStatsClient` remains as an explicit override
  for sources warren can't observe in-stream; when both paths produce
  data the explicit client wins. Closes the cost/tokens column gap
  without an out-of-band `get_session_stats` RPC (`warren-17a4`).
- **`feat(runs)`** — configurable run-branch prefix (`warren-9993`).
  Warren composes the burrow workspace branch as `${prefix}/${run.id}`
  where the prefix resolves with the precedence project default
  (`.warren/defaults.json.runBranchPrefix`) > `WARREN_RUN_BRANCH_PREFIX`
  env > built-in `"burrow"` (preserved as the legacy default so
  existing deployments are unchanged). Using the warren
  `run_xxxxxxxxxxxx` as the branch suffix makes the branch
  back-reference the warren run row on `git log` / PR review, so
  agents stop mistaking `burrow/<id>` branches for branches living in
  the burrow repo. Schema validation uses the same kebab/snake-case
  grammar as `RoleNameSchema`; invalid values silently downgrade to
  the next slot rather than aborting the spawn. `runBranchPrefix` is
  surfaced read-only on the ProjectDetail config panel.
- **`test(server)`** — `integration.multi-worker.test.ts` drives the
  full pool round-trip against two in-process workers: `POST /runs`
  places, `GET /burrows` fans out across both, `GET /burrows/:id` is
  sticky to the owning worker, draining one worker excludes it from
  new placements while existing burrows remain reachable, and an
  unreachable owner surfaces as a clean 502 (`warren-a801`,
  `pl-9ba1` step 8).

### Fixed

- **`fix(runs)`** — the `piStats` terminal-snapshot branch in
  `bridgeRunStream` fired on `event.kind === "agent_end"`, but burrow's
  pi parser maps every pi lifecycle envelope to `kind="state_change"`,
  `stream="system"`, `payload.type=<event>`. The predicate never
  matched on real pi runs, so cost / token columns silently stayed
  null when `PiStatsClient` is wired. New `isPiAgentEnd(event)` wire-
  shape inspector (same as `detectRuntimeTerminal`) gates the
  snapshot; both branches converge on the same envelope, persist
  once, and the bridge breaks immediately after. Tests rewritten to
  use a `piAgentEnd(burrowRunId, seq)` helper that builds the real
  wire shape (`warren-36c0`).

### Docs

- **`docs(spec)`** — new `SPEC.md` §5.4 pins the multi-worker model
  into the V1 record: pool topology, placement rules (project-
  affinity round-robin + sticky-by-burrow), drain semantics, the
  `[workers]` config surface, and the deployment-wide shared bearer
  token constraint. §3.2's "multi-worker is a non-goal" line is
  removed — the substrate now ships (`warren-dd64`).
- **`docs(roadmap)`** — `ROADMAP.md` adds an R-08 reframing note
  recasting the multi-worker direction as a substrate concern (the
  placement / pool / probe primitives) rather than a workload-
  hierarchy concern (workers as a tier above agents). The substrate
  framing leaves room for the planned remote-burrow topology (R-12)
  without forcing a workload model.

## [0.2.0] — 2026-05-13

Closes the last warren↔burrow disk-seam violations on the spawn and reap
paths by adopting burrow's R-07 HTTP file surface end-to-end. Warren no
longer writes the burrow workspace's `.canopy/` / `.mulch/` / `.seeds/` /
`.pi/` drops through shared `/data` — `src/runs/seed.ts` becomes a pure
builder returning `HttpWorkspaceFile[]`, and `spawnRun` threads the list
through `HttpClient.burrows.up({ seed: { files } })` so provisioning and
seeding land in a single atomic round-trip. Reap's `seeds_close` sub-step
flips to `HttpClient.files.read('.seeds/issues.jsonl')`; the
`mulch_merge` sub-step stays disk-bound pending burrow's file-listing
endpoint (`burrow-18ca`, tracked by `warren-7f7c`). Mechanical refactor,
no user-facing API changes — but the minor bump signals that the
warren↔burrow contract is now HTTP-only on every code path except
`mulch_merge` and `branch_push`, which unblocks the remote-burrow
topology that R-12 needs (warren plan `pl-a31c`, parent `warren-0a83`;
burrow plan `bur-pl-2467`).

### Changed

- **`refactor(runs)`** — `seedBurrowWorkspace` is gone; `buildSeedFiles(agent)`
  replaces it as a pure builder returning `HttpWorkspaceFile[]` with
  workspace-relative paths for the five drops (`.canopy/agent.json`,
  `.mulch/expertise/<domain>.jsonl` from `expertise_seed`, `.seeds/workflow.txt`,
  `.pi/skills/<name>/SKILL.md` from `pi_skills`, `.pi/prompts/<name>.md` from
  `pi_prompts`). `src/runs/seed.ts` no longer imports `node:fs/promises`; the
  `SeedFs` injection seam is removed. Same validation errors as the prior
  writer — malformed JSONL, missing `domain`, missing/invalid pi `name`/`body`,
  duplicate or unsafe pi names all surface as `RunSpawnError` at build time
  (warren-e238, pl-a31c step 1).
- **`feat(runs)`** — `spawnRun` ships the `buildSeedFiles` output as the
  `seed.files` payload on `HttpClient.burrows.up({ seed: { files } })`, so
  provisioning + workspace seed land in one atomic burrow round-trip.
  `buildSeedFiles` runs before the warren run row is created, so
  `expertise_seed` / `pi_skills` / `pi_prompts` validation surfaces as a
  clean `RunSpawnError` with no half-spawned row. Seed-validation failures
  inside `burrows.up` roll back on burrow's side before warren observes a
  `burrow_id` — the catch path sees `burrow === null` and no `DELETE
  /burrows/:id` fires. `SeedWorkspaceInput`, the `seedWorkspace` injection
  seam, and the temporary `writeSeedFilesToDisk` adapter are deleted;
  `src/runs/spawn.ts` no longer imports `node:fs/promises`. `spawn.test.ts`
  asserts on the `seed.files` payload posted to `/burrows` and replaces the
  old "seeding fails" case with an atomic-rollback case
  (`burrowsUpStatus: 422`, no DELETE) (warren-eaee, pl-a31c step 2).
- **`refactor(runs)`** — reap's `seeds_close` sub-step reads
  `<burrow-workspace>/.seeds/issues.jsonl` via
  `input.burrowClient.http.files.read('.seeds/issues.jsonl')` wrapped in
  `withTransportMapping` instead of `fs.readFile`. `NotFoundError` from
  `@os-eco/burrow-cli` is the no-op shape (agent never created the file →
  zero closures, no `reap_failed`); any other thrown error rethrows so
  `reapRun`'s outer catch records it as `reap_failed step=seeds_close`. The
  project-side `.seeds/issues.jsonl` write still flows through `ReapFs`
  because reap remains co-tenanted with the project clone on warren's disk.
  `reap.test.ts`'s `fakeBurrowClient` grows a `FakeBurrowClientOpts` arg
  with `seedsIssuesBody` + `filesRead` knobs; default behaviour throws
  `NotFoundError`, so every other test silently exercises the no-op path
  (warren-ae92, pl-a31c step 3).

### Docs

- **`docs(spec)`** — `SPEC.md` §4.3 step 3 + step 6 and §11.A "Seeding" /
  "Reap" / "Why HTTP-and-not-shared-disk" bullets re-pin the burrow-side
  seam as HTTP, not shared disk. §12's mulch row clarifies that warren
  reads/writes the project-side `.mulch/` directly on the host but seeds
  the per-run `.mulch/` via `seed.files`. The §5 ASCII diagram drops the
  stale `ml record` shell-out from warren's outgoing shell calls.

### Tracked follow-ups

- `warren-7f7c` — burrow follow-up filed as `burrow-18ca` (workspace
  file-listing endpoint). Once shipped, reap's `mulch_merge` sub-step
  becomes a mechanical change in `src/runs/reap.ts` `mergeMulch`:
  `HttpClient.files.list` + `.files.read` replace `fs.readdir` +
  `fs.readFile`, and the last warren↔burrow read-side disk seam closes.
  `branch_push` remains workspace-local and out of scope (would need a
  separate burrow primitive for remote-burrow topologies).

## [0.1.7] — 2026-05-13

Pi lands as the third inline built-in (alongside `claude-code` and
`sapling`), and warren grows the surrounding surface for it:
multi-provider frontmatter + per-run overrides, per-run cost + token
accounting on a new `runs.cost_usd` / `tokens_*` column family
(migration 0006), pi-namespaced canopy sections (`pi_skills` /
`pi_prompts`) materialized into the burrow workspace, and UI
rendering for pi's runtime event sub-kinds. Burrow CLI bumps
`0.2.7 → 0.2.8`, which ships the matching `piRuntime` so dispatching
`agent='pi'` round-trips end-to-end in production. Acceptance grows
scenario 16 (pi parity smoke). Docs reposition warren as a standalone
agent platform (the four os-eco tools framed as opt-in built-in
features, not required infrastructure) and the org-readiness cluster
(R-12 – R-18) joins the active forward direction in SPEC §11.J.

### Added

- **`feat(registry)`** — `pi` built-in agent ships inline alongside
  `claude-code` and `sapling` (warren-d18e, pl-4374 step 2). `PI_BUILTIN`
  mirrors `SAPLING_BUILTIN`'s parity shape (system + burrow_config
  sections, `network=open`, `frontmatter.source='builtin'`). Wired into
  `BUILTIN_AGENTS`, `builtins.test.ts`, the container-smoke scenario,
  and the Agents UI page header / empty-state.
- **`feat(registry)`** — `AgentDefinition.frontmatter.provider` and
  `frontmatter.model` are now well-known optional string fields. Two
  helpers: `readProviderFrontmatter()` narrows the open frontmatter bag
  to typed `{provider?, model?}` strings; `withProviderOverrides()`
  folds operator-supplied per-run overrides onto a freshly-cloned
  `AgentDefinition` (empty/whitespace are no-ops). `spawnRun` applies
  overrides **before** creating the run row, so both
  `runs.rendered_agent_json` and the `.canopy/agent.json` seeded into
  the burrow workspace carry the override-applied frontmatter. Base
  agent row stays untouched — overrides are per-run, not per-agent
  (warren-f8c0, pl-4374 step 4).
- **`feat(server)`** — `POST /runs` accepts optional
  `providerOverride` + `modelOverride` strings on the request body;
  `CreateRunInput` on the wire mirrors them.
- **`feat(ui)`** — `NewRunPage` surfaces a paired Provider/Model 2-col
  grid above the prompt textarea, auto-filling from the selected
  agent's frontmatter until the operator types. Empties are trimmed off
  the wire (warren-f8c0).
- **`feat(runs)`** — `seedBurrowWorkspace` materializes pi-specific
  canopy sections alongside `.canopy/agent.json`, `.mulch/expertise`,
  and `.seeds/workflow.txt`. `pi_skills` is a JSONL stream of
  `{name, body}` envelopes that render to
  `.pi/skills/<name>/SKILL.md` (one subdir per skill); `pi_prompts`
  renders to `.pi/prompts/<name>.md` (flat). Malformed JSON,
  missing/empty name, non-string body, duplicate names, and unsafe
  names (path separators, `.`, `..`) abort seeding with
  `RunSpawnError`, mirroring the existing `expertise_seed` shape. No
  behavior change for non-pi agents (warren-846b, pl-4374 step 3).
- **`feat(db)`** — migration 0006 adds nullable `cost_usd` +
  `tokens_input` / `tokens_output` / `tokens_cache_read` /
  `tokens_cache_write` to `runs`. `RunsRepo.attachStats` merges
  partial stat patches into the row using the same undefined-omitted /
  explicit-null-clears shape as `attachBurrow` (warren-a7dc).
- **`feat(runs)`** — `bridgeRunStream` gains an optional
  `PiStatsClient` that snapshots `get_session_stats` at run-start +
  `agent_end` and persists the **delta**. Resumed pi sessions would
  otherwise double-count prior turns; the delta keeps per-run figures
  honest (warren-a7dc).
- **`feat(ui)`** — `RunDetail` shows a cost badge with a tokens
  tooltip; `Runs.tsx` exposes an opt-in Cost column persisted in
  localStorage. Non-pi runs leave every new column null and render
  blank (warren-a7dc).
- **`feat(ui)`** — `EventLine` detects pi-runtime sub-kinds
  (`compaction_start/end`, `auto_retry_start/end`, `extension_error`,
  `queue_update`) by peeking at `payload.type` when `event.kind` is
  `state_change` / `telemetry` — burrow's pi parser collapses pi's
  wide vocabulary into the stable taxonomy and stores the original
  type in the payload. `extension_error` tints rose like stderr.
  Kind-direct matches are honored too, so a future burrow release
  promoting any of these to first-class kinds works without a UI rev
  (warren-70af).
- **`test(acceptance)`** — scenario 16
  (`scripts/acceptance/scenarios/16-pi-parity-smoke.ts`) dispatches
  `POST /runs agent='pi'` against the in-proc warren+burrow stack and
  asserts (a) `GET /agents/pi` returns `source='builtin'`, (b)
  `burrowId` / `burrowRunId` populated, (c) frozen
  `renderedAgentJson`, (d) ≥1 event lands in the events table. The
  acceptance harness registers a declarative pi stub via
  `burrow-with-stub.ts` (deterministic, no pi binary needed in CI);
  production warren talks to the real `piRuntime` in burrow 0.2.8
  (warren-d18e, warren-0e06).

### Changed

- **Burrow CLI bumped `0.2.7 → 0.2.8`** — burrow v0.2.8 (released
  2026-05-13) lands the built-in `piRuntime` (burrow-8aff, pl-5198).
  Pin bumped in all three lockstep locations (`package.json` +
  `bun.lock` + `Dockerfile` global install — see CLAUDE.md
  "Relationship to burrow") so warren's `BUILT_IN_RUNTIMES` sees pi at
  boot. Closes warren-0e06's four-condition gate end-to-end.

### Docs

- **`docs(readme)`** — repositions warren as a standalone agent
  platform (warren-e576). Leads with what warren does (spawn sandboxed
  agents at GitHub repos, watch live, steer, get a branch) instead of
  the four-tool composition. The os-eco data-plane tools
  (canopy/mulch/seeds/sapling) stay bundled in every image but are
  framed as opt-in built-in features — none required for a fresh
  install. Same code, same depth; only the public framing changes.
  README quickstart, SPEC §1 / §2.1 / §2.3, CLAUDE.md opener, package
  description, Dockerfile + fly.toml comments, and Agents/NewRun
  empty-state copy all updated in lockstep.
- **`docs(spec)`** — new `SPEC.md` §11.J pins the **org-readiness
  direction** (2026-05-11) into the V1 record: the seams to extend
  warren from "one team, one box" to a 50-engineer organization
  without forcing a fork. Covers SSO, remote burrow workers, Postgres
  backend, MCP, audit, budgets, GitHub App. New `SPEC.md` §11.K
  records **pi runtime support** as a frozen design entry: phased
  landing (pl-4374), built-in shape, burrow piRuntime contract,
  canopy sections, multi-provider surface, cost + token accounting,
  event-model widening, MCP omission, headless API-key auth posture.
  §1 / §2.1 / §3.2 / §4.2 / §11.B / §12 updated to name pi as the
  third built-in.
- **`docs(roadmap)`** — `ROADMAP.md` adds the org-readiness cluster
  (R-12 – R-18) plus R-19 preview environments, updates R-03's
  problem statement to list pi in the registry inventory, and logs
  the pl-4374 summary plus the three deferred-decision records under
  "Recently shipped". `WARREN_DEFAULT_AGENT` picks pi as a third
  option.

## [0.1.6] — 2026-05-10

R-06 lands: the cron half of the scheduler ships end-to-end. New
`src/triggers/` module (tick + dispatcher) wires into `bootServer`,
fires `.warren/triggers.yaml` entries via croner with no-catch-up
prev-vs-last semantics, and dispatches past-due `scheduledFor` seed
extensions as `trigger='scheduled'` runs. `GET /projects/:id/triggers`
+ `POST /projects/:id/triggers/:triggerId/run` surface scheduler
state in the API and UI (last/next-fire + Run Now button on Project
Detail). New `triggers` table (migration 0005) holds per-trigger fire
state. Acceptance scenario 15 drives the full cron + scheduled-for
round-trip against an in-proc warren+burrow. R-02's defaults consumer
also expands: NewRun pre-fills the agent picker from
`defaults.defaultRole` and the prompt textarea from
`defaults.defaultPrompt`. Webhook triggers remain V2; cron is in V1.

### Added

- **`feat(triggers)`** — `src/triggers/` module ships end-to-end
  (R-06, plan `pl-2f15`). Mirrors `src/warren-config/`'s layout:
  `errors`, `config` (env + tick-ms), `schema`, `cron` (croner
  facade), `repo`, `dispatch` (cron + scheduled), `seeds-extension`
  (`sd list` / `sd update --extensions` shell-outs), `tick`
  (`runTick` + `startScheduler`), `index`. `dispatchCronTrigger`
  encodes the no-catch-up posture via prev-vs-last (`mx-?`): a fire
  happens iff `previousRun(now) > lastFiredAt`, then stamps `now` and
  rolls `nextFireAt` forward — a 4-hour outage on an hourly trigger
  dispatches once, not four times. First observation seeds the row
  at `now` without firing. `dispatchScheduledSeed` walks `sd list`
  output, dispatches past-due `extensions.scheduledFor` as runs with
  `trigger='scheduled'`; per `pl-2f15` risk #4 the warren-side write
  happens first, and `clearScheduledFor` failures surface as
  `trigger.cleared_extension_failed` system events on the dispatched
  run. `startScheduler` wraps `runTick` in a single-flight guard
  (`pl-2f15` risk #5) so overlapping ticks log
  `scheduler.tick_skipped` instead of stacking; `stop()` drains the
  in-flight tick. Decisions recorded in mulch: croner over a
  homegrown 5-token parser, default-UTC tz, skip-and-log on missing
  seeds, no catch-up after downtime, warren row as source of truth
  for fire state (write-once contract).
- **`feat(db)`** — new `triggers` table (migration 0005) keyed by the
  composite string `<projectId>:<triggerId>` so each tick can write
  back `lastFiredAt` / `nextFireAt` / `lastRunId` without juggling a
  generated id (warren-9d8d). `project_id` cascades on delete (mirrors
  the `.warren/` clone disappearing with the project); `last_run_id`
  sets null on delete so a run cleanup doesn't orphan the trigger.
  `TriggersRepo.upsert` merges undefined-omitted patch fields and
  treats explicit `null` as a clear (same shape as
  `RunsRepo.attachBurrow`); `recordFire` is the dispatcher
  convenience that stamps `lastFiredAt` + `lastRunId` and rolls
  `nextFireAt` forward in one transaction.
- **`feat(server)`** — scheduler boots inside `bootServer` from
  `loadTriggerSchedulerConfigFromEnv` and registers `scheduler.stop()`
  on `WarrenServerHandle.stop` between handle stop and bridge/burrow/
  db shutdown so an in-flight tick mid-`spawnRun` drains cleanly
  (warren-0a1b). A new `DispatchSpawnFn` wraps `spawnRun` and calls
  `bridges.start(runId, burrowRunId)` so scheduled-run events flow
  into `warren.events` the same way `POST /runs` does.
- **`feat(server)`** — `GET /projects/:id/triggers` returns
  `TriggerSummary[]` joining parsed `.warren/triggers.yaml` entries
  with persisted scheduler state (`lastFiredAt` / `nextFireAt` /
  `lastRunId`) and a freshly-computed `nextFireAt` via croner;
  per-trigger `parseError` surfaces strict-grammar failures the loose
  warren-config check waved through (warren-99c3). `POST /projects/:id/triggers/:triggerId/run`
  resolves the trigger from warren-config, dispatches inline via
  `spawnRun` with `trigger='manual-trigger'`, bridges the run, and
  records the fire so the next cron tick's prev-vs-last semantic
  stays correct. Handlers 404 on unknown project/trigger ids.
- **`feat(ui)`** — Project Detail page (`src/ui/src/pages/ProjectDetail.tsx`)
  grows a triggers block driven by `GET /projects/:id/triggers` on
  its own react-query key. Each row shows last/next-fire timestamps,
  the most recent dispatched `lastRunId`, and any per-trigger
  `parseError`; a Run Now button per row invalidates the triggers
  query on success and navigates to the new run page (warren-7bbc).
- **`feat(ui)`** — `NewRunPage` auto-fills the agent select from the
  selected project's `.warren/defaults.defaultRole` when it matches a
  registered agent, and pre-fills the prompt textarea from
  `defaults.defaultPrompt`. Both fills latch off the first time the
  user touches the control so manual edits survive subsequent project
  switches; an inline hint surfaces the source of each default while
  the value still equals it, and a destructive-color warning flags a
  `defaultRole` that doesn't resolve to a registered agent
  (warren-fd14, warren-af38). Broader `defaultRole` consumption (CLI
  `warren run`, scheduled-run prompt fallback) remains deferred to
  R-04.
- **`deps`** — `croner ^10.0.1` for the R-06 cron scheduler
  (warren-a006). Picked over a homegrown 5-token parser: small,
  tz-aware with DST handling, no native deps, supports both Vixie and
  6-token grammars. Warren-config keeps its loose validation
  (`mx-40fe51`) and defers strict parsing to fire time.
- **`config`** — warren now dogfoods its own `.warren/`:
  `defaults.json` sets `defaultRole=claude-code` + `defaultBranch=main`;
  `triggers.yaml` is a comment-only stub. warren-bd22 tracks adding a
  CLI/UI affordance so users don't have to hand-author these files.
- **`test(acceptance)`** — scenario 15
  (`scripts/acceptance/scenarios/15-triggers-roundtrip.ts`) drives the
  R-06 scheduler end-to-end against a live in-proc warren+burrow: Run
  Now persists `lastFiredAt` / `lastRunId`; `scheduledFor` in the
  past dispatches exactly one `trigger='scheduled'` run and the
  seed's `scheduledFor` is cleared via `sd update --extensions`;
  future-dated and closed seeds skip; no spontaneous cron fires
  occur. `WARREN_SCHEDULER_TICK_MS=1000` keeps the dispatch budget
  tight (`pl-2f15` risk #8).

### Docs

- **`docs(roadmap)`** — `ROADMAP.md` flips R-06 from `[proposed]` to
  `[shipped]`, resolves the four open questions (croner over
  homegrown, default-UTC tz, skip-and-log on missing seeds, no
  catch-up after downtime), adds R-06 to "Recently shipped", and
  updates suggested sequencing.
- **`docs(spec)`** — new `SPEC.md` §11.I pins the scheduler
  convention into V1's frozen record: tick cadence, triggers table
  shape (migration 0005), failure semantics, the seeds write-once
  contract. §1 / §2 / §3 framing updates so V1 includes the cron
  half of the scheduler (webhooks still V2); §7 project structure
  adds `src/triggers/`; §8.1 HTTP routes adds the two new endpoints;
  §9 schema reflects the `triggers` table; §11.H deferred-scope note
  updates accordingly.

## [0.1.5] — 2026-05-10

R-02 lands: `.warren/` per-project config directory ships end-to-end —
loader, cache, HTTP read endpoint, UI panel, and `warren doctor` /
`/readyz` diagnostics. Triggers are parsed but not dispatched; R-06
(cron scheduler) is the consumer and is now fully unblocked. New
acceptance scenario 14 covers absent / valid / malformed lifecycle.

### Added

- **`feat(warren-config)`** — `.warren/` per-project config directory
  ships end-to-end (R-02, plan `pl-5d74`, warren-571f). Two optional
  files per project: `triggers.yaml` (zod-validated cron entries with a
  `kind:` discriminator that leaves room for future webhook triggers
  without a breaking schema rev) and `defaults.json` (per-project
  `defaultRole` / `defaultBranch` / `defaultPrompt`). Format choice
  diverges from the original ROADMAP sketch: `defaults` is JSON, not
  YAML, for symmetry with the rest of os-eco's wire surface (`mx-2cefdd`).
  YAML parser is `js-yaml ^4.1.1` to match mulch + overstory
  (`mx-8b6896`). New `src/warren-config/` module mirrors the
  `src/projects/` + `src/registry/` layout (errors / config / schema /
  load / cache / index). Loader uses a missing-vs-malformed envelope so
  per-file errors never throw (`mx-66d478`). Per-project cache is
  invalidated inside `refreshProject` and `deleteProject` to dodge the
  stale-config race (pl-5d74 risk #4, `mx-61c0e6`). Triggers are parsed
  but not dispatched — R-06 (cron scheduler) is the consumer and is now
  fully unblocked.
- **`feat(server)`** — `GET /projects/:id/warren-config` returns the
  `LoadedWarrenConfig` envelope verbatim (`{ triggers, defaults, errors }`);
  404 on unknown project. `WarrenConfigUnavailableError` joins the
  existing `BurrowUnreachableError` / `CanopyUnavailableError` /
  `ProjectUnavailableError` family for uniform error handling
  (`mx-adf588`, `mx-bd1f9f`).
- **`feat(ui)`** — Project detail page (`src/ui/src/pages/ProjectDetail.tsx`,
  `mx-dc191e`) renders a read-only Warren Config panel with three blocks
  per envelope: triggers list, defaults key/value, per-file validation
  errors (`mx-a5e30e`). Editing remains a git operation; warren only
  surfaces the parsed view.
- **`feat(diagnostics)`** — `warren doctor` and `/readyz` add a
  `warren_config` check that walks every loaded project and aggregates
  per-file errors into a single diagnostic row (`mx-f37c30`). Doctor's
  check ordering is now eight entries (`mx-1a70ef`); the eighth slot is
  `warren_config`.
- **`test(acceptance)`** — scenario 14
  (`scripts/acceptance/scenarios/14-warren-config-lifecycle.ts`) covers
  `.warren/` lifecycle: absent / valid / malformed states asserted via
  `/readyz` rather than spawning `warren doctor` as a child (avoids the
  wrong-DB problem documented in `mx-e959c0`). Scenarios 11 and 14 also
  pin `WARREN_DB_PATH` to a scratch path so the doctor exit-code check
  doesn't observe the shared dev DB (`mx-544f8f`, `mx-895738`).

### Docs

- **`docs(roadmap)`** — `ROADMAP.md` flips R-02 from `[proposed]` to
  `[shipped]` and inlines the as-built schema, surface, and the scope
  deliberately deferred to R-04 / R-06. R-06's "Depends on" updates to
  show R-02 as satisfied. Suggested-sequencing R-02 entry marked
  shipped. New entry under "Recently shipped".
- **`docs(spec)`** — `SPEC.md` adds §11.H pinning the `.warren/`
  convention into V1's frozen record (layout, format choice, schema,
  loader contract, HTTP/UI/diagnostics surface, deferred scope). §7
  project structure adds `src/warren-config/`; §8.1 HTTP routes adds
  `GET /projects/:id/warren-config`.

## [0.1.4] — 2026-05-10

Acceptance harness fill-in plus a deploy-time guardrail. Six new
end-to-end scenarios (05–10) close the warren↔burrow contract gaps
left by 0.1.3 — events stream, restart-recovery, steer, cancel, and
both reap roundtrips (mulch LWW + seeds-close mirror) — and the
supervisor now fails fast on the misconfigured-token mode that
silently 401'd every dispatch on Fly. Roadmap V2 direction (R-01
through R-11) lands as a planning artifact.

### Added

- **`feat(supervisor)`** — fail fast on missing or mismatched burrow
  auth tokens at boot, before `installGitCredentials` and
  `runSupervisor`. A misconfigured Fly deploy now exits with one
  pointed error instead of crash-looping `burrow serve` five times
  and 401-ing every dispatch. `WARREN_BURROW_NO_AUTH=1` bypasses for
  loopback dev. On success, the validated token's `sha256:<12-hex>`
  fingerprint is logged so a deployer can eyeball that both ends match
  without ever logging the secret. SPEC §10.2 fly secrets block now
  lists `BURROW_API_TOKEN` + `WARREN_BURROW_TOKEN` alongside
  `WARREN_API_TOKEN` (warren-d317).
- **`test(acceptance)`** — scenarios 05+06 cover the events stream
  contract end-to-end. 05 verifies the NDJSON envelope shape on
  `GET /runs/:id/events`, durability via the non-follow replay path,
  and the `?since=` filter. 06 kills warren mid-run, restarts it, and
  asserts the bridge resumes from `MAX(seq)+1` with no event-table
  gaps — the §9 contract. Adds `ScenarioCtx.lifecycle` so process
  control doesn't have to thread through fixtures, plus a per-second
  heartbeat in `stub-agent.sh` so the recovery path has a steady
  source of new burrow events to courier during the warren-down
  window. New `lib/burrow-serve.ts` shim programmatically registers
  declarative `[[agents]]` (which burrow's runtime registry doesn't
  auto-load from a project's `burrow.toml`) and bypasses bwrap with a
  direct `Bun.spawn` so the harness runs cleanly inside warren's own
  production sandbox where userns nesting fails (warren-647e).
- **`test(acceptance)`** — scenarios 07+08 cover steer + cancel. Steer
  asserts the `steer.sent` audit event and the burrow message echo
  prove delivery to the inbox; cancel asserts both warren and burrow
  surfaces report `cancelled`, idempotent on re-cancel (warren-a7f9).
- **`test(acceptance)`** — scenarios 09+10 cover the reap roundtrip.
  Scenario 09 exercises all three SPEC §11.A LWW branches across three
  sequential runs sharing a stable `mulch_id`: added → updated (newer
  ts) → skipped (older ts). Scenario 10 covers the seeds-close mirror
  happy path (`mode='added'`); the `mode='updated'` branch can't be
  observed end-to-end because `spawnRun`'s pre-spawn
  `refreshProjectClone` wipes reap's uncommitted writes to the tracked
  `.seeds/issues.jsonl` between runs (mulch's `acceptance.jsonl`
  survives because it's not committed in the fixture);
  `mirrorClosedSeeds`' updated branch is exercised by `reap.test.ts`.
  The stub agent gains four prompt-driven knobs alongside
  `[sleep_ms=NNN]`: `[mulch_id=...]`, `[mulch_ts=...]`, `[seed_id=...]`,
  `[seed_ts=...]` — letting scenarios drive deterministic LWW inputs
  without warren restarts (warren-c37e).

### Fixed

- **`test(acceptance)`** — scenario 02 now filters built-ins out of
  the "agents list is empty before first refresh" precondition. The
  server now boot-seeds claude-code + sapling built-ins (mx-f52e13),
  so the original assertion was always wrong. Filters to
  `source !== 'builtin'` before counting; `AgentRow` gains the
  optional `source` field already returned by `GET /agents`
  (warren-3682).

### Changed

- **TypeScript `5.9.3 → 6.0.3`** — dev dependency bump (dependabot).

### Docs

- **`docs(roadmap)`** — `ROADMAP.md` adds the V2 direction (R-01
  through R-11): the team-of-ICs phase. Captures seeds extensions,
  `.warren/` config dir, per-project canopy tier, project + issues UI
  (multica pattern), roles tab editor, cron scheduler, sapling-first
  runtime, operator agent, schema-driven config UI, and canopy+mulch
  role meshing. Records the decisions already made (DB only for
  runtime state; seeds is source of truth for issues; markdown editor
  with full canopy feature set; sapling personal default, claude-code
  public default). Cross-repo follow-ups tracked as seeds in
  seeds/sapling/canopy/mulch.
- **`docs(fly)`** — `fly.toml` operator-workflow comment now spells
  out the `BURROW_API_TOKEN` ↔ `WARREN_BURROW_TOKEN` pairing
  requirement. Deploying without setting both to the same value
  crashed the supervisor in a boot loop, then silently 401'd every
  dispatch once the server-side secret was set alone. App name
  corrected to `warren-deployed` to match the created Fly app
  (warren-d317).

## [0.1.3] — 2026-05-09

Third-dogfood follow-through. Closes the warren-on-warren findings from
SPEC §11.G: agents now actually `git commit` (system prompt reaches the
runtime, gitdir bind via burrow 0.2.7), reap distinguishes empty pushes
from real work, successful pushes auto-open a GitHub PR, the dispatch
form lets operators target a non-default branch, and `CANOPY_REPO_URL`
is now optional thanks to inline built-in agents.

### Added

- **`feat(runs)`** — auto-open a GitHub PR after reap pushes the agent's
  branch. Gated by `WARREN_AUTO_OPEN_PR` (default on); skipped when the
  run isn't successful, the push lands no commits, the branch matches
  `project.defaultBranch`, or `GITHUB_TOKEN` is unset. 422 "already
  exists" is treated as success and the existing PR url is recovered.
  Optional `WARREN_BASE_URL` embeds a back-link to the run in the PR
  body (warren-f6af).
- **`feat(runs)`** — reap distinguishes a real-work push from a no-op
  push against an unchanged HEAD. After a successful push reap runs
  `git rev-list --count <project.defaultBranch>..HEAD` and pins the
  count on `ReapRunResult.commitsAhead`. When the count is 0, an extra
  `reap.empty_push` system event fires and `reap.completed` carries
  `commitsAhead: 0`. RunDetail's header shows a destructive
  "empty push" badge or a green "+N commits" badge accordingly. SPEC
  §4.3 step 6 documents the commit/push contract (warren-f3bb).
- **`feat(runs)`** — dispatch composes `agent.system + delimiter + user
  prompt` before posting to `POST /burrows/:id/runs`. Burrow's
  claude-code runtime never reads `.canopy/agent.json`, so the canopy
  `system` body (workspace map, rituals, commit-only invariant per
  warren-1a09) was dead text on disk; it now actually reaches the model.
  `runs.prompt` keeps the user-typed input verbatim — only the body sent
  to burrow is composed.
- **`feat(ui)`** — NewRun page exposes a free-text "Branch / tag / SHA
  (optional)" field between project select and prompt textarea.
  Placeholder mirrors the project's `defaultBranch`; empty submissions
  are omitted from the `POST /runs` body so the server falls back to
  `defaultBranch` as before (warren-7589).
- **`feat(registry)`** — `CANOPY_REPO_URL` is now optional. Warren ships
  default `claude-code` and `sapling` agents inline (`src/registry/builtins/`)
  so a fresh deploy boots without a custom canopy library. When
  `CANOPY_REPO_URL` *is* set, library agents override built-ins by name
  and new names extend the catalog. `warren doctor` and `/readyz` no
  longer fail when the canopy clone is absent (warren-d3e9).
- **`test(acceptance)`** — scenario 04 drives the §4.3 composition flow
  end-to-end against the in-proc warren+burrow harness. Asserts
  `POST /runs` returns 201 with a `run_xxx` id and a populated
  `renderedAgentJson`, and that the column is frozen at spawn time —
  mutating the canopy fixture and re-running `POST /agents/refresh`
  leaves the existing run unchanged while a fresh spawn picks up the
  drift. `canopyRepoPath` is surfaced on `ScenarioCtx.fixtures` so
  future scenarios can drive canopy-source mutations the same way
  (warren-9f65).

### Changed

- **Burrow CLI bumped `0.2.6 → 0.2.7`** — pulls in the burrow-7a80
  gitdir-bind fix. Host worktree gitdir is now visible inside the bwrap
  sandbox, so agents can run `git commit` on their own workspaces. Two-
  place pin (Dockerfile + `package.json` + `bun.lock`) per CLAUDE.md.
- **TypeScript `5.9.3 → 6.0.3`** — dev dependency bump (dependabot).

### Docs

- **`docs(spec)`** — SPEC §11.G records the 2026-05-09 third dogfood.
  Two warren-on-warren runs against `jayminwest/warren`: the first
  reproduced the silent-empty-branch shape (`branchPushed: true`,
  `ahead_by: 0`) — the trigger for warren-f3bb (reap-pushes-without-
  committing observability gap) and warren-fead (`end_turn` while
  waiting on foreground work). The second was the first warren-on-
  warren run that actually shipped real work to the remote, validating
  burrow-7a80 / 0.2.7 gitdir bind end-to-end and confirming
  warren-f3bb's prompt-instruction-is-sufficient fix scope. Filed
  warren-1a09 (P2: agent-side `git push` blocked by `/root/.gitconfig`
  not being in burrow's bwrap ro-bind set; same architectural pattern
  as warren-1eaa).

## [0.1.2] — 2026-05-09

Second-dogfood hardening pass. Fixes the "stuck running, no branch" failure
mode (warren-a69a + warren-67cc compound) by reaping inline on terminal
bridge events, repairs container recreate past migration 0002 (warren-b060),
makes the bundled os-eco CLIs resolvable inside the bwrap sandbox
(warren-1eaa), and survives `DELETE /projects/:id` against a project with
run history (warren-5f19). Burrow bumped to 0.2.6 for built-in
`ANTHROPIC_API_KEY` plumbing.

### Fixed

- **`fix(runs)`** — reap runs inline when the burrow bridge sees a runtime
  terminal event (`kind=state_change`, `stream=system`,
  `payload.type=result`) or when burrow's cancel response carries a terminal
  state. Without an external scheduler, runs were stuck in `running` after
  the agent exited or the operator cancelled; reap is still the sole writer
  to the terminal state transition (warren-a69a).
- **`fix(runs)`** — adds `no_model_response` to `failure_reason`, so the
  reap classifier discriminates "ran but the model never produced an
  assistant turn" (e.g. claude-code's "Not logged in / Please run /login"
  exit) from a generic crash. Heuristic: outcome=failed, stateOnEntry=running,
  no `text`/`thinking`/`tool_use` event ever landed on `stream=stdout`
  (warren-5165).
- **`fix(db)`** — hoists `PRAGMA foreign_keys=OFF` onto the raw connection
  *before* drizzle's migrate transaction opens. SQLite silently ignores
  PRAGMA foreign_keys toggled inside a multi-statement transaction, so
  migration 0003's "12-step ALTER" was running with FK still ON and
  crashing the supervisor on every container recreate past 0002 against any
  `/data/warren.db` with `events` rows referencing `runs` (warren-b060).
- **`fix(docker)`** — relocates the global Bun package store from `/root/.bun`
  to `/usr/local`. Burrow's bwrap profile ro-binds `/usr` but not `/root`,
  so symlinks in `/usr/local/bin` for `sd`/`ml`/`cn`/`sapling`/`burrow` were
  dangling inside the agent's UID-1000 namespace. Sandboxed agents can now
  resolve every bundled os-eco CLI (warren-1eaa).
- **`fix(projects)`** — `runs.project_id` switched to `ON DELETE SET NULL`
  and `deleteProject` now reorders so a delete of a project with run history
  succeeds instead of state-corrupting on the FK error after `rmrf` already
  wiped the disk. Reap guards a null `projectId` by skipping
  `mulch_merge`/`seeds_close`/`branch_push`; UI renders orphans as
  "(deleted project)" on the runs list and detail (warren-5f19).
- **`fix(ui)`** — `RunDetail` invalidates the `['runs']` query when the live
  event stream emits `state_change`, `cancel.requested`, `reap.completed`,
  or `reap_failed`. The state badge and metadata refresh immediately instead
  of waiting on the 3–5s polling backstop. The cancel button now surfaces
  burrow's post-cancel state inline (alreadyTerminal vs. forwarded + state)
  matching SteerForm's no-toast pattern (warren-d9ad).

### Changed

- **Burrow CLI bumped `0.2.4 → 0.2.6`** — built-in claude-code runtime
  now default-allows `ANTHROPIC_API_KEY` (plus `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`) without requiring a
  project `burrow.toml` `[env]` block. Pinned in **both** `Dockerfile` and
  `package.json` + `bun.lock`.
- **`.env.example`** — replaces the misleading `env_passthrough` claim
  (warren never wired project-level passthrough; deferred to warren-766b)
  with a description of burrow's built-in claude-code env contract
  (warren-5165).

### Docs

- **`docs(claude)`** — `CLAUDE.md` now covers tech stack, build/test
  commands, quality gates, version management, and an explicit "Relationship
  to burrow" section (supervisor contract, two-place `@os-eco/burrow-cli`
  pin, bwrap security flags).
- **`docs(spec)`** — SPEC §11.F records the second-dogfood findings
  (warren-67cc + warren-a69a as the "stuck running, no branch" compound).

### Build

- **`ci(release)`** — configures `git config user.name/email` before
  `git tag -a` in the release workflow. Without an identity the runner
  failed with "empty ident name not allowed" and `v0.1.1` never tagged.

## [0.1.1] — 2026-05-09

Post-V1 hardening pass. Closes every "Known limitations" seed filed against
0.1.0 — `GITHUB_TOKEN` git auth, `--no-auth` burrow knob, warren-on-PATH,
queued-vs-crashed reap classification, and `curl` in the runtime image — plus
projects can now refresh on every run, run streams survive Bun's 10s idle
timeout, and the UI no longer overflows on wide tables.

### Added

- **`feat(projects)`** — every run now `git fetch`-refreshes the project clone
  before composing the burrow; the new `POST /projects/:id/refresh` endpoint
  exposes the same flow for manual use. Persistent clones in
  `/data/projects/<owner>/<name>` no longer drift from upstream.
- **`feat(supervisor)`** — `BURROW_NO_AUTH` and `BURROW_EXTRA_ARGS` env knobs
  splice into the supervisor's `burrow serve` invocation, supporting loopback
  dev without bearer auth (warren-93ee).
- **`feat(runs)`** — failed runs now carry a `failure_reason` column
  (`crashed | never_started | cancelled | timeout | reap_failed`), so reap can
  distinguish "queued, never started" from "crashed mid-run" (warren-3c40).
- **`feat(docker)`** — `curl` is installed in the runtime image so operators
  can probe the burrow unix socket from inside the container (warren-bd69).
- **`test(acceptance)`** — scenario 03 covers projects management end-to-end
  (clone, presence checks, refresh, reap merge).

### Fixed

- **`fix(ui)`** — `min-w-0` on the main pane prevents wide tables (events,
  reap output) from pushing the viewport horizontally on the runs page
  (warren-930c).
- **`fix(docker)`** — the `warren` CLI is now symlinked onto `PATH` inside
  the container; previously `docker exec ... warren doctor` failed (warren-fab1).
- **`fix(supervisor)`** — `GITHUB_TOKEN` is wired into `git config --global
  url.<token>@github.com.insteadOf` at supervisor boot, so private project
  clones work without per-run setup (warren-dcf3).
- **`fix(runs)`** — runs transition `queued → running` on the first burrow
  bridge event (previously stuck in `queued` until completion) (warren-865e).
- **`fix(server)`** — run-event SSE streams are kept alive past Bun's 10s
  idleTimeout via periodic comments; long-running agents no longer drop the
  client connection mid-run (warren-b8fc).

### Build

- Added `.github/workflows/release.yml` — pushes to `main` that bump
  `package.json#version` (kept in sync with `src/index.ts`'s `VERSION`)
  automatically tag `v$VERSION` and create a GitHub release with notes
  extracted from `CHANGELOG.md`. The workflow is idempotent: re-runs against
  an already-tagged version are a no-op.

## [0.1.0] — 2026-05-09

Inaugural release. The V1 manual-run path is end-to-end validated against a real
claude-code agent (SPEC §11.E): `warren run claude-code <project> -p "..."`
provisions a burrow, dispatches the run, streams events back, reaps mulch
deltas, and pushes the workspace branch.

### Added

- **Composition flow** (SPEC §4.3): canopy agent resolution → burrow provision
  → seed `.canopy`/`.mulch`/`.seeds` → dispatch → NDJSON event stream → reap.
  Rendered agent JSON is frozen on the run row at spawn time so mid-run canopy
  edits do not affect in-flight runs.
- **Phase 0** — Bun + TS strict scaffolding (biome, drizzle, src tree).
- **Phase 1** — data model + `bun:sqlite` repos for `agents`, `projects`,
  `runs`, `events`.
- **Phase 2** — `burrow-client/` facade over `@os-eco/burrow` `HttpClient`
  (typed mirror of burrow's HTTP surface over the supervisor-managed unix
  socket).
- **Phase 3** — canopy agent registry: `cn render` → `AgentDef`, schema
  validation, refresh on demand.
- **Phase 4** — project management: clone GitHub URLs into
  `/data/projects/<owner>/<name>`, presence checks for `.seeds`/`.mulch`.
- **Phase 5** — run spawn / composition flow.
- **Phase 6** — event streaming + warren event log (write-through cache of
  burrow's stream; supports reload-after-crash and post-hoc replay).
- **Phase 7** — reap: per-run `.mulch/` merged into the project's persistent
  expertise log with last-write-wins-by-`ts` (SPEC §11.A); seeds the agent
  closed are propagated; workspace branch is pushed.
- **Phase 8** — `POST /runs/:id/steer` and `POST /runs/:id/cancel`, proxying
  to burrow's inbox + cancel routes.
- **Phase 9** — Bun.serve HTTP API + bearer-token auth on every route except
  `/healthz`. CORS strict; SPA shell + assets are auth-exempt so the UI loads
  before the user has configured the token.
- **Phase 10** — React + Vite + shadcn/ui SPA served by the same Bun.serve
  process from `src/ui/dist/`.
- **Phase 11** — `warren` admin CLI: `register-agent`, `add-project`, `run`,
  `doctor`, `serve` (the docker entrypoint).
- **Phase 12** — container + supervisor: `src/supervisor/main.ts` spawns
  `burrow serve` + warren as siblings, forwards SIGTERM/SIGINT, restarts
  burrow on crash with a 5-in-60s budget. Two-stage Dockerfile (UI build +
  runtime).
- **Phase 13** — `warren doctor` (burrow reachable, canopy clean, bwrap
  working) and `/readyz` (canopy clone present, burrow socket reachable, at
  least one agent rendered).
- **Phase 14** — acceptance harness skeleton (`scripts/acceptance/`) for
  scenario-based end-to-end validation.
- **Deploy** — `docker-compose.yml` with the four bwrap-friendly security
  flags (apparmor/seccomp/systempaths unconfined + `cap_add: SYS_ADMIN`,
  SPEC §5.3) and a single named volume at `/data`. `fly.toml` for Fly.io
  with the same image and security posture.
- **Bundled runtime** — the image installs `@os-eco/burrow-cli`,
  `@os-eco/canopy-cli`, `@os-eco/seeds-cli`, `@os-eco/mulch-cli`,
  `@os-eco/sapling-cli`, and `@anthropic-ai/claude-code` at fixed pins, with
  an explicit postinstall invocation for claude-code so the platform-native
  binary is wired up.

### Fixed

- `fix(spawn)` — forward `agent.name` as an `[[agents]]` patch row to
  `burrow up`, so burrow can resolve toolchain paths via
  `resolveEffectiveAgents` (paired with burrow `0.2.2`).
- `fix(server)` — SPA shell + asset routes are bearer-auth-exempt; previously
  the UI could not bootstrap on a fresh deploy.
- `fix(deploy)` — unblock first-run image build + boot.

### Build

- Pinned `@os-eco/burrow-cli` to `0.2.3` for bwrap `--uid`/`--gid` mapping
  (claude-code refuses to run as host root with
  `--dangerously-skip-permissions`). Bumped in **both** `Dockerfile` and
  `package.json` + `bun.lock` — the supervisor's `Bun.spawn` resolves
  `./node_modules/.bin/burrow` before PATH, so a Dockerfile-only bump is a
  no-op.
- Bundled `claude-code` runtime into the image with explicit postinstall so
  `bun install -g`'s skipped lifecycle scripts don't leave `/usr/local/bin/claude`
  unwired.
- Dropped the npm publish workflow — warren ships as a container image, not
  an npm package.

### Known limitations (V1)

See SPEC §11.D for the security posture (single bearer token, no rotation,
trust-the-socket between warren and burrow). Outstanding gaps tracked as
warren seeds: supervisor doesn't auto-wire `GITHUB_TOKEN` into git's
credential helper (`warren-dcf3`), no `--no-auth` knob for burrow loopback
dev (`warren-93ee`), `warren` CLI not on `PATH` inside the container
(`warren-fab1`), reap can't distinguish "queued, never started" from
"crashed" (`warren-3c40`), runtime image lacks `curl` (`warren-bd69`).
Scheduler (cron + webhooks) and library API exports are deferred to V2.
