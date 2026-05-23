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
 * reap pushes the branch. `interactive` is the respawn-per-turn primitive
 * powering brainstorm + planner agents (pl-0344 step 3 / warren-1117) — each
 * user message dispatches a fresh burrow turn that reads Plot context, replies,
 * and exits. Mode is fixed at run-create time. TS-only narrowing (mx-2ab984);
 * defaults to `batch` so legacy rows written before this column existed match
 * the historical shape.
 */
export const RUN_MODES = ["batch", "interactive"] as const;
export type RunMode = (typeof RUN_MODES)[number];

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
 *   - `timed_out` is reserved for a future deadline-based reaper — burrow
 *     doesn't currently report a separate timeout state.
 *   - `burrow_run_lost` (warren-b1a9) means burrow returned 404 for the
 *     run's `burrow_run_id` — typically a warren-machine restart that
 *     wiped burrow's in-memory run state. The reconciler (bootBridges)
 *     and the bridge's mid-stream 404 catch both mark the warren row
 *     `failed` with this reason instead of looping forever.
 *
 * Null on succeeded/cancelled rows.
 */
export const RUN_FAILURE_REASONS = [
	"never_started",
	"no_model_response",
	"crashed",
	"timed_out",
	"burrow_run_lost",
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
 * Worker state machine (warren-b0a3 / pl-9ba1 step 1).
 *
 *   - `healthy`     — probe succeeded; eligible for new burrow placement.
 *   - `draining`    — operator-initiated; existing burrows continue to run,
 *                     but `placeFor` skips this worker for new placement.
 *                     Set by `POST /workers/:name/drain` (step 6).
 *   - `unreachable` — probe failed; sticky-by-burrow requests against this
 *                     worker fail loudly rather than silently migrating
 *                     (plan risk #5). Flipped back to `healthy` when probe
 *                     recovers (step 6).
 *
 * A fourth `failed` state is deferred to a future R-NN (plan step 1 prose).
 */
export const WORKER_STATES = ["healthy", "draining", "unreachable"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

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
 * Physical table names. Centralized so the two dialect modules and the drift
 * check stay in lockstep — renaming a table is a one-line change here.
 */
export const TABLE_NAMES = {
	agents: "agents",
	projects: "projects",
	runs: "runs",
	events: "events",
	triggers: "triggers",
	workers: "workers",
	burrows: "burrows",
	planRuns: "plan_runs",
	planRunChildren: "plan_run_children",
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
	eventsRunSeq: "events_run_seq_idx",
	eventsRunTs: "events_run_ts_idx",
	triggersProject: "triggers_project_idx",
	burrowsWorker: "burrows_worker_idx",
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
} as const;

/**
 * Build the composite PK from a project + trigger pair. The colon separator
 * matches the plan's `<projectId>:<triggerId>` shape so a row key can be read
 * back into its components without consulting the columns.
 */
export function makeTriggerRowId(projectId: string, triggerId: string): string {
	return `${projectId}:${triggerId}`;
}
