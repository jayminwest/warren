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
bun run lint                  # biome check --error-on-warnings .
bun run typecheck             # tsc --noEmit
bun run build:ui              # cd src/ui && bun install && bun run build
```

UI-only (its own package):

```bash
bun run ui:dev                # vite dev server
bun run ui:install            # cd src/ui && bun install
```

## Quality gates

Run all three before committing — warnings count as failures:

```bash
bun test && bun run lint && bun run typecheck
```

CI also runs `bun run check:file-sizes`, which enforces a per-file
line-count budget (warren-4553). New `.ts`/`.tsx` files under `src/` and
`scripts/` must stay ≤ 500 lines; existing oversized files are
grandfathered in `scripts/file-size-budgets.json` and may not grow past
their frozen ceiling — the ratchet only goes down. Biome's
`noExcessiveLinesPerFunction` rule (also 500-line cap) enforces the same
budget at the function level, with the same baseline exceptions called
out in `biome.json`'s `overrides`.

CI also runs `bun run check:debt-markers` (warren-7f2b), which scans
`src/` and `scripts/` `.ts`/`.tsx` for `TODO` / `FIXME` / `HACK` / `XXX`
and fails if any marker lacks a tracker reference on the same line
(`warren-XXXX`, `pl-XXXX`, `mx-XXXX`, `#NNN`, or a URL). The ratchet
grandfather list lives in `scripts/debt-marker-allowlist.json` and only
goes down — pair new markers with an id (or remove them) rather than
appending to the allowlist.

CI (`.github/workflows/release.yml`) runs the same trinity. Do not merge
with lint warnings; fix at write time or promote to error in `biome.json`.

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
2. Run quality gates (if code changed):
   `bun test && bun run lint && bun run typecheck`
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
