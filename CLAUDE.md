# Warren

Self-hostable control plane for ephemeral cloud agents. A user points
warren at a GitHub repo, picks an agent, writes a prompt; warren spawns
the agent inside a sandbox, streams events back to the UI, lets the user
steer mid-run, then pushes the workspace branch. One container, one
volume, one HTTP API, one UI.

The fresh-install path is standalone: the built-in `claude-code` agent
ships inline (`src/registry/builtins/`), so a user with a GitHub URL and
an Anthropic key can dispatch a run end-to-end with no other tooling.

Around that kernel warren integrates three [os-eco](https://github.com/jayminwest/os-eco)
data-plane tools as **opt-in features**, not required infrastructure:

- **mulch** — persistent agent memory across runs. Activated by the
  project having a `.mulch/` directory.
- **seeds** — integrated issue queue agents read from and write to.
  Activated by the project having a `.seeds/` directory.
- **sapling** — alternative steerable coding harness. Ships inline as a
  built-in agent alongside claude-code.

The agent registry is entirely inline: `BUILTIN_AGENTS`
(`src/registry/builtins/`) ships `claude-code`, `sapling`, `pi`,
`planner`, `nightwatch`, `bugwatch`, `pr-fixer`, and `healer`, seeded
into the agents table on every boot. There is no external agent library
to point at — the registry is the built-ins plus the per-run agent
definition warren renders into the workspace. `GET /agents` still
reports `source: "builtin" | "library"` provenance; the `library` arm
survives only for legacy rows.

**plan-run** is a dispatch *mode* on top of the single-run primitive,
not a bundled feature: activated by the project having a `.seeds/`
directory, `POST /plan-runs` walks a seeds plan's children one at a
time, gating each on the previous PR merging before the next
dispatches. Re-dispatching the same plan resumes from the next open
child. See SPEC §11.P.

Two former data-plane features — **plot** (a shared coordination
substrate) and **canopy** (an external agent-definition library) — have
been **retired and deleted** in plan pl-3a79: their code, DB surface,
UI, config, CLI paths, and env knobs (`PLOT_ID`, `CANOPY_REPO_URL`,
`POST /agents/refresh`, `warren register-agent`) are gone. SPEC §11.O
and §4.2/§8.1 carry RETIRED banners; see ROADMAP.md for the
sequencing (docs/PHILOSOPHY.md holds policy only).

Same code, same depth — only the user-facing framing surfaces the
integrations as opt-in. When you change cross-cutting docs (README,
SPEC §1/§2, package description), keep the standalone path primary and
the integrations as features that light up when used.

Warren runs against a swappable **runtime provider**, resolved once at
boot from `WARREN_RUNTIME` (`src/runtime/registry.ts`) behind the
`RuntimeProvider` contract (`src/runtime/contract.ts`). Two backends:
`LocalProvider` (`src/runtime/local/`, the default) wraps the
co-tenanted [burrow](https://github.com/jayminwest/burrow) sandbox
daemon; `K8sProvider` (`src/runtime/k8s/`, `WARREN_RUNTIME=k8s`) runs
each agent as a Kubernetes pod with no burrow at all. Burrow is the
LocalProvider's substrate, **not a required warren dependency** — see
"Relationship to burrow" below and [docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md)
for the K8s topology.

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
  `DEFAULT_AGENT_PAUSE_TIMEOUT_MS` when the block is absent. Defined on
  `DefaultsConfigSchema.agent` (`src/warren-config/schema.ts`); see the
  `.warren/config.yaml` convention in SPEC §11.H (warren-cd37 / pl-0344
  step 2).
- `agent.skipGitHooks` (default `false`) — set to `true` to skip arming
  the project's git pre-commit gate on the host clone before each run.
  By default warren detects a `git config core.hooksPath` call in the
  project's `package.json` prepare script and applies it to the clone's
  `.git/config` so every worktree (agent sandbox) inherits the hook.
  Flip this when a project's hooks are too slow, require tools not
  available on the warren host, or you explicitly want agent commits
  unfiltered (warren-8f4c).
- `admission.maxConcurrentRuns` — per-project cap on simultaneous
  non-terminal runs, enforced by the K8s runtime's admission gate
  (`WARREN_RUNTIME=k8s`); exceeding it rejects the dispatch with HTTP 429
  (`Retry-After`) and reason `project_concurrency_exceeded`. Absent → the
  global default `WARREN_K8S_MAX_PROJECT_CONCURRENCY`, else unlimited. Two
  cluster-wide env knobs pair with it: `WARREN_K8S_MAX_QUEUE_DEPTH`
  (total non-terminal pods, default 50) and `WARREN_K8S_MAX_PENDING_PODS`
  (Pending pods, default 20); `0` disables a cap. Ignored by LocalProvider.
  SPEC §3.3 (warren-b6f2, supersedes warren-b01e + warren-ea4f).

## Relationship to burrow

Burrow is the **`LocalProvider`'s sandbox substrate** — the runtime warren
uses under `WARREN_RUNTIME=local` (the default). It is no longer a
universal dependency: under `WARREN_RUNTIME=k8s` there is **no burrow** at
all (no `burrow serve`, no unix socket, no bwrap; the pod boundary is the
sandbox, and `/readyz` drops the burrow/bwrap/stale-workspace probes —
`src/server/handlers/diagnostics.ts`, warren-c128). Everything in this
section is the `local` topology; for the K8s topology see
[docs/RUNBOOK-K8S.md](docs/RUNBOOK-K8S.md) and the design docs under
`docs/design/` (`runtime-provider-contract.md`, `k8s-migration.md`).

Under `local`, warren and burrow are tightly coupled — burrow is the
sandbox runtime, warren is the orchestrator that spawns and talks to it via
`LocalProvider`. **Read `../burrow/SPEC.md` before changing anything that
crosses the warren↔burrow boundary** (the supervisor's `burrow serve`
invocation, the `burrow-client/` HTTP facade, the bwrap-friendly security
flags in `docker-compose.yml`).

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
- **Sandbox primitive:** none directly — a `RuntimeProvider`
  (`src/runtime/`) owns isolation. `LocalProvider` (default) delegates to
  burrow over HTTP over a unix socket; `K8sProvider` (`WARREN_RUNTIME=k8s`)
  runs each agent as a Kubernetes pod (the pod boundary is the sandbox)

## Build & Test Commands

From the repo root (server + supervisor + CLI):

```bash
bun test                      # Run all tests
bun test src/foo.test.ts      # Run a single test file
bun run lint                  # biome + layers + version-sync + wire-types + prose guards
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
bun run check:all     # or its agent-facing alias: bun run verify
```

`check:all` is `bun scripts/check-all.ts` — the os-eco fleet's canonical
quiet runner (see `docs/check-all-standard.md` at the os-eco root). The
script is **byte-identical** to
`templates/l5-toolkit/scripts/check-all.ts`; never edit it in place —
all per-repo variation comes from `package.json`, which the runner
filters against the frozen canonical gate order. (Both frozen scripts
are exempted from Biome's formatter via a `biome.json` override so the
local formatter can't break byte-identity; the linter still covers
them.) Warren's resolved
manifest (exported as `GATES`) is: `lint`, `typecheck`, `check:agents`,
`check:dups` (jscpd), `check:deps`, `check:size`, `check:debt`,
`check:bundle-size`, `gen:docs:check`, `gen:openapi:check`
(warren-b46b: keeps the `docs/openapi.yaml` OpenAPI 3.1 schema in sync
with `ROUTE_TABLE`), `check:coverage` (tests + coverage ratchet), and
`check:ci-parity` — the same set CI enforces (see
`.github/workflows/ci.yml`). Don't merge with lint warnings; fix at
write time or promote to error in `biome.json`.

Output contract ("quiet"): one aligned `<✓|✗> <gate> (N.Ns)` line per
gate, then a one-line tally on success (`12/12 gates passed (…s)`). On
failure it prints the failing gate names plus parsed failure signatures
(bun-test `(fail)` lines, tsc/biome errors, budget violations) — never
the full log — and a `re-run: bun run <gate>` hint. Set
`CHECK_ALL_VERBOSE=1` to stream full output; pass `--bail` to stop at
the first failing gate.

`verify` is the standard agent-facing entry point and is always exactly
`bun run check:all` — neither name may diverge from the other.

Four repo-specific guards ride inside the `lint` gate rather than taking
a manifest slot of their own, because the canonical `check:all` gate
vocabulary is frozen: `scripts/check-layers.ts`,
`scripts/check-version-sync.ts`, `scripts/check-wire-types.ts` and
`scripts/check-prose.ts`. Each is also runnable on its own
(`bun run check:layers`, `bun run check:version-sync`,
`bun run check:wire-types`, `bun run check:prose`). `check:wire-types`
(warren-d371) derives its enforced name list from `src/core/wire.ts` at
run time and fails any file under `src/` that REDECLARES one of those
names — see "Single source of truth" below.

`check:ci-parity` (`bun scripts/check-ci-parity.ts`, also byte-identical
to the template copy) imports `GATES` from `check-all.ts`, parses every
`.github/workflows/ci*.yml` (today `ci.yml` + `ci-postgres.yml`), and
asserts parity in **both** directions (warren-da69): CI → local, no CI
`bun run <X>` step may be unreachable from the manifest; local → CI,
every manifest gate must be transitively invoked by some CI step, so a
gate can never silently vanish from `ci.yml`. Per-repo escape hatches
live in `scripts/ci-parity-config.json` — `aliases` (e.g.
`check:coverage:ci` → `check:coverage`) for same-gate-different-reporter
variants, `ciOnly` (`ui:install`, `build:ui`, `report:test-timing`,
`report:quality-metrics`) for intentionally CI-only steps, and its
inverse `localOnly` for manifest gates deliberately kept out of CI
(warren's is empty — CI runs all 12). Justify every entry in the
config's `$comment`; never edit the script itself.

`check:coverage` (warren-e4b1) wraps `bun test --coverage` and enforces
the floors in `scripts/coverage-budgets.json` against the "All files"
row of Bun's text coverage reporter. CI runs `check:coverage:ci`, which
additionally emits `test-results/junit.xml` for the timing summary and
uploads `coverage/lcov.info` as a build artifact. The ratchet only
goes UP — raise the floors when coverage improves; lowering them
implies you removed tests and needs a tracker reference in the diff.

`report:quality-metrics` (warren-5b95) is a passive CI reporter — it
parses `coverage/lcov.info`, `biome.json` overrides, and the various
budget JSON files, then appends a consolidated code-quality panel to
`$GITHUB_STEP_SUMMARY` (coverage % vs floors, complexity grandfather
counts, file-size + debt-marker ratchet status, bundle-size headroom).
It enforces nothing — the underlying ratchet scripts already fail the
build — so it runs with `if: always()` after the test job in
`.github/workflows/ci.yml` and is safe to run locally too.

`check:deps` (warren-d109) wraps [knip](https://knip.dev) in
`--dependencies` mode to flag unused / undeclared npm dependencies
across the root package and the `src/ui` workspace. Config lives in
`knip.json`. When knip reports an unused dep, the fix is almost
always `bun remove <dep>` (or `cd src/ui && bun remove <dep>`) — don't
add it to an ignore list unless it's a runtime-only / transport peer
(e.g. pino transports loaded by string name). The `@fontsource-variable/*`
packages are the one such peer in `src/ui`: they are reached only through
`url()` in `src/ui/src/index.css`, which knip does not parse, so they sit
in the `src/ui` workspace's `ignoreDependencies`.

**`src/ui` is inside the gates** (warren-c8bd). It used to be excluded
from Biome, `check:size`, `check:debt` and knip's file graph, which is
why three wire-type drifts in `src/ui/src/api/types.ts` went unseen for
months. Only `src/ui/dist/` (build output) is skipped now. Two bounded
grandfather lists carry the pre-existing debt, and both are ratchets that
only shrink:

- `biome.json` `overrides[0]` — 15 `src/ui` files exempt from
  `noExcessiveCognitiveComplexity`.
- `biome.json` `overrides[1]` — 32 legacy PascalCase and camelCase UI
  filenames exempt from `useFilenamingConvention`. New UI files are
  kebab-case like the rest of the repo.

`biome.json` is parsed with strict `JSON.parse` by
`scripts/report-quality-metrics.ts`, so it cannot carry comments or a
`$comment` key — the rationale for those two lists lives here and in
`AGENTS.md`, not in the config. Three oversized UI files
(`api/client.ts`, `api/types.ts`, `pages/RunDetail.tsx`) are grandfathered
in `scripts/file-size-budgets.json` at their measured line counts.

`check:bundle-size` (warren-5abc) guards `src/ui/dist/` against the
ratchet in `scripts/bundle-size-budgets.json`. **Two parity gotchas
that have already bitten us (warren-bfc6): (1) never set a budget from
Vite's build-log gzip number — Vite's reporter runs ~2KB COOLER than
this guard's Node-zlib gzip, so a budget eyeballed from Vite will fail
CI. (2) A stale `src/ui/node_modules` produces a different bundle than
CI's fresh install.** The build is byte-reproducible across machines —
`build:ui` installs with `--frozen-lockfile`, so a clean local build
measures the exact same bytes as CI. If your numbers disagree with CI,
`rm -rf src/ui/node_modules` and rebuild; don't pad the budget. Never
hand-edit the numbers — to re-baseline, run `bun run
check:bundle-size --update` (the script body carries `--build`, so it
always builds first), which writes budgets straight from
the measured build plus a small churn headroom, using the SAME Node-zlib
gzip the guard enforces (so a budget it writes always passes — this is
what closes the Vite parity gap; stop copying Vite's cooler number).
Lowering always applies. Raising is bounded: ordinary feature growth
within `AUTO_RAISE_CAP` (in `check-bundle-size.ts`) re-baselines
hands-free, but a heavy new dep that blows past the cap is refused unless
`WARREN_BUNDLE_SIZE_ALLOW_RAISE=1` is set (a knowing new floor — document
why in a `$comment`). If an agent forgets to re-baseline at all, the
`bundle-size-autoheal` workflow re-runs the bounded `--update` on the PR
branch and pushes the measured budgets back so the run isn't halted by a
few-hundred-byte overshoot; only non-bundle failures (or growth past the
cap) reach a human.

## TypeScript Conventions

- Strict mode with `noUncheckedIndexedAccess` — always handle possible `undefined` from indexing
- No `any` — use `unknown` and narrow, or define proper types
- **Wire vocabulary is defined once and re-exported outward.** Every
  enum-shaped value that crosses the HTTP wire lives in `src/core/wire.ts`;
  the SDK, the drizzle columns and the UI re-export it and never
  redeclare it. See "Single source of truth" below — this is mechanically
  enforced, so a second copy fails `bun run lint`.
- Domain-internal types still co-locate with their domain
  (`src/server/types.ts`, `src/runs/...`, `src/projects/...`). UI-only
  view types — component props, form state, chart shapes — stay in
  `src/ui/`.
- Import with `.ts` extensions
- Tab indentation, 100-char line width (enforced by Biome)

## Single source of truth

Each capability in warren has exactly ONE implementation. The domain modules
(`src/runs/`, `src/projects/`, `src/plan-runs/`, …) own the
logic. The HTTP handlers in `src/server/handlers/` are a thin surface
over those modules. The CLI (`src/cli/`), the SDK (`src/client/`) and the
UI (`src/ui/`) are consumers: they call the domain function, or they call
the HTTP route that calls it. None of them re-implements it, and none of
them keeps a hand-maintained copy of a type the other side already owns.

**Why this section exists.** The old guidance here told agents that "UI
types live under `src/ui/src/api/types.ts`", which sanctioned exactly the
duplication that then drifted: `RunFailureReason` lost `finalize_failed`
and `evicted` in BOTH the SDK copy and the UI copy, the UI still typed
the long-deleted `interactive` run mode, and `RefreshAgentsResponse.removed`
was `{name}[]` in the UI against a server truth of `string[]`
(warren-b229). A convention that permits a second copy produces a second
copy.

### The wire vocabulary

`src/core/wire.ts` is the canonical home for the enum-shaped wire values:
run / plan-run / preview lifecycle states, the failure-cause
discriminator, run mode, clone kind, event stream, agent source, and the
steering-inbox classes. The direction is **define there, re-export
outward**:

- `src/db/schema/columns.ts` does `export * from "../../core/wire.ts"`
- `src/client/types.ts` and `src/client/types.plan-runs.ts` re-export from it
- `src/ui/src/api/types.ts` re-exports from it

`src/core/` is warren's dependency-free kernel — it imports nothing.
That is what lets the Vite-bundled UI reach the same module without
dragging drizzle and `bun:sqlite` into a browser bundle, and it is why
the definition cannot live in `src/db/schema/columns.ts` where it started.

`bun run check:wire-types` (`scripts/check-wire-types.ts`, warren-d371)
holds the line. It derives the enforced name list from `src/core/wire.ts`
at run time — a hard-coded second list would itself be the drift class the
guard exists to prevent. Re-export forms pass (`export * from`,
`export { X } from`, `export type { X } from`, `import { X } from`); a
redeclaration fails with `file:line — declares "NAME"`. A genuinely
deliberate local declaration goes in the script's `ALLOW` list with a
comment saying why.

Two sharp edges worth knowing before you add to the kernel:

- **Cross-package modules need a tsconfig `include` entry.** `src/ui` is
  a separate composite TypeScript project, so any module it imports from
  outside its own `src/` must be named in `include` in
  `src/ui/tsconfig.app.json` (today: `["src", "../core/wire.ts"]`).
  Without it the UI build fails TS6307 — and only `bun run build:ui`
  catches that, because the root `tsc --noEmit` excludes `src/ui`.
- **The guard's `DOMAIN_STEMS` filter is deliberately narrow.** A
  canonical export whose name carries none of `run`, `inbox`, `clone`,
  `preview`, `event`, `agent` is NOT enforced — that keeps a
  generically-named kernel helper (`Status`, `Limits`) from failing an
  unrelated file. The cost is that a new wire name outside those stems is
  silently unguarded; widen `DOMAIN_STEMS` when you add one.

### The layering rule

The same principle applies below the type layer. The guards that enforce
it today both ride inside `bun run lint`:

- **`check:wire-types`** — no second declaration of a canonical wire name.
- **`check:layers`** (`scripts/check-layers.ts`, warren-89a6) — no import
  that points the wrong way across a declared seam.

`check:layers` reads its rules from `scripts/layer-rules.json`, so a new
seam is a data edit and is born enforced. Seven seams ship today:

- The two burrow boundaries it absorbed from the retired
  `check-burrow-boundary.ts` (warren-f796) — no direct
  `src/burrow-client/` or `@os-eco/burrow-cli` import outside the
  local-topology allowlist.
- **Domain owns the logic.** `src/runs/`, `src/projects/`,
  `src/plan-runs/`, `src/registry/`, `src/db/`, `src/runtime/`,
  `src/preview/`, `src/triggers/` and `src/observability/` may not import
  `src/server/**` or `src/cli/**`.
- **The CLI is a consumer.** `src/cli/**` may not import `src/server/**`.
  `src/cli/commands/serve.ts` is the one allowed exception: booting the
  server is that command's whole job.
- **Handlers are a thin surface.** `src/server/handlers/**` may not import
  `src/db/schema/**`, and may not build a repo or a drizzle adapter out of
  `deps.db`. Consume the boot-wired seams — `deps.repos`,
  `deps.dbAdapter`, `deps.runPreviews` — and add a new one in
  `src/server/db-seams.ts`.
- **The kernel imports nothing.** `src/core/` may import only itself.

A rule fires with `file:line` plus the rule's `why` string. A deliberate
exception goes in that rule's `allow` list in the manifest with a `why`
saying what makes it legitimate — JSON has no comments, so the reason is
a field.

Two things the guard cannot see, by design: matching is per line and
lexical, so a dynamic `await import("…")` and a laundered re-export (the
forbidden module reached through a permitted one that re-exports it) both
slip through. It is built to stop the accidental regression, not an
adversary.

**Patterns to copy.** `spawnRun` is defined once in
`src/runs/spawn/dispatch.ts` and imported by five call sites — the
scheduler, the plan-run dispatcher, and three handler modules — instead of
each surface growing its own dispatch path. `addProject` is defined once
in `src/projects/manage.ts` and called by both
`src/cli/commands/add-project.ts` and `src/server/handlers/projects.ts`,
so the CLI and the API register a project identically.

**The counter-example to avoid.** `defaultSpawn` used to exist three
times — `src/cli/output.ts`, `src/server/main/utils.ts` and
`src/server/handlers/index.ts` — and every copy carried a comment calling
the duplication deliberate "so neither surface imports the other". The
reason did not hold: all three copies already imported `resolveSpawnEnv`
from `src/projects/clone.ts`, so the coupling they claimed to avoid was
already there. A comment asserting that a copy is intentional is not
evidence that it is. warren-032a moved the body next to `resolveSpawnEnv`
in `src/projects/clone.ts`; the three surfaces now re-export the one
definition.

## Version Management

The version lives in four places, all of them rewritten by
`bun run version:bump <major|minor|patch|X.Y.Z>`
(`scripts/version-bump.ts`, warren-16b5):

- `package.json` — `"version"` field
- `src/index.ts` — `export const VERSION = "X.Y.Z"`
- `docs/openapi.yaml` — `info.version`, refreshed by the script re-running
  `bun run gen:openapi` after the package.json rewrite
- `README.md` — the semver in the `## Status` paragraph

The script also drafts an `[Unreleased]` block into `CHANGELOG.md` from
`git log <last-tag>..HEAD`, fenced by `<!-- version-bump:draft -->`
markers. That draft is **assistive only** — CHANGELOG curation stays
human and nothing in CI gates on it; edit it down and delete the markers
before releasing. Every rewrite is computed before any file is written,
and a failure (including a failed `gen:openapi`) rolls all of them back.

`.github/workflows/release.yml` fails the release job if `package.json`
and `src/index.ts` disagree, then auto-tags `v$VERSION` and creates a
GitHub release from the matching `CHANGELOG.md` section.

That release-time check only ever compared two of the four sites, on the
release branch, so the README drifted two releases and the openapi
version drifted invisibly. `bun run check:version-sync`
(`scripts/check-version-sync.ts`, warren-0210) closes that: it asserts on
every PR that all four version sites agree, and — same drift class — that
the `@os-eco/burrow-cli` pin agrees across the `Dockerfile` global
install, the `package.json` dependency range, and every burrow-cli
mention in the README. The README locator is imported from
`version-bump.ts` so the gate and the bumper can never disagree about
where the version lives. Because the canonical `check:all` gate
vocabulary is frozen, it is chained into `bun run lint` (alongside
`scripts/check-layers.ts`, `scripts/check-wire-types.ts` and
`scripts/check-prose.ts`) instead of getting its own manifest slot.

## Git identities (Article VII)

Per [`docs/CONSTITUTION.md`](docs/CONSTITUTION.md) Article VII ("Identity
is consistent"), warren-authored commits use **one** canonical bot
identity — one agent, one spelling. There are two distinct identities,
and they must not be conflated:

- **Warren's own bookkeeping bot** — the reap-time `chore(warren): …`
  commits (seeds state) are authored as
  `warren <warren@os-eco.dev>`. This spelling is the single source of
  truth in `src/bot-identity.ts` (`WARREN_BOT_IDENTITY` /
  `warrenCommitIdentityArgs()`). Never re-spell `user.name` /
  `user.email` inline at a new commit site — import the constant so the
  history can never drift again (warren-598f closed a ~9-spelling drift:
  `@warren.local`, `@os-eco.local`, `@local`, `@example.com`, …).
- **The agent's own author identity** — operator-configured via
  `WARREN_GIT_AUTHOR_NAME` / `WARREN_GIT_AUTHOR_EMAIL` and installed by
  `src/supervisor/git-identity.ts`. This governs the *agent's* commits,
  not warren's bookkeeping bot. Operators should use a github.com
  `<id>+warren@users.noreply.github.com` noreply address so the
  contribution graph reflects agent-driven work.

## Acceptance Harness

`scripts/acceptance/` runs scenario-based end-to-end checks against a real
warren+burrow stack. Each scenario lives in `scripts/acceptance/scenarios/`
and uses the helpers in `scripts/acceptance/lib/`. New scenarios should be
deterministic, idempotent, and clean up after themselves — they are
expected to run against a live (possibly long-lived) deployment.

Scenario 39 (`39-public-exposure.ts`, warren-c405) is the public-instance
leak guard and the only scenario wired into CI
(`.github/workflows/acceptance-public.yml`, `bun run acceptance:public`).
It boots its own `WARREN_AUTH=public` warren over a database seeded
through warren's repos before boot, so it needs no burrow dispatch — the
rest of the suite still runs locally only.

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
