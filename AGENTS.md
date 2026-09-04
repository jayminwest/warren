# AGENTS.md

This file is the canonical instruction doc for AI coding agents working
in this repo, following the [agents.md](https://agents.md) convention.
`CLAUDE.md` is a symlink to this file, so one document serves every
harness and there is nothing to drift.

## What this project is

Coding agents are tools. Warren turns them into infrastructure.

It runs agent harnesses as isolated workloads on infrastructure the
operator controls. Warren owns the workspace, lifecycle, limits,
events, intervention, recovery, and Git delivery.

`AgentRuntimeAdapter` keeps the kernel harness-neutral. A harness needs
an adapter before the runtime can drive it. The current distribution
ships Pi and Claude Code adapters.

Runtime providers place each run in a local `bwrap` sandbox on Linux or
`sandbox-exec` sandbox on macOS, a sibling Docker container, or a
Kubernetes pod.

The kernel guarantees a pushed workspace branch. Project settings can
add PR creation and tracker reactions around that boundary.

The fresh-install path is standalone. A user with a GitHub URL and the
model credential for a shipped harness can dispatch a run end-to-end
with no other os-eco tooling. Around that kernel, two
[os-eco](https://github.com/jayminwest/os-eco) data-plane tools integrate
as opt-in features, not required infrastructure.

- **mulch** — persistent agent memory across runs. Activated by a
  `.mulch/` directory in the project.
- **seeds** — the integrated issue queue agents read from and write to.
  Activated by a `.seeds/` directory. Seeds is implementation #1 of the
  `IssueTracker` seam (`src/tracker/contract.ts`), with external
  trackers reachable through the `RemoteTracker` bridge — see
  [docs/design/issue-tracker.md](docs/design/issue-tracker.md).

The agent registry is entirely inline. `BUILTIN_AGENTS`
(`src/registry/builtins/`) ships seven agents and boot seeds them into
the agents table on every start: `claude-code`, `pi`,
`planner`, `nightwatch`, `bugwatch`, `pr-fixer`, and `healer`. There is
no external agent library. `GET /agents` still reports
`source: "builtin" | "library"` provenance. The `library` arm survives
only for legacy rows.

**plan-run** is a dispatch mode over the single-run primitive, unlocked
by a plan in the project's issue tracker — `POST /plan-runs` with
`planId` (requires a `supportsPlans` tracker, such as a `.seeds/` plan)
or with an explicit ordered list of issue ids (any tracker). Warren
walks the children one at a time and gates each on the previous PR
merging. Re-dispatching the same plan resumes from the next open
child. See [docs/design/plan-run-coordinator.md](docs/design/plan-run-coordinator.md)
and the issue-tracker design record.

Plan pl-3a79 retired and deleted two former data-plane features:
`plot` (a shared coordination substrate) and `canopy` (an external
agent-definition library). See [ROADMAP.md](ROADMAP.md) for
the sequencing and [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) for policy.

## Runtime topology

Warren runs against a swappable runtime provider, resolved once at boot
from `WARREN_RUNTIME` (`src/runtime/registry.ts`) behind the
`RuntimeProvider` contract (`src/runtime/contract.ts`). Three
backends exist.

- `LocalProvider` (`src/runtime/local/`, the default) runs the
  in-process engine. It materializes a worktree, composes a bwrap
  profile from the warren-owned sandbox (`src/sandbox/`), and drives
  the agent through a host-side loop. The runtime adapters
  (`src/runtime/adapters/`) own the per-harness command, parser, and
  steering shapes.
- `DockerProvider` (`src/runtime/docker/`, `WARREN_RUNTIME=docker`)
  runs each agent as a sibling container over the docker socket. The
  container boundary is the sandbox. See
  [docs/design/runtime-docker-provider.md](docs/design/runtime-docker-provider.md).
- `K8sProvider` (`src/runtime/k8s/`, `WARREN_RUNTIME=k8s`) runs each
  agent as a Kubernetes pod. The pod boundary is the sandbox, so no
  bwrap runs there.

For the K8s topology see
[docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md) and the design records
[docs/design/runtime-provider-contract.md](docs/design/runtime-provider-contract.md)
and [docs/design/k8s-migration.md](docs/design/k8s-migration.md).

### The burrow absorption (plan pl-3007)

Warren once delegated the local sandbox to the co-tenanted
[burrow](https://github.com/jayminwest/burrow) daemon. Plan pl-3007
absorbed that substrate: the sandbox, the harness adapters, the spawn
path, and the preview sidecars are warren-owned now. Warren no longer
spawns `burrow serve`, links `@os-eco/burrow-cli`, or talks to a burrow
socket. The burrow repo stays a standalone project.

- The supervisor spawns only warren's HTTP server and forwards
  SIGTERM/SIGINT to it.
- The local engine persists run state in-process
  (`src/runtime/local/run-store.ts`). A warren restart reconciles live
  rows as lost, same as a daemon restart did.
- The sandbox needs three apparmor/seccomp/systempaths-unconfined flags
  plus `cap_add: SYS_ADMIN` on Linux for user-namespace nesting.
  `docker-compose.yml` bakes them in. See
  [docs/design/runtime-and-supervisor.md](docs/design/runtime-and-supervisor.md).

## Per-project config (`.warren/config.yaml`)

The canonical home for per-project defaults is `.warren/config.yaml`.
The legacy `defaults.json` still loads with a deprecation warning. The
schema lives in `src/warren-config/schema.ts` (`DefaultsConfigSchema`)
and `loadWarrenConfig()` surfaces it. Notable knobs:

- `defaultRole`, `defaultPrompt`, `defaultProvider`, `defaultModel`,
  `defaultBranch`, `runBranchPrefix` — dispatch-time defaults. See
  [docs/design/warren-config.md](docs/design/warren-config.md).
- `repoContext` (warren-540f) — free-text onboarding block (≤8 KiB)
  injected into every dispatched agent's prompt between the agent system
  section and the user task. The blessed way to onboard a mirror of a
  repo you do not control — see
  [docs/onboarding-external-repos.md](docs/onboarding-external-repos.md).
- `preview` — per-run preview environments. The canonical home is
  `.warren/preview.yaml`. See
  [docs/design/preview-environments.md](docs/design/preview-environments.md).
- `agent.skipGitHooks` (default `false`) — set `true` to skip arming
  the project's git pre-commit gate on the host clone before each run
  (warren-8f4c).
- `maxCostUsd` — project-wide default per-run USD spend cap
  (warren-a63d), enforced mid-run by the event bridge. Weakest source in
  the cap chain: dispatch override (`POST /runs` `maxCostUsd`,
  `warren run --max-cost-usd`, or a trigger entry's cap) > agent
  `frontmatter.maxCostUsd` > this default — applied only when the agent
  declares no cap (malformed agent values still fail open).
- `admission.maxConcurrentRuns` — per-project cap on simultaneous
  non-terminal runs, enforced by the K8s admission gate. Over the cap
  the gate rejects the dispatch with HTTP 429 and reason
  `project_concurrency_exceeded`. Cluster-wide env knobs pair with it.
  See [docs/design/k8s-migration.md](docs/design/k8s-migration.md) §3.3
  (warren-b6f2).
- `WARREN_K8S_MAX_PROJECT_CONCURRENCY` — the global default for the
  per-project cap. `WARREN_K8S_MAX_QUEUE_DEPTH` (default 50) caps total
  non-terminal pods. `WARREN_K8S_MAX_PENDING_PODS` (default 20) caps
  Pending pods. `0` disables a cap. LocalProvider ignores all of these.

## Agent session bootstrap (warren CLI)

Agents driving warren from the shell get their session context from the
CLI itself, the same way `sd prime` and `ml prime` make seeds and mulch
discoverable. The CLI installs from npm (`npm i -g @os-eco/warren-cli`) and
runs on Bun v1.1+ (the package ships raw bun-shebang TypeScript).
**At the start of every session**, run:

```bash
warren prime
```

The command reference lists each command with its purpose and key
flags, derived from the program definition so it cannot drift from the code.
The same walk generates `docs/cli-reference.md` (`bun run gen:cli-ref`).
The env contract documents `WARREN_BASE_URL`, `WARREN_API_TOKEN`, and
`WARREN_CLIENT_CONFIG`.

- The CLI never auto-loads a cwd `.env`: the `src/cli/main.ts` shebang
  passes `--env-file=/dev/null`, so only genuinely exported environment
  variables participate in credential resolution. This closed the
  stale-dotfile trap of warren-8807/warren-2244 structurally. A guard
  test in `src/cli/main.test.ts` pins the shebang.
- `warren login` prefers a token piped on stdin over an ambient env
  token.
- Auth-rejection errors name the environment as the token source when
  it supplied the credential.
- `warren doctor` names the slot that supplied the token, in the ok line
  and in the rejection hint.

The exit-code table is the stable warren-b61e one. The workflows cover
dispatch-and-wait, tail-and-steer, and plan runs. Default output is
ndjson for machines. Pass `--output pretty` for humans.

To store credentials for the session, pipe the token on stdin so it stays
out of shell history:

```bash
echo "$WARREN_API_TOKEN" | warren login --url https://warren.example.com
```

`warren login` verifies the credential against `/whoami`, then writes
base URL + token (only — never a DB credential, per decision D5) to the
client config at `~/.warren/client.json` with mode 0600. Resolution
precedence everywhere: flags > env > config file > built-in default.

## Tech stack

- **Runtime:** Bun (runs TypeScript directly, no server build step)
- **Language:** TypeScript, strict mode (`noUncheckedIndexedAccess`, no `any`)
- **Lint/format:** Biome (`--error-on-warnings` — warnings fail CI)
- **Storage:** SQLite via `bun:sqlite` (Postgres optional)
- **HTTP:** `Bun.serve` serves both the JSON API and the SPA
- **UI:** React + Vite + Tailwind + shadcn-style components, in
  `src/ui/` as the `@os-eco/warren-ui` package, built into `src/ui/dist/`
- **Sandbox primitive:** a `RuntimeProvider` (`src/runtime/`), not a
  direct dependency. `LocalProvider` runs the in-process engine.
  `K8sProvider` runs pods.

## Build & test commands

From the repo root (server + supervisor + CLI):

```bash
bun test                       # Run all tests
bun test src/foo.test.ts       # Run a single test file
bun run test:coverage          # bun test --coverage (text + lcov -> coverage/)
bun run check:coverage         # tests + coverage + ratchet enforcement
bun run test:pg                # test suite against Postgres
bun run lint                   # biome + layers + version-sync + wire-types + prose guards
bun run typecheck              # tsc --noEmit
bun run build:ui               # cd src/ui && bun install && bun run build
bun run db:generate            # regenerate drizzle migrations (sqlite + postgres)
bun run gen:cli-ref            # regenerate the CLI reference (docs/cli-reference.md)
bun run version:bump           # bump version across all four sites
bun run acceptance             # end-to-end acceptance scenarios
bun run acceptance:container   # acceptance scenarios in container mode
bun run acceptance:public      # scenario 39, the public-instance leak guard
bun run acceptance:nightly     # the nightly acceptance suite
```

CI (`.github/workflows/ci.yml`) runs each manifest gate as its own
step. The test job invokes `check:coverage:ci`, which emits
`test-results/junit.xml` and uploads `coverage/lcov.info`. CI then runs
`report:test-timing` for a slowest-suite summary and
`report:quality-metrics` (warren-5b95) for a code-quality panel in the
GitHub Actions step summary. Git ignores `test-results/` and
`coverage/` as build artifacts.

UI-only (its own package):

```bash
bun run ui:dev                 # vite dev server
bun run ui:install             # cd src/ui && bun install
```

## Quality gates

Run all checks before committing. Warnings count as failures:

```bash
bun run check:all     # or its agent-facing alias: bun run verify
```

`check:all` is the os-eco canonical quiet runner (`scripts/check-all.ts`).
It is byte-identical to `../templates/l5-toolkit/scripts/check-all.ts`
at the os-eco root. Never edit it in place. It prints one aligned
status line per gate and a `12/12 gates passed` tally. On failure it
shows parsed failure signatures plus a `re-run: bun run <gate>` hint.
`CHECK_ALL_VERBOSE=1` streams full output and `--bail` stops early.

Warren's resolved manifest, in order:

- `lint`
- `typecheck`
- `check:agents`
- `check:dups` (jscpd)
- `check:deps`
- `check:size`
- `check:debt`
- `check:bundle-size`
- `gen:docs:check`
- `gen:openapi:check`
- `check:coverage` (tests + coverage ratchet)
- `check:ci-parity`

The release workflow (`.github/workflows/release.yml`) runs the same
`check:all` before any release work, so a release can never ship code
CI would reject. `check:ci-parity` proves the local manifest and the CI
workflow agree in both directions. Per-repo escape hatches live in
`scripts/ci-parity-config.json`.

Ten repo-specific guards ride inside the `lint` gate rather than
taking a manifest slot, because the canonical gate vocabulary is
frozen. Each also runs standalone under the matching `check:` script
name.

- `scripts/check-layers.ts`, `scripts/check-version-sync.ts`,
  `scripts/check-wire-types.ts`, `scripts/check-prose.ts`,
  `scripts/check-merge-strategy.ts`
- `scripts/check-seeds-integrity.ts` (warren-a71f) — catches duplicate
  and contradictory rows in `.seeds/issues.jsonl`, the shape a git
  auto-merge leaves behind
- `scripts/check-rls.ts` (warren-3206) — replays the Postgres
  migrations in journal order and fails any still-live table without
  `ENABLE ROW LEVEL SECURITY`
- `scripts/check-runtime-ids.ts` (warren-c80e) — fails a runtime-id
  literal written outside `src/runtime/adapters/`. Per-runtime behavior
  belongs behind the adapter registry. The allowlist has two buckets:
  files that name a runtime on purpose, and the older conditional code
  that phase 2 moves behind the seam
- `scripts/check-client-contract.ts` (warren-4d2d) reads the request
  paths in `src/ui/src/api/client.ts` and fails any call that
  `ROUTE_TABLE` does not serve. A path the parser cannot resolve
  statically fails too, because a silent skip hides the drift this
  guard exists to catch
- `scripts/check-extensions.ts` (warren-c26c) runs the `typecheck`
  and `lint` scripts each `extensions/*` package declares. The root
  tsconfig and Biome config exclude `extensions/` on purpose, so before
  this guard an extension could sit red on main behind green gates. The
  guard runs a frozen install first when a package has no `node_modules`

`gen:cli-ref:check` rides the same gate and holds the generated CLI
reference in place.

`check:design-docs` also rides inside `lint` and enforces these rules:

- Every record has controlled metadata and one row in `docs/design/README.md`.
- Shipped records point to current truth.
- Mixed records have a scope-status table.
- Records in `next` state name their ROADMAP order.
- Approval alone never means roadmap commitment.

Details on the additional checks:

- **`check:size`** (warren-4553) — enforces a per-file line-count
  budget. New `.ts`/`.tsx` files under `src/` and `scripts/` must stay
  at or under 500 lines. `scripts/file-size-budgets.json` grandfathers
  existing oversized files at frozen ceilings, and the ratchet only
  goes down. `src/ui/` is in scope as of warren-c8bd with three
  grandfathered entries. The walk skips only `src/ui/dist/`. Biome's
  `noExcessiveLinesPerFunction` rule enforces the same 500-line cap at
  the function level. `bun run scripts/check-file-sizes.ts --headroom 10`
  reports the files with 10 lines of slack or less, and never fails
  (warren-8746). A file at its ceiling passes every PR that touches it
  alone. It then fails once a merge lands the union of two of them.
  `.github/workflows/size-overshoot-report.yml` names what overshot, on
  the PR itself.
- **`check:debt`** (warren-7f2b) — scans `src/` and `scripts/` for
  `TODO` / `FIXME` / `HACK` / `XXX`. Any marker without a tracker
  reference on the same line fails the gate. Accepted references are
  `warren-XXXX`, `pl-XXXX`, `mx-XXXX`, an issue number, or a URL.
  `scripts/debt-marker-allowlist.json` holds the grandfather list, and
  it only goes down. Pair new markers with an id instead of appending
  to the allowlist.
- **`check:agents`** — validates that `AGENTS.md` references still
  resolve. Every `bun run <x>` in a fenced bash block must exist in
  `package.json` scripts. Every backticked path-shaped token must exist
  on disk or sit in the script's explicit known-missing list.
- **`check:dups`** (warren-61e9) — runs jscpd over
  `src/**/*.{ts,tsx}` to detect copy-pasted code. Config lives in
  `.jscpd.json`, which excludes tests, generated migrations, drizzle
  schema, goldens, and the UI build output. The percentage threshold is
  a ratchet that only goes down.
- **`check:deps`** (warren-d109) — wraps knip in `--dependencies` mode
  (config in `knip.json`) to flag unused or undeclared npm dependencies
  across the root package and the `src/ui` workspace. The fix for a
  knip hit is almost always `bun remove <dep>`. Ignore a dep only when
  it resolves by string at runtime, like a pino transport target.
- **`check:bundle-size`** (warren-5abc) — measures the Vite UI build
  output in `src/ui/dist/assets/` against the ratchet in
  `scripts/bundle-size-budgets.json`. Never hand-edit the budget from
  Vite's build-log gzip number, which runs about 2KB cooler than this
  guard's Node-zlib measure. Re-baseline with
  `bun run check:bundle-size --update`, which always builds first and
  writes measured numbers. Ordinary growth auto-raises within
  `AUTO_RAISE_CAP`. A heavy new dep past the cap needs
  `WARREN_BUNDLE_SIZE_ALLOW_RAISE=1`. On a PR that fails on a
  within-cap overshoot, the `bundle-size-autoheal` workflow
  re-baselines and pushes for you. Lowering applies on a laptop or in
  CI, but `--update` REFUSES to lower budgets when running inside a
  warren-dispatched run (warren-6397): the agent image's toolchain
  gzips the build ~1.3-1.5KB cooler than CI, so a pod-written lower
  budget corrupts the CI-enforced number. Re-baseline lowers from a
  CI-matching environment instead.
- **`check:coverage`** (warren-e4b1) — wraps `bun test --coverage` and
  enforces the floors in `scripts/coverage-budgets.json` against the
  "All files" row of Bun's text reporter. CI invokes
  `check:coverage:ci`, which also emits `test-results/junit.xml` and
  uploads `coverage/lcov.info`. The ratchet only goes up. Lowering a
  floor means you deleted tests, and it needs a tracker reference.
- **`gen:docs:check`** (warren-e5fb) — keeps `docs/http-api.md` in sync
  with the `ROUTE_TABLE` array in `src/server/handlers/route-table.ts`, the
  canonical HTTP API surface. Refresh with `bun run gen:docs` and
  commit the result.
- **`gen:openapi:check`** (warren-b46b) — keeps `docs/openapi.yaml`
  (OpenAPI 3.1, derived from the same `ROUTE_TABLE`) up to date.
  Refresh with `bun run gen:openapi` and commit.
- **`gen:cli-ref:check`** (warren-1caf) — keeps `docs/cli-reference.md`
  in sync with the commander command definitions in `src/cli/main.ts`,
  the canonical CLI surface. Refresh with `bun run gen:cli-ref` and
  commit the result. The check rides inside the `lint` gate.

Biome's `noExcessiveCognitiveComplexity` rule (warren-d3a6, ceiling 15)
holds a project-wide complexity budget. New code must stay under the
threshold. Existing complexity and filename exceptions document their
ratchet policies inline in `biome.jsonc`. Both lists only shrink.

## Docs are a public surface

Downstream readers link to `docs/` paths, so treat every one as
published (warren-d602).

- Deleting or moving any `docs/` path requires a one-line pointer entry
  in `docs/README.md` of the form `<old path> -> <successor>` or
  `<old path> — retired, see <X>`.
- Add the tombstone in the same commit that removes or renames the file.

## Naming conventions

- **Filenames (server/scripts):** `kebab-case.ts`. Tests are
  `<name>.test.ts` next to the file under test. Dotted groupings like
  `src/server/handlers/plan-runs.create.test.ts` pass, and each
  dot-segment must itself be kebab-case. Biome's
  `useFilenamingConvention` rule enforces this.
- **Filenames (`src/ui/`):** the same kebab-case rule applies as of
  warren-c8bd. Write new UI files in kebab-case. PR #922 cleared the
  grandfathered exception list in `biome.jsonc`, so the rule now
  applies to every UI filename with no exceptions.
- **Directories:** `kebab-case` (`src/plan-runs/`,
  `src/warren-config/`, `src/runtime/local/`).
- **Identifiers:** `camelCase` for functions, variables, and instance
  fields. `PascalCase` for types, interfaces, classes, and React
  components. `SCREAMING_SNAKE_CASE` for true module-level constants
  like `NETWORK_POLICIES`. Booleans read as predicates (`isOpen`,
  `hasPreview`).
- **Test names:** `describe("<unitUnderTest>")` plus a verb-led
  `test("...")` behaviour description. No `should`, no `it`.
- **TOML / config keys** (agent definitions, `burrow_config`) stay
  `snake_case` to match the upstream schema, even when the TypeScript
  helper that parses them is kebab-case.

## TypeScript conventions

- Strict mode with `noUncheckedIndexedAccess`. Always handle possible
  `undefined` from indexing.
- No `any`. Use `unknown` and narrow, or define a proper type.
- **Define wire vocabulary once, then re-export it outward.** Every
  enum-shaped value that crosses the HTTP wire lives in
  `src/core/wire.ts`. The SDK, the drizzle columns, and the UI
  re-export it. None of them declares a second copy, and `bun run lint`
  fails if one appears. See "Single source of truth" below.
- **Domain-internal types co-locate with their domain**
  (`src/server/types.ts`, `src/runs/`, `src/projects/`). UI-only view
  types stay in `src/ui/`: component props, form state, chart shapes.
- Import with `.ts` extensions.
- Tab indentation, 100-char line width (enforced by Biome).

## Single source of truth

Each capability in warren has exactly one implementation. The domain
modules under `src/runs/`, `src/projects/`, and `src/plan-runs/` own
the logic. The HTTP handlers in `src/server/handlers/` are a thin
surface over them. The CLI, the SDK, and the UI are consumers that call
the domain function or the HTTP route that wraps it. None of them
re-implements it. None keeps a hand-maintained copy of a type another
side already owns.

The old wording told agents to keep UI types in a separate file, which
sanctioned the duplication that then drifted. `RunFailureReason` lost
values in both the SDK copy and the UI copy. The UI still typed a run
mode the server had deleted. `RefreshAgentsResponse.removed` read as an
object array against a server truth of `string[]` (warren-b229). A
convention that permits a second copy produces a second copy.

### The wire vocabulary

`src/core/wire.ts` is the canonical home for every enum-shaped value
that crosses the HTTP wire. That covers run, plan-run, and preview
lifecycle states, the failure-cause discriminator, run mode, clone
kind, event stream, agent source, and the steering-inbox classes. The
direction is define there, re-export outward.

- `src/db/schema/columns.ts` re-exports the whole module with
  `export * from "../../core/wire.ts"`.
- `src/client/types.ts` and `src/client/types.plan-runs.ts` re-export
  the names they need.
- `src/ui/src/api/types.ts` re-exports the same names and declares none
  of them.

`src/core/` imports nothing. A kernel with no imports is what lets the
Vite-bundled UI reach the same module without dragging drizzle and
`bun:sqlite` into a browser bundle.

Two guards hold the rule, and both run inside `bun run lint`.

- `check:wire-types` (`scripts/check-wire-types.ts`, warren-d371) reads
  the canonical name list out of `src/core/wire.ts` at run time.
  Re-export forms pass. A redeclaration fails with
  `file:line — declares "NAME"`. A deliberate local copy goes in the
  script's `ALLOW` list with a comment saying why.
- `check:layers` (`scripts/check-layers.ts`, warren-89a6) refuses an
  import that points the wrong way across a declared seam. Rules live
  in `scripts/layer-rules.json`, so a new seam is a data edit. A hit
  prints `file:line` plus the rule's `why`. A deliberate exception goes
  in that rule's `allow` list with a `why` field.

Ten seams ship today (the two burrow boundaries left with the facade
and the package in warren-ea0a):

- Domain modules must not import `src/server/**` or `src/cli/**`.
- `src/cli/**` must not import `src/server/**`.
  `src/cli/commands/serve.ts` is the one exception, because booting the
  server is that command's whole job.
- `src/server/handlers/**` must not import `src/db/schema/**` and must
  not build a repo out of `deps.db`. Use the boot-wired seams
  `deps.repos`, `deps.dbAdapter`, and `deps.runPreviews`.
- `extensions/**` must not import `src/**` or `scripts/**`, and neither
  may import `extensions/**`. The seam is symmetric on purpose. See
  "Extensions" below.
- The two forge boundaries (plan pl-d1c9). Only `src/forge/**` may
  speak the GitHub REST API (`api.github.com` literals), and only
  `src/forge/**` may import the `src/forge/github/` transport core.
  Everything else consumes the boot-resolved `Forge` instance. See
  [docs/design/forge-contract.md](docs/design/forge-contract.md).
- `src/core/` may import only itself.
- `src/ui/` is a browser consumer: it imports the `src/core/` kernel, the
  SDK's browser-safe `src/client/ndjson.ts` reader, and its own code —
  nothing else under `src/` (warren-f0ae).

Beside the layer rules, the `IssueTracker` seam (`src/tracker/contract.ts`,
boot-wired as `deps.issueTracker`) is a provider seam, not a bus
subscriber: call sites consume the boot-resolved instance and branch
on its capability flags. See
[docs/design/issue-tracker.md](docs/design/issue-tracker.md).

Two sharp edges:

- A module that `src/ui` imports from outside its own `src/` must
  appear in `include` in `src/ui/tsconfig.app.json`. The UI is a
  separate composite project, so a missing entry fails the build with
  TS6307. Only `bun run build:ui` catches that, because the root
  typecheck skips `src/ui`.
- `check:wire-types` only enforces canonical names that carry one of
  its `DOMAIN_STEMS`: run, inbox, clone, preview, event, agent. A new
  wire name outside those stems stays unguarded until you widen the
  list.

### Patterns to copy

- `spawnRun` lives once in `src/runs/spawn/dispatch.ts`. Five call
  sites import it: the scheduler, the plan-run dispatcher, and three
  handler modules.
- `addProject` lives once in `src/projects/manage.ts`. Both
  `src/cli/commands/add-project.ts` and
  `src/server/handlers/projects.ts` call it, so the CLI and the API
  register a project the same way.
- `defaultSpawn` lives once in `src/projects/clone.ts`, beside the
  `SpawnFn` contract and `resolveSpawnEnv`. `src/cli/output.ts`,
  `src/server/main/utils.ts`, and `src/server/handlers/index.ts`
  re-export it.

The counter-example to avoid. `defaultSpawn` used to exist three times,
once per surface, and each copy carried a comment calling the
duplication deliberate. The reason did not hold, because all three
already imported `resolveSpawnEnv` from `src/projects/clone.ts`. A
comment asserting that a copy is intentional is not evidence that it
is. warren-032a removed the copies.

## Version management

The version lives in four places, all rewritten by
`bun run version:bump <major|minor|patch|X.Y.Z>`
(`scripts/version-bump.ts`, warren-16b5):

- `package.json` — the `"version"` field
- `src/index.ts` — `export const VERSION = "X.Y.Z"`
- `docs/openapi.yaml` — `info.version`, refreshed by the script
  re-running `gen:openapi`
- `README.md` — the semver in the `## Status` paragraph

The script also drafts an `[Unreleased]` block into `CHANGELOG.md` from
`git log <last-tag>..HEAD`, fenced by `<!-- version-bump:draft -->`
markers. The draft is assistive only. Curate it and delete the markers
before releasing. All rewrites roll back together on failure.

`.github/workflows/release.yml` fails the release job if `package.json`
and `src/index.ts` disagree. It then auto-tags the release and creates
it from the matching `CHANGELOG.md` section.

`bun run check:version-sync` (warren-0210,
`scripts/check-version-sync.ts`) asserts on every PR that all four
sites agree. It shares the
README locator with `scripts/version-bump.ts`, so the gate and the
bumper can never disagree about where the version lives. It rides
inside `bun run lint` because the canonical gate manifest is frozen.

## Git identities (Article VII)

Per [docs/CONSTITUTION.md](docs/CONSTITUTION.md) Article VII,
warren-authored commits use one canonical bot identity. Two distinct
identities exist. Do not conflate them.

- **Warren's bookkeeping bot** authors the reap-time `chore(warren)`
  commits. The resolver in `src/bot-identity.ts` is the single source
  of truth. Operators override the spelling with `WARREN_BOT_NAME` and
  `WARREN_BOT_EMAIL` together. The default is
  `warren <bot@warren.invalid>`, an RFC 2606 non-routable address
  (warren-02cd). Never re-spell `user.name` or `user.email` inline at a
  new commit site. Go through the resolver. warren-598f closed a
  nine-spelling drift this way.
- **The agent's author identity** comes from `WARREN_GIT_AUTHOR_NAME`
  and `WARREN_GIT_AUTHOR_EMAIL`, installed by
  `src/supervisor/git-identity.ts`. Operators should use a dedicated
  GitHub machine account's noreply address so agent work attributes to
  the bot, not to a personal account.

## Protected paths (Article IX)

Per [docs/CONSTITUTION.md](docs/CONSTITUTION.md) Article IX, some
changes require explicit human review and must not ride an auto-merged
PR. The protected paths are `docs/CONSTITUTION.md` itself,
`.warren/triggers.yaml`, and the agent definitions in
`src/registry/builtins/`. The "Article IX check" step in
`.github/workflows/auto-merge.yml` refuses to enable auto-merge on any
PR touching those paths or the workflow itself.

## Auth modes

`WARREN_AUTH` resolves the auth backend once at boot
(`src/server/auth.ts`). The default `token` mode requires a bearer
credential on every request. `WARREN_AUTH=public` (warren-851b) admits
an unauthenticated caller as a read-only spectator on the public
projection. The server holds a credentialed caller to its credentials.
A stale or malformed token returns 401 rather than silently degrading
to the public view. Acceptance scenario 39 is the leak guard for this
mode.

## Lifecycle bus

Boot wires the Tier-1 observation event bus in
`src/server/main/lifecycle-bus-wiring.ts` (warren-4e74). It is an
observe-only process singleton that run-lifecycle call sites emit into.
Proof consumers are the healer (`src/healer/lifecycle.ts`) and the
seed-close reap hook (`src/runs/reap/seed-close-lifecycle.ts`). See
[docs/design/tier1-observation-bus.md](docs/design/tier1-observation-bus.md).
The run-level provider retry (`src/runs/retry/provider-retry.ts`) is a
third consumer. Its policy is in
[docs/design/provider-retry.md](docs/design/provider-retry.md).

## Extensions

`extensions/` holds out-of-process packages built against warren's
published HTTP surface only. Each one is standalone: own
`package.json`, own lockfile, own tsconfig, own tests.

An extension never imports `src/` or `scripts/`, and core never
imports it. `check:layers` enforces both directions, because an import
either way compiles the extension into core and makes its removal
breaking.

Six extension packages ship today. The flagship is
`extensions/audit-log/` (plan pl-116e), a collector that tails run
events, normalizes them into an append-only audit log, and exports it
over `GET /audit-log.jsonl`. Beside it sits `extensions/judge/`
(plan pl-17ca), which reads finished runs, judges them against the
15-class rubric v1, stores verdicts append-only, and exports them
over `GET /verdicts.jsonl`. `extensions/tracker-jira/` (warren-27d9)
speaks the warren-tracker/v1 protocol against Jira Cloud and holds
its own Jira credential. Its README carries the friction list for
that build. `extensions/tracker-ado/` does the same against Azure
DevOps Boards, holding its own PAT, and its README carries the second
friction list. `extensions/tracker-conformance/` (warren-53ea) is the
warren-tracker/v1 conformance suite plus FakeTracker, the reference
in-memory server. `extensions/campaign-controller/` (plan pl-91b6) is
the first controller extension: it owns durable campaign state and
drives warren's HTTP command APIs under an operator-approved policy —
dry-run journaling in V0, plus a single policy-gated create-PR
mutation from Phase 2.

`extensions/audit-log/FRICTION.md` logs every place the extension
author had to work around a missing warren surface, and that list is
the spec for warren's delivery mechanism. Add to it when you hit a new
one. See [docs/design/extensions.md](docs/design/extensions.md).

## Golden snapshots

Stable wire shapes that downstream consumers depend on are pinned with
on-disk JSON fixtures under a sibling directory named `__golden__`.
The first adopter is `src/server/__golden__/responses` (warren-8aa4),
which locks the `renderError`, `notFound`, `methodNotAllowed`, and
`notImplemented` envelopes. The companion test is
`src/server/responses.golden.test.ts`.

Regenerate after an intentional shape change with
`WARREN_UPDATE_GOLDENS=1 bun test src/server/responses.golden.test.ts`.
Then diff the fixtures and commit only what you meant. The
`__golden__` name is already excluded from `check:size`, `check:debt`,
`check:dups`, and Biome's filename-convention rule. Keep new golden
directories under the same name so those exclusions keep applying.

## Acceptance harness

`scripts/acceptance/` runs scenario-based end-to-end checks against a
real warren boot. Scenarios live in
`scripts/acceptance/scenarios/` and use the helpers in
`scripts/acceptance/lib/`. New scenarios must be deterministic,
idempotent, and clean up after themselves.

Scenario 39 (`scripts/acceptance/scenarios/39-public-exposure.ts`, warren-c405) is the
public-instance leak guard. It is the only scenario wired into CI, via
`.github/workflows/acceptance-public.yml` and
`bun run acceptance:public`. The rest of the suite runs locally and on
the nightly workflow.

## Session completion protocol

When ending a work session, complete ALL steps:

1. File issues for remaining work: `sd create --title "..."`
2. Run quality gates (if code changed): `bun run check:all`
3. Close finished issues: `sd close <id>`
4. Record insights worth preserving: `ml learn` then `ml record ...`
5. Push: `sd sync && ml sync && git push`
6. Verify: `git status` shows "up to date with origin"

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard:v0.4.0 -->
<!-- seeds-onboard-schema:4 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) v0.4.0 for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows. Pass `--format json|compact|markdown|plain|ids` on any command for agent-friendly output.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd search <query>` — Full-text search across titles + descriptions
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Planning
Use `sd plan` when work is large or ambiguous enough that an LLM benefits from structured decomposition. Submit spawns one child seed per step. `step.blocks` uses forward semantics: step i with `blocks: [j]` means step i blocks step j, and step j gets step i's id in its `blockedBy`.

- `sd plan templates` — List built-ins (`feature`, `bug`, `refactor`) plus custom templates
- `sd plan prompt <seed-id>` — Emit a structured prompt the LLM fills in
- `sd plan submit <seed-id> --plan <file>` — Validate + spawn child seeds
- `sd plan show <pl-id>` — View sections, children, sub-plans
- `sd plan outcome <pl-id> --result success|partial|failure` — Record outcome (storage-only)
- `sd plan review <pl-id> --by <name>` — Record reviewer (informational)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard:v0.8.0 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) v0.8.0 for structured expertise management.

**At the start of every session**, run:
```bash
ml prime
```

Injects project-specific conventions, patterns, decisions, failures, references, and guides into
your context. Run `ml prime --files src/foo.ts` before editing a file to load only records
relevant to that path (per-file framing, classification age, and confirmation scores included).

For monolith projects where dumping every record wastes context, set
`prime.default_mode: manifest` in `.mulch/mulch.config.yaml` (or pass `--manifest`) to emit a
quick reference + domain index. Agents then scope-load with `ml prime <domain>` or
`ml prime --files <path>`.

**Before completing your task**, record insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made:
```bash
ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Evidence auto-populates from git (current commit + changed files). Link explicitly with
`--evidence-seeds <id>` / `--evidence-gh <id>` / `--evidence-linear <id>` / `--evidence-bead <id>`,
`--evidence-commit <sha>`, or `--relates-to <mx-id>`. Upserts of named records merge outcomes
instead of replacing them. Validation failures print a copy-paste retry hint with missing fields
pre-filled.

Run `ml status` for domain health, `ml doctor` to check record integrity (add `--fix` to strip
broken file anchors), `ml --help` for the full command list. Write commands use file locking and
atomic writes, so multiple agents can record concurrently. Expertise survives `git worktree`
cleanup — `.mulch/` resolves to the main repo.

`ml prune` soft-archives stale records to `.mulch/archive/` instead of deleting them. Pass
`--hard` for true deletion. Restore an archived record with `ml restore <id>`. Do not read
`.mulch/archive/` directly — those records are stale by definition. If you need historical
context, run `ml search --archived <query>`.

### Before You Finish

1. Discover what to record (shows changed files and suggests domains):
   ```bash
   ml learn
   ```
2. Store insights from this work session:
   ```bash
   ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
   ```
3. Validate and commit:
   ```bash
   ml sync
   ```
<!-- mulch:end -->

## Without the sd/ml CLIs

The seeds and mulch sections above assume you have the sd and ml CLIs.
If you do not, skip those steps.

Everything else applies as written: make the change, run the quality
gates, open the PR. The project's own tooling maintains the issue queue
and expertise records. PRs from contributors without the CLIs are
welcome.

## Further reading

- [ROADMAP.md](ROADMAP.md) — sequencing and release plan
- [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) — project policy
- [docs/CONSTITUTION.md](docs/CONSTITUTION.md) — the articles agents answer to
- [docs/design/](docs/design/) — topic design records
- [README.md](README.md) — user-facing pitch + deploy instructions
- [ACCEPTANCE.md](ACCEPTANCE.md) — operator runbook for V1 release gates
- [CHANGELOG.md](CHANGELOG.md) — release history (0.9.10 and earlier:
  [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md))
