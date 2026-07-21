/**
 * Dialect-agnostic schema constants shared between the SQLite and Postgres
 * physical schemas (R-13, pl-f17e step 2).
 *
 * Drizzle has no shared sqlite/pg table builder — pg-core's `pgTable` and
 * sqlite-core's `sqliteTable` are different modules with different column
 * functions. The shared layer therefore lives at the metadata level: enum
 * tuples, type unions, and table/index name strings that both physical
 * schemas import. Drift between the two schemas is caught by
 * `src/db/schema/drift.test.ts` (acceptance #6).
 *
 * Repos and consumers continue to import from `../db/schema.ts`, which
 * re-exports these constants alongside the SQLite tables (today's runtime).
 * Step 3 (warren-a66e) adds dialect-aware `openDatabase`; until then, the
 * Postgres tables exist but are unused at runtime.
 */

export const RUN_STATES = [
	"queued",
	"running",
	"paused",
	"succeeded",
	"failed",
	"cancelled",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_TERMINAL_STATES = [
	"succeeded",
	"failed",
	"cancelled",
] as const satisfies readonly RunState[];
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number];

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
 * Conversation lifecycle status (warren-0b91). A
 * conversation stays `active` across re-wakes (the anchoring run may go
 * terminal and be respawned without closing the conversation); it flips
 * to `closed` only on send-off (warren-756d) or operator close. TS-only
 * narrowing — no SQL CHECK (mx-2ab984).
 */
export const CONVERSATION_STATES = ["active", "closed"] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

/**
 * Role discriminator for a persisted conversation turn
 * (warren-0b91). `user` is an operator turn delivered over the steering
 * channel; `assistant` is a leveret reply captured off the stream;
 * `system` is a host-written marker (e.g. re-wake replay); `tool` carries
 * a structured tool turn. TS-only narrowing — no SQL CHECK.
 */
export const MESSAGE_ROLES = ["user", "assistant", "system", "tool"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

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
 *     warren-managed bookkeeping artifacts (`.mulch/`, `.seeds/`,
 *     `.plot/`, `.canopy/`; warren-89b0) — which stays `succeeded` and
 *     is surfaced as `noChanges` on `reap.empty_push` / `reap.completed`.
 *     The dropped-commit guard stays conservative: any non-bookkeeping
 *     dirty path (real uncommitted work) still fails the run. Marking a
 *     genuine dropped commit `failed` keeps it
 *     commit from masquerading as success and, on plan-runs, fails the
 *     plan instead of silently auto-merging/advancing past the child.
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
 *   - `oom_killed` (warren-9cce) means the agent container was cgroup
 *     OOM-killed — burrow's `oomKilled()` probe or the K8s
 *     `terminated.reason=="OOMKilled"` signal, carried through the run-state
 *     probe's `terminalReason` onto the finalized row.
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
	"crashed",
	"timed_out",
	"burrow_run_lost",
	"burrow_unreachable",
	"dropped_commit",
	"finalize_failed",
	"provider_error",
	"oom_killed",
	"evicted",
] as const;
export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];

export const EVENT_STREAMS = ["stdout", "stderr", "system"] as const;
export type EventStream = (typeof EVENT_STREAMS)[number];

/**
 * Preview environment lifecycle (R-19 / SPEC §11.L).
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

/**
 * Shape of the `plots.state_json` blob (warren-9022). The plots table is
 * a read-CACHE that mirrors full git-backed
 * Plot state (`.plot/<id>.json` + `<id>.events.jsonl`), NOT an authoritative
 * store — source of truth stays git. The JSON blob holds the entire plot
 * state object so the table schema stays stable as the plot section shape
 * drifts (no migration per shape change). The promoted scalar columns
 * (id / project_id / status / title / updated_at) are denormalized out of
 * this blob purely to back list / index queries. Typed as an opaque JSON
 * object: warren never narrows the blob's interior — the plot-cli shape is
 * the source of truth and the projection round-trips it verbatim.
 *
 * Deliberately NOT modeled (open question, settled here): no event
 * count / last-seq summary columns. Consumers that need event rollups read
 * the git-backed `<id>.events.jsonl`; promoting them would re-introduce the
 * per-shape-drift coupling the JSON blob exists to avoid.
 */
export type PlotProjectionState = Record<string, unknown>;

/**
 * Physical table names. Centralized so the two dialect modules and the drift
 * check stay in lockstep — renaming a table is a one-line change here.
 */
export const TABLE_NAMES = {
	agents: "agents",
	projects: "projects",
	runs: "runs",
	events: "events",
	triggers: "triggers",
	planRuns: "plan_runs",
	planRunChildren: "plan_run_children",
	plots: "plots",
	conversations: "conversations",
	messages: "messages",
	runInbox: "run_inbox",
} as const;

/**
 * Physical index names. The drift check matches on these strings exactly;
 * if a new index is added to one dialect it must be added to the other with
 * the same name and column list.
 */
export const INDEX_NAMES = {
	projectsGitUrl: "projects_git_url_idx",
	runsState: "runs_state_idx",
	runsProjectStarted: "runs_project_started_idx",
	runsAgentStarted: "runs_agent_started_idx",
	runsWorkerState: "runs_worker_state_idx",
	runsPlotId: "runs_plot_id_idx",
	runsMode: "runs_mode_idx",
	// warren-0b75: the CI-fixer poller counts prior fixer attempts per PR by
	// `runs.pr_url` (fixAttemptHistoryByPrUrl) and enumerates PR candidates by
	// project. Index the column the poller filters on so the per-tick attempt
	// count stays a covered lookup instead of a full-table scan.
	runsPrUrl: "runs_pr_url_idx",
	eventsRunSeq: "events_run_seq_idx",
	eventsRunTs: "events_run_ts_idx",
	triggersProject: "triggers_project_idx",
	// R-03 step 1 (pl-fef5, warren-094a): agents are addressed by (name,
	// project_id). The composite enforces uniqueness for project-tier rows
	// (project_id non-null). The partial index enforces a single global row
	// per name; SQLite's NULL-distinct semantics mean the composite alone
	// would let two rows with (NULL, "claude-code") coexist.
	agentsProjectName: "agents_project_name_idx",
	agentsGlobalName: "agents_global_name_idx",
	// pl-a258 step 2 (warren-4d7c). plan_runs walk is sequential per project;
	// `plan_runs_project_state` powers the API's listByProjectAndState filter
	// and `plan_runs_state` powers the coordinator's `listActive()` (queued |
	// running) call. plan_run_children rolls up by (plan_run_id, state) for
	// `pickNextPending` and the detail page's child counts; `plan_run_children_run`
	// reverses the run_id → child lookup the reap path uses.
	planRunsProjectState: "plan_runs_project_state_idx",
	planRunsState: "plan_runs_state_idx",
	planRunsPlotId: "plan_runs_plot_id_idx",
	planRunChildrenRun: "plan_run_children_run_idx",
	planRunChildrenState: "plan_run_children_state_idx",
	// warren-9022. The plots projection is queried two ways:
	// `plots_project_updated` powers the per-project list ordered by recency
	// (composite (project_id, updated_at) serves both ASC and DESC scans), and
	// `plots_status` powers status-filtered rollups across a project.
	plotsProjectUpdated: "plots_project_updated_idx",
	plotsStatus: "plots_status_idx",
	// warren-0b91. Conversations list by project (recency via
	// last_activity_at scan off the project predicate) and by Plot binding
	// (N:1 conversations per Plot). Messages page strictly by (conversation,
	// seq) — the monotonic transcript order the re-wake replay reads back.
	conversationsProject: "conversations_project_idx",
	conversationsPlot: "conversations_plot_idx",
	messagesConversationSeq: "messages_conversation_seq_idx",
	// warren-3d0b. The run_inbox poll claims unread rows for one run
	// (`GET /runs/:id/inbox`): the composite (run_id, state) makes the
	// undelivered-per-run claim a covered index scan instead of a full-table
	// filter, and FIFO ordering within the claimed set is done in-app by seq.
	runInboxRunState: "run_inbox_run_state_idx",
} as const;

/**
 * Build the composite PK from a project + trigger pair. The colon separator
 * matches the plan's `<projectId>:<triggerId>` shape so a row key can be read
 * back into its components without consulting the columns.
 */
export function makeTriggerRowId(projectId: string, triggerId: string): string {
	return `${projectId}:${triggerId}`;
}
