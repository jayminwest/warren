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
ships inline (`src/registry/builtins/`). The bundled os-eco data-plane
features (`canopy`, `mulch`, `seeds`, `sapling`, `plot`, `plan-run`) are
**opt-in** and light up when their config / directories are present —
see `CLAUDE.md` and [`SPEC.md`](SPEC.md) §1 / §11 for the full framing.

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
bun run lint                  # biome check --error-on-warnings .
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
bun run check:all
```

This runs: `check:coverage` (tests + coverage ratchet), `lint`,
`typecheck`, `validate:agents-md`, `check:file-sizes`,
`check:debt-markers`, `check:deps`, `check:bundle-size:build`, and
`gen:docs:check` — the same set CI enforces (see
`.github/workflows/ci.yml`). Do not merge with lint warnings; fix at
write time or promote to error in `biome.json`.

Details on the additional checks:

- **`check:file-sizes`** (warren-4553) — enforces a per-file line-count
  budget. New `.ts`/`.tsx` files under `src/` and `scripts/` must stay
  ≤ 500 lines; existing oversized files are grandfathered in
  `scripts/file-size-budgets.json` and may not grow past their frozen
  ceiling — the ratchet only goes down. Biome's
  `noExcessiveLinesPerFunction` rule (also 500-line cap) enforces the
  same budget at the function level, with the same baseline exceptions
  called out in `biome.json`'s `overrides`.
- **`check:debt-markers`** (warren-7f2b) — scans `src/` and `scripts/`
  `.ts`/`.tsx` for `TODO` / `FIXME` / `HACK` / `XXX` and fails if any
  marker lacks a tracker reference on the same line (`warren-XXXX`,
  `pl-XXXX`, `mx-XXXX`, `#NNN`, or a URL). The ratchet grandfather list
  lives in `scripts/debt-marker-allowlist.json` and only goes down —
  pair new markers with an id (or remove them) rather than appending to
  the allowlist.
- **`validate:agents-md`** — validates that `AGENTS.md` references
  (`bun run <X>` commands and backtick-quoted paths) still exist.

Biome's `noExcessiveCognitiveComplexity` rule (warren-d3a6, cognitive
complexity ≤ 15) enforces a project-wide complexity ceiling. New code
must stay under the threshold; existing offenders are grandfathered in
the second `overrides` block of `biome.json`. The ratchet only goes
down — refactor offenders out of the list rather than adding new
entries.

- **`check:bundle-size`** (warren-5abc) — measures the Vite UI build
  output in `src/ui/dist/assets/` and enforces a ratchet in
  `scripts/bundle-size-budgets.json`. Tracks raw + gzipped totals per
  extension (`.js`, `.css`) and the largest single chunk's gzipped
  size. The ratchet only goes DOWN — code-split or trim deps rather
  than raising a budget. Run `bun run check:bundle-size` against an
  existing `src/ui/dist` tree, or `bun run check:bundle-size:build` to build
  first; CI uses the explicit `build:ui` + `check:bundle-size` pair so
  the build step is visible in logs.

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
  is in sync with the `ROUTE_TABLE` array in `src/server/handlers.ts`.
  The route table is the canonical HTTP API surface; this guard keeps
  the doc from drifting. To refresh after editing routes, run
  `bun run gen:docs` and commit the result. CI runs the `--check` mode
  via `check:all`.

`check:deps` (warren-d109) wraps [knip](https://knip.dev) in
`--dependencies` mode (config in `knip.json`) to flag unused or
undeclared npm dependencies across the root package and the `src/ui`
workspace. The fix for a knip hit is almost always `bun remove <dep>`
(or `cd src/ui && bun remove <dep>`) — only ignore a dep when it's
resolved by string at runtime (e.g. a pino transport target).

CI also runs `bun run check:duplicates` (warren-61e9), which invokes
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
  groupings (e.g. `src/server/handlers.plan-runs.test.ts`) are allowed
  and each dot-segment must itself be kebab-case. Enforced by Biome's
  `useFilenamingConvention` rule (group `style`, kebab-case, strict).
  The `src/ui/` package is excluded from this Biome config and uses
  `PascalCase.tsx` for React components/pages plus kebab-case for
  everything else (hooks, helpers, api modules).
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
- Server types co-locate with their domain (`src/server/types.ts`,
  `src/runs/...`, `src/projects/...`); UI types live in
  `src/ui/src/api/types.ts`
- Import with `.ts` extensions
- Tab indentation, 100-char line width (enforced by Biome)

## Version management

The version lives in **two places**, kept in sync manually and verified
by the release workflow:

- `package.json` — `"version"` field
- `src/index.ts` — `export const VERSION = "X.Y.Z"`

There is no `bun run version:bump` in this repo — edit both files
directly. `.github/workflows/release.yml` fails the release job if they
disagree, then auto-tags `v$VERSION` and creates a GitHub release from
the matching `CHANGELOG.md` section.

## Per-project config (`.warren/config.yaml`)

Canonical home for per-project defaults. Schema:
`src/warren-config/schema.ts` (`DefaultsConfigSchema`), surfaced by
`loadWarrenConfig()`. Notable knobs: `defaultRole`, `defaultPrompt`,
`defaultProvider`, `defaultModel`, `defaultBranch`, `runBranchPrefix`,
`preview`, `agent.pauseTimeoutMs`, `plotSync`. See `CLAUDE.md` and
SPEC §11.H / §11.L / §11.O for details.

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
- [`CHANGELOG.md`](CHANGELOG.md) — release history
