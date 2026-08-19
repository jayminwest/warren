/**
 * Dialect-agnostic schema constants shared between the SQLite and Postgres
 * physical schemas (R-13, pl-f17e step 2).
 *
 * Drizzle has no shared sqlite/pg table builder — pg-core's `pgTable` and
 * sqlite-core's `sqliteTable` are different modules with different column
 * functions. The shared layer therefore lives at the metadata level: enum
 * tuples, type unions, and table/index name strings that both physical
 * schemas import from one place. Drift between the two schemas is caught by
 * `src/db/schema/drift.test.ts` (acceptance #6).
 *
 * Repos and consumers continue to import from `../db/schema.ts`, which
 * re-exports these constants alongside the SQLite tables (today's runtime).
 * Step 3 (warren-a66e) adds dialect-aware `openDatabase`; until then, the
 * Postgres tables exist but are unused at runtime.
 *
 * Enum tuples and their type unions are NOT defined here — they are the
 * canonical wire vocabulary and live in `src/core/wire.ts` (warren-b229),
 * the dependency-free kernel module the SDK and the browser UI can both
 * import. This file re-exports them so every `../db/schema.ts` consumer
 * keeps working unchanged; what it still OWNS is the physical-schema
 * metadata below (table names, index names, row-id helpers), which never
 * crosses the wire.
 */

export * from "../../core/wire.ts";

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
	runInbox: "run_inbox",
	toolCalls: "tool_calls",
	// warren-36e7 / pl-a37b Track A: one insert-only fact row per dispatched
	// run. PK is run_id; cascade on runs delete matches tool_calls.
	dispatchContext: "dispatch_context",
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
	runsMode: "runs_mode_idx",
	// warren-0b75: the CI-fixer poller counts prior fixer attempts per PR by
	// `runs.pr_url` (fixAttemptHistoryByPrUrl) and enumerates PR candidates by
	// project. Index the column the poller filters on so the per-tick attempt
	// count stays a covered lookup instead of a full-table scan.
	runsPrUrl: "runs_pr_url_idx",
	eventsRunSeq: "events_run_seq_idx",
	eventsRunTs: "events_run_ts_idx",
	// warren-55cf: the healer counts prior heal.dispatched attempts per alert
	// fingerprint with a `kind = ?` predicate, so index the kind it filters on
	// (newest-first by ts) instead of scanning the whole events table.
	eventsKindTs: "events_kind_ts_idx",
	triggersProject: "triggers_project_idx",
	// warren-f787: agents are identified by `name` alone (the project tier
	// and its `project_id` column were removed). A single unique index on
	// name enforces registry identity.
	agentsName: "agents_name_idx",
	// pl-a258 step 2 (warren-4d7c). plan_runs walk is sequential per project;
	// `plan_runs_project_state` powers the API's listByProjectAndState filter
	// and `plan_runs_state` powers the coordinator's `listActive()` (queued |
	// running) call. plan_run_children rolls up by (plan_run_id, state) for
	// `pickNextPending` and the detail page's child counts; `plan_run_children_run`
	// reverses the run_id → child lookup the reap path uses.
	planRunsProjectState: "plan_runs_project_state_idx",
	planRunsState: "plan_runs_state_idx",
	planRunChildrenRun: "plan_run_children_run_idx",
	planRunChildrenState: "plan_run_children_state_idx",
	// warren-3d0b. The run_inbox poll claims unread rows for one run
	// (`GET /runs/:id/inbox`): the composite (run_id, state) makes the
	// undelivered-per-run claim a covered index scan instead of a full-table
	// filter, and FIFO ordering within the claimed set is done in-app by seq.
	runInboxRunState: "run_inbox_run_state_idx",
	// warren-7746. The tool_calls rollup writes one row per tool_use event
	// and joins each tool_result back by (run_id, tool_use_id); the unique
	// (run_id, seq) index doubles as the backfill idempotency guard (one
	// row per tool_use event, INSERT ON CONFLICT DO NOTHING) and covers the
	// analytics read's (run_id, seq) ordering. The (run_id, tool_use_id)
	// index keeps the result-join UPDATE a covered lookup.
	toolCallsRunSeq: "tool_calls_run_seq_idx",
	toolCallsRunUseId: "tool_calls_run_use_id_idx",
	// warren-36e7. GET /analytics/dispatch (warren-5423) windows on
	// created_at, not started_at, so never-started dispatches stay visible.
	dispatchContextCreatedAt: "dispatch_context_created_at_idx",
} as const;

/**
 * Build the composite PK from a project + trigger pair. The colon separator
 * matches the plan's `<projectId>:<triggerId>` shape so a row key can be read
 * back into its components without consulting the columns.
 */
export function makeTriggerRowId(projectId: string, triggerId: string): string {
	return `${projectId}:${triggerId}`;
}
