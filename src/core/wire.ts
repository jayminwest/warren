/**
 * Canonical wire vocabulary (warren-b229 / pl-b82d step 26).
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH for every enum-shaped value that
 * crosses warren's HTTP wire: run / plan-run / preview lifecycle states,
 * failure-cause discriminators, run mode, clone kind, event stream, and the
 * steering-inbox classes. Every other layer — the drizzle column metadata
 * (`src/db/schema/columns.ts`), the SDK (`src/client/types*.ts`), and the
 * browser UI (`src/ui/src/api/types.ts`) — RE-EXPORTS these names. None of
 * them may redeclare one. `bun run check:wire-types` (warren-d371) enforces
 * that mechanically.
 *
 * Why `src/core/` and why this direction:
 *
 *   - `src/core/` is warren's dependency-free kernel (errors + ids). It
 *     imports nothing, so every layer can import it without inheriting a
 *     dependency. Defining here and re-exporting outward is the only
 *     direction that works for the UI: `src/ui` is a separate package
 *     (`@os-eco/warren-ui`) bundled by Vite, and it must never reach into
 *     `src/db/schema/` — that would drag drizzle and `bun:sqlite` into a
 *     browser bundle. A leaf module with zero imports is reachable from
 *     both sides without either side importing the other.
 *   - The three surfaces drifted for exactly as long as they were hand-kept
 *     copies: `RunFailureReason` lost `finalize_failed` + `evicted` in both
 *     the SDK and the UI, the UI still typed the deleted `interactive` run
 *     mode, and `RefreshAgentsResponse.removed` was `{name}[]` in the UI
 *     against a server truth of `string[]`.
 *
 * Container-shape convention: every set is a frozen `as const` tuple
 * narrowed by `satisfies readonly <Union>[]`, so the tuple and the union it
 * derives can never disagree. Membership is tested with the exported type
 * guards, never by rebuilding a `Set` at a call site — the previous
 * `ReadonlySet` / `readonly []` / `as const` three-way split was itself a
 * drift vector.
 *
 * The physical-schema constants (table names, index names, row-id helpers)
 * are NOT wire vocabulary and stay in `src/db/schema/columns.ts`.
 */

export const RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_TERMINAL_STATES = [
	"succeeded",
	"failed",
	"cancelled",
] as const satisfies readonly RunState[];
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number];

/** True once a run can no longer change state. */
export function isTerminalRunState(state: RunState): state is RunTerminalState {
	return (RUN_TERMINAL_STATES as readonly RunState[]).includes(state);
}

/**
 * Run mode discriminator (pl-0344 step 1 / warren-67b6). `batch` is the
 * historical single-shot run: warren spawns burrow, agent runs to completion,
 * reap pushes the branch. Mode is fixed at run-create time. TS-only narrowing
 * (mx-2ab984); defaults to `batch` so legacy rows written before this column
 * existed match the historical shape. (The retired `interactive` and
 * `conversation` mode values are intentionally dropped from the enum —
 * warren-d622, warren-ee27.)
 */
export const RUN_MODES = ["batch"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/**
 * Steering-message priority classes for the `run_inbox` table (warren-3d0b,
 * pl-829f step 18). Mirrors the seam's `MessagePriority`
 * (`src/runtime/contract.ts`) verbatim so the K8sProvider can forward the
 * contract value straight onto a row without translation. Ordering is
 * `urgent > high > normal > low`; the poll endpoint claims priority-desc then
 * FIFO-by-`seq` within a class. TS-only narrowing — no SQL CHECK (mx-2ab984).
 */
export const INBOX_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type InboxPriority = (typeof INBOX_PRIORITIES)[number];

/**
 * Delivery lifecycle for a `run_inbox` row (warren-3d0b). Mirrors the seam
 * `Message.state` union: a fresh steering message is `unread`; the in-pod
 * poll (`GET /runs/:id/inbox`) atomically flips claimed rows to `delivered`;
 * `failed` is reserved for a delivery that could not be completed (symmetry
 * with burrow's inbox lifecycle — LocalProvider parity). TS-only narrowing.
 */
export const INBOX_STATES = ["unread", "delivered", "failed"] as const;
export type InboxState = (typeof INBOX_STATES)[number];

/**
 * Chain-kind discriminator for a run that carries a `parent_run_id`
 * (warren-e96f). Both kinds share the parent back-link column but differ in
 * workspace semantics:
 *
 *   - `continue` (warren-4b11) — the new run's workspace is seeded from the
 *     parent run's pushed branch; a follow-up turn that builds on prior work.
 *   - `replicate` (warren-e96f) — the new run is a fresh re-dispatch of the
 *     parent's exact agent / model / project / prompt against the project's
 *     default base (NOT the parent's pushed branch). Independent of whatever
 *     the parent did — the parent might have failed before pushing.
 *
 * Nullable on the row: root runs (no parent) leave it null. TS-only narrowing
 * (mx-2ab984); no SQL CHECK. Set at run-create time and never mutated.
 */
export const CLONE_KINDS = ["replicate", "continue"] as const;
export type CloneKind = (typeof CLONE_KINDS)[number];

/**
 * Failure-cause discriminator for a `failed` run (warren-3c40, warren-5165).
 * `state:failed` alone can't tell several different failure shapes apart.
 * Reap infers from the warren state on entry plus event content:
 *
 *   - still `queued` on entry ⇒ no events ever flowed from burrow ⇒
 *     `never_started` (config/runtime issue, e.g. under-specified prompt).
 *   - `running` on entry but events table holds no model-turn output
 *     (`text` / `thinking` / `tool_use` on stdout) ⇒ `no_model_response`
 *     (typically a credential/auth failure — the original warren-5165
 *     symptom was claude-code emitting an init system event then exiting
 *     with "Not logged in" before any assistant turn — but also covers
 *     rate-limit and provider-network failures).
 *   - `running` on entry with model output ⇒ `crashed` (agent ran and
 *     hit an unrecoverable error mid-conversation).
 *   - `timed_out` (warren-285d) is set by the heartbeat watchdog
 *     (src/runs/watchdog.ts) when a `running` run goes silent-but-busy
 *     past `WARREN_RUN_HEARTBEAT_TIMEOUT_MS` — e.g. a runaway gate command
 *     behind a stuck bash tool. The watchdog cancels the burrow run and
 *     reaps it `failed` so the sandbox process tree is torn down instead
 *     of pinning CPU forever. burrow itself reports no separate timeout
 *     state, so warren owns the deadline.
 *   - `burrow_run_lost` (warren-b1a9) means burrow returned 404 for the
 *     run's `burrow_run_id` — typically a warren-machine restart that
 *     wiped burrow's in-memory run state. The reconciler (bootBridges)
 *     and the bridge's mid-stream 404 catch both mark the warren row
 *     `failed` with this reason instead of looping forever.
 *   - `burrow_unreachable` (warren-af76) means burrow stayed up but
 *     unresponsive — the socket probe timed out, so the bridge errored
 *     with `burrowRunMissing:false` and reconnected with no forward
 *     progress past `BRIDGE_STALL_CEILING` consecutive attempts. The
 *     reconnect loop gives up and finalizes the warren row `failed` with
 *     this reason instead of spinning forever (the run otherwise wedges
 *     in `running`). Distinct from `burrow_run_lost`, which is a clean
 *     404; here burrow never answered at all.
 *   - `dropped_commit` (warren-72b9) means reap's `git push` landed zero
 *     commits ahead of the base branch (`reap.empty_push`) AND the
 *     workspace tree was still dirty at reap — the agent edited/staged
 *     work but never ran `git commit` (the common weak-model failure,
 *     e.g. Gemini Flash narrating "before committing" then exiting).
 *     Distinguished from a deliberate no-op — a clean tree with zero
 *     commits, OR a dirty tree whose ONLY uncommitted paths are
 *     warren-managed bookkeeping artifacts (`.mulch/`, `.seeds/`;
 *     warren-89b0) — which stays `succeeded` and
 *     is surfaced as `noChanges` on `reap.empty_push` / `reap.completed`.
 *     The dropped-commit guard stays conservative: any non-bookkeeping
 *     dirty path (real uncommitted work) still fails the run. Marking a
 *     genuine dropped commit `failed` keeps it
 *     commit from masquerading as success and, on plan-runs, fails the
 *     plan instead of silently auto-merging/advancing past the child.
 *   - `finalize_failed` (warren-495d) means reap's finalize did NOT
 *     complete its branch push before it timed out or failed — under K8s
 *     the in-pod finalize round-trip (git push → mirror deltas → POST the
 *     result) can time out (`WARREN_K8S_FINALIZE_TIMEOUT_MS`, default
 *     120s) or the pod can vanish / reach a terminal phase before it
 *     posts a result, yielding a structured FAILED `FinalizeResult` with
 *     `pushed:false`. Marking the run `failed` (instead of letting it
 *     masquerade as `succeeded`) keeps a run whose commits never reached
 *     origin from reporting success — and pairs with reap PRESERVING the
 *     workspace (skipping `terminate`) so the agent's commits stay
 *     recoverable instead of being silently destroyed. Distinct from
 *     `dropped_commit` (push succeeded but landed zero commits over a
 *     still-dirty tree): here the push itself never completed.
 *   - `finalize_unposted` (warren-5ea1) means the K8s in-pod finalize
 *     never POSTed a result at all — the pod reached a terminal phase
 *     (or vanished, or the round-trip timed out) while warren was still
 *     waiting, so reap's `FinalizeResult` is the provider's synthesized
 *     degradation, not a pod-computed collection. The canonical trigger:
 *     the agent process exited WITHOUT its terminal envelope reaching
 *     warren (a severed/lost event stream), so no reap intent was ever
 *     parked while the pod was alive to serve it. Distinct from
 *     `finalize_failed` (the pod DID post a result whose branch-push
 *     stage failed, e.g. a rejected/non-fast-forward push — warren-b94b's
 *     class): the two look identical at the stage level but
 *     `finalize_unposted` means the workspace died with the pod, so the
 *     only recovery path is the salvage bundle/rescue ref the pod POSTed
 *     before exiting (surfaced on `reap.completed`'s `salvage` payload).
 *   - `provider_error` (warren-edc3) means the agent's terminal model
 *     turn ended with `stopReason === "error"` and a non-empty provider
 *     `errorMessage` (e.g. Anthropic `400` "Your credit balance is too
 *     low to access the Anthropic API"). Burrow sees the agent process
 *     exit 0 and marks the run `succeeded`, so the in-stream terminal
 *     detect (warren-e281 / pl-5516, which keys off the `agent_end`
 *     envelope) misses it when the error signal rides the per-turn
 *     `turn_end` envelope instead. Reap's safety net scans the persisted
 *     event log for the terminal error turn and flips an otherwise-
 *     `succeeded` run to `failed`, blocking the bookkeeping-only PR /
 *     seed close / plan-run advance. The provider message is surfaced on
 *     the `reap.provider_error` event; `failure_reason` carries only the
 *     discriminator (the column is enum-narrowed, not free text).
 *   - `oom_killed` (warren-9cce) means the agent container was cgroup
 *     OOM-killed — burrow's `oomKilled()` probe or the K8s
 *     `terminated.reason=="OOMKilled"` signal, carried through the run-state
 *     probe's `terminalReason` onto the finalized row.
 *   - `sandbox_failed` (warren-daef) means the sandbox PRIMITIVE itself
 *     broke before the agent ever ran — bwrap could not create the
 *     namespace (user namespaces disabled, missing setuid bit, AppArmor
 *     policy) or sandbox-exec refused the profile, so the run died with
 *     the sandbox's own error on stderr and zero model turns. Reap
 *     infers it from a bwrap/sandbox-exec error line on `stream=stderr`
 *     when no model-turn output exists, so a broken host stops
 *     masquerading as `no_model_response` (which reads as a
 *     credential/provider fault and sends the operator down the wrong
 *     debugging path). Distinct from `no_model_response` (the agent
 *     started but produced nothing) and `never_started` (the bridge
 *     never claimed the row).
 *   - `evicted` (warren-c0cd) means the kubelet evicted the run pod under node
 *     resource pressure (K8s `status.reason=="Evicted"`) — most often
 *     ephemeral-storage exhaustion (the emptyDir workspace outgrowing its
 *     budget). K8s-only; distinct from `oom_killed` (a container cgroup kill)
 *     and `crashed` (an agent fault) because an eviction is an infra-capacity
 *     signal. Surfaced via the run-state probe's `terminalReason`.
 *
 * Null on succeeded/cancelled rows.
 */
export const RUN_FAILURE_REASONS = [
	"never_started",
	"no_model_response",
	"sandbox_failed",
	"crashed",
	"timed_out",
	"burrow_run_lost",
	"burrow_unreachable",
	"dropped_commit",
	"finalize_failed",
	"finalize_unposted",
	"provider_error",
	"oom_killed",
	"evicted",
] as const;
export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];

export const EVENT_STREAMS = ["stdout", "stderr", "system"] as const;
export type EventStream = (typeof EVENT_STREAMS)[number];

/**
 * Registry provenance stamped onto an agent row by the server
 * (warren-f6ad / readAgentSource). Two tiers: built-in agents shipped
 * inline (`"builtin"`) and same-named library overrides (`"library"`).
 * The per-project `.canopy/` tier was removed in warren-f787.
 */
export const AGENT_SOURCES = ["builtin", "library"] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

/**
 * The `GET /agents` row shape as every consumer sees it (warren-4253 /
 * pl-b82d). Not enum-shaped like the rest of this file, but it crosses the
 * same wire and drifted the same way: the UI typed the hoisted
 * `description` / `provider` / `model` trio while the SDK's hand-copy
 * lacked all three. Declared once here; `src/client/types.ts` and
 * `src/ui/src/api/types.ts` re-export it.
 *
 * Field notes (server truth: `DecoratedAgent` in
 * `src/server/handlers/agents.ts`):
 *
 *   - `renderedJson` is OPTIONAL: the public projection drops the whole
 *     rendered envelope for a `readPublic`-only spectator (warren-4f6c),
 *     so operator surfaces must test presence.
 *   - `description` / `provider` / `model` are the frontmatter facts
 *     hoisted out of `renderedJson` onto the row (warren-4f6c) so both
 *     audiences get them; null when the frontmatter declares none.
 *   - `source` is decorated by the server (warren-f6ad /
 *     `readAgentSource`).
 *
 * The drizzle `agents` table row is a DIFFERENT shape (physical schema,
 * not wire vocabulary) and lives in `src/db/schema/` as `AgentDbRow`.
 */
export interface AgentRow {
	name: string;
	renderedJson?: unknown;
	registeredAt: string;
	lastRefreshed: string;
	description: string | null;
	provider: string | null;
	model: string | null;
	source?: AgentSource;
}

/**
 * Preview environment lifecycle (R-19 / docs/design/preview-environments.md).
 *
 *   - `starting`    — `preview_launch` sub-step has spawned the sidecar
 *                     command in burrow; readiness probe hasn't returned
 *                     2xx yet.
 *   - `live`        — readiness probe succeeded; the host reverse proxy
 *                     can route requests to `preview_port`.
 *   - `failed`      — sidecar exited or readiness probe timed out;
 *                     `preview_failure_message` holds the stderr tail.
 *   - `torn-down`   — eviction worker or manual teardown stopped the
 *                     sidecar and released the port. Workspace stays.
 *
 * TS-only narrowing — no SQL CHECK constraint (mx-2ab984). Null on rows
 * for projects that haven't opted into previews.
 */
export const PREVIEW_STATES = ["starting", "live", "failed", "torn-down"] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

/** Preview states whose sidecar is still holding a port (UI polls these). */
export const PREVIEW_ACTIVE_STATES = [
	"starting",
	"live",
] as const satisfies readonly PreviewState[];
export type PreviewActiveState = (typeof PREVIEW_ACTIVE_STATES)[number];

/** True while a preview environment still owns a sidecar + port. */
export function isActivePreviewState(state: PreviewState): state is PreviewActiveState {
	return (PREVIEW_ACTIVE_STATES as readonly PreviewState[]).includes(state);
}

/**
 * Plan-run lifecycle (pl-a258 step 2 / warren-4d7c). One row per dispatched
 * `sd plan` walk; the coordinator (warren-2623) advances the row through
 * these states as it executes each child seed sequentially:
 *
 *   - `queued`     — row inserted by POST /plan-runs; first tick will flip
 *                    to `running` and dispatch the lowest-seq child.
 *   - `running`    — at least one child has been dispatched. The row stays
 *                    here until every child is `merged` / `skipped`, OR a
 *                    child terminal-fails / its PR closes without merge.
 *   - `succeeded`  — every child reached `merged` or `skipped`.
 *   - `failed`     — a child terminal-failed or its PR closed unmerged;
 *                    `failure_reason` carries the discriminator.
 *   - `cancelled`  — operator hit POST /plan-runs/:id/cancel.
 *
 * TS-only narrowing — no SQL CHECK constraint (mx-2ab984).
 */
export const PLAN_RUN_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type PlanRunState = (typeof PLAN_RUN_STATES)[number];

export const PLAN_RUN_TERMINAL_STATES = [
	"succeeded",
	"failed",
	"cancelled",
] as const satisfies readonly PlanRunState[];
export type PlanRunTerminalState = (typeof PLAN_RUN_TERMINAL_STATES)[number];

/** Plan-run states the coordinator still ticks (UI polls these). */
export const PLAN_RUN_ACTIVE_STATES = [
	"queued",
	"running",
] as const satisfies readonly PlanRunState[];
export type PlanRunActiveState = (typeof PLAN_RUN_ACTIVE_STATES)[number];

/** True once a plan-run walk can no longer advance. */
export function isTerminalPlanRunState(state: PlanRunState): state is PlanRunTerminalState {
	return (PLAN_RUN_TERMINAL_STATES as readonly PlanRunState[]).includes(state);
}

/**
 * Per-child lifecycle within a plan-run (pl-a258 step 2 / warren-4d7c).
 *
 *   - `pending`    — child seed not yet dispatched; waiting for its turn.
 *   - `dispatched` — coordinator called spawnRun and stamped `run_id`; the
 *                    warren run row may still be `queued` at this instant.
 *   - `running`    — the linked run reached `running`.
 *   - `pr_open`    — the linked run succeeded and reap opened a PR (or
 *                    landed a zero-commit "trivially merged" push).
 *   - `merged`     — PR merged (poll-confirmed via GitHub) OR the
 *                    trivial-merge path advanced directly.
 *   - `failed`     — the linked run terminal-failed, the PR closed
 *                    unmerged, or the dispatch itself errored.
 *   - `skipped`    — resume semantics (warren-fcc9): the child's seed was
 *                    already `closed` at dispatch time, so the coordinator
 *                    advanced without spawning a run.
 *
 * TS-only narrowing — no SQL CHECK constraint (mx-2ab984).
 */
export const PLAN_RUN_CHILD_STATES = [
	"pending",
	"dispatched",
	"running",
	"pr_open",
	"merged",
	"failed",
	"skipped",
] as const;
export type PlanRunChildState = (typeof PLAN_RUN_CHILD_STATES)[number];

export const PLAN_RUN_CHILD_TERMINAL_STATES = [
	"merged",
	"failed",
	"skipped",
] as const satisfies readonly PlanRunChildState[];
export type PlanRunChildTerminalState = (typeof PLAN_RUN_CHILD_TERMINAL_STATES)[number];

/** True once a plan-run child can no longer advance. */
export function isTerminalPlanRunChildState(
	state: PlanRunChildState,
): state is PlanRunChildTerminalState {
	return (PLAN_RUN_CHILD_TERMINAL_STATES as readonly PlanRunChildState[]).includes(state);
}
