# LEVERET.md — Leveret conversation system

Leveret is warren's conversational overseer: a long-lived pi-chat agent
that shapes a Plot's structured intent through multi-turn dialogue and,
as Audit Warden, synthesizes the audit population's weekly findings into
actionable plans. This document is the design reference for the
conversation runtime, HTTP surface, data model, and warden boundary.

---

## §0.0 — Glossary and primitives

### §0.0.A — Plot

A Plot (`src/db/schema/sqlite.ts plots projection`) is a git-backed
structured-intent document. Plots live under `.plot/` in the project
workspace. N conversations bind to one Plot (N:1).

### §0.0.B — Send-off (send to planner)

When the operator sends a conversation to the planner
(`POST /conversations/:id/send-off`), warren:

1. Flips the conversation `active → closed` and the anchoring run
   `running → succeeded`, emitting a `conversation.sent_off` system
   event on the run stream.
2. Opens a send-off PR that carries the Plot-state diff (only — no
   workspace edits, since leveret never calls `edit`/`write`).
3. Dispatches a planner run as the conversation's follow-up
   (`plannerRunId` recorded on the conversation row) so the
   PR-merge poller can track it.

The PR-merge poller (`src/runs/conversation-merge-poller.ts`) watches
`submittedPrUrl`; once it detects merge, it dispatches the planner run
against the merged Plot state. Implemented by warren-756d / warren-b872.

### §0.0.E — pi-chat runtime

Leveret dispatches onto the `pi-chat` runtime (a long-lived, multi-turn
pi session rather than the one-shot batch runtime). `readRuntimeId`
(`src/registry/schema.ts`) reads `frontmatter.runtime` as a free string
and forwards it onto burrow as the runtime id — no `KNOWN_RUNTIME_IDS`
change is needed. Operators with a custom canopy library can override the
runtime per `DefaultsConfigSchema.interactiveAgents.brainstormRuntime` /
`plannerRuntime` (warren-b802).

### §0.0.F — Database tables

The `conversations` and `messages` tables live in
`src/db/schema/sqlite.ts` (with a parallel Postgres mirror in
`src/db/schema/postgres.ts`). The Plots projection (`§0.0.A`) provides
a read-cache of the git-backed `.plot/` files for the UI.

---

## §0.1 — Agent identity

The built-in `leveret` agent (`src/registry/builtins/leveret.ts`) ships
inline. It runs on the `pi-chat` runtime (`§0.0.E`). Its only structured
side effect is the `propose_intent` pi extension, which patches the four
STRUCTURED fields on the active Plot (`goal`, `non_goals`,
`constraints`, `success_criteria`) — a field-scoped patch, NOT a
free-form replace. The system prompt grants only read-leaning tools
(`read`/`grep`/`find`/`ls`/`bash`) and explicitly withholds
`edit`/`write`, so a send-off PR (`§0.0.B`) can only ever carry a
plot-state update, never an arbitrary workspace diff.

---

## §0.2 — Conversation creation and Plot binding

`POST /conversations` creates a conversation and dispatches its first
anchoring mode:`conversation` run. Plot binding is operator-controlled:

- Pass `plot_id` to **attach** to an existing Plot.
- Omit it to **auto-create** a fresh Plot (same `plotCreator` seam
  `POST /plots` uses).

N conversations may bind to one Plot; the relation is N:1. A
conversation created without a Plot fails at dispatch time (the anchoring
run needs a Plot to write `propose_intent` against).

---

## §0.4 — Anchoring run and idle timeout

A `mode:'conversation'` anchoring run is a pi-chat session that stays
non-terminal across turns: the burrow-side agent suppresses the per-turn
`agent_end` terminal envelope. Warren-side lifetime guards (watchdog,
reap workspace-destroy, crash-recovery finalize) exempt `conversation`
runs — an idle conversation run is healthy, not hung.

**Idle-finalize** (`src/runs/conversation-idle.ts`, warren-005d): when
`now - conversations.last_activity_at >= budget`, the coordinator
finalizes the anchoring run `running → succeeded` and emits
`conversation.idle_finalized`. It does NOT close the conversation — the
`conversations` row stays `status='active'`, the Plot persists, and the
`messages` transcript survives.

Budget: `conversation.idleTimeoutMs` in `.warren/config.yaml`, default
`DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS` (20 min). Bounds 1 s – 24 h.

**Re-wake** (`src/runs/conversation-rewake.ts`, warren-6ccf,
`POST /conversations/:id/re-wake`): spawns a fresh mode:`conversation`
run that replays the `messages` transcript into a brand-new pi session,
then rotates `conversations.anchoring_run_id` to the new run. Re-wake is
safe to call on any `active` conversation whose anchoring run is
terminal; calling it on an `active` conversation with a still-running
anchoring run returns a `ValidationError` (nothing to re-wake). A
`closed` conversation cannot be re-woken.

---

## §0.5 — Data model (conversations and messages)

### conversations

One row per leveret conversation. Key columns:

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | |
| `project_id` | FK → projects | `ON DELETE SET NULL` (orphans, does not block) |
| `plot_id` | TEXT | git-backed; plain text, no FK |
| `anchoring_run_id` | TEXT | nullable; rotates on re-wake (`§0.4`) |
| `status` | `active` \| `closed` | flips to `closed` on send-off or operator close |
| `title` | TEXT | human label; used as the well-known warden identifier (`§0.15`) |
| `submitted_pr_url` | TEXT | send-off PR ref (warren-756d) |
| `submitted_pr_number` | INT | |
| `planner_agent` | TEXT | send-off planner agent |
| `planner_run_id` | TEXT | merge-poller dispatch guard (warren-b872) |
| `created_at` / `last_activity_at` | ISO8601 | `last_activity_at` drives idle-detect (`§0.4`) |

### messages

The conversation transcript, one row per turn.

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | |
| `conversation_id` | FK → conversations | `ON DELETE CASCADE` |
| `seq` | INT | monotone, 1-indexed within the conversation |
| `role` | `user` \| `assistant` \| `system` \| `tool` | `user` = operator turn; `assistant` = leveret reply; `system` = host marker; `tool` = structured tool turn |
| `content` | TEXT | |
| `created_at` | ISO8601 | |

Anchoring runs are deliberately **hidden** from the Runs API
(`src/db/repos/runs.ts` excludes `mode:'conversation'` from
list/aggregate paths) — operators see conversations here, not a pile of
never-terminating runs on the Runs page.

---

## §0.7 — Send-off submission (data layer)

`repos.conversations.recordSendOff` (warren-756d) writes `submitted_pr_url`,
`submitted_pr_number`, `planner_agent`, and `planner_run_id` in one
atomic update alongside the `active → closed` flip. The planner run is
dispatched *after* the conversation row is closed; the merge poller uses
`planner_run_id` as a re-entry guard so a duplicate merge event does not
dispatch a second planner run.

---

## §0.8 — mode:interactive (workbench)

`mode:'interactive'` runs (`src/server/handlers/plots/workbench.ts`,
warren-d622) are the synchronous read-only scouting path: brainstorm /
planner sessions that inspect the codebase and return a proposed intent
shape in one turn. They are *not* conversations — no `conversations` row
is created, no transcript is persisted, and the run terminates normally
at `agent_end`. The `interactive` run mode constant was intentionally
dropped from `RUN_MODES` (`src/db/schema/columns.ts`) — `batch` and
`conversation` are the only persisted modes; `interactive` lives only in
the workbench handler.

---

## §0.9 — HTTP surface

Full handler detail: `src/server/handlers/conversations.ts`.

| method | path | description |
|---|---|---|
| `POST` | `/conversations` | Create + dispatch anchoring run. |
| `GET` | `/conversations` | List (`?project`, `?plot`, `?status`). |
| `GET` | `/conversations/:id` | Conversation row + full transcript. |
| `POST` | `/conversations/:id/messages` | Operator turn — 202 over steering channel + persist to transcript. |
| `POST` | `/conversations/:id/send-off` | Send to planner (`§0.0.B`). |
| `POST` | `/conversations/:id/re-wake` | Re-wake an idled conversation (`§0.4`). |

UI types: `src/ui/src/api/types.ts` (warren-af15 / warren-763f).

---

## §0.11 — Built-in agent registration

The `leveret` built-in is registered in `src/registry/builtins/leveret.ts`
(warren-fdd9, build-phase 3). It carries:

- `runtime: "pi-chat"`
- `mode: "conversation"` front-matter default
- The `propose_intent` pi extension seeded into
  `.pi/extensions/propose_intent.ts` by `src/runs/seed.ts` (warren-e38b)
- A system prompt that grants `read`/`grep`/`find`/`ls`/`bash` and
  withholds `edit`/`write`

Operators may override with a custom canopy entry; warren falls back to
the built-in when no override exists.

---

## §0.13 — Acceptance scenario

Scenario 33 (`scripts/acceptance/scenarios/33-leveret-conversation-loop.ts`,
warren-9f47) is the end-to-end smoke test for the conversation loop:
create → post messages → send-off → planner dispatch → plan proposed.

Scenario 34 (`scripts/acceptance/scenarios/34-warden-conversation-acceptance.ts`,
warren-6022 / pl-da54 step 4) is the dedicated warden acceptance test:
seeds the standing warden conversation, posts auditor findings over
`POST /conversations/:id/messages`, fires the digest message, and
asserts Leveret synthesizes a digest and proposes a plan through the
existing send-off → planner chain. See `§0.15` for warden architecture.

---

## §0.14 — Idle-timeout config

`conversation.idleTimeoutMs` lives under `DefaultsConfigSchema` in
`src/warren-config/schema.ts` (warren-005d). Schema: `z.number().int()`
with bounds 1 000 – 86 400 000 (1 s – 24 h) and default
`DEFAULT_CONVERSATION_IDLE_TIMEOUT_MS = 1_200_000` (20 min). Consumers
that find no `agent` block fall back to the exported constant. Wired in
`src/server/main/detector-wiring.ts` (`bootConversationIdleDetectorFromEnv`),
on by default — unlike opt-in detectors.

---

## §0.15 — Audit Warden boundary

The Audit Warden is a **standing** Leveret conversation that receives
findings from the audit population (gatewatch, ratchetwatch, tastewatch)
and synthesizes weekly digests into actionable plans. It is not a new
primitive — it reuses every existing conversation endpoint with no new
dispatch path.

### Standing conversation and meta-Plot

One long-lived `active` conversation is bootstrapped idempotently under
the well-known title **"Audit Warden"** and bound to a meta-Plot. The
meta-Plot is created once (`POST /conversations` with no `plot_id` →
auto-creates a fresh Plot). Both the conversation and its Plot persist
indefinitely across re-wakes; they are never closed by warden operations.

The conversation is **resolvable by title**: auditors and the digest cron
call `GET /conversations?status=active`, filter for `title === "Audit Warden"`,
and use the returned `id` for all subsequent writes.

### Ingestion boundary — only via POST /conversations/:id/messages

All audit findings arrive over the **existing** `POST /conversations/:id/messages`
steering channel (202 accepted, message appended to transcript, live pi
session picks it up on its next turn). No new endpoint, no new dispatch
primitive, no direct DB write from auditor scripts.

Each auditor (gatewatch, ratchetwatch, tastewatch) posts its findings
as user-role messages to the warden conversation in addition to filing
seeds. Message shape mirrors the existing operator-turn format; the
warden's transcript accumulates all findings between digest runs.

### Digest cadence

`warden-digest` cron (`0 5 * * 0`, Sunday 05:00 America/Los_Angeles,
`.warren/triggers.yaml`):

1. If the anchoring run has idled, call `POST /conversations/:id/re-wake`
   to restore a live pi session.
2. Post the weekly synthesis prompt to the warden conversation via
   `POST /conversations/:id/messages`.
3. Leveret reads the week's accumulated transcript, proposes plans
   through the existing send-off → planner chain.

`tastewatch-digest` cron (`0 4 * * 0`, 60 min earlier) produces the taste
digest and delivers it to the same warden conversation before the warden
synthesizes.

### Auditor-autonomy-promotion recommendations

Tastewatch tracks a precision table for each auditor (number of findings
filed vs. number acted on). When an auditor's precision crosses a
confidence threshold, tastewatch may **recommend** promotion to
autonomous dispatch (`auto_plan_run: true`) in its weekly digest. These
recommendations are advisory: they surface as a proposed amendment or
seed in the digest, they are delivered to the warden conversation for
Leveret to route, and they require explicit human review before any
`.canopy/` or `.warren/triggers.yaml` change is applied (Article IX of
`docs/CONSTITUTION.md`).

The mechanical implementation of autonomy-promotion recommendations
(reading the precision table, emitting a structured promotion proposal)
is tracked separately as a follow-up (filed per warren-05ef close-out).

### Non-goals

- The warden does not own a new dispatch path, event kind, or DB table.
- The warden conversation is not closed or re-created by the digest cron.
- Auditors do not write directly to the DB; all writes go through the
  existing HTTP channel.
- Warden operations are not exposed in the main Runs UI; they are visible
  as conversation turns in the Conversations view.
