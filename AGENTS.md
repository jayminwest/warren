# AGENTS.md

This file is the canonical entry point for AI coding agents working in
this repo, following the [agents.md](https://agents.md) convention. It
mirrors the essentials from [`CLAUDE.md`](CLAUDE.md); when the two
disagree, `CLAUDE.md` is authoritative and this file should be updated
to match.

## What this project is

Warren is a self-hostable control plane for ephemeral cloud agents.
Point it at a GitHub repo, pick an agent, write a prompt; warren spawns
the agent inside a sandbox (burrow), streams events to the UI, lets the
user steer mid-run, then pushes the workspace branch. One container,
one volume, one HTTP API, one UI.

The fresh-install path is standalone: the built-in `claude-code` agent
ships inline (`src/registry/builtins/`) with the other built-ins. The
opt-in os-eco integrations (`mulch`, `seeds`, `sapling`) light up when
their config or directories are present.

`plan-run` is a dispatch mode over the single-run primitive that a
`.seeds/` plan unlocks. The deletion pass pl-3a79 retired `plot` and
`canopy` — see `CLAUDE.md` and [`SPEC.md`](SPEC.md) §1 / §11 for the
full framing.

The runtime substrate is [burrow](https://github.com/jayminwest/burrow);
warren and burrow are co-tenanted inside the container and share a unix
socket. **Before touching anything that crosses the warren↔burrow
boundary** (`src/supervisor/main.ts`, `src/burrow-client/`,
`docker-compose.yml` security flags), read `../burrow/SPEC.md` and the
"Relationship to burrow" section of `CLAUDE.md`.

## Tech stack at a glance

- **Runtime:** Bun (runs TypeScript directly, no server build step)
- **Language:** TypeScript, strict mode (`noUncheckedIndexedAccess`, no `any`)
- **Lint/format:** Biome (`--error-on-warnings` — warnings fail CI)
- **Storage:** SQLite via `bun:sqlite` (Postgres optional, see SPEC §11.J)
- **HTTP:** `Bun.serve` serves both the JSON API and the SPA
- **UI:** React + Vite + Tailwind + shadcn-style components, in
  `src/ui/` as the `@os-eco/warren-ui` package, built into `src/ui/dist/`
- **Sandbox primitive:** burrow (HTTP over a unix socket)

## Build & test commands

From the repo root:

```bash
bun test                      # Run all tests
bun test src/foo.test.ts      # Run a single test file
bun run test:ci               # bun test --reporter=junit -> test-results/junit.xml
bun run test:coverage         # bun test --coverage (text + lcov -> coverage/)
bun run check:coverage        # tests + coverage + ratchet enforcement
bun run report:test-timing    # print slowest suites/tests from junit.xml
bun run report:quality-metrics # print code-quality metrics summary (coverage + complexity + ratchets)
bun run lint                  # biome + layers + version-sync + wire-types + prose guards
bun run check:wire-types      # canonical wire vocabulary guard (also inside lint)
bun run typecheck             # tsc --noEmit
bun run build:ui              # cd src/ui && bun install && bun run build
```

CI (`.github/workflows/ci.yml`, warren-cec7) runs `bun run test:ci` instead
of bare `bun test` so every PR emits `test-results/junit.xml`, then runs
`bun run report:test-timing` to dump a slowest-suite/slowest-test summary
into the GitHub Actions step summary, then `bun run report:quality-metrics`
(warren-5b95) appends a consolidated code-quality panel — coverage % vs
floors, complexity grandfather counts, file-size + debt-marker ratchet
status, and bundle-size headroom — to the same summary, and uploads the JUnit XML as the
`bun-test-junit` artifact for offline analysis (regression triage, perf
ratchets, etc.). `test-results/` is gitignored — it's a build artifact.

UI-only (its own package):

```bash
bun run ui:dev                # vite dev server
bun run ui:install            # cd src/ui && bun install
```

## Quality gates

Run all checks before committing — warnings count as failures:

```bash
bun run check:all     # or its agent-facing alias: bun run verify
```

`check:all` is the os-eco canonical quiet runner (`scripts/check-all.ts`,
byte-identical to `../templates/l5-toolkit/scripts/check-all.ts` at the
os-eco root — never edit it in place). It prints one aligned status line
per gate and a `12/12 gates passed` tally; on failure it shows parsed
failure signatures plus a `re-run: bun run <gate>` hint
(`CHECK_ALL_VERBOSE=1` streams full output, `--bail` stops early).
Warren's resolved manifest, in order: `lint`, `typecheck`,
`check:agents`, `check:dups` (jscpd), `check:deps`, `check:size`,
`check:debt`, `check:bundle-size`, `gen:docs:check`, `gen:openapi:check`,
`check:coverage` (tests + coverage ratchet), and `check:ci-parity` —
the same set CI enforces, and `check:ci-parity` proves it in both
directions (see `.github/workflows/ci.yml`; escape hatches live in
`scripts/ci-parity-config.json`). Do not merge with
lint warnings; fix at write time or promote to error in `biome.json`.

Details on the additional checks:

- **`check:size`** (warren-4553) — enforces a per-file line-count
  budget. New `.ts`/`.tsx` files under `src/` and `scripts/` must stay
  ≤ 500 lines; existing oversized files are grandfathered in
  `scripts/file-size-budgets.json` and may not grow past their frozen
  ceiling — the ratchet only goes down. `src/ui/` is in scope as of
  warren-c8bd. The walk skips only the `src/ui/dist/` build output.
  That change added the three `src/ui/` entries to the budget file. Biome's
  `noExcessiveLinesPerFunction` rule (also 500-line cap) enforces the
  same budget at the function level, with the same baseline exceptions
  called out in `biome.json`'s `overrides`.
- **`check:debt`** (warren-7f2b) — scans `src/` and `scripts/`
  `.ts`/`.tsx` for `TODO` / `FIXME` / `HACK` / `XXX` and fails if any
  marker lacks a tracker reference on the same line (`warren-XXXX`,
  `pl-XXXX`, `mx-XXXX`, `#NNN`, or a URL). The ratchet grandfather list
  lives in `scripts/debt-marker-allowlist.json` and only goes down —
  pair new markers with an id (or remove them) rather than appending to
  the allowlist. `src/ui/` is in scope as of warren-c8bd. The walk
  skips only `src/ui/dist/`. `src/ui/` carried no untracked marker, so
  the allowlist stays empty.
- **`check:agents`** — validates that `AGENTS.md` references
  (`bun run <X>` commands and backtick-quoted paths) still exist.
- **Four guards ride inside `lint`** rather than taking a manifest slot of their own, because the canonical `check:all` gate vocabulary is frozen. They are `scripts/check-layers.ts`, `scripts/check-version-sync.ts`, `scripts/check-wire-types.ts` and `scripts/check-prose.ts`. Each one also runs on its own under the matching `check:` script name. See "Single source of truth" below for the first and third.

Biome's `noExcessiveCognitiveComplexity` rule (warren-d3a6, cognitive
complexity ≤ 15) enforces a project-wide complexity ceiling. New code
must stay under the threshold; existing offenders are grandfathered in
the first `overrides` block of `biome.json`. That block also names the
15 `src/ui/` files warren-c8bd brought into scope. The ratchet only goes
down — refactor offenders out of the list rather than adding new
entries.

- **`check:bundle-size`** (warren-5abc) — measures the Vite UI build
  output in `src/ui/dist/assets/` and enforces a ratchet in
  `scripts/bundle-size-budgets.json`. Tracks raw + gzipped totals per
  extension (`.js`, `.css`) and the largest single chunk's gzipped
  size. Never hand-edit the budget JSON from Vite's build-log gzip
  number — it runs ~2KB cooler than this guard, so eyeballed budgets
  fail CI. Re-baseline with `bun run check:bundle-size --update`,
  which writes the authoritative measured numbers: lowering always
  applies, ordinary growth auto-raises within `AUTO_RAISE_CAP`, and a
  heavy new dep past the cap needs `WARREN_BUNDLE_SIZE_ALLOW_RAISE=1`.
  The `bundle-size-autoheal` workflow re-baselines + pushes for you when
  a PR fails on a within-cap overshoot, so a few-hundred-byte miss never
  halts a run. The script body carries `--build`, so `bun run
  check:bundle-size` is self-contained (frozen-lockfile UI install +
  build, then measure); CI additionally keeps an explicit `build:ui`
  step so the build is visible in logs.

- **`check:coverage`** (warren-e4b1) — wraps `bun test --coverage`
  (text + lcov reporters) and enforces the floors in
  `scripts/coverage-budgets.json` against the "All files" aggregate of
  Bun's text coverage table. CI invokes `check:coverage:ci`, which
  additionally emits `test-results/junit.xml` for the test-timing
  summary; the `coverage/lcov.info` artifact is uploaded for downstream
  analysis. The ratchet only goes UP — raise floors as coverage
  improves; lowering them requires a tracker-referenced rationale (it
  means you deleted tests).

- **`gen:docs:check`** (warren-e5fb) — verifies that `docs/http-api.md`
  is in sync with the `ROUTE_TABLE` array in `src/server/handlers/index.ts`.
  The route table is the canonical HTTP API surface; this guard keeps
  the doc from drifting. To refresh after editing routes, run
  `bun run gen:docs` and commit the result. CI runs the `--check` mode
  via `check:all`.

- **`gen:openapi:check`** (warren-b46b) — verifies that
  `docs/openapi.yaml` (an OpenAPI 3.1 schema derived from the same
  `ROUTE_TABLE`) is up to date. Paths, methods, path parameters, and
  operationIds are generated from the handler module; request/response
  bodies remain permissive in V1. Refresh with `bun run gen:openapi`
  and commit; CI runs `--check` via `check:all`.

`check:deps` (warren-d109) wraps [knip](https://knip.dev) in
`--dependencies` mode (config in `knip.json`) to flag unused or
undeclared npm dependencies across the root package and the `src/ui`
workspace. The fix for a knip hit is almost always `bun remove <dep>`
(or `cd src/ui && bun remove <dep>`) — only ignore a dep when it's
resolved by string at runtime (e.g. a pino transport target).

`check:all` runs `bun run check:dups` (warren-61e9), which invokes
[jscpd](https://github.com/kucherenko/jscpd) over `src/**/*.{ts,tsx}` to
detect copy-pasted code. Config lives in `.jscpd.json`: tests,
auto-generated migrations (`src/db/migrations/`), drizzle schema
(`src/db/schema/`), goldens, and the UI build output are excluded so
the scanner only sees hand-written production code. The percentage
threshold (`threshold` in `.jscpd.json`) is a ratchet that should only
go down — fix duplicates rather than raising the ceiling.

CI (`.github/workflows/release.yml`) runs the same trinity. Do not merge
with lint warnings; fix at write time or promote to error in `biome.json`.

## Naming conventions

- **Filenames (server/scripts):** `kebab-case.ts`. Tests are
  `<name>.test.ts` sitting next to the file under test. Dotted
  groupings (e.g. `src/server/handlers/plan-runs.create.test.ts`) are allowed
  and each dot-segment must itself be kebab-case. Enforced by Biome's
  `useFilenamingConvention` rule (group `style`, kebab-case, strict).
- **Filenames (`src/ui/`):** the same kebab-case rule applies as of
  warren-c8bd. The second `overrides` block of `biome.json` names the 32
  legacy PascalCase and camelCase UI files that predate the rule. That
  list is a bounded ratchet and only goes down. Write new UI files in
  kebab-case. To clear an entry, rename the file and delete its line.
- **Directories:** `kebab-case` (`src/burrow-client/`,
  `src/plan-runs/`, `src/warren-config/`).
- **Identifiers:** `camelCase` for functions, variables, and instance
  fields; `PascalCase` for types, interfaces, classes, and React
  components; `SCREAMING_SNAKE_CASE` for module-level constants that
  are true constants (e.g. `NETWORK_POLICIES`). Booleans read as
  predicates (`isOpen`, `hasPreview`).
- **Test names:** `describe("<unitUnderTest>")` + `test("verb-led
  behaviour description")` — no `should`, no `it`.
- **TOML / config keys** (agent definitions, `burrow_config`, etc.)
  stay `snake_case` to match the upstream schema even when the TS
  helper that parses them is kebab-case.

## TypeScript conventions

- Strict mode with `noUncheckedIndexedAccess` — always handle possible
  `undefined` from indexing
- No `any` — use `unknown` and narrow, or define a proper type
- **Define wire vocabulary once, then re-export it outward.** Every enum-shaped value that crosses the HTTP wire lives in `src/core/wire.ts`. The SDK, the drizzle columns and the UI re-export it. None of them declares a second copy, and `bun run lint` fails if one does. See "Single source of truth" below.
- **Domain-internal types still co-locate with their domain** (`src/server/types.ts`, `src/runs/...`, `src/projects/...`). UI-only view types stay in `src/ui/` — component props, form state, chart shapes.
- Import with `.ts` extensions
- Tab indentation, 100-char line width (enforced by Biome)

## Single source of truth

Each capability in warren has exactly ONE implementation. The domain modules under `src/runs/`, `src/projects/` and `src/plan-runs/` own the logic. The HTTP handlers in `src/server/handlers/` are a thin surface over them. The CLI, the SDK and the UI are consumers that call the domain function or the HTTP route that wraps it. None of them re-implements it, and none of them keeps a hand-maintained copy of a type the other side already owns.

The old wording here told agents to keep UI types in a separate file, which sanctioned the duplication that then drifted. `RunFailureReason` lost `finalize_failed` and `evicted` in BOTH the SDK copy and the UI copy. The UI still typed a run mode the server deleted. `RefreshAgentsResponse.removed` read as an object array in the UI against a server truth of `string[]`. warren-b229 repaired all three.

### The wire vocabulary

`src/core/wire.ts` is the canonical home for every enum-shaped value that crosses the HTTP wire. That covers run, plan-run and preview lifecycle states, the failure-cause discriminator, run mode, clone kind, event stream, agent source, and the steering-inbox classes. The direction is define there, re-export outward.

- `src/db/schema/columns.ts` re-exports the whole module with `export * from "../../core/wire.ts"`.
- `src/client/types.ts` and `src/client/types.plan-runs.ts` re-export the names they need.
- `src/ui/src/api/types.ts` re-exports the same names and declares none of them.

`src/core/` imports nothing. A kernel with no imports is what lets the Vite-bundled UI reach the same module. Neither drizzle nor `bun:sqlite` reaches the browser bundle.

Two guards hold the rule, and both run inside `bun run lint`:

- `check:wire-types` (`scripts/check-wire-types.ts`, warren-d371) reads the canonical name list out of `src/core/wire.ts` at run time. Re-export forms pass. A redeclaration fails with `file:line — declares "NAME"`. Put a deliberate local copy in the script's `ALLOW` list with a comment saying why.
- `check:layers` (`scripts/check-layers.ts`, warren-89a6) refuses an import that points the wrong way across a declared seam. Its rules live in `scripts/layer-rules.json`, so a new seam is a data edit, not a new script. A hit prints `file:line` plus the rule's `why`. Put a deliberate exception in that rule's `allow` list with a `why` field. Seven seams ship today:
  - The two burrow boundaries it took over from the retired burrow-boundary guard (warren-f796). No direct `src/burrow-client/` or `@os-eco/burrow-cli` import outside the local-topology allowlist.
  - Domain modules must not import `src/server/**` or `src/cli/**`.
  - `src/cli/**` must not import `src/server/**`. `src/cli/commands/serve.ts` is the one exception, because booting the server is that command's whole job.
  - `src/server/handlers/**` must not import `src/db/schema/**`, and must not build a repo out of `deps.db`. Use the boot-wired seams `deps.repos`, `deps.dbAdapter` and `deps.runPreviews`.
  - `src/core/` may import only itself.

Two sharp edges:

- A module that `src/ui` imports from outside its own `src/` must appear in `include` in `src/ui/tsconfig.app.json`. The UI is a separate composite project, so a missing entry fails the build with TS6307. Only `bun run build:ui` catches that, because the root typecheck skips `src/ui`.
- `check:wire-types` only enforces canonical names that carry one of its `DOMAIN_STEMS`: run, inbox, clone, preview, event, agent. A new wire name outside those stems stays unguarded until you widen the list.

### Patterns to copy

- `spawnRun` lives once in `src/runs/spawn/dispatch.ts`. Five call sites import it — the scheduler, the plan-run dispatcher and three handler modules.
- `addProject` lives once in `src/projects/manage.ts`. Both `src/cli/commands/add-project.ts` and `src/server/handlers/projects.ts` call it, so the CLI and the API register a project the same way.

- `defaultSpawn` lives once in `src/projects/clone.ts`, beside the `SpawnFn` contract and `resolveSpawnEnv`. `src/cli/output.ts`, `src/server/main/utils.ts` and `src/server/handlers/index.ts` re-export it.

The counter-example to avoid: `defaultSpawn` used to exist three times, once per surface. Each copy carried a comment that called the duplication deliberate "so neither surface imports the other". That reason did not hold, because all three already imported `resolveSpawnEnv` from `src/projects/clone.ts`. A comment asserting that a copy is intentional is not evidence that it is. warren-032a removed the copies.

## Version management

The version lives in **four places**, all rewritten by
`bun run version:bump <major|minor|patch|X.Y.Z>`
(`scripts/version-bump.ts`):

- `package.json` — `"version"` field
- `src/index.ts` — `export const VERSION = "X.Y.Z"`
- `docs/openapi.yaml` — `info.version` (the script re-runs `gen:openapi`)
- `README.md` — the semver in the `## Status` paragraph

It also drafts an `[Unreleased]` block into `CHANGELOG.md` from
`git log <last-tag>..HEAD`, fenced by `<!-- version-bump:draft -->`
markers — assistive only, nothing gates on it; curate it and delete the
markers before releasing. All rewrites roll back together on failure.
`.github/workflows/release.yml` fails the release job if `package.json`
and `src/index.ts` disagree, then auto-tags `v$VERSION` and creates a
GitHub release from the matching `CHANGELOG.md` section.

`bun run check:version-sync` (warren-0210, `scripts/check-version-sync.ts`)
asserts on every PR — not just at release — that all four sites agree, and
that the `@os-eco/burrow-cli` pin agrees across `Dockerfile`,
`package.json` and the README. It shares the README locator with
`scripts/version-bump.ts`, so the gate and the bumper can never disagree about
where the version lives. It is chained into `bun run lint` rather than
registered as its own gate, because the canonical `check:all` manifest is
frozen.

## Per-project config (`.warren/config.yaml`)

Canonical home for per-project defaults. Schema:
`src/warren-config/schema.ts` (`DefaultsConfigSchema`), surfaced by
`loadWarrenConfig()`. Notable knobs: `defaultRole`, `defaultPrompt`,
`defaultProvider`, `defaultModel`, `defaultBranch`, `runBranchPrefix`,
`preview`, `agent.skipGitHooks`. See `CLAUDE.md` and
SPEC §11.H / §11.L / §11.O for details.

## Golden snapshots

Stable wire shapes that downstream consumers depend on are pinned with
on-disk JSON fixtures under a sibling directory named `__golden__`.
The first adopter is `src/server/__golden__/responses` (warren-8aa4 /
pl-7b06 step 22), which locks `renderError` + `notFound` /
`methodNotAllowed` / `notImplemented` envelopes; the companion test is
`src/server/responses.golden.test.ts`. Regenerate after an intentional
shape change with `WARREN_UPDATE_GOLDENS=1 bun test
src/server/responses.golden.test.ts`, then `git diff` the fixtures and
commit only the diffs you meant. The directory name mirrors the
upstream burrow convention (the `__golden__` fixture dirs under
burrow's parser tree) and is already excluded from `check:size`, `check:debt`,
`check:dups`, and Biome's filename-convention rule — keep new
golden directories under the same name so those exclusions keep
applying without churn.

## Acceptance harness

`scripts/acceptance/` runs scenario-based end-to-end checks against a
real warren+burrow stack. Scenarios live in
`scripts/acceptance/scenarios/` and use the helpers in
`scripts/acceptance/lib/`. New scenarios must be deterministic,
idempotent, and clean up after themselves.

## Session completion protocol

When ending a work session, complete ALL steps:

1. File issues for remaining work: `sd create --title "..."`
2. Run quality gates (if code changed): `bun run check:all`
3. Close finished issues: `sd close <id>`
4. Record insights worth preserving: `ml learn` then `ml record ...`
5. Push: `sd sync && ml sync && git push`
6. Verify: `git status` shows "up to date with origin"

This repo uses [Seeds](https://github.com/jayminwest/seeds) for issue
tracking and [Mulch](https://github.com/jayminwest/mulch) for expertise
records. Run `sd prime` and `ml prime` at the start of every session;
see `CLAUDE.md` for the full command surface.

## Further reading

- [`CLAUDE.md`](CLAUDE.md) — authoritative long-form version of this file
- [`SPEC.md`](SPEC.md) — V1 design record
- [`README.md`](README.md) — user-facing pitch + deploy instructions
- [`ACCEPTANCE.md`](ACCEPTANCE.md) — operator runbook for V1 release gates
- [`CHANGELOG.md`](CHANGELOG.md) — release history (0.9.10 and earlier:
  [`docs/CHANGELOG-archive.md`](docs/CHANGELOG-archive.md))
