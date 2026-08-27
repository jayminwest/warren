# Agent Composition + Pi Runtime Contract

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-01
**Shipped:** before this record; live contract salvaged in v0.13.2
**Current truth:** `src/registry/schema.ts`, `src/registry/builtins/`, and `src/runs/seed.ts`

> **Salvage provenance:** lifted from the retired top-level spec §4.1 (the four sides of
> a custom agent), the still-live schema parts of §4.2, §4.3 (the
> composition flow), and §11.K (pi runtime support) as part of the SPEC
> retirement plan `pl-1717` (step `warren-ff89`). The wording below is
> the live contract — `src/registry/schema.ts`,
> `src/registry/builtins/`, `src/runs/seed.ts`, and the stream-usage
> accumulators all narrow against it — so edit it only in lockstep with
> the code it describes. The retired external-canopy framing (the
> `cn render` spawn step, `CANOPY_REPO_URL`, `warren register-agent`,
> `/agents/refresh`) was dropped during the lift: the flow is described
> as it exists today, with agents seeded from the inline built-ins.
> Cross-references to other surviving SPEC sections are repointed by the
> later sweep steps of `pl-1717`.

## The four sides of a custom agent

| Side | Where it lives | Tool |
|---|---|---|
| **Mind** (persona, skills) | inline built-ins in `src/registry/builtins/`, frozen onto the run row | warren registry |
| **Memory** (expertise) | `.mulch/expertise/<domain>.jsonl` (per-project) | mulch |
| **Worklist** (tasks) | `.seeds/issues.jsonl` (per-project) | seeds |
| **Body** (loop, tools) | `pi` or `claude-code` | the runtime |

Burrow is the cell the agent runs in. Warren is the operator that picks
who runs where, when, and on what. The os-eco canopy tool lives on to
author prompt libraries, but warren no longer integrates with it — a
fresh install seeds agents from the inline built-ins and freezes their
rendered envelopes on the run row, so no canopy tooling is required.

## The agent definition (warren's internal envelope schema)

An agent is a single agent-envelope with a schema-validated set of
sections, parsed by `src/registry/schema.ts` into `AgentDefinition`
(`{ name, version, sections, resolvedFrom, frontmatter }`):

```yaml
name: refactor-bot
version: 1
sections:
  system: |
    You are a refactor-focused agent. Prefer small, reviewable diffs...
  skills: |
    - run-tests
    - open-pr
    - investigate-flake
  expertise_seed: |
    {"type":"convention","domain":"refactor","content":"..."}
    {"type":"failure","domain":"refactor","description":"...","resolution":"..."}
  burrow_config: |
    [toolchain]
    bun = "1.1"
    [sandbox]
    network = "restricted"
    allowed_domains = ["api.anthropic.com", "github.com", "registry.npmjs.org"]
  workflow: |
    # seeds plan template name to use
    template: refactor
  pi_skills: |                           # pi-only — materialized into .pi/skills/<name>/SKILL.md
    {"name":"refactor-pass","body":"# Refactor pass\nIdentify dead code..."}
    {"name":"safe-rename","body":"# Safe rename\nUse the LSP rename..."}
  pi_prompts: |                          # pi-only — materialized into .pi/prompts/<name>.md
    {"name":"summarize-diff","body":"Summarize the diff in {{lines}} lines..."}
```

**Section enumeration.** Generic sections shared by every runtime:
`system`, `skills`, `expertise_seed`, `burrow_config`, `workflow`. Only
`system` is required (`REQUIRED_AGENT_SECTIONS`); the rest are consumed
at run-spawn time. Pi-namespaced sections (consumed only by the `pi`
built-in; ignored by `claude-code`): `pi_skills`,
`pi_prompts`. Pi-section bodies are JSON-Lines envelopes of
`{name, body}` — one artifact per line — which `src/runs/seed.ts`
materializes into `.pi/skills/<name>/SKILL.md` and
`.pi/prompts/<name>.md` inside the burrow workspace before dispatch (see
the pi runtime contract below). Malformed envelopes (non-JSON,
missing/empty `name`, non-string `body`, duplicate names, unsafe names
containing `/`, `\`, `.`, `..`) abort seeding with the same
`RunSpawnError` shape as `expertise_seed`.

**Well-known frontmatter fields** (open `frontmatter` bag, no schema
rev — `readProviderFrontmatter` / `readToolsFrontmatter` in
`src/registry/schema.ts`):

- `provider`, `model` — free-form strings the multi-provider surface
  reads (see the pi contract below).
- `runtime` — burrow runtime id the agent dispatches onto (`pi`,
  `claude-code`). When unset, warren falls back to
  `DEFAULT_RUNTIME_ID` (`"pi"`); `claude-code` is opt-in via this field
  (warren-16f8).
- `auto_plan_run` (boolean, warren-a32a) — on run success, reap diffs
  `.seeds/plans.jsonl` and auto-dispatches a plan-run per new plan.
- `auto_plan_run_agent` (string, warren-65b2) — agent name for those
  auto-dispatched plan-runs, so triage-only agents don't propagate their
  system prompt to child runs that write code.
- `tools` (object, warren-8dee) — per-agent tool allowlist/denylist
  consumed by the pi runtime; see the pi contract below.

`POST /runs` accepts `providerOverride` / `modelOverride`; the spawn
composer merges overrides on top of frontmatter before freezing onto
`runs.rendered_agent_json`.

## The composition flow

When warren spawns a run:

1. **Resolve agent** — warren looks the agent up in its registry: the
   inline built-ins in `src/registry/builtins/` plus any project-registered
   agents, parsed through `parseRenderedAgent` into an `AgentDefinition`.
   The resolved definition is persisted on the run row
   (`runs.rendered_agent_json`) and **frozen for the lifetime of the
   run** — mid-run edits to the registry do not affect in-flight runs.
   Run-time agent identity always reads from `runs.rendered_agent_json`,
   never from a re-resolve.
2. **Provision burrow** — `POST /burrows` to burrow with
   `{ projectRoot, branch?, baseBranch?, network?, ... }` derived from
   the agent's `burrow_config` and the project's local clone path.
   Burrow returns 201 + `Burrow` (id, workspace path, branch, state).
   Warren records `burrow_id` on the run. The `branch` field is composed
   by warren as `${prefix}/${run.id}` where the prefix resolves project
   default (`.warren/config.yaml.runBranchPrefix`, or the same field in
   legacy `.warren/defaults.json`) > `WARREN_RUN_BRANCH_PREFIX` env >
   built-in `"warren"` (warren-9993; warren-2de0 flipped the default — the
   legacy `"burrow"` value survives
   backward compatibility). The warren `run_xxx` suffix makes the branch
   back-reference the warren run row on `git log` / PR review without a
   separate lookup.
3. **Seed the burrow** — `buildSeedFiles(agent)` returns a seed-file
   list covering the workspace drops (`.mulch/expertise/<domain>.jsonl`
   from `expertise_seed`, `.seeds/workflow.txt`,
   `.pi/skills/<name>/SKILL.md` from `pi_skills`,
   `.pi/prompts/<name>.md` from `pi_prompts`). The list rides along on
   the step-2 `POST /burrows` as `seed.files`, so provision-and-seed is
   a single atomic round-trip — burrow rolls the burrow back on its side
   if any file fails validation, and warren never observes a half-seeded
   workspace (R-07; see `docs/design/runtime-and-supervisor.md`).
4. **Dispatch** — `POST /burrows/:burrow_id/runs` with
   `{ agentId, prompt, metadata? }`. Burrow returns 201 + `Run` in
   `state='queued'`; its run loop picks it up. Warren records the burrow
   run id in `runs.burrow_run_id`.
5. **Stream** — `GET /runs/:burrow_run_id/stream?follow=1` (NDJSON,
   chunked HTTP). Warren persists every event into its own `events`
   table keyed by warren run id, then fans out to UI subscribers. UI
   clients hit warren's own `/runs/:id/events?follow=1`, which serves
   history from the warren log + tails the live stream concurrently. If
   warren restarts mid-run, on boot it re-subscribes to burrow's stream
   from `MAX(events.burrow_event_seq)+1` to backfill anything missed
   (see `docs/design/runtime-and-supervisor.md`).
6. **Reap** — on run terminal state, copy the burrow's
   `.mulch/expertise/*.jsonl` back to the project's persistent `.mulch/`
   with **last-write-wins by record `ts`**; close any seeds the agent
   marked done by reading the burrow's `.seeds/issues.jsonl` via
   `HttpClient.files.read` (R-07); push the workspace branch. The
   `mulch_merge` sub-step still reads off shared disk pending burrow's
   file-listing endpoint (`burrow-18ca`, tracked by `warren-7f7c`) —
   once shipped, that read flips to `HttpClient.files.list` +
   `.files.read` and warren's reap goes fully HTTP. **Commit/push
   contract:** the agent commits inside the sandbox; reap pushes from
   the host. Sandboxed agents have **no GitHub auth path** in V1
   (`warren-1a09`: the supervisor's `insteadOf` rewrite lives in
   `/root/.gitconfig`, which burrow's bwrap profile does not bind), so
   agent-side `git push` is structurally broken — the built-in prompts
   instruct commit-only and warren reap is the actual push mechanism.
   After push, reap counts commits ahead of `baseBranch`
   (`git rev-list --count <baseBranch>..HEAD`) and surfaces
   `commitsAhead` on the reap summary; `commitsAhead: 0` fires a
   `reap.empty_push` event so a push that landed nothing (the
   `warren-f3bb` shape: agent never committed, push exit-0'd against
   unchanged HEAD) is observably distinct from a real-work push.

Steering: `POST /runs/:id/steer` (warren) →
`POST /burrows/:burrow_id/inbox` (burrow). Cancellation:
`POST /runs/:id/cancel` (warren) → `POST /runs/:burrow_run_id/cancel`
(burrow). Burrow's full HTTP contract is at `GET /openapi.json` on the
burrow socket; warren generates code against the OpenAPI document, so
contract drift surfaces at build time.

The agent's worklist (seeds) belongs to the project, not the agent. The
same project worked on by `refactor-bot` today and `sre-bot` tomorrow
uses the same seeds queue.

## Pi runtime support (2026-05-12)

The `pi` (`@earendil-works/pi-coding-agent`) runtime is the third
built-in coding agent alongside `claude-code` and `sapling`. It shipped
as plan `pl-4374` (warren-39c1) in seven phased steps: a cross-repo
burrow piRuntime contract (`warren-0e06` → `burrow-8aff`), a
parity-shape builtin (`warren-d18e`), workspace seeding for
pi-namespaced sections (`warren-846b`), a multi-provider surface
(`warren-f8c0`), per-run cost tracking (`warren-a7dc`), event-model
widening in the UI (`warren-70af`), and the docs/decision record
(`warren-f1da`).

**Why a third built-in.** Pi is distinguished from `claude-code` and
`sapling` by three properties warren operators care about: (1) a unified
multi-provider LLM API (Anthropic, OpenAI, Google, Bedrock, Vertex,
DeepSeek, Groq, Mistral, Azure OpenAI, and custom OpenAI-compatible
endpoints) — pick the best model per task without standing up a second
runtime; (2) first-class `get_session_stats` RPC reporting tokens
(input / output / cacheRead / cacheWrite) + cost (USD) per session — see
what a run actually cost; (3) a clean customization surface
(`.pi/skills/<name>/SKILL.md`, `.pi/prompts/<name>.md`) that maps onto
warren's existing workspace-section seeding flow.

**Built-in shape.** `src/registry/builtins/pi.ts` (`PI_BUILTIN`,
`mx-4888d2`) mirrors `SAPLING_BUILTIN` exactly: `name='pi'`, `version=1`,
`sections.system` + `sections.burrow_config` with `network='open'`,
`frontmatter.source='builtin'`, `resolvedFrom=['builtin:pi']`. Wired into
`BUILTIN_AGENTS` (`src/registry/builtins/index.ts`), asserted by
`builtins.test.ts`, surfaced in the Agents page (`mx-723c5e`), and
covered by acceptance scenario 16 (`mx-05f62f`). Warren forwards
`agent.name='pi'` to burrow as the runtime id via the existing
`agent.name → burrow agentId` convention (`mx-7352f4`, `mx-c8fc41`);
burrow's piRuntime is registered in the `AgentRegistry` per the
warren-0e06 contract (`mx-0db923`).

**Burrow piRuntime contract.** Pinned at `mx-0db923`: `id='pi'`;
`displayName='Pi'`; `supportsResume=true` (pi has `--continue` /
`--session`, *not* one-shot like codex); spawn shape
`pi --mode rpc --no-session [--no-extensions] --provider <…> --model <…>`
(RPC mode, not JSON — chosen for the bidirectional steer / abort /
get_state / get_session_stats surface that warren's spawn-per-turn flow
assumes). RPC commands warren consumes: `prompt`, `steer`, `abort`,
`get_state`, `get_session_stats`. Event kinds warren's parser surfaces:
`agent_start`/`end`, `turn_start`/`end`,
`message_start`/`update`/`end`, `tool_execution_start`/`update`/`end`,
`queue_update`, `compaction_start`/`end`, `auto_retry_start`/`end`,
`extension_error`. `envPassthrough` widens beyond claude-code's
`ANTHROPIC_*` + `CLAUDE_CODE_OAUTH_TOKEN` set to include
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `PI_API_KEY`,
`GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY` — implemented at
the runtime-contract layer (burrow's `envPassthrough` escape hatch), so
warren does not change `docker-compose.yml` to add a new provider. If
burrow ships piRuntime under a different id (e.g. `pi-coding-agent`),
warren's `BUILTIN_AGENTS` name must change in lockstep — the two strings
must match exactly (`mx-7352f4`).

**Pi-namespaced sections.** Pi accepts two extra sections beyond the
generic enumeration above: `pi_skills` and `pi_prompts`. Bodies are
JSON-Lines `{name, body}` envelopes, materialized by
`src/runs/seed.ts` into the burrow workspace before dispatch
(`mx-413c1b`): `pi_skills` writes to `.pi/skills/<name>/SKILL.md`
(per-skill subdir matching the `agentskills.io` standard); `pi_prompts`
writes to `.pi/prompts/<name>.md` (flat). Both reject malformed JSON,
non-object lines, missing/empty `name`, non-string `body`, duplicate
names, and unsafe names with `RunSpawnError` — same shape as
`expertise_seed`. Sections are pi-namespaced (not generic `skills`) so
an author can land a generic `skills` section on a base agent and have
it remain ignored by pi without collision.

**Multi-provider surface.** `AgentDefinition.frontmatter` grows two
well-known optional string fields: `provider` and `model` (`mx-20a3b9`).
Built-in `PI_BUILTIN` leaves both unset by default — pi resolves from
its own `~/.pi/agent/models.json`. `POST /runs` accepts optional
`providerOverride` + `modelOverride` strings (`mx-fd6008`); they thread
onto `agent.frontmatter` before freeze, so the rendered agent on
`runs.rendered_agent_json` records exactly what ran. `NewRun.tsx`
surfaces the pair as two free-text Inputs in a 2-col grid (`mx-0048cb`),
auto-filled from the selected agent's frontmatter.

**Cost + token accounting.** Migration 0006 adds five nullable columns
to `runs`: `cost_usd REAL`, `tokens_input INTEGER`,
`tokens_output INTEGER`, `tokens_cache_read INTEGER`,
`tokens_cache_write INTEGER`. `RunsRepo.attachStats` mirrors
`attachBurrow`'s partial-input semantics (`mx-49272e`): omitted fields
preserve existing values; explicit `null` does not clear. Two runtimes
populate the columns by shape-sniffing events as they flow through
`bridgeRunStream`:

- **pi** (`warren-17a4`): `accumulatePiUsage` sums
  `turn_end.message.usage` totals across turns; persisted at the first
  `agent_end`. The legacy out-of-band `PiStatsClient` (`mx-916eb6`) is
  still wired as an explicit override that wins over in-stream when
  injected — it fetches `get_session_stats` at run-start and run-end and
  persists the delta, defending against the multi-session cost
  double-count when pi resumes via `--continue` / `--session`.
- **claude-code** (`warren-87f9`): `extractClaudeUsage` reads the single
  terminal `result` envelope's `total_cost_usd` +
  `usage.{input_tokens, output_tokens, cache_read_input_tokens,
  cache_creation_input_tokens}`. Single-shot — claude-code emits
  cumulative run totals once at end, so no accumulation is needed.
  Persisted on terminal detection.

Dispatch is shape-sniffed (not keyed off `runs.agent_name`) so a future
runtime emitting a known terminal shape Just Works. If both shapes
appear in one stream (mixed runtimes — unlikely in practice), pi wins
for parity with the pre-warren-87f9 behavior. `sapling` runs leave every
column `null` (no terminal cost emission yet — separate seed). RPC
failures are logged as a system event and do not fail the run.
`run-detail.tsx` renders a header cost badge using `formatCostUsd()`
(`mx-9d987a`): `≥$1` → 2 decimals, `<$1` → 3 decimals; badge omitted
when `cost_usd` is `null`. `Runs.tsx` adds an opt-in Cost column
(hidden by default, toggled via the toolbar).

Per-run spend caps are enforced separately (warren-a63d): a per-agent
`frontmatter.maxCostUsd` or per-trigger `maxCostUsd` (triggers.yaml)
cancels a run mid-stream once cumulative cost crosses the cap. Broader
run-budget enforcement — concurrent-run caps, per-user / per-project
rollups — is still planned post-V1 (R-17). The columns above are
reporting (observability); the budget rollups remain the deferred half.

**Event model.** Pi's wider event vocabulary (`compaction_start`/`end`,
`auto_retry_start`/`end`, `extension_error`, `queue_update`) is
collapsed by burrow's pi parser (`src/runtime/parsers/pi.ts`) into
burrow's stable event taxonomy, with the original pi envelope `type`
preserved in `payload.type`. `run-detail.tsx` `EventLine` detects pi
sub-kinds by peeking at `payload.type` when `event.kind` is
`state_change` or `telemetry` (`mx-66ff69`); `PI_SUBKIND_LABELS` maps
each to a friendlier display label; `extension_error` additionally tints
`rose-700` like stderr. A kind-direct match (e.g.
`event.kind === 'compaction_start'`) is also honored so a future burrow
release that promotes any of these to first-class kinds Just Works
without a UI rev. Unknown kinds fall through to the existing generic
renderer.

**Pi extensions are deferred** (`.pi/extensions/*.ts`). Pi extensions
are TypeScript source modules with access to `ExtensionAPI`
(`registerTool`, `registerCommand`). Encoding TS source inside a
section body works but is awkward — operators lose `tsc` / `biome` on
the source, syntax errors only surface at run time, and the diff view
becomes useless. The right fix is an *artifact type* (file-shaped, not
section-shaped) that warren materializes alongside the rendered
`AgentDefinition`. V1 ships `pi_skills` + `pi_prompts` (already
file-shaped + markdown) and leaves `.pi/extensions/` to a follow-up.

**No MCP support on pi.** Pi explicitly has no MCP — its tool surface is
built-in plus extensions only. This is a worldview difference, not an
omission: R-15 (MCP via frontmatter, post-V1) stays scoped to
`claude-code` and `sapling` and is *not* a blocker for the `pi`
built-in. Operators wanting MCP-style external tools on pi should reach
for pi's extensions story once artifact types land.

**Headless provider-auth posture.** Warren passes provider API keys into
the sandbox via burrow's `envPassthrough` (see contract above). Pi's
interactive `/login` flow (OAuth for Anthropic Claude Pro/Max, ChatGPT
Plus, GitHub Copilot, etc.) is unsupported by design: warren is
headless. A future "bring-your-own-browser" path for OAuth-only
providers is reconsiderable in V2 if there is demand; in V1, pi is
API-key-only.

**Why a built-in, not a library agent?** Built-ins exist precisely so a
fresh warren install can dispatch a run with no external agent-library
setup (see `src/registry/builtins/index.ts`). `claude-code` and
`sapling` both ship inline; `pi` is the third member of the same set and
deserves the same treatment. A library-only path would mean every
operator who wants pi has to stand up an external agent library first —
high friction for the "multi-provider out of the box" value proposition.

**Per-agent tool allowlist/denylist (warren-8dee).**
`AgentDefinition.frontmatter` grows an optional `tools` object so a
reviewer / patrol agent can declare a hard read-only (or otherwise
scoped) tool surface at the harness level, not just via bwrap network
policy. Shape:
`tools = { allow?: string[], deny?: string[], noBuiltins?: boolean, noTools?: boolean }`.
`readToolsFrontmatter` (`src/registry/schema.ts`) parses, validates, and
normalizes it: `allow`/`deny` accept a real `string[]` or a single
comma/whitespace-separated string (the string/boolean trap shape,
warren-5f07), and `noBuiltins`/`noTools` tolerate `"true"`/`"false"`
strings. A malformed declaration throws `AgentSchemaError` at parse time
(`parseRenderedAgent` + `validateAgentDefinition`) rather than silently
dropping the guarantee. `parseRenderedAgent` freezes the *normalized*
policy back onto `frontmatter.tools`, so the rendered envelope on
`runs.rendered_agent_json` and the metadata warren forwards to burrow
carry a canonical shape. The policy rides the existing
`composeBurrowMetadata` seam (`src/runs/spawn/dispatch.ts`) — no new
dispatch plumbing — so it forwards on
`Run.metadataJson.frontmatter.tools` exactly like `provider`/`model`.

This is a **paired warren↔burrow change** (same pin discipline as the
piRuntime contract above): warren validates + forwards the policy;
burrow's `buildPiArgv` (`../burrow src/runtime/pi.ts`) reads
`ctx.frontmatter.tools` and appends `--tools <allow>` /
`--exclude-tools <deny>` / `--no-builtin-tools` / `--no-tools` to the pi
argv. Only the `pi` runtime consumes the field in V1 — `claude-code` and
`sapling` ignore it. Until burrow ships the `buildPiArgv` half, warren
already freezes + forwards a well-formed policy, so the burrow change is
additive and non-breaking.

**Adding a fourth built-in (or schema-extending pi).** Per `mx-39a64f`,
five places update in lockstep: (1) `src/registry/builtins/<name>.ts`,
(2) `BUILTIN_AGENTS` array + re-export in `src/registry/builtins/index.ts`,
(3) `builtins.test.ts` assertions on `BUILTIN_AGENT_NAMES` +
`readAgentSource`, (4) `scripts/acceptance/scenarios/13-container-smoke.ts`
builtin-names check, (5) `src/ui/src/pages/Agents.tsx` header +
empty-state copy. Scenario `02-agents-refresh.ts` already filters on
`source !== 'builtin'` (`mx-ae877e`), so it auto-extends without a code
change.
