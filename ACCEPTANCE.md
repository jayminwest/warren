# Warren Acceptance Runbook

This is the operator's checklist for verifying a warren cut against the
V1 goals (below) + §11.A reap roundtrip + restart-recovery contract before
pushing a release.

The contract is split across **automated** (the harness in
`scripts/acceptance/`) and **manual** gates (real claude-code run, GKE
deploy, UI smoke). Run the automated suite on every change; run the
manual gates before a tag.

## TL;DR

```bash
# Quality gates — same trinity CI runs.
bun test && bun run lint && bun run typecheck

# Automated acceptance harness (in-proc, default).
bun run acceptance

# Container-mode boot smoke (requires Docker, slow first run).
bun run acceptance:container
```

A green run prints something like:

```
Acceptance results:
  ✓ 01     312ms  boot + /healthz auth-exempt + /readyz transitions to 200 after refresh
  ✓ 03     842ms  projects management — add / list / refresh / delete
  ...
  12 passed, 0 failed, 0 skipped
```

In container mode, scenarios that need host-side fixtures skip cleanly:

```
  ✓ 01     180ms  boot + /healthz auth-exempt + /readyz transitions to 200 after refresh
  ○ 19       0ms  warren on postgres
        ↳ not supported in container mode
  ...
  ✓ 13   42130ms  container boot — image builds, supervisor + bwrap flags hold, healthz/readyz/agents respond
  2 passed, 0 failed, 11 skipped
```

## Quality gates (CI parity)

CI (`.github/workflows/release.yml`) runs the same three commands; if
any fails locally, your push will fail there too.

```bash
bun test                     # 489+ tests across 50 files
bun run lint                 # biome check --error-on-warnings .
bun run typecheck            # tsc --noEmit
```

Biome enforces `scripts/acceptance/` (per d7a788e). Warnings count as
failures (`--error-on-warnings`); fix at write time, don't suppress.
Release wiring (`.github/workflows/release.yml`) auto-tags `v$VERSION`
and cuts a GitHub release on every push to `main` where
`package.json` + `src/index.ts` agree on a new version. **The harness
must be green before bumping VERSION** or a broken release ships
unattended.

## Automated harness — in-proc mode

Default mode. Boots `bun run src/server/main.ts` + `burrow serve` as
sibling processes on a temp dir, builds local git fixtures via the
`GIT_CONFIG_GLOBAL` insteadOf rewrite (no network), and exercises every
HTTP route end-to-end. No Docker, no API keys, ~30s wall-clock.

```bash
bun run acceptance                          # all scenarios
bun run scripts/acceptance/run.ts --only 04,05  # one or more by id
bun run scripts/acceptance/run.ts --stop-on-failure
bun run scripts/acceptance/run.ts --keep-tmp     # leave fixtures for inspection
```

Logging knobs:

| env                                | effect                                        |
|------------------------------------|-----------------------------------------------|
| `WARREN_ACCEPTANCE_LOG_LEVEL=debug`| verbose harness logs                          |
| `WARREN_ACCEPTANCE_WARREN_STDOUT=1`| passthrough warren server stdout              |
| `WARREN_ACCEPTANCE_WARREN_STDERR=1`| passthrough warren server stderr              |
| `WARREN_ACCEPTANCE_BURROW_STDOUT=1`| passthrough burrow stdout                     |
| `WARREN_ACCEPTANCE_BURROW_STDERR=1`| passthrough burrow stderr                     |

In-proc mode covers scenarios 01–12 (the V1-goals application contract
in the next section).

## V1 goals under verification

These are the V1 goals the acceptance
criteria and scenarios 01–13 verify:

- Single-image deploy: `docker compose up` on a home server, `kubectl apply -k` on a cluster (GKE Autopilot), same Dockerfile.
- Web UI for: agent registry, project list, run dispatch, live event tail, basic settings.
- HTTP API mirroring the UI's surface so external scripts can drive warren.
- Custom-agent-as-canopy-prompt: an agent is a single canopy prompt with required sections. Warren auto-discovers agents from a connected canopy repo.
- Runs against project repos cloned into warren's data dir from GitHub URLs.
- Self-* loop: agents read seeds queue, write seeds for follow-ups, record mulch on success/failure, prime mulch on next spawn.
- Durable event log: warren persists every event burrow streams in its SQLite database. Reload-after-crash and post-hoc inspection both work.

Deferred to V2 (context, not built in V1):

- GitHub webhook receiver and signature verification: the event-driven half of the scheduler. The cron half shipped in V1. See [`docs/design/scheduler.md`](docs/design/scheduler.md).
- `@os-eco/warren` library API exports — internal-only `Client` is fine for V1.

## Automated harness — container mode

Boots warren via `docker compose up -d --build` using the canonical
`docker-compose.yml` plus a generated override that:

- gives the run a unique compose project name + container name,
- maps a random ephemeral host port to the container's `:8080`,
- supplies `WARREN_API_TOKEN`, `WARREN_BURROW_NO_AUTH=1`, and
  `WARREN_LOG_LEVEL=warn` inline
  (no `.env` file required at the repo root).

```bash
bun run acceptance:container
# or, equivalently:
bun run scripts/acceptance/run.ts --mode container
```

Container mode requires Docker on PATH and a running daemon. First run
builds the image (~1–3 min on a warm cache); subsequent runs reuse the
image layer and complete the boot smoke in ~30s.

What container mode actually verifies (scenarios 01 + 13):

- the image builds (ui-builder + runtime stages),
- the supervisor (`bun run src/supervisor/main.ts`) boots burrow under
  the four bwrap-friendly security flags from `docker-compose.yml`
  (apparmor=unconfined, seccomp=unconfined, systempaths=unconfined,
  cap_add=SYS_ADMIN),
- warren and burrow start as siblings on `/var/run/burrow.sock`,
- `/healthz` is auth-exempt and returns 200,
- `GET /agents` returns the built-in coding agents (`claude-code`,
  `pi`) seeded by `seedBuiltinAgents`,
- `/readyz` returns a structured `{ ok, checks: [...] }` body.

Scenarios that depend on host-side fixtures (a sample project repo)
declare `modes: ["in-proc"]` and skip cleanly in
container mode — the compose harness deliberately doesn't bind-mount
fixtures into the container, since the production deploy is
fixture-free. Scenarios that drive process control (kill warren /
restart warren / kill burrow) also stay in-proc-only because the
in-container supervisor owns burrow lifecycle and would fight
harness-side kills.

**macOS Docker Desktop caveat.** Container boot succeeds on macOS, but
`cap_add: SYS_ADMIN` is partial under Docker Desktop's VM. Boot smoke
(scenario 13) holds; dispatching a real run with bwrap nesting is
Linux-only territory and is not asserted here. For nested-bwrap
verification, run `acceptance:container` on a Linux host. (Under the
`k8s` runtime there is no bwrap at all — the pod boundary is the
sandbox — so nested-bwrap only applies to the `local` topology.)

**`--keep-tmp` in container mode** leaves the compose stack running
after the harness exits. Tear it down with the printed command:

```
docker compose -p warren-acceptance-<suffix> down -v
```

## Manual gate — `--real` claude-code run

Verifies the first-run path exercised in the first dogfood post-mortem
(below): a real claude-code run, with a real
ANTHROPIC_API_KEY, against a real GitHub repo, completes end-to-end
with `state: succeeded` + `branchPushed: true` + non-zero `commitsAhead`.

`--real` is a documented opt-in flag on `scripts/acceptance/run.ts`,
but no `--real` scenario is implemented today (token cost + flakiness
risk). Drive the gate manually instead, against a long-lived dev
instance of warren:

```bash
# 1. Make sure your local stack is up (compose or `bun run src/server/main.ts`)
#    and ANTHROPIC_API_KEY + GITHUB_TOKEN are set.

# 2. Register a real project (a writeable repo you control, like a sandbox fork).
warren add-project https://github.com/<you>/<sandbox-repo>.git

# 3. Spawn a claude-code run with a small, scoped prompt.
warren run claude-code <project-name> -p "Add a one-line CHANGELOG entry under [Unreleased] about the V1 acceptance gate. Commit when done."

# 4. Watch the run in the UI (http://localhost:8080) or via:
warren tail <run-id> --follow
```

**Pass criteria.**
- Run reaches `state: succeeded` (terminal).
- `runRow.branchPushed === true`.
- `gh compare main...burrow/<bur-id>` reports `ahead_by ≥ 1` and the
  diff matches the prompt's intent.
- Reap fired `mulch.record.added`/`updated`/`skipped` events for any
  records the agent recorded inside the sandbox; project's persistent
  `.mulch/` carries the post-merge state.

If any of the above fail, do **not** ship — the §4.3 composition flow
is structurally broken in a way the automated harness can't catch
(stub agent has no real toolchain). Re-read the dogfood post-mortems
below for the canonical failure shapes
(`warren-67cc`, `warren-a69a`, `warren-1eaa`, `warren-1a09`, etc.) and
`branchPushed-requires-both-reap-and-sandbox-git` (a `branchPushed:
true` does NOT prove the agent committed — it can fire on an
empty-push, surfaced by the `reap.empty_push` event when
`commitsAhead: 0`).

## Manual gate — GKE deploy

Verifies the §10.2 deploy shape on the hosted target: the `k8s` runtime
on GKE Autopilot, where each run is its own pod and there is no burrow.
This is the cluster equivalent of "did the canonical home-server deploy
just work." The canonical procedure is [`docs/RUNBOOK-K8S.md`](docs/RUNBOOK-K8S.md);
the pipeline that performs it is `.github/workflows/deploy-gke.yml`.

```bash
# Roll the cluster forward (a published GitHub release does this
# automatically; a manual dispatch of deploy-gke.yml with `deploy: true`
# is the on-demand path). Then check the control plane came up:
kubectl -n warren rollout status deploy/warren --timeout=300s
INGRESS=https://<your-ingress-host>
curl -fsS "$INGRESS/healthz"                       # 200 expected
curl -fsS "$INGRESS/readyz" \
    -H "Authorization: Bearer $WARREN_API_TOKEN"    # 200 expected
```

**Pass criteria.**
- `kubectl rollout status` reports the Deployment available before the timeout.
- `/healthz` returns 200, `/readyz` returns 200 with all probes ok
  (the `k8s` runtime drops the burrow/bwrap probes — warren-c128).
- `kubectl -n warren logs deploy/warren` shows warren `/healthz responding`
  and the K8sProvider selecting the `k8s` runtime at boot.
- A real claude-code run (per the `--real` gate above) completes
  end-to-end — the run pod schedules, works, and reaps with a pushed branch.

Under `k8s` there is no burrow and none of the four bwrap flags
(`apparmor`/`seccomp`/`systempaths`/`SYS_ADMIN`) apply — the pod
boundary is the sandbox and kubelet enforces per-run CPU/memory. See
[`docs/RUNBOOK-K8S.md`](docs/RUNBOOK-K8S.md) for the cluster topology.

## Manual gate — UI smoke

The acceptance harness drives the HTTP API exclusively. The UI
(`src/ui/`) is a separate Vite/React SPA that's bundled into the
runtime image at build time; the only way to catch UI regressions is
to look at it.

Two surfaces to drive against your local stack (or the deployed
warren):

```bash
# Local stack (in-proc):
bun run src/server/main.ts &
bun run ui:dev                      # vite at http://localhost:5173

# Or the bundled UI (what production serves at :8080):
bun run build:ui
bun run src/server/main.ts          # serves UI from src/ui/dist
open http://localhost:8080
```

**Walkthrough — golden path.**

1. **Login screen.** Paste `WARREN_API_TOKEN` into the bearer-token
   input (stored in localStorage under `warren.apiToken`). The
   ProjectsPage should load without redirecting back to login.
2. **Agents page.** Built-in agents (`claude-code`, `pi`)
   appear in the registry table. Expand a row to inspect its rendered
   definition.
3. **Projects page.** `Add project` accepts a github.com URL and
   produces a row within ~5s; refresh updates `defaultBranch`.
4. **New run.** Pick agent + project, type a prompt, submit. The page
   redirects to RunDetail; the event tail flows in real time and the
   header badge transitions queued → running → succeeded.
5. **RunDetail page.** Steer form sends a body that appears as a
   `steer.sent` audit event. Cancel button transitions the run to
   `cancelled`. The post-reap header carries either a `+N commits`
   badge or an `empty push` warning (mx-6aae24); a real-claude-code
   run also surfaces a `PR ↗` link if `WARREN_AUTO_OPEN_PR` is on
   (mx-f0f743).

**Walkthrough — regressions to watch for.**

- Wide tables (Projects, Runs) push the layout past 100vw → fix the
  `min-w-0` on the flex `<main>` (mx-a8a1df).
- RunDetail badge stale after reap → check the events subscription is
  still wired (warren-d9ad).
- Empty-push warning fires on a real-work run → the agent didn't
  commit (warren-f3bb / `branchPushed-requires-both-reap-and-sandbox-git`).

## Known V1 caveats

These don't fail acceptance but are footguns when interpreting
results:

- **`warren` CLI is not on the in-container PATH** for scenarios that
  shell `warren <cmd>` from the host (warren-fab1). Container-mode
  scenarios that need the CLI use `bun /app/src/cli/main.ts <cmd>`
  via `docker exec` instead of relying on PATH symlinks. The Dockerfile
  does symlink `/usr/local/bin/warren`, but the harness doesn't
  `docker exec` into the container — scenarios that need the CLI
  declare `modes: ["in-proc"]`.
- **Supervisor `--no-auth` knob is via env, not flag** (warren-93ee
  closed; mx-24f580). Container mode sets `WARREN_BURROW_NO_AUTH=1`
  in the override env block.
- **Runtime image installs curl** (mx-4c4bee) — first-run diagnostics
  inside the container can shell `curl http://127.0.0.1:8080/healthz`
  directly without the `bun -e fetch(...)` workaround the original
  warren-bd69 issue described.
- **macOS Docker Desktop nests bwrap partially** — see container-mode
  caveat above.

## Dogfood post-mortems (2026-05-09)

The three V1 dogfood passes are the
canonical record of how the composition flow failed in the wild. Re-read
them before shipping when a manual gate fails.

### First-run validation

The first end-to-end exercise of the composition flow against a real claude-code agent surfaced three burrow gaps. Each shipped a fix in the same session.

- `burrow-7b97`: `burrow serve` had no in-process executor, so runs queued forever. The fix wired `RunDispatcher` into `startServer` and hooked `RunsClient.setOnCreated`.
- `burrow-55e3`: HTTP `burrows.up` ignored agent-id hints and left `toolchainPaths: []`. The fix accepts `agents` on `HttpBurrowUpInput` and threads them through `resolveEffectiveAgents`. Warren's spawn forwards `agents: [agent.name]` to match.
- `burrow-0329`: `buildBwrapArgv` lacked `--uid`/`--gid`. The sandboxed process inherited host root, and claude-code refused to run with `--dangerously-skip-permissions`.

Warren-side fixes:

- Bump `@os-eco/burrow-cli` in **both** `Dockerfile` and `package.json` + `bun.lock`. The supervisor's `Bun.spawn` resolves `./node_modules/.bin/burrow` before PATH, so a Dockerfile-only bump does nothing.
- Bundle `@anthropic-ai/claude-code` with an explicit postinstall invocation. `bun install -g` skips lifecycle scripts.
- Add a compose-time `CANOPY_SOURCE_DIR` bind mount for local-canopy testing.

Outcome with burrow at `0.2.3`: `warren run claude-code <prj> -p "..."` against warren itself completes in ~5s. The run ends `state: succeeded` with `branchPushed: true` and a real model response in `run.event seq:4`.

Open gaps for V1 after this pass (all open warren seeds):

- `warren-dcf3`: the supervisor does not auto-wire `GITHUB_TOKEN` into git's credential helper.
- `warren-93ee`: the supervisor has no `--no-auth` knob for burrow loopback dev.
- `warren-fab1`: the `warren` CLI is not on `PATH` inside the container.
- `warren-3c40`: reap cannot tell "queued, never started" apart from "crashed".
- `warren-bd69`: the runtime image lacks `curl` for diagnostics.

### Second dogfood

All five first-run gaps closed, then a second end-to-end run against warren itself surfaced six new structural seams. Burrow patched one mid-session: `burrow-e9e7` landed in `0.2.6`. The `claude-code` runtime now default-allows `ANTHROPIC_API_KEY` plus the OAuth env names, with no project `burrow.toml [env]` block required. Claude-code is a built-in runtime, so its env contract ships built-in too.

With burrow at `0.2.6`, the agent authenticated cleanly (`apiKeySource: "ANTHROPIC_API_KEY"` in the seq:1 init). It ran for 12m48s and ended with a clean terminal `result` event: `is_error: false`, 102 turns, and `bun test 417/417 + lint + typecheck` all green inside the sandbox.

**None of that work landed on the remote.** Two compounding bugs explain why:

- `warren-67cc`: the burrow worktree's `.git` file points at `<project>/.git/worktrees/<burrowId>`. That path lives outside the bwrap mount. The agent cannot run `git commit` inside its workspace, so reap had nothing to push.
- `warren-a69a`: warren's reap does not transition runs on terminal events. The bridge stores the result event, but the runs row stays `running` forever. Even with a commit, reap would not push.

Mulch records the pattern as `mx-runs/branchPushed-requires-both-reap-and-sandbox-git`. A `branchPushed: true` is a compound output of in-sandbox git AND warren reap. Either half failing alone produces the same shape: a stuck `running` run with no branch.

Other open seeds from this iteration:

- `warren-5f19`: `deleteProject` rmrf's the disk before the row delete. The FK on `runs.project_id` makes the row delete fail. The system ends in a `(row exists, disk gone)` state. Recommended fix: `ON DELETE SET NULL` plus row-first ordering inside a transaction.
- `warren-1eaa`: `bun install -g` runs as root during build. The `/usr/local/bin/{sd,ml,cn,sapling,overstory}` symlinks point into `/root/.bun/...`, which user `bun` cannot traverse. Every os-eco CLI dangles at runtime.
- `warren-5165`: `.env.example` and warren's docs claimed canopy `env_passthrough` flows via `burrow_config`, but `parseBurrowConfig` only reads `[sandbox].network`. Resolved as docs-only: the claude-code env contract is now burrow-built-in via `burrow-e9e7`. Project-level `env_passthrough` plumbing waits until a non-built-in runtime needs it.
- `warren-d9ad`: the UI's RunDetail badge does not react to incoming events. Even after the reap fix lands, the UI shows stale state until a manual refresh.

### Third dogfood

Released as `0.1.2` after all six second-dogfood gaps closed. Bumped `@os-eco/burrow-cli` to `0.2.7` in **both** `Dockerfile` and `package.json` + `bun.lock`. That pulls in the gitdir-bind fix `burrow-7a80`: burrow's bwrap profile now binds the host worktree gitdir into the sandbox. An agent at UID 1000 can resolve `<workspace>/.git → /<host-path>/.git/worktrees/<id>` and run `git commit` inside its workspace.

Two runs against warren-on-warren produced the cleanest signal yet on the composition flow.

**Run 1** (`run_a98cfx1fantf`, prompt `"Work on sd warren-9f65. Use ml"`) completed `succeeded` in 6m28s / 49 turns with `branchPushed: true`. Zero of the agent's work reached the remote: `gh compare main...burrow/bur_r9mjn6da9xc9` reported `ahead_by: 0, total_commits: 0`. The branch ref pointed at main's SHA. Warren reap pushed an unchanged HEAD because the agent never ran `git commit`.

The thin canopy `claude-code` prompt (`canopy-daf3`, `"You are a helpful coding assistant. Be concise."`) carries no commit contract. Combined with `src/runs/reap.ts:257-265` (push-without-commit) and the `branchPushed` boolean, any successful push flips it `true`, including a no-op. The result is a silent work-loss shape that even an attentive operator misreads as success. Filed as `warren-f3bb` (P1: observability fix B, canopy-prompt fix C, docs/design/agent-composition.md doc fix D).

A secondary entanglement: `warren-fead`. The agent emitted `stop_reason=end_turn` while it waited on a foreground `bun install` Monitor. It wrote that it would wait for the monitor, then made no follow-up tool call. The run ended before commit could happen.

**Run 2** (`run_agpet4ev6e4a`, prompt `"...Commit and push when you're done"`) produced the first warren-on-warren success that actually shipped. Branch `burrow/bur_0qgh4pwpvgv0` at SHA `15339e61` with `ahead_by: 1`. A real diff across 5 files: acceptance scenario 04 implementation, lib changes, mulch, seeds. This validates the fix-C scope: instructing the agent to commit suffices for the smoke-test agent.

The "and push" portion proved inert and counterproductive. Agent-side `git push` failed four times with `fatal: could not read Username for 'https://github.com'`. Warren's supervisor installs the `insteadOf` rewrite rule into `/root/.gitconfig` (`src/supervisor/git-credentials.ts:65-71`). Burrow's bwrap profile ro-binds `/usr`, `/etc`, `/lib`, `/lib64`, `/bin`, `/sbin`, `/opt`, but not `/root`. Same architectural pattern as `warren-1eaa`: the Bun store at `/root/.bun` and the git config stay invisible inside the sandbox. Filed as `warren-1a09` (P2).

For V1, fix A (canopy prompt instructs commit only, since warren handles the push) and fix D suffice. Fix D documents the contract: the agent commits, reap pushes, the sandbox has no github auth path. Reap pushed the agent's commit because reap runs host-side with `/root/.gitconfig` visible. The system did the right thing while the agent burned ~5 turns on doomed retries.

## Wiring summary

| File                                        | Purpose                                           |
|---------------------------------------------|---------------------------------------------------|
| `scripts/acceptance/run.ts`                 | Harness entry; argv parsing, mode dispatch        |
| `scripts/acceptance/lib/inproc.ts`          | In-proc boot (warren + burrow as host children)   |
| `scripts/acceptance/lib/compose.ts`         | Container boot (`docker compose up -d --build`)   |
| `scripts/acceptance/lib/fixtures.ts`        | Local git fixtures + insteadOf rewrites           |
| `scripts/acceptance/lib/burrow-with-stub.ts`| Wraps `burrow serve` so `stub-shell` is registered|
| `scripts/acceptance/lib/stub-agent/agent.sh`| Deterministic no-network stub agent               |
| `scripts/acceptance/lib/assert.ts`          | Scenario runner + assertion helpers               |
| `scripts/acceptance/lib/http.ts`            | Bearer-aware fetch + NDJSON streaming             |
| `scripts/acceptance/scenarios/01-13`        | The 13 V1-goal acceptance criteria                |
| `package.json`                              | `acceptance` + `acceptance:container` scripts     |

When adding a scenario, mirror the existing file shape: a top-level
JSDoc with the criterion + verification surface, an exported `Scenario`
constant with `id`, `title`, `modes`, and an async `run(ctx)`. Use
`WarrenHttp` for HTTP, `assertEqual`/`assertTrue` for asserts, and
`AcceptanceError` for thrown failures so the runner's table shows the
message verbatim.
