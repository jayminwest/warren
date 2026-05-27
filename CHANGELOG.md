# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.15] — 2026-05-27

Patch release landing pl-5516: pi `agent_end` envelopes that carry a
provider error (overloaded_error 529, rate_limit, network, …) now
finalize the run as `failed` instead of silently succeeding, so reap's
`inferFailureReason` fires and downstream plan-run automation no longer
advances on a stale branch.

### Fixed

- **`fix(runs)`** — `detectRuntimeTerminal` in `src/runs/stream.ts`
  now inspects pi `agent_end` envelopes for `stopReason === 'error'`
  or a non-empty `errorMessage` and returns `'failed'` when either is
  present, mirroring the claude-code `result.is_error` guard. Zero
  tokens / empty content alone is still treated as a legitimate noop
  (warren-1ac2 / pl-5516 step 1).

### Added

- **`test(runs)`** — `src/runs/stream.detect.test.ts` locks the pi
  `agent_end` mapping table (stopReason='error' → failed, errorMessage
  alone → failed, empty/zero-usage success → succeeded, non-state
  envelopes → null) so the provider-error → succeeded regression
  surfaces as a focused unit-test failure (warren-6fcc / pl-5516
  step 2).

## [0.6.14] — 2026-05-27

Patch release landing the CI-parity plan (pl-da5b): the local
`bun run check:all` now mirrors `ci.yml` + `ci-postgres.yml` exactly,
the pre-commit hook delegates to that same gate, deployed agents read
it via `WARREN_QUALITY_GATE`, and a drift detector keeps the three in
sync going forward.

### Added

- **`feat(dx)`** — `bun run test:pg` boots a disposable Docker Postgres
  and runs the test matrix with `WARREN_TEST_DIALECT=postgres`, so the
  Postgres lane CI exercises is reproducible locally (warren-0d10 /
  pl-da5b step 1).
- **`feat(ci)`** — `scripts/check-ci-parity.ts` parses `ci.yml` and
  `ci-postgres.yml` and fails if any `bun run <X>` step is not
  transitively reachable from `check:all`. Wired into `check:all`
  itself so drift can't land silently (warren-6296 / pl-da5b step 3).

### Changed

- **`chore(dx)`** — `bun run check:all` now invokes `check:duplicates`
  (jscpd) inline so the local quality gate mirrors `ci.yml` exactly.
  Previously CI ran jscpd on top of `check:all`; that drift is gone
  (warren-2bcd / pl-da5b step 2).
- **`chore(config)`** — This repo's `.warren/config.yaml` now sets
  `qualityGate: "bun run check:all"` so deployed agents read it via
  `WARREN_QUALITY_GATE` instead of the fuzzy fallback (warren-57cd /
  pl-da5b step 4).
- **`chore(hooks)`** — `scripts/hooks/pre-commit` is collapsed to
  `exec bun run check:all`, making it impossible to commit through a
  red gate locally (warren-8544 / pl-da5b step 5).
- **`docs(agents)`** — Built-in claude-code / sapling / pi agent
  prompts now treat the green quality gate as terminal, not advisory:
  explicit "you are not done until `$WARREN_QUALITY_GATE` exits zero"
  language replaces the prior soft wording (warren-6a34 / pl-da5b
  step 6).

### Fixed

- **`test(ci-parity)`** — Validated the new `check:all` against a
  dirty migration (Class A regression) and a missing-artifact
  reference (Class B regression) to confirm both failure modes are
  caught locally before CI (warren-ace1 / pl-da5b step 7).

## [0.6.13] — 2026-05-27

Patch release fixing structured JSON 404s on unmatched API-prefix paths,
plus CI test-timing visibility and a Postgres migration FK fix.

### Fixed

- **`fix(server)`** — Requests to unmatched paths under an API prefix
  (e.g. `GET /runs/<id>/status`) now return the canonical JSON
  `not_found` / `method_not_allowed` envelope instead of falling
  through to the SPA HTML shell. The guard is lifted into dispatch in
  `src/server/server.ts` so there is exactly one place that decides
  "API path → JSON 404"; the redundant in-handler check in
  `src/server/ui.ts` was removed (pl-230a, warren-635d, warren-b1b8,
  warren-66bd, warren-ac91).
- **`fix(db)`** — Postgres migration `0008_add_plan_runs.sql` no longer
  schema-qualifies its FK targets as `"public"."plan_runs"`, matching
  the `0004` fix from the previous release. Migrations now resolve via
  `search_path` and succeed under isolated test schemas.

### Changed

- **`ci`** — CI now runs `bun run test:ci` (emits
  `test-results/junit.xml` via `bun test --reporter=junit`) and
  publishes a slowest-suites / slowest-tests markdown summary via
  `bun run report:test-timing`. JUnit XML is uploaded as the
  `bun-test-junit` artifact on every run, including failures, for
  offline regression triage and perf ratchets (warren-cec7).

## [0.6.12] — 2026-05-27

Patch release tightening server input parsing and de-duplicating JSON
body helpers.

### Fixed

- **`fix(server)`** — HTTP pagination (`?limit=`, `?offset=`) and the
  env-int helpers (`parseEnvPositiveInt`, `resolvePgPoolMax`,
  `parseIntEnv`) now apply the same strict `String(n) === raw`
  round-trip check used by `parseNonNegativeInt` /
  `parsePositiveInt`. Junk-suffix inputs like `?limit=5abc`,
  `WARREN_DB_POOL_MAX=10x`, and `WARREN_PAUSE_DETECTOR_TICK_MS=15000abc`
  now reject with a `ValidationError` instead of silently coercing to
  the leading integer (warren-da37).

### Changed

- **`refactor(server)`** — `readJsonBody` is now a thin wrapper over
  `readJsonBodyOrEmpty`, eliminating ~95% duplicated parse / validation
  / error-message code while preserving the byte-identical error
  strings for empty body, invalid JSON, and non-object payloads
  (warren-9ced).

## [0.6.11] — 2026-05-27

Patch release fixing pre-commit hooks and adding quality-gate
enforcement for coding agents in burrow sandboxes.

### Fixed

- **`fix(hooks)`** — `prepare` script now sets `core.hooksPath` to the
  tracked `scripts/hooks/` directory instead of copying files to
  `.git/hooks/`. Hooks stay in sync with source and fire on any
  checkout without requiring `bun install` first (warren-5797).

### Added

- **`feat(agents)`** — Built-in coding agent prompts (claude-code, pi,
  sapling) now instruct agents to run the project's quality gates
  before committing, referencing `$WARREN_QUALITY_GATE` with fallbacks
  to CLAUDE.md and common commands (warren-5797).
- **`feat(config)`** — New optional `qualityGate` field on
  `.warren/config.yaml`. When set, `spawnRun` injects it as
  `WARREN_QUALITY_GATE` into the burrow sandbox environment so agents
  can discover the project-specific command (warren-5797).

## [0.6.10] — 2026-05-26

Patch release hardening the developer experience: unified quality gates,
CI-enforced code-health checks, dev container support, and naming
convention enforcement.

### Added

- **`feat(dx)`** — Unified `check:all` script runs the full quality gate
  suite (`test`, `lint`, `typecheck`, `validate:agents-md`,
  `check:file-sizes`, `check:debt-markers`, `check:deps`,
  `check:bundle-size:build`, `gen:docs:check`) in one command.
- **`feat(ci)`** — CI now runs `validate:agents-md`, `check:file-sizes`,
  `check:debt-markers`, `check:duplicates` (jscpd), `check:deps` (knip),
  and `check:bundle-size` alongside the existing test/lint/typecheck jobs.
- **`feat(dx)`** — `check:deps` wraps [knip](https://knip.dev) in
  `--dependencies` mode to flag unused / undeclared npm dependencies
  across root and `src/ui` workspaces (warren-d109).
- **`feat(dx)`** — `check:duplicates` wires jscpd for duplicate-code
  detection with project-tuned thresholds (warren-c0c2).
- **`feat(dx)`** — `check:debt-markers` scans for TODO/FIXME/HACK markers
  not tracked in the allowlist (warren-9ce6).
- **`feat(dx)`** — `check:file-sizes` enforces per-file line-count budgets
  to flag overgrown modules (warren-7dc0).
- **`feat(dx)`** — `check:bundle-size` tracks Vite build output against
  per-chunk size budgets (warren-2cb2).
- **`feat(dx)`** — `gen:docs` auto-generates API route table documentation
  from handler source (warren-27a7).
- **`feat(dx)`** — `validate:agents-md` validates AGENTS.md commands
  still run (warren-b775).
- **`feat(dx)`** — `.devcontainer/devcontainer.json` for Bun-based
  Codespaces / Dev Container support (warren-1daa).
- **`feat(dx)`** — Dependabot configuration with dependency-update delay
  cooldown (warren-e54e).
- **`docs`** — `AGENTS.md` added at repo root mirroring CLAUDE.md
  essentials for non-Claude agents (warren-14a6).
- **`docs`** — `docs/http-api.md` generated API route documentation.

### Changed

- **`refactor(lint)`** — Biome complexity rules enabled project-wide:
  `noExcessiveLinesPerFunction` (500-line cap) and
  `noExcessiveCognitiveComplexity` (threshold 15), with overrides for
  existing large files (warren-e830).
- **`refactor(lint)`** — `useFilenamingConvention` enforces kebab-case
  filenames; `burrow_config.ts` renamed to `burrow-config.ts`
  (warren-a5b3).
- **`chore`** — Removed unused `chalk` and `pino-pretty` dependencies.
- **`chore`** — `.gitignore` extended to cover `.idea/` and `.vscode/`
  IDE directories.

### Fixed

- **`fix(test)`** — Six `launchPreview` tests updated with missing
  `tcpConnect` inject after the warren-44ed TCP-handshake refactor.

### Docs

- **`docs(claude)`** — CLAUDE.md updated: quality gates section now
  references `check:all` and documents `check:deps` / knip workflow.

## [0.6.9] — 2026-05-26

Patch release making the Plot "Run plan" dialog's agent prompt editable
(plan pl-f666, parent warren-b55b).

### Added

- **`feat(ui)`** — `RunPlanDialog` in `src/ui/src/pages/PlotDetail.tsx`
  now exposes a controlled `<Textarea>` for the agent prompt, seeded
  with `DEFAULT_PROMPT_TEMPLATE` and tracking a `promptTouched` flag
  for the "Default." hint (mirrors the `NewPlanRun` pattern). The
  edited prompt is forwarded on dispatch; an empty prompt is rejected
  client-side (warren-6e4c).

### Tests

- **`test(ui)`** — Added coverage for the editable prompt in the Plot
  Run-plan dialog (warren-fdf0).

## [0.6.8] — 2026-05-26

Patch release adding a bulk "Sync all" button to the /projects page and
a README update with the demo video link.

### Added

- **`feat(ui)`** — "Sync all" button on `/projects` page reuses
  `RefreshProjectsCTA` to fan out `projectsApi.refresh()` across all
  registered repos in parallel (warren-f1f3).

### Docs

- **`docs(readme)`** — Added demo video link to README.

### Chores

- **`chore(triggers)`** — Shifted bugwatch cron to 5 AM PT to avoid
  overlap with the seeds nightwatch window.

## [0.6.7] — 2026-05-26

Patch release with two small follow-ups from the 2026-05-26 nightwatch
patrol (plan pl-fb66): a docs correction to the `/release` slash command
and a content-type normalization on the preview-proxy error path.

### Fixed

- **`fix(preview)`** — `previewError` and `previewUnauthorized` in
  `src/preview/proxy.ts` now emit
  `content-type: application/json; charset=utf-8`, matching the rest of
  warren's JSON responses (`jsonResponse`, `notFoundResponse`). Error
  envelopes and the 401 `www-authenticate` header are unchanged
  (warren-a1e1).

### Docs

- **`docs(release)`** — `.claude/commands/release.md` step 4 now
  instructs editing `package.json` and `src/index.ts` directly, matching
  CLAUDE.md's explicit note that there is no `bun run version:bump`
  script in this repo. The release workflow's version-consistency check
  is called out inline (warren-9023).

## [0.6.6] — 2026-05-26

Patch release fixing preview-launch misclassification of slow-first-headers
dev servers. Phase-1 of `attemptPreviewLaunch` now answers the narrower
question ("did anything bind on the host port?") with a raw TCP handshake
instead of an HTTP fetch, so a bound server that takes >2s to flush
response headers (e.g. Next.js mid-compile) no longer burns the connect
budget being classified as `not_connected`. Closes plan pl-592f
(warren-c3a2).

### Added

- **`feat(preview)`** — `tcpConnectOnce(host, port, timeoutMs)` helper in
  `src/preview/launch.ts` opens a raw TCP socket via `Bun.connect` and
  closes it on the first connect callback, returning `connected` |
  `not_connected` (warren-49d9). Exported so unit tests can drive it
  directly.
- **`feat(preview)`** — optional `LaunchPreviewInput.tcpConnect` injection
  point mirroring the existing `fetch` injection, so phase-1 probe
  behaviour is fully deterministic under test (warren-44ed).

### Fixed

- **`fix(preview)`** — phase-1 of `attemptPreviewLaunch` now uses
  `tcpConnectOnce` instead of `probeOnce`'s HTTP fetch (warren-44ed).
  `probeOnce` is reserved for phase-2 where the HTTP readiness question
  is the correct one. Hit in real Next.js dispatches (`run_sjxddbjpg950`)
  where slow first-headers caused the connect budget to expire even
  though the dev server was bound. Regression test in launch.test.ts
  exercises the slow-first-headers path (warren-f04c).

## [0.6.5] — 2026-05-25

Patch release fixing auto_plan_run never firing when `mirrorPlans` is
active — the v0.6.4 `mirrorPlans` step copied workspace plans into the
project clone *before* the baseline snapshot, making the diff always
empty. Bugwatch runs that created plans would reap with
`autoPlanRunCreated: false` and no plan-runs would dispatch.

### Fixed

- **`fix(runs)`** — auto_plan_run baseline snapshot now runs before
  `mirrorPlans` (ordering bug introduced in warren-d9a2). Previously
  `mirrorPlans` appended workspace plans into the project clone first,
  so the subsequent baseline read saw the same plan IDs as the workspace
  — the diff found zero new plans and skipped dispatch. Regression test
  exercises the full `mirrorPlans` + auto_plan_run path end-to-end.

## [0.6.4] — 2026-05-25

Patch release fixing auto_plan_run children dispatching before the
parent run's PR merges — without this gate, children would start on
stale seeds state. Also mirrors `.seeds/plans.jsonl` from the workspace
into the project clone during reap so `stageSeedsForCommit` no longer
overwrites agent-created plans.

### Added

- **`feat(plan-runs)`** — `parentRunId` column on plan-runs
  (warren-d9a2). Auto-plan-runs now back-link to the run that created
  them. The coordinator gates on the parent run's PR being merged (or
  the parent being a no-op empty-push) before dispatching the first
  child. New DB migration `0018_add_plan_run_parent_run_id.sql`
  (SQLite + Postgres).

- **`feat(runs)`** — `mirrorPlans` reap step (warren-d9a2). During
  reap, `.seeds/plans.jsonl` is now mirrored from the burrow workspace
  into the project clone (append-only by plan ID) before
  `stageSeedsForCommit` runs. Emits `seeds.plan_mirrored` events per
  new plan.

### Fixed

- **`fix(plan-runs)`** — auto_plan_run children no longer dispatch
  before the parent run's PR merges (warren-d9a2). Previously children
  would start immediately on the default branch which lacked the
  parent's seeds state. The coordinator now waits for merge, handles
  closed-unmerged (fails the plan-run), and treats deleted parent rows
  as gate-passed for best-effort recovery.

- **`fix(runs)`** — `stageSeedsForCommit` no longer overwrites
  agent-created plans (warren-d9a2). The new `mirrorPlans` step copies
  workspace plans into the project clone first, so the subsequent
  project→workspace copy in `stageSeedsForCommit` preserves them.

## [0.6.3] — 2026-05-25

Patch release fixing auto_plan_run agent name inheritance — triage
agents (bugwatch, nightwatch) no longer propagate their "do not write
code" system prompt to the plan-run children that need to implement
fixes.

### Added

- **`feat(registry)`** — `auto_plan_run_agent` frontmatter field
  (warren-65b2). When set on an agent, the auto-dispatched plan-run
  uses this agent name instead of inheriting the parent run's agent.
  Falls back to the parent's `agentName` when unset (backward-
  compatible). New `readAutoPlanRunAgent()` reader in
  `src/registry/schema.ts`.

### Fixed

- **`fix(runs)`** — auto_plan_run children no longer inherit the
  parent triage agent name (warren-65b2). `reapRun` now calls
  `resolveAutoPlanRunAgent()` which reads `auto_plan_run_agent` from
  the rendered agent's frontmatter before falling back to
  `run.agentName`. Both `bugwatch` and `nightwatch` built-ins set
  `auto_plan_run_agent: "pi"` so child runs boot with a coding agent
  prompt instead of the triage prompt.

## [0.6.2] — 2026-05-25

Patch release shipping the **bugwatch** built-in agent — a bug triage
patrol that reads open bug seeds, investigates the codebase, and
produces seeds plans with concrete fix steps. Complements nightwatch
(which discovers new issues by scanning code) by planning fixes for
existing filed bugs. Also fixes nightwatch and bugwatch dispatch by
adding the missing `runtime: "pi"` frontmatter field.

### Added

- **`feat(registry)`** — built-in `bugwatch` bug triage agent. New
  `src/registry/builtins/bugwatch.ts` ships a read-only triage agent
  that reads open bug seeds, investigates each one in the codebase, and
  produces a seeds plan per bug with concrete fix steps. Caps at 3 plans
  per run; skips bugs that already have plans, are in-progress, are
  blocked, or lack sufficient detail. Uses `auto_plan_run: true` so
  warren auto-dispatches plan-runs for each new plan on reap. Registered
  in `seedBuiltinAgents()`.
- **`feat(triggers)`** — twice-weekly bugwatch cron trigger
  (`.warren/triggers.yaml`). Fires at 4 AM PT on Wednesdays and Sundays
  against the `bugwatch` role with a triage prompt.

### Fixed

- **`fix(registry)`** — add missing `runtime: "pi"` to nightwatch
  frontmatter (`src/registry/builtins/nightwatch.ts`). Without the
  runtime field, nightwatch (and bugwatch) dispatch failed because
  burrow couldn't resolve the agent runtime. Both patrol agents now
  explicitly declare `runtime: "pi"`.

## [0.6.1] — 2026-05-25

Patch release shipping the **nightwatch** patrol agent pattern end-to-end:
a built-in code-quality scanning agent, an `auto_plan_run` reap hook that
auto-dispatches plan-runs for any plans the agent creates, a nightly cron
trigger, and the plumbing to make `seed` optional on cron triggers so
seedless agents (like nightwatch) can run on schedule. Also switches the
default provider/model from Google Gemini to Anthropic Opus.

### Added

- **`feat(registry)`** — built-in `nightwatch` patrol agent
  (warren-a32a). New `src/registry/builtins/nightwatch.ts` ships a
  read-only code patrol agent that scans repos for quality issues
  (inconsistencies, bugs, type safety gaps, dead code, test gaps,
  security vectors, doc drift) and produces a seeds plan to fix them.
  Does not write source files — only writes to `.seeds/` via the `sd`
  CLI. Intended for nightly cron triggers; operators with a custom
  canopy library override by registering a same-named agent.
- **`feat(runs)`** — `auto_plan_run` reap hook (warren-a32a). When an
  agent's canopy frontmatter declares `auto_plan_run: true` and the run
  succeeds, reap diffs `.seeds/plans.jsonl` (workspace vs project
  baseline) to detect new plans created during execution and
  auto-dispatches a plan-run for each via `POST /plan-runs`. Enables
  the patrol pattern: cron fires a scan agent → agent files a plan →
  warren auto-executes it. New `ReapRunResult` fields:
  `autoPlanRunCreated`, `autoPlanRunId`, `autoPlanRunPlanId`. Failures
  are best-effort (`reap_failed` step=`auto_plan_run`). Test coverage
  in `src/runs/reap.test.ts`.
- **`feat(registry)`** — `auto_plan_run` frontmatter field documented
  in `AgentDefinition` schema comments (`src/registry/schema.ts`).
- **`feat(triggers)`** — nightly nightwatch cron trigger
  (`.warren/triggers.yaml`). Fires at 2 AM PT daily against the
  `nightwatch` role with a patrol prompt.

### Changed

- **`feat(triggers)`** — `seed` is now optional on cron triggers
  (warren-60dc). Previously `seed` was a required field in
  `TriggersConfigSchema`; seedless agents (nightwatch, future patrol
  variants) couldn't be scheduled without a placeholder seed.
  `resolveCronPrompt` falls back to `"Run cron trigger <id>."` when no
  seed is present. Metadata omits `seed` when undefined instead of
  passing `undefined`.
- **`chore(defaults)`** — switch default provider/model from Google
  Gemini 3.5 Flash to Anthropic Claude Opus (`0226bc5`).

## [0.6.0] — 2026-05-25

Minor release introducing the **Warren Client SDK** (`src/client/`) — a
standalone, zero-server-deps TypeScript facade over warren's HTTP API,
intended for acceptance scenarios, CLIs, and third-party tooling that
drive warren without re-implementing the wire format.

### Added

- **`feat(client)`** — `WarrenClient` skeleton, wire types, error
  classes, and config loader (warren-552c, #91). Establishes the
  package layout: types co-located in `src/client/types.ts`, transport
  errors (`WarrenClientError`, `WarrenUnreachableError`) in
  `errors.ts`, no imports from server-side modules (mirrors the
  `burrow-client/` pattern, cf. mx-acdd4c).
- **`feat(client)`** — Project & agent management endpoints
  (warren-285f, #93): `listProjects` / `createProject` /
  `refreshProject` and `listAgents` / `getAgent` / `refreshAgents` /
  `refreshProjectAgents`. Path segments are URL-encoded; `refreshProject`
  sends `{}` when no ref is supplied to satisfy
  `readJsonBodyOrEmpty`.
- **`feat(client)`** — Run dispatch and status polling (warren-387a,
  #94): `dispatch()` (wrapping `POST /runs` with a user-facing
  `DispatchRunInput`), `getRun()`, and `waitForRun({intervalMs,
  timeoutMs, signal, onTick})` polling until `isTerminalRunState`
  holds. Defaults: 2 s poll, 30 min budget. Throws
  `WarrenClientError(408, 'wait_timeout')` on deadline,
  `AbortError` on signal. Exports `RUN_TERMINAL_STATES` /
  `isTerminalRunState` mirroring `src/db/schema.ts`.
- **`feat(client)`** — SSE event streaming via
  `streamRunEvents(runId, { follow?, sinceSeq?, signal? })` (warren-e0ed,
  #95). Wire format is NDJSON (not SSE despite the seed title) to match
  the existing `GET /runs/:id/events` handler. Yields typed `RunEvent`
  objects via `AsyncGenerator`; handles chunked partial lines, flushes
  trailing newline-less line, drops malformed lines best-effort.
  Transport failures map to `WarrenUnreachableError` via the shared
  `withTransportMapping` seam.
- **`feat(client)`** — Mid-run steering: `steer(runId, { body,
  priority?, fromActor? })` wraps `POST /runs/:id/steer` and returns
  `{ message: InboxMessage }` (warren-a4b9, #96). `InboxMessage` /
  `MessagePriority` are declared inline to keep the client zero-deps on
  `@os-eco/burrow-cli`. Docstring points operators at the server-driven
  pause/resume lifecycle (`src/runs/pause.ts`, Plot `question_answered`)
  so they don't issue a redundant `resume` after answering a
  `question_posed`.
- **`feat(client)`** — Plot and plan-run management (warren-8ffc, #97):
  `listPlots` / `getPlot` / `createPlot` / `editPlotIntent` /
  `changePlotStatus` / `syncPlot` for `/plots` (snake_case wire,
  mirroring `@os-eco/plot-cli`'s on-disk shape), and `createPlanRun` /
  `getPlanRun` / `listPlanRuns` for `/plan-runs` (camelCase wire,
  parallel to `/runs`). Inputs accept camelCase for ergonomics and are
  mapped to snake_case at the boundary for `/plots`. Optional fields
  are omitted when undefined.

## [0.5.6] — 2026-05-25

Patch release fixing Plot aggregator staleness when new Plots arrive
via git fetch after the index was built, and guarding the Docker build
against a missing `.git` directory in the prepare script.

### Fixed

- **`fix(plots)`** — Plot aggregator `queryWithRebuildRetry` now
  compares index row count against on-disk `*.json` file count via a
  new `countPlotFilesOnDisk()` method on `AggregatorPlotClient`
  (warren-d590). When disk has more files than the index knows about
  (e.g. new Plots fetched via `git fetch` after the index was built),
  the aggregator triggers `rebuildIndex()` and retries — catching
  incremental staleness that the existing empty-rows path (warren-ede7)
  didn't cover. New tests pin the rebuild-on-count-mismatch path and
  the no-rebuild-on-match path.
- **`fix(docker)`** — Guard the `prepare` script against a missing
  `.git` directory (a480429). The `prepare` hook unconditionally copied
  the pre-commit hook into `.git/hooks/`, which fails in Docker where
  `.git` is excluded via `.dockerignore`. Now exits 0 when either path
  is absent.

### Added

- **`feat(plots)`** — Plot for warren client SDK (plot-1ce5ca91).
  Typed remote client for external agents to interact with warren's
  HTTP API.

## [0.5.5] — 2026-05-23

Patch release shipping the Plot sync feature end-to-end: warren can now
push dirty `.plot/` state back to GitHub as a PR (with configurable
merge strategy), both on-demand via a UI button and automatically in
the background on formalize/status-change. Also fixes builtin agent
drift detection on boot and switches the default provider to Google
Gemini 3.5 Flash.

### Added

- **`feat(plots)`** — Plot sync module (`src/plots/sync.ts`,
  warren-5bc2 / pl-5a6c). `defaultPlotSyncer.sync()` detects dirty
  `.plot/` files via `git status --porcelain`, creates a temporary
  worktree off `origin/<targetBranch>`, copies plot files, commits under
  the warren bot identity, pushes the branch, opens a PR via the GitHub
  API, and optionally merges it immediately based on `mergeStrategy`
  (`immediate` | `auto` | `manual`). Worktree is cleaned up in a
  `finally` block. Full test coverage in `sync.test.ts` (#85).
- **`feat(config)`** — `plotSync` block in `DefaultsConfigSchema`
  (warren-cd22 / pl-5a6c step 1). New `PlotSyncConfig` type with
  optional `mergeStrategy` (immediate/auto/manual, default manual) and
  `targetBranch` (defaults to project's `defaultBranch`). Schema
  validation tests cover all merge strategies, empty block, omitted
  block, and strict-mode rejection of unknown fields (#84).
- **`feat(server)`** — `POST /plots/:id/sync` endpoint (warren-1d0c /
  pl-5a6c step 3). Manual sync trigger with plot existence + project
  `hasPlot` validation. Returns the `PlotSyncResult` envelope
  (`no_op` | `synced` with branch/prUrl/merged). Server handler test
  coverage for success, 404, and project-lacks-plot cases (#86).
- **`feat(server)`** — Background auto-sync on formalize and
  status-change (pl-5a6c step 3). `triggerBackgroundSync` fires-and-logs
  after `POST /plots/:id/formalize` and `POST /plots/:id/status` so
  Plot metadata flows to GitHub without manual intervention.
- **`feat(ui)`** — `PlotSyncButton` on PlotDetail page (warren-1d0c /
  pl-5a6c step 4). "Sync to GitHub" button with `GitBranch` icon,
  loading spinner, success/error toast with auto-dismiss, and inline PR
  link on success. Placed alongside the status transition control (#87).
- **`chore(hooks)`** — Pre-commit hook (`scripts/hooks/pre-commit`)
  runs `bun run lint` + `bun run typecheck` before every commit.
  Installed via the new `prepare` script in `package.json`.

### Changed

- **`fix(registry)`** — `seedBuiltinAgents` now re-upserts built-in
  agent rows whose content or frontmatter has drifted from the code
  definition, while preserving library/project-tier overrides (#83).
  Previously, a builtin seeded in a prior version (e.g. brainstorm
  without `runtime: pi`) would never update, requiring manual DB
  surgery. New `areDeepEqual` comparison + `readAgentSource` tier check.
- **`chore(defaults)`** — Switch default provider to Google Gemini 3.5
  Flash (`d8164d7`).

## [0.5.4] — 2026-05-23

Patch release. Bumps `@os-eco/burrow-cli` 0.3.3 → 0.3.4 to fix
Google/Gemini provider env passthrough, and makes brainstorm/planner
runtime configurable via `.warren/config.yaml`.

### Changed

- **`chore(burrow-cli)`** — bump `@os-eco/burrow-cli` 0.3.3 → 0.3.4
  to pick up the Google/Gemini provider env passthrough fix.
- **`feat(config)`** — brainstorm/planner runtime is now configurable
  via `.warren/config.yaml` `interactiveAgents` block (warren-b802).

## [0.5.3] — 2026-05-23

Patch release shipping cost analytics, a responsive mobile UI, and
several reap/refresh fixes. The cost analytics view
(`GET /analytics/cost` + `/cost-analytics` page) breaks down
`runs.cost_usd` across eight dimensions (date, project, plan, plot,
run, agent, model, provider) with filterable date range and project
selector. The UI gains a mobile navigation shell, responsive table
layouts across all pages, and a paginated/sortable Runs table. On the
backend, reap now commits `.seeds/` deltas on the agent's behalf
(closing the planner-default-prompt bug where `sd plan submit` writes
were lost on push), and project refresh merges `.plot/` snapshots
instead of blindly overwriting them.

### Added

- **`feat(analytics)`** — `GET /analytics/cost` endpoint + cost
  analytics aggregator (warren-cf63 / pl-b0c0 step 6). Pure
  `buildCostAnalytics` function takes flat analytics rows and emits
  eight grouped breakdowns (date, project, plan, plot, run, agent,
  model, provider), each with `costUsd`, `runs`, `priced` per bucket.
  Date dimension sorted chronologically; all others by cost descending.
  Null group keys fold into a `__none__` bucket rendered as em-dash.
  New `CostAnalyticsPage` at `/cost-analytics` with date-range and
  project filters persisted in URL search params. Server endpoint
  accepts optional `projectId`, `from`, `to` query params; defaults to
  last 30 days. Full test coverage in `cost-analytics.test.ts`.
- **`feat(plan-runs)`** — show cost per plan on the plan-runs list page
  (warren-2235 / pl-b0c0 step 5). `PlanRunsRepo` gains a
  `listWithCost` query joining `plan_run_children → runs` to sum
  `cost_usd` per plan-run; the plan-runs table renders the aggregate
  cost inline.
- **`feat(plots)`** — `POST /plots/:id/rename` endpoint + PlotDetail
  inline rename affordance (warren-bed0 / pl-b0c0 step 3). Renames
  allowed in every status (name is metadata, not frozen at done).
  `UserPlotClient.rename` mutates `plot.json#/name` under the per-Plot
  file lock and appends a `note` event recording the from→to
  transition. New `src/plots/renamer.ts` seam + test coverage in
  `renamer.test.ts`.
- **`feat(ui)`** — mobile navigation shell and responsive layout
  wrapper (#73). Collapsible sidebar with hamburger toggle on small
  screens; layout wrapper applies consistent padding and max-width
  breakpoints.
- **`feat(ui)`** — Cost Analytics entry in sidebar navigation with
  route at `/cost-analytics`.

### Changed

- **`refactor(ui)`** — Runs page: replace truncated list with
  paginated, sortable table (#76). Server-side pagination via
  `offset`/`limit` query params on `GET /runs`; sortable columns
  (started, cost, state); URL-persisted page state.
- **`refactor(ui)`** — Plot status: replace forward-only buttons with
  a dropdown selector (warren-470e, #80). The status transition control
  now renders a `<select>` dropdown showing all legally-reachable
  statuses per SPEC §6.5, replacing the previous forward-only button
  group.
- **`refactor(ui)`** — Enhance Runs, Plan-Runs, and Projects table
  pages responsiveness (#74). Tables use horizontal scroll on small
  viewports; cell content truncates gracefully.
- **`refactor(ui)`** — Ensure Plots list and Plot details pages wrap
  and display correctly on narrow viewports (#75).
- **`refactor(ui)`** — Optimize form pages (New Run, New Plan Run) and
  touch targets for mobile (#77).
- **`chore(deps)`** — bump claude-code 2.1.138→2.1.150 and pi
  0.74.0→0.75.4 in Dockerfile.

### Fixed

- **`fix(reap)`** — commit `.seeds/` deltas on the agent's behalf
  (warren-7ecc). Mirrors the `.plot/` commit-through-reap pattern
  (warren-343a): agents with narrowly-scoped write contracts (the
  planner) are forbidden from running `git commit`, so `sd plan submit`
  writes to `.seeds/issues.jsonl` + `.seeds/plans.jsonl` but the push
  landed empty (`reap.empty_push`). Reap now copies committable seeds
  files from the project clone into the workspace, stages `.seeds/`,
  and authors a `chore(warren): seeds state` commit under the warren
  bot identity when there's a real delta. Skipped when the project has
  no `.seeds/`. Best-effort: failures emit `reap_failed`
  step=`seeds_commit`. New `seedsCommitted` field on `ReapRunResult`.
  Test coverage for round-trip, no-op, skip-config, and planner-prompt
  scenarios.
- **`fix(projects)`** — merge `.plot/` snapshot on refresh instead of
  blind overwrite (warren-af9e). `preservePlot`'s restore phase now
  merges snapshot files with any changes that arrived via
  `git reset --hard`, instead of unconditionally overwriting. Prevents
  data loss when origin carries newer `.plot/` state than the snapshot.
  Test coverage in `refresh.test.ts`.
- **`fix(ui)`** — fix or remove broken plot interactive chat (#78).
  Interactive chat component cleaned up to prevent runtime errors on
  plots without an active interactive run.

## [0.5.2] — 2026-05-22

Patch release. Fixes canopy-defined interactive agents (brainstorm,
planner) failing ~17s into a run with `execvp claude: No such file or
directory` when the agent's name didn't match a burrow runtime id
(warren-53e6).

### Fixed

- `spawnRun` now forwards `readRuntimeId(agent)` (not `agent.name`) to
  `provisionBurrow`, so burrow's `POST /burrows` resolves the correct
  runtime and mounts the claude toolchain. Previously, canopy agents
  with `frontmatter.runtime` (e.g. brainstorm/planner) caused
  `registry.get` to return undefined, `collectToolchainPaths` to skip
  the agent, and bwrap to fail on exec. Test guard added for the
  warren-ebca brainstorm case (warren-53e6).

## [0.5.1] — 2026-05-23

Patch release. Fixes interactive agents (brainstorm/planner) failing
with "agent not registered" (#68).

### Fixed

- Interactive agents (brainstorm/planner) no longer fail with
  "agent not registered" (#68).

## [0.5.0] — 2026-05-23

Minor release shipping the Plot-workbench loop (plan pl-0344, parent
warren-769e / SPEC §11.O). Plot is now the primary UI surface: users
brainstorm Plots from zero with an interactive agent, formalize intent,
run a planner that submits structured seeds plans, and watch batch runs
pause on `question_posed` and resume on `question_answered`. V1.5
click-to-merge + auto-sync and a summary-artifact view round out the
loop. The /plots inbox surfaces "needs you" Plots via a sidebar badge,
and a new acceptance scenario (32) covers the full loop end-to-end.

### Added

- **`feat(db)`** — `runs.mode` column (`batch`|`interactive`, default
  `batch`) plus pause columns (`paused_at`, `paused_question_event_id`)
  and the new `paused` run state (warren-67b6 / pl-0344 step 1).
  `ALLOWED_TRANSITIONS` extended with `running→paused`,
  `paused→running`, `paused→cancelled`. Mirrored across sqlite +
  postgres schemas with matching migrations; `drift.test.ts` updated.
- **`feat(config)`** — `agent.pauseTimeoutMs` knob in
  `DefaultsConfigSchema` (default `1800000` = 30 min, bounds 1s..24h)
  for paused interactive turns and batch runs awaiting answers
  (warren-cd37 / pl-0344 step 2). Surfaced via `loadWarrenConfig()`,
  documented in SPEC §11.O and CLAUDE.md.
- **`feat(runs)`** — interactive run primitive (warren-1117 /
  pl-0344 step 3). New `src/runs/interactive.ts` implements
  respawn-per-turn lifecycle: `spawnInteractiveTurn(runId, message)`
  reads Plot context (intent + last N events + attachments), constructs
  the prompt, spawns burrow via existing `spawnRun`, and captures the
  reply on reap. User and agent turns persist as `user_message` /
  `agent_message` events. Composable with `interactiveAgent` config
  (brainstorm vs planner).
- **`feat(server)`** — interactive run HTTP API (warren-b3b9 /
  pl-0344 step 4). `POST /runs` now accepts `mode='interactive'` +
  `interactiveAgent` + `plot_id` (required for interactive). New
  `POST /runs/:id/messages` sends a user turn (202). `GET /runs/:id/events`
  streams interactive message events. Typed request/response schemas
  in `src/server/handlers.ts`.
- **`feat(runs)`** — blocking-question pause detector for batch runs
  (warren-2976 / pl-0344 step 5). Supervisor polls `.plot/.index.db`
  for new `question_posed` events on in-flight batch runs, transitions
  the run to `paused`, persists `paused_question_event_id`, and
  schedules `pauseTimeoutMs`. On `question_answered` for the same
  Plot+question, warren respawns the agent turn with the answer in
  prompt context; on timeout the same respawn fires with a timeout
  warning. Coverage in `src/runs/pause.test.ts`.
- **`feat(registry)`** — built-in `brainstorm` agent (warren-3de8 /
  pl-0344 step 6). New `src/registry/builtins/brainstorm.ts` ships a
  read-only scout (rg + file read + web fetch) that sharpens an
  unformed idea into Plot intent. No Plot writes, no source-code
  writes, no dispatch. Registered in `seedBuiltinAgents()`.
- **`feat(registry)`** — built-in `planner` agent (warren-543d /
  pl-0344 step 7). New `src/registry/builtins/planner.ts` reads Plot
  intent, scouts the repo, asks clarifying questions interactively,
  submits a structured `sd plan` via `sd plan submit`, and attaches
  resulting seeds to the Plot. Writes restricted to `.plot/` +
  `.seeds/` paths; no source-code writes.
- **`feat(plots)`** — brainstorm dispatcher + formalize endpoint
  (warren-d22e / pl-0344 step 8). `POST /brainstorm` creates a draft
  Plot (status=`drafting`, empty intent, auto-named) and spawns the
  first interactive turn with the brainstorm agent. `POST
  /plots/:id/formalize` runs a summarize turn that returns suggested
  intent (goal, non_goals, constraints, success_criteria) from the
  conversation; user edits via existing `POST /plots/:id/intent` and
  transitions to `ready` via existing status endpoint.
- **`feat(plots)`** — needs-attention API (warren-d693 /
  pl-0344 step 9). `GET /plots?filter=needs_attention` returns Plots
  with (a) paused runs awaiting answer, (b) merged-but-unreviewed
  `gh_pr` attachments, (c) drafts with no activity in N days. New
  `PlotsRepo.listNeedsAttention()` + `GET /plots/needs-attention/count`
  for the sidebar badge.
- **`feat(ui)`** — `Chat.tsx` component primitive (warren-ea98 /
  pl-0344 step 10). Streaming message list (user + agent bubbles),
  input box, send button; consumes `useEventStream` for live agent
  replies via `/runs/:id/events`. Reusable across brainstorm + planner
  + future interactive surfaces.
- **`feat(ui)`** — PlotDetail interactive surfaces (warren-444c /
  pl-0344 step 11). "Start brainstorming" button (creates a Plot via
  `POST /brainstorm` if none, else opens chat), "Run planner" button
  (spawns planner interactive run), inline `Chat` panel for the
  currently-active interactive run, and "Formalize" button (`POST
  /plots/:id/formalize` → suggested intent for user review → transitions
  to `ready` on accept).
- **`feat(ui)`** — paused-run surfacing on PlotDetail (warren-4ea4 /
  pl-0344 step 12). Activity feed renders `question_posed` events with
  a prominent "Answer & resume" card (textarea + submit via existing
  `POST /plots/:id/questions/:event_id/answer`) and a countdown to the
  pause timeout. New `StateBadge` variant for `paused`.
- **`feat(ui)`** — Plot-first home + inbox (warren-f0e2 /
  pl-0344 step 13). `DefaultLanding` now redirects `/` → `/plots`
  whenever any project has `hasPlot`. Plots page gains a "Needs you"
  filter chip (queries `?filter=needs_attention`), the sidebar gains a
  needs-attention badge, and "Start brainstorming" + "New Plot" become
  primary buttons at the top of `/plots`.
- **`feat(plots)`** — (V1.5) click-to-merge + auto-sync (warren-8e39 /
  pl-0344 step 14). `POST /plots/:id/attachments/:ref/merge` calls the
  GitHub API to merge a `gh_pr` attachment; on success warren schedules
  `refreshProjectClone()` to pull merged commits into the local clone.
  Merge state + GitHub rate-limit/error states surfaced on the PR
  attachment UI; background sync notifies via the existing event
  stream.
- **`feat(plots)`** — (V1.5) summary artifact view (warren-8917 /
  pl-0344 step 15). `GET /plots/:id/summary` returns a curated payload
  (formatted intent, decisions filtered from the event log by
  `type=decision_made`, linked PRs + commits, timeline) backed by the
  pure `summarizePlot` derivation seam in `src/plots/summary.ts`. New
  `src/ui/src/pages/PlotSummary.tsx` at `/plots/:id/summary` renders a
  clean institutional-memory layout.
- **`test(acceptance)`** — scenario 32, Plot-workbench loop
  (warren-7cd9 / pl-0344 step 16). Covers the full V1+V1.5 loop
  end-to-end against live warren+burrow: create brainstorm Plot, chat,
  formalize, run planner, submit `sd plan`, dispatch PlanRun, agent
  emits `question_posed`, run pauses, user answers via API, run
  resumes, PR opens, user clicks merge, auto-sync pulls into clone,
  Plot auto-transitions to `done`, summary renders. Idempotent and
  deterministic; cleans up after itself.

## [0.4.8] — 2026-05-19

Patch release closing out the SPEC §11.Q "Plot → synthesized plan-run
pipeline" (pl-f404) that landed as a design lock in `0.4.7`: warren now
ships both halves of the pipeline (server endpoint + PlotDetail UI
button), the burrow-cli triple-pin bumps to 0.3.3 to pick up pi
multi-provider env passthrough, and the Plots UX gains an inline
"Refresh projects to discover new Plots" CTA that closes the first
dogfood-discovered visibility gap.

### Added

- **`feat(server)`** — `POST /plot-plan-runs` synthesis endpoint
  (warren-99b2, pl-f404 step 2 / SPEC §11.Q). New `src/plot-plan-runs/`
  module synthesizes a seeds plan from a Plot's open `seeds_issue`
  attachments via `sd create` + `sd plan submit` with `existing_seed`
  children (seeds-cli 0.4.7 contract), then dispatches it through the
  existing §11.P plan-run coordinator unmodified. Filters out closed
  seeds and `sd_plan`-shaped refs server-side; re-reads the synthesized
  plan via `showPlan` and inlines the same persistence + Plot append
  flow as `POST /plan-runs`. Typed 4xx errors:
  `NoDispatchableSeedsError` (400), `SdPlanSynthesisError` (500), plus
  the inherited `plot_id_invalid` / `plot_id_not_found` /
  `project_lacks_plot` / `project_lacks_seeds` gates. Preview proxy
  invariant (warren-63e1) updated to include `/plot-plan-runs`.
- **`feat(ui)`** — PlotDetail "Dispatch as plan-run (N)" button on the
  SubstratePanel (warren-bce0 / pl-f404 step 4 / SPEC §11.Q). Same
  `isBatchDispatchTarget` filter as the parallel "Dispatch all" batch
  button, but synthesizes a seeds plan from the Plot's open
  `seeds_issue` attachments and dispatches it as a single tracked
  PlanRun via `POST /plot-plan-runs` (warren-99b2). Children run
  serially with PR-merge gating, and the Plot auto-transitions to
  `done` when the final child merges (§11.P.Plot wiring inherited
  unchanged). Confirm dialog renders the synthesized plan title preview
  + candidate seed list + filter rationale; on success the user is
  routed to `/plan-runs/:id`. The batch-dispatch dialog (warren-7c3f)
  description now points operators at the plan-run path as the
  recommended action for PR-merge-serial gating, with the batch button
  reframed as the parallel-fan-out escape hatch. New API client method
  `plotsApi.dispatchSynthesizedPlanRun` + types `CreatePlotPlanRunInput`
  / `CreatePlotPlanRunResponse` in `src/ui/src/api/types.ts`.
- **`feat(server)`** — `GET /projects/:id/seeds/:seedId` read endpoint
  (warren-4015). Returns the narrow `{id, status, blockedBy}` shape the
  UI needs so PlotDetail's BatchDispatchDialog can probe each target's
  status in parallel on open and drop closed seeds at confirm time,
  satisfying warren-ea66 acceptance (d). Gate order mirrors
  `POST /plan-runs` (project 404 → hasSeeds gate → seedsCli gate);
  dialog now marks closed seeds as `skipped`, dispatches only the open
  subset, and surfaces the skipped count inline.
- **`feat(ui)`** — Inline "Refresh projects to discover new Plots" CTA
  (warren-bb22, first dogfood-discovered Plot UX gap). Plots committed
  via the `plot` CLI in a project repo were silently invisible in the
  warren UI until something else triggered `refreshProjectClone`
  (`detectProjectFeatures` only flips `hasPlot` during refresh). New
  `src/ui/src/components/RefreshProjectsCTA.tsx` fans out
  `projectsApi.refresh` across every registered project and invalidates
  `[projects]`, `[plots]`, `[plot]`. Wired into the Plots page
  EmptyState (both "no `hasPlot` projects" and "no plots yet" branches)
  and the PlotDetail 404/isError branch as the inline recovery path.
  Scopes (2) periodic background refresh and (3) GitHub-webhook
  auto-refresh remain open for follow-ups.
- **`feat(acceptance)`** — Scenario 31 plot-plan-run synthesis roundtrip
  (warren-af97). Composes scenarios 25 + 27 + 29 against a live
  warren+burrow stack: `POST /plot-plan-runs` synthesizes a seeds plan
  from a Plot's open `seeds_issue` attachments via `existing_seed`
  adoption (seeds-cli 0.4.7), walks three children to merged through
  the GH-fetch-merge shim, auto-transitions the Plot `active → done`,
  and verifies re-dispatch mints a fresh `synthesizedPlanId`. Negative
  arms cover `plot_id_invalid`, `plot_id_not_found`,
  `project_lacks_plot`, and `no_dispatchable_seeds` typed 4xx.

### Changed

- **`deps`** — bump `@os-eco/burrow-cli` 0.3.2 → 0.3.3 (warren-fe96).
  Picks up burrow-6f3f's conditional `AgentRuntime.envPassthrough` so a
  pi run dispatched with `providerOverride='openai'` (or `gemini` /
  `google` / `groq` / `mistral` / `deepseek`) actually sees the
  matching `*_API_KEY` inside the sandbox. Triple-pin bump per
  CLAUDE.md "Relationship to burrow" (`package.json` + `bun.lock` +
  `Dockerfile`). New acceptance scenario 30 exercises the end-to-end
  warren↔burrow handoff (operator override →
  `renderedAgentJson.frontmatter` → burrow run metadata → dispatcher
  `readFrontmatter` → `piEnvPassthrough` → spawn env) and asserts the
  picked-up key is visible inside the sandbox.

### Fixed

- **`fix(projects)`** — `src/projects/refresh.ts` `preservePlot` wrapper
  now spans `git checkout --force <ref>` in addition to
  `git reset --hard origin/<ref>` (folded into warren-af97). Checkout
  was discarding uncommitted modifications to tracked files, so the
  host-side Plot appender writes (`plan_run_dispatched` at POST time,
  per-child `run_dispatched` from `spawnRun`, the `active → done`
  `status_changed` from auto-done) were getting wiped before the
  snapshot could capture them — only the last child's writes survived.
- **`fix(seeds-cli)`** — `PlanShowStepSchema.title` relaxed to optional
  and now accepts `existing_seed`, matching what `sd plan show --json`
  emits for adoption-only steps (folded into warren-af97). The
  plot-plan-run synthesizer's payload (`steps[].existing_seed`) was
  being rejected on the `showPlan` readback with a 500
  `sd_plan_synthesis_error`, even though warren only consumes
  `plan.children` for dispatch.
- **`fix(acceptance)`** — Scenario 27 now expects a PR on the
  no-agent-commit child (warren-9e2c). After warren-343a (commit
  `.plot/` through reap), reap's `stagePlotForCommit` lands a
  `chore(warren): plot state` commit on every plot-bound run carrying
  host-side `.plot/` appender writes back to origin, so `commitsAhead`
  is ≥ 1 even when the agent itself commits nothing — the
  "trivial-merge no-PR" contract only holds for plot-less projects
  (scenario 26). Variables renamed `trivialChild`/`trivialRun` →
  `noAgentCommitChild`/`noAgentCommitRun` to match what the test
  actually exercises.
- **`fix(acceptance)`** — Scenario 29 now expects `attachment_added`
  (warren-911c); plot-cli 0.3.0 renamed the event from
  `attachment_attached`.

## [0.4.7] — 2026-05-18

Patch release bundling the next two shipped steps of the Plot UX vision
(pl-5310 / warren-e40a) on top of the per-seed Run button that landed in
`0.4.6`: dispatch-time `plot_id` validation closes the silent-accept
dogfood signal from `plot-3e72876d`, and PlotDetail grows a batch
"Dispatch all" header action on the SubstratePanel. The cross-repo
Plot→synthesized plan-run pipeline (pl-5310 step 4) lands as a SPEC
§11.Q design lock only — implementation is gated on an upstream
seeds-cli contract (warren-d519) and will ship in a follow-up release.

### Added

- **`feat(server,ui)`** — Batch "Dispatch all (N)" button on PlotDetail's
  SubstratePanel (warren-7c3f, pl-5310 step 3). Opens a confirm dialog
  and fires N parallel `POST /runs` in one go, each bound to the Plot
  via `plot_id` and `seed_id`. Reuses the same agent/prompt resolution
  as the per-row RunSeedButton (`.warren/defaults.yaml` `defaultRole` +
  `defaultPrompt` with `{seed_id}` substituted). Each dispatch's
  `run_dispatched` event flows into the activity feed via the 5s poll
  tick. Eligibility: `seeds_issue` attachments that are not `sd_plan`-
  shaped (`pl-*` refs already render their own per-row Run plan
  button). V1 ships parallel mode only — serial-gated-on-PR-merge is
  deferred to pl-5310 step 4. Closed-seed skip filed as warren-4015
  follow-up.

### Changed

- **`feat(server,ui)`** — `plot_id` format + existence validation at
  dispatch (warren-bae5, pl-5310 step 2). Two new typed errors in
  `src/plots/errors.ts` — `PlotIdInvalidError` (`code=plot_id_invalid`)
  and `PlotIdNotFoundError` (`code=plot_id_not_found`) — both mapped to
  400 in `src/server/errors.ts`. New shared helper
  `src/plots/id-validator.ts` exports `PLOT_ID_REGEX`
  (`/^plot-[a-z0-9]+$/`) and `isValidPlotIdFormat()`. The HTTP edge
  calls `assertPlotIdDispatchable()` in `createRunHandler` and
  `createPlanRunHandler` **before** any row insert; format check is
  always-on, existence check piggybacks on `deps.plotResolver` and
  no-ops when unwired so test harnesses keep working. Empty / undefined
  `plot_id` passes through unchanged. In `createPlanRunHandler` the new
  check layers **after** `ProjectLacksPlotError` so the more-specific
  project-shape error still wins when both apply. Client mirror:
  `NewRun.tsx` and `NewPlanRun.tsx` duplicate the regex literal
  (UI bundle can't import server-side `src/plots/index.ts`), show an
  inline error, and disable the Dispatch button while malformed.
  Origin: dogfood signal #4 from `plot-3e72876d` (warren-a353) where a
  user pasted the literal string `plot_id=plot-3e72876d` (including the
  `plot_id=` prefix) into the NewRun input and warren silently accepted
  it.

### Docs

- **`docs(spec)`** — SPEC §11.Q "Plot → synthesized plan-run pipeline
  (pl-5310 step 4)" design lock (warren-a4b7). Locks the endpoint shape
  (`POST /plot-plan-runs`), the synthesis algorithm (filter closed +
  `sd_plan` attachments, mint throwaway parent seed, call
  `POST /plan-runs` in-process with `plot_id`), the typed-4xx error map
  (mirrors §11.O/§11.P gates + warren-bae5 `plot_id` validation), the
  UI surface (PlotDetail "Dispatch as plan-run" button next to
  `BatchDispatchAllButton`), and acceptance scenario 30 composing
  scenarios 25 + 27 + 29. §11.Q names the upstream seeds-cli contract:
  `sd plan submit` accepts existing-seed children, validates per-repo
  existence, rejects cross-repo ids + closed seeds at submit time,
  emits a plan row byte-compatible with warren's `showPlan` reader.
  Once upstream ships, warren double-pins per the burrow-cli rule
  (`package.json` + `bun.lock` + `Dockerfile`). pl-f404 decomposes
  warren-a4b7 into 5 children blocked on warren-d519. No code changes.

## [0.4.6] — 2026-05-18

Patch release bundling the post-`0.4.5` stream of dogfood-driven fixes
and Plot-UX features: `.plot/` now round-trips through reap to origin
(warren-343a) closing the shape (a) loop opened by `0.4.2`; PlotDetail
gains a one-click "Run agent" affordance off `seeds_issue` attachments
(warren-ff2a); the runs subsystem grows two terminal-recovery paths
(raw-text agent terminal-detect via burrow state poll, and read-time
cost/token hydration from events) plus the long-standing ghost-run
reconciliation in the bridge; project-tier canopy roles get
cross-tier inheritance and an on-disk rendered cache; preview launch
gets a distinct `connect_timeout` phase; and the burrow data dir is
pinned onto the persistent volume so in-flight runs survive redeploy.

### Added

- **`feat(reap)`** — Commit `.plot/` through reap so Plot state
  round-trips to origin (warren-343a, shape (a), follow-up to
  warren-fdd2 / pl-d4d6 shape (b)). After `mergePlot` lands the
  workspace's `.plot/` deltas into the project clone, a new
  `plot_commit` sub-step replicates `plot-*.{json,events.jsonl}` files
  back into the burrow workspace, runs `git add -- .plot/`, and —
  when `git diff --cached --quiet -- .plot/` exits non-zero —
  authors a `chore(warren): plot state` commit under a fixed warren
  bot identity (`warren <warren@os-eco.dev>`). The follow-on
  `branch_push` carries that commit upstream, so on PR merge `.plot/`
  becomes durable on origin and the next `refreshProjectClone` fetches
  it back. `.plot/.index.db*` and any non-`plot-*` entries are skipped
  on copy. The trivial-merge case (`reap.empty_push` per warren-f3bb)
  no longer fires when the agent skipped `git commit` but warren wrote
  `.plot/` entries — the warren-authored commit lifts `commitsAhead`
  above zero. Gating: skipped when `project.hasPlot === false`, so
  projects without `.plot/` are byte-identical to the pre-change reap.
  Best-effort like the surrounding sub-steps: a failure emits a
  `reap_failed` event with `step: "plot_commit"` and never fails the
  run. The reap result surface adds `plotCommitted: boolean` and a
  `reap.plot_committed` event. The host-side snapshot/restore in
  `refreshProjectClone` (warren-fdd2) stays as belt-and-suspenders
  preservation for in-flight writes between dispatch and the next
  reap.

- **`feat(ui)`** — "Run agent" button on every `seeds_issue` attachment
  row in `PlotDetail`'s `SubstratePanel` (warren-ff2a). Clicking
  navigates to `/runs/new` with project, agent, `plot_id`, and prompt
  pre-filled so the user can dispatch immediately — agent comes from
  the project's `defaultRole`, prompt from `defaultPrompt` (with
  `{seed_id}` substituted) or `"work on sd {seed_id}"` as fallback.
  `NewRunPage` now reads `NewRunRouteState` off react-router
  `location.state` on mount; pre-filled non-empty `agent`/`prompt`
  mark `*Touched=true` so the existing project-default auto-fill
  effects don't clobber them. First child of the Plot-UX vision
  (`warren-e40a`) that surfaces Plot→plan→seed→run end-to-end.

- **`feat(registry)`** — Cross-tier inheritance for per-project canopy
  roles (warren-44a3, follow-up to R-03 / pl-fef5). A project-tier role
  can now declare `extends:` (or `mixins:`) pointing at a library or
  built-in role: when `cn render` bails because the parent lives outside
  the project's `.canopy/`, `refreshProjectAgents` falls back to a
  warren-side composer (`src/registry/compose.ts`) that walks parents
  through the resolver `project → global` and merges sections + frontmatter
  with canopy's own algorithm. Same-named name shadows are walked past, so
  a project role named `claude-code` whose `extends: claude-code` resolves
  to the built-in instead of recursing on itself. Source stamping still
  tracks the leaf tier (`project:<id>`); parent provenance survives in
  `resolvedFrom`.

- **`feat(registry)`** — On-disk rendered cache for project-tier agents
  (warren-44e3, R-03 / pl-fef5 follow-up). `refreshProjectAgents` now
  mirrors each registered project agent's rendered JSON to
  `<projectPath>/.canopy/.rendered/<name>.json` alongside the
  agents-table upsert. A self-ignoring `.gitignore` is seeded once so
  the cache stays out of project commits. Removed rows get their cache
  file pruned. Non-warren consumers (`cn render`, agents reading the
  project directly) can now see what a project-tier role resolves to
  without going through warren.

- **`feat(preview)`** — Two-phase readiness probe with a distinct
  `connect_timeout` (warren-9b15 / warren-fdf2 approach B). `preview`
  blocks now accept an optional `connect_timeout` (default 5m, bound
  1s..1h) that caps phase 1 ("did anything bind on the port?"). The
  existing `readiness_timeout` keeps its 10m default but now caps phase 2
  ("did the bound server return 2xx?"), with the deadline starting at
  first successful TCP connect — sidecar startup variance (shell pre-exec,
  dev-server CLI startup, dependency import-graph load, port bind) lives
  under `connect_timeout` instead of stealing from the bundler budget. Any
  HTTP response (even 4xx/5xx) flips the loop into phase 2; ECONNREFUSED /
  hung connect-aborts keep the loop in phase 1. New
  `LaunchFailureReason: 'connect_timeout'` and `preview_failure_message`
  now records the failing phase (`phase=connect:` / `phase=readiness:`).
  **Migration note:** existing per-project `readiness_timeout` values stay
  valid but now cover less — only the post-connect bundler phase. Operators
  whose dev server binds in well under 5m can shrink `readiness_timeout`
  to match the bundler's actual cold-compile cost. Closes `warren-9b15`.

### Fixed

- **`fix(runs)`** — Bridge run-state poller catches terminal for
  raw-text agents (warren-6596). Burrow's run-stream is an infinite
  tail that never closes when a run reaches terminal, and
  `detectRuntimeTerminal` only fires for `claude-code` (result) and
  `pi` (agent_end) envelopes. Declarative agents with
  `outputFormat=raw-text` (acceptance stub-shell, user-authored shell
  agents) emit only text events, so warren had no way to learn the run
  had finished — runs stayed `running` forever, blocking inline reap
  and acceptance scenarios 20/20-path/24 on Linux. `bridgeRunStream`
  now runs a 2s-cadence `burrow.runs.get` poller alongside the event
  stream. On observing a terminal burrow state it waits a 1s drain
  window (one `tailBurrow` cycle) for final events, then aborts the
  stream and synthesises `terminalDetected` from the burrow state (1:1
  outcome map). In-stream terminal-detect still wins when both fire —
  it carries exit_code semantics from the runtime parser. The poller
  is dormant in tests that pass `source` without a `runStateProbe`, so
  existing tests don't need updates.

- **`fix(runs)`** — Compute cost/tokens from events for terminal runs
  with null totals (warren-ab18). When a run terminates abnormally
  (machine reboot, ghost run, reap that never finalises), the bridge's
  in-stream `attachStats` checkpoint never lands and the
  cost/token columns stay null even though the underlying usage
  envelopes are durably persisted to `events`. The UI then renders the
  run's cost as `"-"` despite the data being there. `hydrateRunsUsage`
  (`src/runs/usage-hydrate.ts`) is the read-time fallback: for
  terminal runs with null `costUsd`, it reads the run's
  `state_change` / `system` events via the new
  `EventsRepo.listUsageEvents`, sums them with the same
  shape-sniffing the bridge uses, and overlays the derived totals onto
  the row. The list-endpoint case batches all candidates into a single
  events query so this is one extra round-trip per `GET /runs`, not
  N+1. The shape-sniffing functions (`accumulatePiUsage`,
  `extractClaudeUsage`, `SessionStatsAccumulator`) move from
  `src/runs/stream.ts` into the new `src/runs/usage-aggregate.ts` so
  write-time (bridge) and read-time (hydrator) share one canonical
  implementation and can't drift.

- **`fix(ui)`** — Inline "Refresh project" action on the `NewPlanRun`
  missing-`.seeds` destructive card (warren-c666). The card told
  users to "refresh the project" but offered no in-page action. Most
  cases are a stale `has_seeds` flag (project registered before
  warren-9990 detection landed), so the card now renders a Refresh
  project button that calls `projectsApi.refresh` and invalidates the
  projects query — same pattern as `Projects.tsx`.

- **`fix(bridge)`** — Detect & reconcile "ghost" runs (warren state
  `running`, burrow has no record). When warren's machine restarts and
  burrow loses an in-flight run from its store, the bridge previously
  spammed `bridge errored — reconnecting after backoff` forever and the
  warren row stayed `running` indefinitely, requiring direct DB surgery
  to clear. Now: (1) `bridgeRunStream` distinguishes `BurrowNotFoundError`
  from transport errors and returns `burrowRunMissing: true` instead of
  `errored: true`; (2) the bridge registry's reconnect loop treats
  `burrowRunMissing` as terminal, transitions the warren row to `failed`
  with `failure_reason='burrow_run_lost'`, and emits a `bridge_lost`
  system event for the UI; (3) `bootBridges` pre-probes each non-terminal
  run via `GET /runs/:id` at startup and reconciles ghosts (skip code
  `burrow_run_lost`) before attaching a bridge; (4) `cancelRun` on 404
  finalizes the row to the same shape so the user gets a clean response
  instead of `run not found: run_xxx`; (5) `steerRun` on 404 raises a
  `ValidationError` pointing at the lost-run state instead of leaking the
  raw burrow error. Closes `warren-b1a9`.
- **`fix(deploy)`** — Pin burrow's data directory onto the persistent
  `/data` volume via `BURROW_DATA_DIR=/data/burrow` (set in `Dockerfile`
  ENV and mirrored in `fly.toml [env]`). Previously burrow fell back to
  its default `XDG_DATA_HOME/burrow` path (`/root/.local/share/burrow`),
  which lived on the container's writable overlay and got wiped on
  every redeploy. Any run in flight at deploy time was orphaned:
  warren's row stayed `state='running'` (its DB is on the volume), but
  burrow returned 404 for the burrow_run_id on cancel + stream, leaving
  the bridge in indefinite reconnect-with-backoff. `BURROW_DATA_DIR`
  is read by burrow's path resolver (burrow-cli `src/config/paths.ts`)
  ahead of `XDG_DATA_HOME`, and the supervisor's `Bun.spawn` of
  `burrow serve` inherits process env so no supervisor-side wiring
  change was needed. Burrow's db client `mkdir -p`s the dbPath parent
  on first open, so `/data/burrow/` materializes itself on the
  mounted volume. Closes `warren-0375`.

## [0.4.5] — 2026-05-18

Patch release surfacing dogfood signal #3 from `plot-3e72876d` (the
housekeeping pass): `NewPlanRun.tsx` had a `plot_id` input for
plan-runs, but the single-run `NewRun.tsx` form had no Plot binding
affordance — single runs dispatched from the UI could not bind to a
Plot, only plan-runs could. The housekeeping arc is "one warren run
per child seed" (single-run shape), so without this input the
activity feed couldn't accumulate the per-seed coordination it was
designed to surface.

### Added

- **`feat(ui)`** — `NewRun.tsx` gains an optional `Plot ID` input,
  gated on the selected project's `hasPlot=true`. Mirrors
  `NewPlanRun.tsx`'s pattern: a `plotId` state initialized blank, the
  trimmed value passed into `runsApi.create` only when both `hasPlot`
  and a non-empty value are present. Server-side accepts `plotId?` on
  `CreateRunInput` already (shipped in pl-2047 / v0.3.18 era) — only
  the UI surface was missing. Prereq for `warren-e40a` (Plot UX
  vision: surface Plot→plan→seed→run end-to-end), whose three child
  seeds (`warren-ff2a`, `warren-ea66`, `warren-5561`) all depend on
  single-run dispatch being Plot-bindable.

## [0.4.4] — 2026-05-18

Patch release closing `warren-ede7`: the Plot aggregator's
`queryWithRebuildRetry` (`src/plots/aggregate.ts`) only rebuilt the
index on a thrown error from `client.query()`, but `.plot/.index.db`
is gitignored (commit `2d7a75f`). A freshly-refreshed project clone
therefore has the `*.json` + `*.events.jsonl` files but no index DB,
and `SQLitePlotIndex` creates an empty index on first construction
without throwing — so `query()` returned `rows: []`, the rebuild path
was never hit, and `GET /plots` / `GET /plots/:id` came back empty /
404 even though Plots existed on disk. Discovered dogfooding
`plot-3e72876d` (the housekeeping Plot) in deployed warren.

### Fixed

- **`fix(plots)`** — `queryWithRebuildRetry` now also triggers a
  rebuild when the first query returns zero rows and the project's
  `.plot/` directory contains at least one non-dot `*.json` file
  (probed via `fs.readdir`). The disk probe distinguishes "index is
  stale, rebuild" from "project legitimately has no plots" so the
  rebuild cost only lands when there's something to recover. Both
  `GET /plots` (aggregator) and `GET /plots/:id` (resolver, which
  shares the aggregator's cache path) recover from a missing index DB
  without operator intervention. New tests at
  `src/plots/aggregate.test.ts` pin the empty-rows-rebuild path and
  the empty-rows-no-rebuild path; the existing throw-path retry test
  is unchanged.

## [0.4.3] — 2026-05-18

Patch release closing `warren-c106`, the cascade gap left by `0.4.1`:
that release shipped the warren-side of `pl-95dd` BEFORE
`@os-eco/burrow-cli@0.3.2` (containing `burrow-59cd`, `body.env`
parsing on `POST /burrows`) was published to npm, so the two bump-step
seeds (`warren-0a6b`, `warren-73ee`) correctly detected the
cascade-block at execution time and recorded notes rather than
bumping to a non-existent version (commits `9a12e6b`, `983d77a`). With
`burrow@0.3.2` now on npm, this release lands the deferred consumer
bump unchanged in shape from the original `pl-95dd` plan.

### Changed

- **`chore(burrow-cli)`** — bump `@os-eco/burrow-cli` double-pin from
  `^0.3.1` → `^0.3.2` across `package.json`, `bun.lock` (via `bun
  install`), and the `Dockerfile` global install (`warren-c106`).
  Picks up `burrow-59cd` so the env-reaches-sandbox contract is now
  satisfied by the published runtime, not just by source. Per the
  CLAUDE.md "Relationship to burrow" convention all three pin
  locations stay in sync; a mismatch is a no-op since `Bun.spawn`
  resolves `./node_modules/.bin/burrow` before `PATH`.

## [0.4.2] — 2026-05-18

Patch release closing `warren-6f25` / plan `pl-d4d6`: warren's host-side
Plot appenders (`defaultPlotAppender`, `defaultPlanRunPlotAppender`,
`autoTransitionPlotToDone`) write to `<project_clone>/.plot/` without
ever committing, but `refreshProjectClone`'s `git reset --hard
origin/<ref>` wiped those uncommitted writes on every subsequent
`spawnRun`. Observable as: only the **last** child's `run_dispatched`
survived on disk after a plan-run; `plan_run_dispatched` and earlier
per-child events disappeared, and the auto-`done` status snapshot
reverted to `active` at the next refresh. Scenario 27 had been masking
the regression with a 100ms tail of the events.jsonl that accumulated
the transient writes into memory before the next reset wiped them.

Fix shape: shape (b) per the plan — preserve `.plot/` across the reset
rather than commit it through reap (shape (a) deferred as
`warren-343a`). `refreshProjectClone` now wraps fetch+reset in
`defaultPreservePlot`, which snapshots regular files under `.plot/`
(skipping the derived `.index.db*`) to an out-of-tree `mkdtemp` dir,
runs the reset, then restores the snapshot back into the working tree.
Snapshot wins on conflict (host-side appender writes are strictly
newer than anything committed in the project repo). Projects without
`.plot/` short-circuit before any fs work — byte-identical to the
pre-fix refresh.

### Changed

- **`fix(projects)`** — `refreshProjectClone` now preserves `.plot/`
  across `git reset --hard` via the new `defaultPreservePlot` wrapper
  (`warren-fdd2`). The wrapper is injectable for tests; the SQLite
  `.index.db*` files are intentionally not preserved (derived state,
  rebuilt on demand by the existing `plot rebuild-index` retry-once
  path in `defaultPlotAppender`).
- **`test(projects)`** — `src/projects/refresh.test.ts` gains coverage
  for byte-equality preservation of `events.jsonl`, snapshot-wins
  semantics on conflict with origin, byte-identical behavior for
  projects without `.plot/`, and tmpdir cleanup under repeated
  refreshes (`warren-b960`).
- **`test(acceptance)`** — scenario 27 reads `.plot/<id>.events.jsonl`
  directly at the end of the plan-run instead of tailing it every
  100ms; the workaround is gone now that the writes survive on disk
  (`warren-aa63`).
- **`docs(spec)`** — SPEC §11.O documents the `.plot/` preservation
  contract and the deferred origin-durability work (`warren-343a`).
  §11.P cross-references it for between-child durability.

## [0.4.1] — 2026-05-18

Patch release closing the warren-side of `warren-a346` / plan `pl-95dd`:
the Plot env-reach gap where `PLOT_ID` / `PLOT_ACTOR` set on a run
dispatch were dropped at burrow's `POST /burrows` boundary instead of
reaching the sandbox. The fix itself ships in burrow as `burrow-59cd`
(burrow parses `body.env` on burrow up); warren consumes it by
bumping the `@os-eco/burrow-cli` double-pin and flipping scenario 25's
previously soft-skipped env-reach / workspace plot append / `plot.*`
mirror assertions to hard-required so any future regression in the
burrow contract fails CI loudly. No warren API or schema changes —
send-side (`BurrowClient.burrowsUp`, `src/runs/spawn.ts`) was already
correct; this release is purely the consumer-side bump that makes the
os-eco Plot integration's agent-side append path end-to-end honest
for the first time.

### Changed

- **`chore(burrow-cli)`** — bump `@os-eco/burrow-cli` double-pin
  (`warren-0a6b`) across `package.json`, `bun.lock`, and the
  `Dockerfile` global install to the release containing `burrow-59cd`
  (`body.env` parsing on `POST /burrows`). Per the CLAUDE.md
  "Relationship to burrow" convention all pin locations stay in sync;
  a mismatch is a no-op since `Bun.spawn` resolves
  `./node_modules/.bin/burrow` before `PATH`.
- **`test(acceptance)`** — scenario 25
  (`scripts/acceptance/scenarios/25-plot-dispatch-roundtrip.ts`,
  `warren-49d7`) drops the `if (skipReason) ...` guards around the
  env-reaches-sandbox / workspace-plot-append / `plot.*` mirror
  assertions. Inside a sandbox spawned from a run with
  `PLOT_ID=plot-xyz` and `PLOT_ACTOR=agent:claude:wr-...`,
  `printenv PLOT_ID` and `printenv PLOT_ACTOR` now return the
  dispatched values rather than empty strings, and the parallel
  PlanRun + Plot roundtrip (scenario 27) remains green.

### Fixed

- **Plot env-reach end-to-end** (`warren-a346`, `pl-95dd`) — runs
  dispatched with a `plot_id` against a `.plot/`-enabled project now
  see `PLOT_ID` and `PLOT_ACTOR` inside the sandbox, unblocking the
  in-sandbox `plot` CLI's agent-side append path. Previously the
  values were silently dropped at burrow's handler edge
  (`burrow-59cd`) and warren's Plot integration was half-disconnected.

## [0.4.0] — 2026-05-18

Phase 3 of `warren-d362` (plan `pl-9d6a`) shifts warren's web UI from
run-centric to Plot-centric on deployments that opt into Plot, without
disturbing the standalone path. Plots become the primary surface —
list page, detail page with intent + substrate + unified activity feed,
and a default-landing redirect — while every write path stays bound
to the same `UserPlotClient` ACL surface §11.O established for
single-run dispatch. The minor bump (0.3.18 → 0.4.0) reflects the
new top-level surface and routing flip.

### Added

- **`feat(plots)`** — server-side Plot aggregation module
  (`warren-7e85`). `src/plots/` exposes a typed facade over
  `UserPlotClient.list/query/rebuildIndex` across `hasPlot` projects,
  returning `PlotSummary[]` with parallel per-project queries, a
  best-effort `rebuildIndex+retry-once` recovery on cold-cache misses
  (mx-239786), and a 5s in-memory cache keyed by `project_id`.
  `PlotResolver` resolves the owning project for a given `plot_id`.
  Unit tests pin the byte-identical empty-array contract when no
  project has `hasPlot=true`.
- **`feat(server)`** — `GET /plots` aggregator handler
  (`warren-c167`). Optional `?status=` filter; empty array (not 404)
  when no `hasPlot` projects exist.
- **`feat(server)`** — `POST /plots` create handler (`warren-194e`).
  Gated on `project.hasPlot` with typed `ProjectLacksPlotError`;
  `dispatcher_handle` resolution with `operator` fallback (mx-6a9788);
  hard-rejected on failure (no fire-and-log — the user is waiting).
- **`feat(server)`** — `GET /plots/:id` full-envelope handler
  (`warren-961e`). `PlotResolver`-backed 404; `event_log` ordered by
  `ts` ascending for the UI's unified feed.
- **`feat(server)`** — `POST /plots/:id/intent` intent-edit handler
  (`warren-896f`). Rejects edits when the current status is `done` or
  `archived` (SPEC §6 — intent is frozen at done). The facade's
  compile-time ACL guard (mx-bd4d67) makes `agent:*` attribution
  unreachable from this path.
- **`feat(server)`** — `POST /plots/:id/status` transition handler
  (`warren-e868`). Validates against the SPEC §6.5 whitelist at the
  handler edge as defense in depth.
- **`feat(server)`** — `POST/DELETE /plots/:id/attachments`
  (`warren-589c`). Per-kind ref-shape validation at the handler edge
  (mx-aa4e2e); routes through `UserPlotClient.attach/detach`.
- **`feat(server)`** — `POST /plots/:id/questions/:event_id/answer`
  (`warren-e1ac`). Validates the targeted `question_posed` exists and
  has no subsequent `question_answered` referencing it before
  appending — a handler-edge concurrency invariant the Plot library
  does not guarantee on its own.
- **`feat(ui)`** — `plotsApi` + Plot wire-type mirrors
  (`warren-4879`). `src/ui/src/api/client.ts` gains
  `plotsApi.{list,create,get,editIntent,setStatus,attach,detach,answer,dispatchPlanRun}`;
  types mirrored manually in `src/ui/src/api/types.ts` per the
  mx-7f971c pattern.
- **`feat(ui)`** — `/plots` list page (`warren-e3e6`). Sortable
  table (default sort by `last_event_ts` desc), status filter chip
  group, New Plot dialog filtered to `hasPlot=true` projects, empty
  state copy when no `hasPlot` projects exist.
- **`feat(ui)`** — sidebar `Plots` entry gated on
  `someProject.hasPlot=true` (`warren-2f55`).
- **`feat(ui)`** — `/plots/:id` PlotDetail page (`warren-bdbf`).
  Three-panel layout: IntentPanel (editable inline, disabled at
  `done`/`archived`), SubstratePanel (attachments grouped by role with
  detach + add), ActivityFeed (unified human + agent timeline reusing
  the mx-b97599 EventLine shape; 3+ same-kind/same-actor chains
  collapse). Polls every 5s with tanstack-query `staleTime: 5s`
  (mx-268674).
- **`feat(ui)`** — Run-plan button on PlotDetail (`warren-5d94`).
  Visible when an `sd_plan` attachment exists; confirm-dialog +
  `POST /plan-runs` with auto-filled `plot_id` reuses the NewPlanRun
  defaults flow (mx-4c064b) and routes to `/plan-runs/:id` on success.
- **`feat(ui)`** — inline question-answer card in ActivityFeed
  (`warren-3c3e`). Open `question_posed` events render with a textarea
  + Submit; optimistic insertion of `question_answered`, draft-restore
  on failure.
- **`feat(ui)`** — status-transition control + `PlotStatusBadge`
  (`warren-6336`). Button group rendering only the legally-reachable
  next statuses per SPEC §6.5; optimistic UI; badge mirrors
  `StateBadge.tsx`'s shape.
- **`feat(ui)`** — live Plot back-link on PlanRunDetail + RunDetail
  with graceful 404 fallback (`warren-37fd`). Flips the mx-757be9
  placeholder now that `/plots/:id` is rendered.
- **`feat(ui)`** — default-landing flip + sidebar reorder
  (`warren-e59a`). `DefaultLanding.tsx` redirects to `/plots` only
  when `someProject.hasPlot && anyPlotExists`; otherwise to `/runs`
  (the CLAUDE.md standalone path is preserved byte-identical). Layout
  reorders to Plots → Runs → Plan Runs → Projects → Agents under
  the same gate.
- **`test(acceptance)`** — scenarios 28 + 29
  (`warren-5b8a`, `warren-c40b`). Scenario 28 pins the list+create
  roundtrip across mixed `hasPlot` / non-`hasPlot` projects with the
  zero-leakage `/runs` snapshot; scenario 29 exercises the full
  detail-page roundtrip including the `Run plan` → `POST /plan-runs`
  → Plot auto-`done` composition that reuses §11.P.Plot's wiring
  (mx-92e6b3 + mx-90f430). Both follow the mx-af2627 / mx-15e4da
  in-proc warren-stack pattern with idempotent teardown.

### Changed

- **`docs(spec)`** — SPEC.md gains §11.O.Plot.UI subsection following
  the mx-49a44c five-thing template (gating, API, ACL, ASCII
  data-flow, what's deferred).
- **`docs(readme)`** — README features section calls out the
  `hasPlot`-conditional default landing and the unified activity feed,
  pointing at SPEC §11.O.Plot.UI.

## [0.3.18] — 2026-05-18

PlanRun composes onto Plot: a plan-run dispatched against a `.plot/`
project threads `plot_id` through every child run, emits a single
`plan_run_dispatched` event on the bound Plot at start, and
auto-transitions the Plot from `active` → `done` when the final child
merges. Phase 2 of `warren-000b`, plan `pl-7937`.

### Added

- **`feat(plan-runs)`** — Plot wiring for PlanRun (`warren-06dc`,
  plan `pl-7937`). Mirrors Phase 1's single-run wiring (§11.O) on the
  PlanRun surface, never forking the single-run code path. A new
  nullable `plan_runs.plot_id` column (sqlite + postgres, indexed) is
  accepted on `POST /plan-runs`; passing `plot_id` against a project
  with `hasPlot=false` rejects with `ProjectLacksPlotError` (typed 400)
  before any side effect, stacked on top of the existing
  `ProjectLacksSeedsError` gate so a project missing `.seeds/` is
  rejected first even when `plot_id` is supplied. At PlanRun creation,
  the handler best-effort appends one `plan_run_dispatched` event on
  the bound Plot via `defaultPlanRunPlotAppender`
  (`src/plan-runs/plot-appender.ts`) — actor `user:<dispatcherHandle>`,
  payload `{plan_run_id, plan_id, children_count}` — with the same
  rebuild-index + retry-once recovery as the single-run appender; a
  Plot-write failure logs `plan_run.plot_append_failed` and leaves the
  PlanRun row durable. The coordinator forwards `planRun.plotId` into
  the dispatch wrapper so every child spawns with `plotId` set; the
  unchanged Phase 1 path (`composePlotEnv` / `defaultPlotAppender` in
  `src/runs/spawn.ts`) injects `PLOT_ID` + `PLOT_ACTOR` and emits one
  per-child `run_dispatched` for free. When the coordinator transitions
  a PlanRun to `succeeded`, `autoTransitionPlotToDone`
  (`src/plan-runs/plot-transition.ts`) opens a `UserPlotClient` as
  `user:<dispatcherHandle>` and — guarded on `plot.status === 'active'`
  — calls `setStatus('done')`; non-active Plots (drafting / ready /
  done / archived) emit `plan_run.plot_status_skipped` without
  trampling operator-driven status; setStatus throws emit
  `plan_run.plot_auto_done_failed` without affecting the PlanRun's
  terminal state. The NewPlanRun form surfaces an optional `plot_id`
  input only when the selected project ships both `.plot/` and
  `.seeds/`; PlanRunDetail renders `plot_id` with a placeholder
  `/plots/:id` link (Phase 3 owns the live Plot detail page).
  `@os-eco/plot-cli` is double-pinned at `^0.3.0` /
  `0.3.0` in `package.json` + `Dockerfile` per the burrow-cli rule, to
  consume the `plan_run_dispatched` event type added in plot's
  `plot-3e3d` (`PLOT_EVENT_TYPES` + ACL). Acceptance scenario 27
  (`scripts/acceptance/scenarios/27-plan-run-plot-roundtrip.ts`)
  composes scenarios 25 + 26 against a live warren+burrow stack: three
  children including one trivial-merge case, assertions on `PLOT_ID`
  in every child sandbox, one `plan_run_dispatched` at start, per-child
  `run_dispatched` events, Plot auto-transition to `done` after the
  final merge, and a zero-leakage snapshot for plan-runs dispatched
  without `plot_id` against the same project. See SPEC §11.P.Plot.
  (`warren-06dc`, `pl-7937`)

## [0.3.17] — 2026-05-18

PlanRun ships as a serial dispatch mode on top of the existing single-run
primitive — projects shipping `.seeds/` can `POST /plan-runs` against a
seeds plan, and warren walks the plan's children one at a time, gating
each step on the previous PR merging before the next dispatches.

### Added

- **`feat(plan-runs)`** — serial plan-run dispatch (`warren-fcc9`,
  plan `pl-a258`). A new dispatch mode on top of the single-run
  primitive, not a sixth bundled feature: `POST /plan-runs { project,
  planId, agent, promptTemplate? }` enumerates a seeds plan's children
  into a `plan_runs` + `plan_run_children` pair and walks them
  sequentially, spawning one warren run per child with the prompt
  template substituted (`{seed_id}`) per step. Each child gates on
  the previous PR merging (or trivially merging when the child run
  produced no commits — the `reap.empty_push` signal advances past
  docs-only steps without GitHub polling) before the next dispatches.
  Children whose seeds are already closed flip to `skipped` without
  spawning a run, so re-dispatching the same plan id resumes from the
  next open child. Gated on `project.hasSeeds`; rejected with
  `ProjectLacksSeedsError` (typed 400) before any side effect when the
  project has no `.seeds/` directory. Coordinator
  (`src/plan-runs/coordinator.ts`) returns a 7-shape `AdvanceResult`
  discriminated union the tick wrapper, the unit tests, and the
  event-emit seam all narrow against — every transition emits a
  `plan_run.*` system event on the most-recently-dispatched child run.
  Boot wiring mirrors `bootScheduler` single-flight: tunable via
  `WARREN_PLAN_RUN_TICK_MS` (default `10000`), disable with
  `WARREN_PLAN_RUN_DISABLED=1`. New REST surface: `POST /plan-runs`,
  `GET /plan-runs`, `GET /plan-runs/:id`, `POST /plan-runs/:id/cancel`,
  `GET /plan-runs/:id/events`. UI gets three new pages — list, detail
  (with live polling + cancel), new — plus a top-level Plans nav entry.
  Acceptance scenario 26
  (`scripts/acceptance/scenarios/26-plan-run-roundtrip.ts`) covers the
  round-trip end-to-end against a live warren+burrow stack, including
  the trivial-merge branch and the resume-on-re-dispatch contract.
  See SPEC §11.P. (`warren-fcc9`, `pl-a258`)

## [0.3.16] — 2026-05-17

Plot integration ships as the fifth opt-in bundled feature, plus a preview
readiness-timeout bump sized for modern SPA cold-compile budgets.

### Added

- **`feat(plot)`** — Plot integration (phase 1 of `warren-000b`,
  plan `pl-2047`). Plot joins canopy/mulch/seeds/sapling as the fifth
  opt-in bundled feature: a project shipping a `.plot/` directory plus
  a `plot_id` on `POST /runs` lights up the substrate, projects without
  `.plot/` are byte-identical to the pre-change behavior. Spawn-time
  injects `PLOT_ID` + `PLOT_ACTOR=agent:<name>:<run-id>` into the
  sandbox env so the `plot` CLI inside resolves the right Plot;
  warren appends a `run_dispatched` event (actor `user:<handle>`) to
  the originating Plot on dispatch; reap merges the workspace `.plot/`
  back into the project's persistent `.plot/` (content-addressed,
  conflict-on-content) and mirrors agent-emitted `decision_made` /
  `question_posed` / `artifact_produced` events into warren's event
  stream tagged with `plot_id`. The `src/plot-client/` facade narrows
  the agent-actor write surface so warren cannot construct the four
  humans-only event types (`intent_edited`, `status_changed`,
  `attachment_removed`, `question_answered`) — same defense-in-depth
  pattern as `src/burrow-client/`. `@os-eco/plot-cli` is double-pinned
  in `package.json` + `bun.lock` AND the `Dockerfile` global install
  per the burrow-cli rule. Acceptance scenario 25
  (`scripts/acceptance/scenarios/25-plot-roundtrip.ts`) covers the
  round-trip end-to-end against a live warren+burrow stack. See
  SPEC §11.O. (`warren-000b`, `pl-2047`)

### Changed

- **`feat(preview/launch)`** — `DEFAULT_READINESS_TIMEOUT_MS` bumped from 5m
  to 10m. Sized for the bundler now that `warren-d9e7` moved install into
  its own setup sidecar with a separate `setup_timeout` — what's left under
  this budget is dev-server bind plus first-route compile, which routinely
  takes 5-8 minutes for modern SPAs (Next.js, Vite, SvelteKit, Astro) on
  apps with hundreds of modules. `run_428nktsej0yh` (jayminwest.com,
  Next.js 14, ~1875 modules) finished its cold first-compile at ~10 min
  once install was factored out — the 5m default would have failed it.
  The probe still returns on first 2xx so the happy path is unaffected;
  per-project override via `.warren/preview.yaml`'s `readiness_timeout`
  unchanged. Deadline still starts at sidecar-create (not first
  probe-connect); tightening that semantic is a follow-up under
  `warren-fdf2` approach B. (`warren-fdf2`)

## [0.3.15] — 2026-05-17

Preview hardening pass — five coupled fixes that turn path-mode preview
into a working zero-DNS default for modern SPA frameworks and shore up
the readiness/teardown lifecycle. No schema changes; all server-side.

### Added

- **`feat(preview/launch)`** — optional `preview.setup` runs as its own
  sidecar before the dev-server sidecar, so dependency install no longer
  shares `readiness_timeout` with dev-server bind. Non-zero setup exit
  surfaces as `reason=setup_failed` with a stderr tail in
  `preview_failure_message`; hangs past `setup_timeout` (default 5m,
  bounds 1s..1h) surface as `reason=setup_timeout` and the lingering
  sidecar is best-effort deleted. `PreviewSidecarsClient` gains a
  `get()` method over the burrow-client facade so the launcher can
  observe sidecar lifecycle without bypassing the boundary.
  (`warren-d9e7`)
- **`feat(preview/launch)`** — default `HOST`, `HOSTNAME`, and `PORT`
  into the sidecar env so CRA/Express-style dev servers bind reachably.
  Burrow's inbound forwarder enters the sandbox netns and connects via
  `nc 127.0.0.1 <port>`, so a server bound to localhost/::1 only
  (Next.js 13.5+ default) is unreachable even though the process is
  alive. Operators override by inlining `HOST=... PORT=...` ahead of
  the command. Next.js's CLI silently ignores `HOSTNAME`/`HOST` env
  vars, so Next.js projects still need `-H 0.0.0.0` in their command —
  documented in the `.warren/preview.yaml` stub framework matrix.
  (`warren-79b2`)

### Changed

- **`feat(preview/proxy)`** — path mode now works out-of-the-box for
  SPAs whose compiled output emits root-relative asset URLs that
  `<base>` can't redirect (Next.js, Vite, SvelteKit, Astro). Three
  coupled changes: (1) per-run cookie at `warren_preview_<runId>`,
  `Path=/`, so the browser carries it on `/_next/static/...` asset
  loads while preserving sibling-session isolation (SPEC §11.L risk 4);
  (2) `Referer`-based routing in `src/preview/proxy.ts` when
  `url.pathname` misses `/p/<id>/...` and isn't a warren API surface —
  extracts the runId from the referer's pathname and forwards
  `url.pathname` verbatim to that preview's upstream port, fixing the
  "blank preview" pathology (run_pexj1wxq90v0 / jayminwest.com PR #19)
  where every Next.js asset returned warren's SPA `index.html`; (3)
  `rewriteRootRelativeAttrs` prefixes `href`/`src`/`srcset` values
  within the same 64 KiB head lookahead as `<base>` injection, as
  defense-in-depth for server-rendered HTML with abs paths computed
  before `<base>` was visible. (`warren-63e1`)

### Fixed

- **`fix(preview/launch)`** — `probeOnce` wraps each fetch in a 2s
  `AbortController` so a hung response (burrow forwarder accepted TCP
  but the dev server hasn't flushed bytes) can no longer block the
  outer wall-clock deadline indefinitely. Observed on
  run_7jjpt2jn9ej5 (jayminwest.com): `preview_state` stayed `starting`
  for 6m47s against a 5m `readiness_timeout` — one fetch waited
  through Next.js compile, then succeeded. New
  `PROBE_PER_CALL_TIMEOUT_MS` constant + `probePerCallTimeoutMs`
  override on `LaunchPreviewInput` keep the per-call cap injectable
  for tests. (`warren-33eb`)
- **`fix(server)`** — `previewTeardownHandler` no longer hard-gates on
  `dialect === "sqlite"`. `createRunPreviewsRepo` became
  dialect-polymorphic under `warren-adfb`, but the manual-teardown
  affordance was still 503'ing on the postgres deploy until idle-TTL
  reclaimed the port. Narrowed the precondition to
  `deps.db === undefined` (the only thing the repo construction
  actually requires) and added a pg-conditional regression test
  exercising the route end-to-end on postgres. (`warren-a743`)

## [0.3.14] — 2026-05-15

Fix the preview proxy's blank-page failure mode (`run_7jjpt2jn9ej5`
preview rendered as `ERR_CONTENT_DECODING_FAILED` in the browser even
though `preview_state='live'` and the upstream HTML reached the
forwarder).

Root cause: Bun's `fetch` auto-decompresses gzip/br/deflate bodies
transparently but does **not** strip the `Content-Encoding` header
from `upstream.headers` (oven-sh/bun#4528). The proxy was forwarding
those headers verbatim alongside the already-decompressed body, so
the browser tried to gunzip plaintext and bailed. The announced
`Content-Length` had the same problem — it described the encoded body
length, not the plaintext we were streaming.

### Fixed

- **`fix(preview/proxy)`** — strip `Content-Encoding` and
  `Content-Length` once at the upstream boundary in `forwardToUpstream`
  so every downstream branch (subdomain passthrough, path-mode HTML
  rewrite, path-mode non-HTML passthrough) emits clean headers. The
  `applyPathModeRewrites` signature now takes the pre-stripped headers
  from the caller rather than cloning `upstream.headers` itself, which
  also removes the previous "skip rewrite when Content-Encoding is
  set" special case — under the new boundary contract that branch was
  dead code (the header is gone by the time it ran).

## [0.3.13] — 2026-05-15

Bake `netcat-openbsd` into the runtime image. Burrow's inbound
port-forwarder (SPEC §8.7, `../burrow/src/provider/local/inbound-forward.ts`)
relays each accepted host-loopback connection into the burrow netns via
`nsenter --net=/proc/<pid>/ns/net -- nc 127.0.0.1 <sandboxPort>`. Without
`nc` on `PATH` inside the warren container, the relay never spawns, the
host socket is terminated, and any client (notably the reap-time preview
readiness probe) just sees connection drops until the deadline.

Diagnosed against `run_t688fe74n1ts` (jayminwest.com) where
`next dev -H 0.0.0.0` was finally binding on `0.0.0.0:3000` inside the
netns — confirmed by Next.js logging both `Local:` AND `Network:` URLs —
but the 5m probe still failed because no relay process was ever started.
`flyctl ssh console` confirmed `/usr/bin/nsenter` present, `nc` not
found. With this layer, fresh image builds carry both binaries that
burrow's forwarder expects.

### Changed

- **`build(Dockerfile)`** — add `netcat-openbsd` to the apt-get layer
  that already installs `bubblewrap` + `uidmap` + util-linux. Image
  growth is sub-megabyte; the package is the standard `nc` provider on
  bookworm.

## [0.3.12] — 2026-05-15

R-03: per-project `.canopy/` role tier. Warren's agent registry now has
three tiers — built-in, library, and per-project — with precedence
project > library > built-in. Per-project roles travel with the project
they belong to, no more forking a shared canopy repo to add a
project-specific refactor-bot. Plan: `pl-fef5` (parent seed
`warren-2842`). Also raises the per-run preview readiness timeout
default to 5m and makes it project-overridable.

### Added

- **`feat(db)`** — migration `0011_colorful_mole_man.sql` (sqlite) +
  `0004_magical_valeria_richards.sql` (postgres) drop the single-column
  `name` primary key on `agents` in favor of a synthetic rowid PK,
  add a nullable `project_id` column (`ON DELETE CASCADE`), and enforce
  identity with a composite unique on `(project_id, name)` plus a
  partial unique on `(name) WHERE project_id IS NULL`. The
  `runs.agent_name → agents.name` FK is dropped — the agents table is
  a soft cache and `POST /agents/refresh` re-discovers from canopy, so
  rippling the FK into a composite was rejected as more invasive than
  the cache it would guard. (`warren-094a`)
- **`feat(registry)`** — `CanopyClient.forProjectPath()` factory
  parameterizes the client's cwd so the same `cn list` / `cn render`
  facade drives both the library clone and a project's `<projectPath>/.canopy/`.
  `refreshProjectAgents(projectId)` lives alongside the existing
  `refreshAgentRegistry` and scans one project's `.canopy/` per call.
  `AgentSource` widens to `'project:<projectId>'` alongside `'builtin'`
  and `'library'`; readers that pattern-match on prefix keep working,
  readers that did `source === 'library'` were widened to
  `startsWith('project:')` where needed. (`warren-7a3b`, `warren-2f14`,
  `warren-a8b0`, `warren-91bd`)
- **`feat(server)`** — `POST /agents/refresh` now refreshes the library
  AND every project's `.canopy/` in one call; per-project errors are
  collected on the response envelope under `projectErrors` and never
  fatal. `POST /projects/:id/agents/refresh` is the targeted path for
  refreshing one project. `GET /agents` accepts `?projectId=<id>` to
  return global ∪ that project's tier; `GET /agents/:name?projectId=<id>`
  resolves project-first with global fallback. Empty `?projectId=` is
  rejected so a typo'd query surfaces instead of silently collapsing to
  global-only. (`warren-7777`)
- **`feat(runs)`** — `spawnRun` prefers the project-tier row when the
  run's project matches an agent name in both tiers, falls back to
  global otherwise. `runs.rendered_agent_json.frontmatter.source`
  reflects the chosen tier. (`warren-0a7e`)
- **`feat(ui)`** — Agents page filters by `?projectId=<id>` (URL
  param-driven, persisted on reload), surfaces a project-tier badge
  alongside the existing built-in / library labels, and renders the
  project name next to the badge. NewRun's role picker filters to the
  selected project's tier ∪ globals, with the project-tier badge
  inline. New `src/ui/src/lib/agent-source.ts` centralizes the
  source-string parsing the UI surfaces. (`warren-f36c`)
- **`test(acceptance)`** — scenario 23 (`23-canopy-project-tier`)
  covers the project-tier roundtrip end-to-end against a live
  warren+burrow stack: per-project `.canopy/` is rendered, surfaces in
  the agents list with the right provenance, spawns prefer the
  project-tier row, and `POST /agents/refresh` doesn't tank on a
  malformed per-project prompt. (`warren-b2f9`)

### Changed

- **`refactor(server)`** — `withAgentSource` decorates AgentRow with the
  full provenance label (`'builtin' | 'library' | 'project:<projectId>'`)
  on every read path. Listed + per-project refresh outcomes share the
  same `decorateRefreshResult` helper so the wire shape is identical
  across `POST /agents/refresh` and `POST /projects/:id/agents/refresh`.
- **`preview(launch)`** — per-run preview readiness timeout default
  raised from 60s to 5m and made project-overridable via
  `.warren/preview.yaml` (`readiness_timeout`, bounds-checked 1s..1h at
  config load). Cold `pnpm install` commonly exceeds the old default;
  `launchPreview` accepts the override and `reapRun` parses + forwards
  it. (`warren-0928`)

## [0.3.11] — 2026-05-15

R-01 producer side: warren now writes warren-namespaced runtime metadata
to `seeds.extensions` after every successful dispatch. Unblocks the R-04
issues UI (which can read `role` / `trigger` / `lastRunId` off the seed)
and consolidates the cron tick's post-fire write onto the same facade.

### Added

- **`feat(seeds-cli)`** — `src/seeds-cli/warren-extensions.ts` defines
  `WarrenTriggerKind` (zod enum: `manual` | `cron` | `scheduled` |
  `webhook` | `comment` | `cli`) and a strict `WarrenExtensionsSchema`
  covering `role` / `trigger` / `lastRunId` / `lastRunAt` /
  `scheduledFor` / `lastScheduledRun`. `updateExtensions(deps,
  projectPath, seedId, ext)` validates the payload then shells out via
  `sd update <id> --extensions <json>`. Strict mode rejects unknown
  keys to lock down trigger-string proliferation (`pl-bb70` risk #6)
  before write. `clearScheduledFor` becomes a thin wrapper that
  delegates to `updateExtensions`. (`warren-187b`)
- **`feat(runs)`** — nullable `runs.seed_id` column on both sqlite
  (`0010_add_run_seed_id.sql`) and postgres
  (`postgres/0003_add_run_seed_id.sql`). `POST /runs` accepts an
  optional `seedId`; `spawnRun` forwards it onto `repos.runs.create`
  so the post-dispatch `updateExtensions` write has a seed to merge
  into and the Run API can surface a back-link on RunDetail.
  (`warren-805a`)
- **`feat(runs)`** — after `attachBurrow(burrowRunId)` succeeds with
  `seedId` + `seedsCli` wired, `spawnRun` merges
  `{role, trigger, lastRunId, lastRunAt}` onto the seed's
  warren-namespaced extensions via a single `sd update`. Trigger
  strings outside `WarrenTriggerKind` (e.g. legacy
  `'manual-trigger'`) are dropped so `role` / `lastRunId` /
  `lastRunAt` still land. Failures emit a
  `seeds_extension_write_failed` system event on the run and do **not**
  roll back the dispatch. `ServerDeps.seedsCli` is wired into
  `createRunHandler`, `runProjectTriggerHandler`, and
  `bootScheduler.spawnDispatch` so every dispatch path (manual `POST
  /runs`, Run-Now on a cron trigger, scheduler tick) writes the same
  convention. (`warren-46cd`)
- **`feat(ui)`** — `seedId: string | null` on the UI `RunRow` type and
  optional `seedId?: string` on `CreateRunInput`, mirroring the wire
  shape the server already serializes. `RunDetail.tsx` renders a "Seed"
  MetaCard next to Burrow ID / Burrow Run when `r.seedId !== null`
  — plain monospaced text for now; R-04 will convert it into a
  hyperlink without changing the data shape. (`warren-c845`)
- **`test(acceptance)`** — scenario 22 (`22-seeds-extensions-roundtrip`).
  Covers `pl-bb70` acceptance #3/#5/#6: manual `POST /runs` with
  `seedId` stamps `{role, trigger:'manual', lastRunId, lastRunAt}`
  on the seed via `sd update --extensions`; a bogus `seedId` surfaces
  a `seeds_extension_write_failed` system event without rolling the
  run back; `GET /runs/:id` exposes `seedId` for the RunDetail
  back-link. Brings the harness to 23 scenarios.

### Changed

- **`refactor(seeds-cli)`** — the seeds CLI shell-out facade
  (`listScheduledSeeds`, `clearScheduledFor`, `SeedsCliError`,
  envelope schema) moves out of `src/triggers/seeds-extension.ts`
  into a shared `src/seeds-cli/` module so the post-dispatch
  `updateExtensions` write can share it without importing through the
  cron scheduler. `triggers/tick.ts` and `dispatch.ts` import
  `ScheduledSeed` from the new module; `server/scheduler.ts` imports
  `listScheduledSeeds` + `clearScheduledFor` directly.
  `triggers/index.ts` no longer re-exports the seeds-cli symbols.
  (`warren-5655`)
- **`feat(triggers)`** — the scheduler tick's `clearScheduledFor`
  specialization is replaced with the shared `updateExtensions` facade,
  so the scheduled-seed post-fire write lands as a single `sd update`
  merging `scheduledFor` clear + `lastScheduledRun` pointer + the
  warren-namespaced common keys (`role`, `trigger:'scheduled'`,
  `lastRunId`, `lastRunAt`). `dispatchScheduledSeed` surfaces the
  resolved role on its fired result; the tick composes the typed
  `WarrenExtensions` payload and invokes the injected
  `updateExtensions` dep. Failure semantics (system event on the run,
  no rollback) are unchanged. (`warren-2064`)

### Docs

- **`docs(roadmap)`** — flip R-01 status to `[shipped]`; update R-04
  / suggested-sequencing references — warren now writes
  warren-namespaced `seeds.extensions` after every successful dispatch
  via the shared `src/seeds-cli/` facade. (`warren-2df2` / `pl-bb70`)

## [0.3.10] — 2026-05-15

Branding pass on the UI and a sortable Cost column on the runs list.

### Added

- **`feat(ui)`** — Warren brand mark in the sidebar header and tab
  favicon (`warren-1990`). New `WarrenLogo` component renders the
  burrow-network mark (hex cluster + active spoke + control-plane
  center) as inline SVG using `currentColor`, so it adapts to both
  light and dark themes from `src/ui/src/components/Layout.tsx`. The
  `Boxes` lucide placeholder is gone. `src/ui/public/favicon.svg`
  carries a self-contained variant (explicit fills plus a
  `prefers-color-scheme` style block) wired in via `<link rel="icon">`
  in `src/ui/index.html`.
- **`feat(runs)`** — sortable Cost column on the runs list
  (`warren-fd4b`). `GET /runs` now accepts `?sort=started|cost` and
  `?dir=asc|desc` (defaults preserve the previous `startedAt DESC`
  ordering); the repo's `listAll` / `listByProject` / `listByAgent`
  triplet takes an options bag and orders by `cost_usd` with explicit
  `NULLS LAST` in both directions so unbilled runs always sink. The
  Runs page renders click-to-sort headers on Started and Cost with a
  chevron affordance; cycle is inactive → desc → asc → default.
  `id ASC` remains the stable tiebreaker.

## [0.3.9] — 2026-05-15

README polish reflecting that warren is in continuous use, not a
pre-release.

### Changed

- **`docs(readme)`** — drop V1/V2 framing throughout. Status now reads
  "Stable, running on Fly.io in continuous use against real GitHub
  repos." Rename "V1 today" → "Operating model" and "Where this is
  going" → "Roadmap". Condense the per-run previews operator section
  (drop the lifecycle-knobs table, redundant DNS block, and legacy
  `defaults.json` migration note). Replace mid-sentence em-dashes and
  "not X, but Y" structures with normal punctuation. Bump the inline
  Status version badge to match `package.json`.

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
