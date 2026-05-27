# Warren

Self-hostable control plane for ephemeral cloud agents. A user points
warren at a GitHub repo, picks an agent, writes a prompt; warren spawns
the agent inside a sandbox, streams events back to the UI, lets the user
steer mid-run, then pushes the workspace branch. One container, one
volume, one HTTP API, one UI.

The fresh-install path is standalone: the built-in `claude-code` agent
ships inline (`src/registry/builtins/`), so a user with a GitHub URL and
an Anthropic key can dispatch a run end-to-end with no other tooling.

Warren also bundles five [os-eco](https://github.com/jayminwest/os-eco)
data-plane tools as **opt-in built-in features**, not required
infrastructure:

- **canopy** — versioned prompt libraries for custom agents. Activated by
  setting `CANOPY_REPO_URL`; library agents override built-ins by name.
- **mulch** — persistent agent memory across runs. Activated by the
  project having a `.mulch/` directory.
- **seeds** — integrated issue queue agents read from and write to.
  Activated by the project having a `.seeds/` directory.
- **sapling** — alternative steerable coding harness. Ships inline as a
  built-in agent alongside claude-code.
- **plot** — shared coordination substrate where humans and agents are
  peer nodes on a per-Plot event log. Activated by the project having a
  `.plot/` directory **and** the dispatch carrying a `plot_id`; warren
  injects `PLOT_ID` + `PLOT_ACTOR` into the sandbox, appends
  `run_dispatched`, and mirrors agent-emitted events at reap. See
  SPEC §11.O.
- **plan-run** — serial sd plan execution; activated by the project
  having a `.seeds/` directory. A dispatch mode on top of the existing
  single-run primitive (not a sixth bundled feature): `POST /plan-runs`
  walks a seeds plan's children one at a time, gating each on the
  previous PR merging before the next dispatches. Re-dispatching the
  same plan resumes from the next open child. When the project also
  ships `.plot/` and the dispatch carries `plot_id`, plan-runs compose
  onto Plot: one `plan_run_dispatched` event at start, per-child
  `PLOT_ID` injection + `run_dispatched` for free, and an auto-`done`
  Plot transition when the final child merges. See SPEC §11.P and
  §11.P.Plot.

Same code, same depth — only the user-facing framing surfaces them as
opt-in. When you change cross-cutting docs (README, SPEC §1/§2, package
description), keep the standalone path primary and the integrations as
features that light up when used.

The runtime substrate is [burrow](https://github.com/jayminwest/burrow);
warren and burrow are co-tenanted inside the container and share a unix
socket — see "Relationship to burrow" below.

[SPEC.md](SPEC.md) is the V1 design record. The manual-run path
(`warren run <agent> <project> -p "..."`) and the cron half of the
scheduler (`.warren/triggers.yaml` + past-due `scheduledFor` seed
extensions, SPEC §11.I) are what V1 ships; GitHub webhook triggers
and library API exports are deferred to V2.

### Per-project config (`.warren/config.yaml`)

The canonical home for per-project defaults is `.warren/config.yaml`
(legacy `.warren/defaults.json` still loads with a deprecation warning).
Schema lives in `src/warren-config/schema.ts` (`DefaultsConfigSchema`)
and is surfaced by `loadWarrenConfig()`. Notable knobs:

- `defaultRole`, `defaultPrompt`, `defaultProvider`, `defaultModel`,
  `defaultBranch`, `runBranchPrefix` — dispatch-time defaults; see
  SPEC §11.H.
- `preview` — per-run preview environments; canonical home is
  `.warren/preview.yaml`, see SPEC §11.L.
- `agent.pauseTimeoutMs` (default `1800000` = 30 min, bounds 1s..24h)
  — wall-clock budget for paused interactive turns and batch runs that
  emit `question_posed`. Consumers fall back to
  `DEFAULT_AGENT_PAUSE_TIMEOUT_MS` when the block is absent. SPEC §11.O
  (warren-cd37 / pl-0344 step 2).
- `plotSync` — per-project Plot sync to GitHub configuration.
  `mergeStrategy` (`immediate` | `auto` | `manual`, default `manual`)
  controls whether sync PRs are auto-merged; `targetBranch` overrides
  the project's `defaultBranch` for the PR base. `POST /plots/:id/sync`
  triggers manually; formalize and status-change fire background syncs.

## Relationship to burrow

Warren and burrow are tightly coupled — burrow is the sandbox runtime,
warren is the orchestrator that spawns and talks to it. **Read
`../burrow/SPEC.md` before changing anything that crosses the warren↔burrow
boundary** (the supervisor's `burrow serve` invocation, the `burrow-client/`
HTTP facade, the bwrap-friendly security flags in `docker-compose.yml`).

- The **supervisor** (`src/supervisor/main.ts`) spawns `burrow serve` as a
  sibling process and forwards SIGTERM/SIGINT. They share a unix socket
  (default `/var/run/burrow.sock`) and a bearer token (`BURROW_API_TOKEN` ==
  `WARREN_BURROW_TOKEN`).
- `src/burrow-client/` is a typed facade over `@os-eco/burrow`'s
  `HttpClient`. Don't talk to the socket directly — use the facade so the
  HTTP surface stays mirrored.
- `@os-eco/burrow-cli` is pinned in **two places**: the `Dockerfile` global
  install AND `package.json` + `bun.lock`. Bumping only one is a no-op —
  `Bun.spawn` resolves `./node_modules/.bin/burrow` before PATH, so the
  supervisor runs the local copy. Update both, regenerate the lockfile,
  re-test.
- Burrow needs three apparmor/seccomp/systempaths-unconfined flags + `cap_add:
  SYS_ADMIN` on Linux to do user-namespace nesting (see SPEC §5.3 and burrow
  `DEPLOY.md`). These are baked into `docker-compose.yml`; don't strip them.

## Tech Stack

- **Runtime:** Bun (runs TypeScript directly, no build step on the server)
- **Language:** TypeScript with strict mode (`noUncheckedIndexedAccess`, no `any`)
- **Linting:** Biome (formatter + linter; `--error-on-warnings`, so warnings fail CI)
- **Storage:** SQLite via `bun:sqlite` for runs / events / agents / projects
- **HTTP:** `Bun.serve` — same process serves the JSON API and the SPA
- **UI:** React + Vite + Tailwind + shadcn-style components, lives in
  `src/ui/` as a separate `@os-eco/warren-ui` package; built into
  `src/ui/dist/` and served from there
- **Sandbox primitive:** none directly — burrow owns isolation; warren talks
  to it over HTTP over a unix socket

## Build & Test Commands

From the repo root (server + supervisor + CLI):

```bash
bun test                      # Run all tests
bun test src/foo.test.ts      # Run a single test file
bun run lint                  # biome check --error-on-warnings .
bun run typecheck             # tsc --noEmit
bun run build:ui              # cd src/ui && bun install && bun run build
```

The UI is its own package with its own scripts:

```bash
bun run ui:dev                # vite dev server
bun run ui:install            # cd src/ui && bun install
```

## Quality Gates

Run all checks before committing — warnings count as failures:

```bash
bun run check:all
```

This runs: `check:coverage` (tests + coverage ratchet), `lint`,
`typecheck`, `validate:agents-md`, `check:file-sizes`,
`check:debt-markers`, `check:deps`, `check:bundle-size:build`, and
`gen:docs:check` — the same set CI enforces (see
`.github/workflows/ci.yml`). CI also runs `check:duplicates` (jscpd)
on top. Don't merge with lint warnings; fix at write time or promote
to error in `biome.json`.

`check:coverage` (warren-e4b1) wraps `bun test --coverage` and enforces
the floors in `scripts/coverage-budgets.json` against the "All files"
row of Bun's text coverage reporter. CI runs `check:coverage:ci`, which
additionally emits `test-results/junit.xml` for the timing summary and
uploads `coverage/lcov.info` as a build artifact. The ratchet only
goes UP — raise the floors when coverage improves; lowering them
implies you removed tests and needs a tracker reference in the diff.

`check:deps` (warren-d109) wraps [knip](https://knip.dev) in
`--dependencies` mode to flag unused / undeclared npm dependencies
across the root package and the `src/ui` workspace. Config lives in
`knip.json`. When knip reports an unused dep, the fix is almost
always `bun remove <dep>` (or `cd src/ui && bun remove <dep>`) — don't
add it to an ignore list unless it's a runtime-only / transport peer
(e.g. pino transports loaded by string name).

## TypeScript Conventions

- Strict mode with `noUncheckedIndexedAccess` — always handle possible `undefined` from indexing
- No `any` — use `unknown` and narrow, or define proper types
- Server types co-locate with their domain (`src/server/types.ts`,
  `src/runs/...`, `src/projects/...`); UI types live under `src/ui/src/api/types.ts`
- Import with `.ts` extensions
- Tab indentation, 100-char line width (enforced by Biome)

## Version Management

Version lives in two places — kept in sync manually and verified by the
release workflow:

- `package.json` — `"version"` field
- `src/index.ts` — `export const VERSION = "X.Y.Z"`

There is **no** `bun run version:bump` script in this repo (unlike burrow);
edit both files directly. `.github/workflows/release.yml` fails the release
job if they disagree, then auto-tags `v$VERSION` and creates a GitHub release
from the matching `CHANGELOG.md` section.

## Acceptance Harness

`scripts/acceptance/` runs scenario-based end-to-end checks against a real
warren+burrow stack. Each scenario lives in `scripts/acceptance/scenarios/`
and uses the helpers in `scripts/acceptance/lib/`. New scenarios should be
deterministic, idempotent, and clean up after themselves — they are
expected to run against a live (possibly long-lived) deployment.

## Session Completion Protocol

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
Use `sd plan` when work is large or ambiguous enough that an LLM benefits from structured decomposition. Submit spawns one child seed per step; `step.blocks` uses forward semantics (step i with `blocks: [j]` means step i blocks step j, and step j gets step i's id in its `blockedBy`).

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
instead of replacing them; validation failures print a copy-paste retry hint with missing fields
pre-filled.

Run `ml status` for domain health, `ml doctor` to check record integrity (add `--fix` to strip
broken file anchors), `ml --help` for the full command list. Write commands use file locking and
atomic writes, so multiple agents can record concurrently. Expertise survives `git worktree`
cleanup — `.mulch/` resolves to the main repo.

`ml prune` soft-archives stale records to `.mulch/archive/` instead of deleting them; pass
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
