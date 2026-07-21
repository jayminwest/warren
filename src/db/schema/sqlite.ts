/**
 * SQLite physical schema for warren's durable state (SPEC §9).
 *
 * Tables: agents (canopy registry cache), projects (cloned repos), runs
 * (warren-side run rows that mirror burrow's lifecycle), events (write-through
 * cache of burrow's stream — see SPEC §9 "event durability rationale"), triggers
 * (R-06 scheduler bookkeeping), planRuns + planRunChildren, plots, and
 * runInbox. The conversations + messages tables were dropped in
 * warren-d93e (0030) as part of the conversations deletion pass
 * (pl-3a79). The workers + burrows multi-worker placement
 * tables were dropped in warren-3743 (0028) once LocalProvider absorbed the
 * single-burrow runtime; `runs.worker_id` is retained (nullable, unwritten)
 * for historical rows only.
 *
 * Timestamps are ISO8601 TEXT, mirroring the burrow event envelope `ts` field
 * so we don't translate at the stream boundary. JSON columns use drizzle's
 * `mode: "json"` (stored as TEXT under the hood; drizzle (de)serializes); the
 * Postgres mirror uses `jsonb`.
 *
 * Constants and table/index names live in `./columns.ts`; the parallel pg
 * physical schema is in `./postgres.ts`. Drift between the two is caught by
 * `./drift.test.ts`.
 */

import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { PlotProjectionState } from "./columns.ts";
import {
	CLONE_KINDS,
	EVENT_STREAMS,
	INBOX_PRIORITIES,
	INBOX_STATES,
	INDEX_NAMES,
	PLAN_RUN_CHILD_STATES,
	PLAN_RUN_STATES,
	PREVIEW_STATES,
	RUN_FAILURE_REASONS,
	RUN_MODES,
	RUN_STATES,
	TABLE_NAMES,
} from "./columns.ts";

/**
 * Canopy registry cache. Three tiers of rows live here, addressed by
 * (name, project_id):
 *
 *   - built-in   (`source = 'builtin'`)        — `project_id IS NULL`
 *   - library    (`source = 'library'`)        — `project_id IS NULL`
 *   - project    (`source = 'project:<id>'`)   — `project_id = <id>`
 *
 * R-03 (pl-fef5, warren-094a) replaced the single-column `name` primary
 * key with a synthetic rowid PK so the project tier can carry duplicate
 * names across projects. Identity is enforced at the index layer:
 *
 *   - composite unique on (project_id, name) for project-tier rows.
 *   - partial unique on (name) WHERE project_id IS NULL for the global
 *     tier — SQLite treats NULL as distinct in plain unique indexes, so
 *     the composite alone would allow two `(NULL, "claude-code")` rows.
 *
 * `runs.agent_name` used to FK to `agents.name`; with composite identity
 * the FK is unrepresentable in SQLite (no composite FK from a single
 * column), so it was dropped. The agents table is a soft cache —
 * spawn-time lookups fall back to "global" if a project-tier row is
 * missing and `POST /agents/refresh` re-discovers from canopy.
 */
export const agents = sqliteTable(
	TABLE_NAMES.agents,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		renderedJson: text("rendered_json", { mode: "json" }).notNull(),
		registeredAt: text("registered_at").notNull(),
		lastRefreshed: text("last_refreshed").notNull(),
	},
	(t) => [
		uniqueIndex(INDEX_NAMES.agentsProjectName).on(t.projectId, t.name),
		uniqueIndex(INDEX_NAMES.agentsGlobalName).on(t.name).where(sql`${t.projectId} IS NULL`),
	],
);

export const projects = sqliteTable(
	TABLE_NAMES.projects,
	{
		id: text("id").primaryKey(),
		gitUrl: text("git_url").notNull(),
		localPath: text("local_path").notNull(),
		defaultBranch: text("default_branch").notNull(),
		addedAt: text("added_at").notNull(),
		lastFetchedAt: text("last_fetched_at"),
		lastHeadSha: text("last_head_sha"),
		// Plot opt-in gating flag (warren-4e20). True iff a `.plot/` directory
		// exists at the clone root at the time of the most recent
		// addProject / refreshProjectClone. The dispatch path reads this to
		// gate `plot_id` validation and PLOT_ID/PLOT_ACTOR env injection
		// (warren-a8c3, warren-e26f). Defaults to false so legacy rows
		// written before this column existed match the no-`.plot/` shape.
		hasPlot: integer("has_plot", { mode: "boolean" }).notNull().default(false),
		// Seeds opt-in gating flag (warren-9990 / pl-a258 step 1). True iff a
		// `.seeds/` directory exists at the clone root at the time of the
		// most recent addProject / refreshProjectClone. The PlanRun API
		// (warren-f923) reads this to reject plan-run dispatch against
		// projects without the issue queue. Defaults to false so legacy rows
		// written before this column existed match the no-`.seeds/` shape.
		hasSeeds: integer("has_seeds", { mode: "boolean" }).notNull().default(false),
	},
	(t) => [index(INDEX_NAMES.projectsGitUrl).on(t.gitUrl)],
);

export const runs = sqliteTable(
	TABLE_NAMES.runs,
	{
		id: text("id").primaryKey(),
		// Plain text, no FK to agents.name. With R-03 (pl-fef5, warren-094a)
		// agents are identified by (name, project_id) rather than a single-
		// column PK, so this FK is no longer representable. The agents table
		// is a soft cache anyway — spawn resolves `(agentName, projectId)`
		// with global fallback at the application layer.
		agentName: text("agent_name").notNull(),
		// Nullable + ON DELETE SET NULL so deleting a project orphans its
		// runs instead of being blocked by the FK. The UI's delete-project
		// dialog promises 'Run history for this project is kept' (warren-5f19);
		// before this change, an FK constraint failure on delete combined
		// with the disk-first ordering in deleteProject left the project
		// row orphaned from its on-disk clone.
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		// Provider-side sandbox id (burrow id under LocalProvider). Load-bearing:
		// the bridge/reconnect path (`bootBridges`, `server/bridge-reconnect.ts`)
		// reads it after a host restart to re-attach the run's live event stream.
		// Nullable — a run that fails before dispatch never gets one.
		burrowId: text("burrow_id"),
		// Provider-side run/dispatch id (burrow run id under LocalProvider).
		// Load-bearing alongside `burrow_id` for the same resume path (it scopes
		// cancel / steer / status against the sandbox). Nullable, same reason.
		burrowRunId: text("burrow_run_id"),
		// Retired multi-worker placement copy (warren-135b / pl-9ba1 step 2).
		// The workers + burrows placement tables were dropped in warren-3743 once
		// LocalProvider absorbed the single-burrow runtime; new runs write NULL.
		// The column is retained (nullable, unwritten) so historical rows keep
		// their value. All reads tolerate NULL (preview / proxy treat null as the
		// local worker). The `runs_worker_state_idx` index is likewise retained.
		workerId: text("worker_id"),
		// Optional back-link to the seeds issue this run was dispatched against
		// (pl-bb70 step 3, warren-805a). Threaded through POST /runs → spawnRun →
		// runs row so the post-dispatch `updateExtensions` write (pl-bb70 step 4)
		// has a seed to merge {role, trigger, lastRunId, lastRunAt} into.
		// Nullable: legacy rows and runs dispatched without a seed leave it null.
		// Plain text (no FK to seeds) — seeds live in the project workspace, not
		// in warren's database, and the seed-id space is per-project.
		seedId: text("seed_id"),
		// Optional back-link to the Plot this run was dispatched against
		// (warren-a8c3, parent warren-000b). Gated on the owning project's
		// `hasPlot` flag at handler-level — POST /runs rejects a plot_id when
		// the project has no `.plot/` directory. When set, the spawn flow
		// (warren-e26f) injects PLOT_ID + PLOT_ACTOR into the sandbox env,
		// emits a `run_dispatched` event into the Plot (warren-e848), and
		// reap mirrors plot deltas back into warren's event stream tagged
		// with this plot_id (warren-7e0f). Nullable: legacy rows and runs
		// dispatched without a plot leave it null. Plain text, no FK — Plots
		// live in the project workspace, not in warren's database.
		plotId: text("plot_id"),
		renderedAgentJson: text("rendered_agent_json", { mode: "json" }).notNull(),
		state: text("state", { enum: RUN_STATES }).notNull(),
		failureReason: text("failure_reason", { enum: RUN_FAILURE_REASONS }),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		prompt: text("prompt").notNull(),
		trigger: text("trigger").notNull(),
		// PR URL filled in by reap's pr_open sub-step (warren-f6af) when the
		// agent's branch push lands real commits and WARREN_AUTO_OPEN_PR is on.
		// Null encodes "no PR was opened" — auto-open disabled, push failed,
		// branch == defaultBranch, no commits ahead, or the GitHub call itself
		// errored (recorded as a `reap_failed` event with step=pr_open).
		prUrl: text("pr_url"),
		// Operator-requested target branch (warren-1f81, #419); null = none.
		targetBranch: text("target_branch"),
		// Per-run cost + token accounting (warren-a7dc). All nullable: only the
		// pi runtime reports session-cumulative stats via get_session_stats today,
		// and even there the value is best-effort (null when the bridge can't
		// snapshot the RPC). Cost is the persisted delta between run-start and
		// run-end snapshots so resumed pi sessions don't double-count prior turns.
		costUsd: real("cost_usd"),
		tokensInput: integer("tokens_input"),
		tokensOutput: integer("tokens_output"),
		tokensCacheRead: integer("tokens_cache_read"),
		tokensCacheWrite: integer("tokens_cache_write"),
		// Per-run preview environment columns (R-19 / SPEC §11.L). All nullable
		// because only projects that opt in via `.warren/defaults.json`'s
		// `preview` block exercise this path; non-opted-in runs leave every
		// field null. Populated by reap's `preview_launch` sub-step, the
		// readiness probe, the host reverse proxy (last_hit_at), and the
		// eviction worker / manual teardown route. ISO8601 TEXT mirrors the
		// existing started_at/ended_at convention so cross-dialect passthrough
		// (mx-845f11) stays lossless.
		previewState: text("preview_state", { enum: PREVIEW_STATES }),
		previewPort: integer("preview_port"),
		previewStartedAt: text("preview_started_at"),
		previewLastHitAt: text("preview_last_hit_at"),
		previewFailureMessage: text("preview_failure_message"),
		// Run mode discriminator (pl-0344 step 1 / warren-67b6). `batch` is the
		// historical single-shot run; `interactive` is the respawn-per-turn
		// primitive (pl-0344 step 3 / warren-1117). Fixed at run-create time.
		// Defaults to `batch` so legacy rows match the historical shape.
		mode: text("mode", { enum: RUN_MODES }).notNull().default("batch"),
		// Pause bookkeeping (pl-0344 step 1 / warren-67b6). Populated when the
		// supervisor (pl-0344 step 5 / warren-2976) detects a blocking
		// `question_posed` event on the linked Plot and transitions the run
		// `running → paused`. `paused_at` is the ISO8601 transition timestamp;
		// `paused_question_event_id` is the Plot event id awaiting an answer.
		// Both nullable: only set while the run is in the `paused` state. On
		// resume (`paused → running`), the row may keep or clear these — the
		// supervisor clears them once the answering turn is dispatched.
		pausedAt: text("paused_at"),
		pausedQuestionEventId: text("paused_question_event_id"),
		// Continuation back-link (warren-4b11): when an operator re-runs a
		// terminated run "with a follow-up", the new run is spawned with the
		// prior run's pushed branch as the workspace base (instead of the
		// project default branch). This column records which run this one
		// continues from, so the UI can render a chain indicator and chain
		// cost/token totals are derivable by walking the link. Cost/tokens on
		// each run stay independent — they are NOT accumulated with the
		// parent. Nullable: the overwhelming majority of runs are roots.
		// Plain text (no FK) for symmetry with the other run back-links and to
		// keep the column tolerant of a since-deleted parent row.
		parentRunId: text("parent_run_id"),
		// Chain-kind discriminator (warren-e96f). Tells a `parent_run_id`
		// back-link apart: `continue` (warren-4b11) seeds the workspace from the
		// parent's pushed branch; `replicate` re-dispatches its exact config
		// against the project default base. Null for root runs. See `CLONE_KINDS`.
		cloneKind: text("clone_kind", { enum: CLONE_KINDS }),
	},
	(t) => [
		index(INDEX_NAMES.runsState).on(t.state),
		index(INDEX_NAMES.runsProjectStarted).on(t.projectId, sql`${t.startedAt} DESC`),
		index(INDEX_NAMES.runsAgentStarted).on(t.agentName, sql`${t.startedAt} DESC`),
		index(INDEX_NAMES.runsWorkerState).on(t.workerId, t.state),
		index(INDEX_NAMES.runsPlotId).on(t.plotId),
		index(INDEX_NAMES.runsMode).on(t.mode),
		index(INDEX_NAMES.runsPrUrl).on(t.prUrl),
	],
);

export const events = sqliteTable(
	TABLE_NAMES.events,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		runId: text("run_id")
			.notNull()
			.references(() => runs.id),
		burrowEventSeq: integer("burrow_event_seq").notNull(),
		ts: text("ts").notNull(),
		kind: text("kind").notNull(),
		stream: text("stream", { enum: EVENT_STREAMS }),
		payloadJson: text("payload_json", { mode: "json" }).notNull(),
	},
	(t) => [
		index(INDEX_NAMES.eventsRunSeq).on(t.runId, t.burrowEventSeq),
		index(INDEX_NAMES.eventsRunTs).on(t.runId, t.ts),
	],
);

/**
 * R-06 scheduler state (warren-3f59).
 *
 * One row per (project, trigger-id-from-.warren/triggers.yaml). The PK is a
 * composite string `<projectId>:<triggerId>` so the scheduler tick can write
 * back last/next fire timestamps without juggling a separate generated id —
 * the trigger's authoring identity in YAML is what survives across restarts.
 *
 * The trigger definition itself stays in .warren/triggers.yaml (R-02); only
 * mutable scheduler bookkeeping lives here. last_run_id points at the most
 * recent dispatched run (ON DELETE SET NULL so deleting a run row doesn't
 * orphan the trigger). project_id is the cascade root — deleting the project
 * drops its triggers, mirroring the .warren/ clone going away with it.
 */
export const triggers = sqliteTable(
	TABLE_NAMES.triggers,
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		triggerId: text("trigger_id").notNull(),
		lastFiredAt: text("last_fired_at"),
		nextFireAt: text("next_fire_at"),
		lastRunId: text("last_run_id").references(() => runs.id, { onDelete: "set null" }),
	},
	(t) => [index(INDEX_NAMES.triggersProject).on(t.projectId)],
);

/**
 * Plan-run coordinator state (pl-a258 step 2 / warren-4d7c). One row per
 * `POST /plan-runs` dispatch. The coordinator (warren-2623) walks
 * `plan_run_children` in `seq` order, spawning one warren run per open
 * child and waiting for its PR to merge before advancing. `plan_id` is
 * the seeds plan id (pl-XXXX); plain text, no FK, because seeds live in
 * the project workspace, not warren's database.
 *
 * `prompt_template` is rendered per child with `{seed_id}` substitution;
 * `'work on sd {seed_id}'` is the default. `ref` is the branch warren
 * dispatches each child against (null falls back to project.defaultBranch
 * at spawn time). `dispatcher_handle` and `trigger` echo the run rows'
 * shape so the UI can attribute plan runs the same way it does single
 * runs.
 *
 * State machine + transition guards live in `repos/plan-runs.ts` (TS-only
 * narrowing per mx-2ab984; no SQL CHECK).
 */
export const planRuns = sqliteTable(
	TABLE_NAMES.planRuns,
	{
		id: text("id").primaryKey(),
		planId: text("plan_id").notNull(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		agentName: text("agent_name").notNull(),
		promptTemplate: text("prompt_template").notNull().default("work on sd {seed_id}"),
		ref: text("ref"),
		providerOverride: text("provider_override"),
		modelOverride: text("model_override"),
		dispatcherHandle: text("dispatcher_handle").notNull().default("operator"),
		trigger: text("trigger").notNull().default("manual"),
		// Optional back-link to the Plot this plan-run was dispatched against
		// (warren-06dc / pl-7937 Phase 2; mirrors `runs.plot_id`). Gated on the
		// owning project's `hasPlot` flag at handler level. When set, the
		// coordinator forwards it to every child run's spawn input (PLOT_ID/
		// PLOT_ACTOR injection, per-child `run_dispatched`) and auto-transitions
		// the bound Plot to `done` once every child is terminal. Nullable;
		// plain text, no FK — Plots live in the project workspace.
		plotId: text("plot_id"),
		// Back-link to the parent run that created this plan-run via
		// auto_plan_run (warren-d9a2). When set, the coordinator gates on
		// the parent run's PR being merged before dispatching the first
		// child — the parent's branch carries the seeds state the children
		// need. Nullable: manual plan-runs and legacy rows have no parent.
		// Plain text, no FK — ON DELETE behavior is handled by the
		// coordinator (parent row missing → treat as merged and proceed).
		parentRunId: text("parent_run_id"),
		state: text("state", { enum: PLAN_RUN_STATES }).notNull(),
		failureReason: text("failure_reason"),
		createdAt: text("created_at").notNull(),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
	},
	(t) => [
		index(INDEX_NAMES.planRunsProjectState).on(t.projectId, t.state),
		index(INDEX_NAMES.planRunsState).on(t.state),
		index(INDEX_NAMES.planRunsPlotId).on(t.plotId),
	],
);

/**
 * Per-child progress within a plan-run (pl-a258 step 2 / warren-4d7c).
 * Composite PK on (plan_run_id, seq) gives the coordinator's
 * `pickNextPending(planRunId)` an O(1) ordered lookup. `run_id` is null
 * until the coordinator dispatches the child; `ON DELETE SET NULL` so a
 * deleted run orphans the child row instead of breaking referential
 * integrity (mirrors `runs.project_id`'s posture for project deletes).
 *
 * `state` enum is TS-only narrowing (mx-2ab984). Indexes back two query
 * shapes: `(plan_run_id, state)` for `pickNextPending` and the detail
 * page's child-state counts, and `run_id` for the reverse lookup the reap
 * path uses to mark a child PR-open from a run-id event.
 */
export const planRunChildren = sqliteTable(
	TABLE_NAMES.planRunChildren,
	{
		planRunId: text("plan_run_id")
			.notNull()
			.references(() => planRuns.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		seedId: text("seed_id").notNull(),
		runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
		// Execution project the coordinator routed this child to (pl-fb43
		// step 6 / warren-57f6). Nullable (pending/skipped + legacy rows).
		executionProjectId: text("execution_project_id"),
		state: text("state", { enum: PLAN_RUN_CHILD_STATES }).notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		prMergedAt: text("pr_merged_at"),
		failureReason: text("failure_reason"),
	},
	(t) => [
		primaryKey({ columns: [t.planRunId, t.seq] }),
		index(INDEX_NAMES.planRunChildrenRun).on(t.runId),
		index(INDEX_NAMES.planRunChildrenState).on(t.planRunId, t.state),
	],
);

export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type RunInsert = typeof runs.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
export type TriggerRow = typeof triggers.$inferSelect;
export type TriggerInsert = typeof triggers.$inferInsert;
/**
 * Plots projection (warren-9022). A read-cache that
 * mirrors full git-backed Plot state — NOT an authoritative store; source of
 * truth stays git. The `state_json` blob holds the entire plot state (schema
 * stable across plot-shape drift), and the promoted scalars (project_id /
 * status / title / updated_at) are denormalized out of it for list / index
 * queries. `project_id` FKs `projects.id` ON DELETE CASCADE (the projection
 * is rebuildable from git); `id` is the caller-supplied `plot-...` id
 * (PLOT_ID_REGEX, mx-28a262). See `columns.ts`'s `PlotProjectionState` for
 * the full framing.
 */
export const plots = sqliteTable(
	TABLE_NAMES.plots,
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		status: text("status").notNull(),
		title: text("title"),
		updatedAt: text("updated_at").notNull(),
		stateJson: text("state_json", { mode: "json" }).$type<PlotProjectionState>().notNull(),
	},
	(t) => [
		index(INDEX_NAMES.plotsProjectUpdated).on(t.projectId, t.updatedAt),
		index(INDEX_NAMES.plotsStatus).on(t.status),
	],
);

/**
 * Run inbox (warren-3d0b, pl-829f step 18). The durable steering channel for
 * pod-per-run K8s runs: with no live socket into the sandbox, warren persists
 * each steering message here and the in-pod agent harness polls
 * `GET /runs/:id/inbox` over the Service-DNS callback URL to drain it. The
 * K8sProvider's `sendMessage` writes the row; the poll endpoint claims unread
 * rows priority-desc then FIFO-by-`seq` and atomically flips them `delivered`.
 *
 * `run_id` FKs `runs.id` ON DELETE CASCADE (a run's undelivered steers die with
 * it). `seq` is monotonic per run (allocated max+1 under the enqueue
 * transaction, mirroring `messages.seq`) so FIFO ordering within a priority
 * class is deterministic even when two rows share a `created_at` millisecond.
 * `state` defaults to `unread`; `delivered_at` is the ISO-8601 claim timestamp,
 * null until a poll delivers the row. Mirrors the seam `Message` shape
 * (`src/runtime/contract.ts`) so the provider maps a row onto it without loss.
 */
export const runInbox = sqliteTable(
	TABLE_NAMES.runInbox,
	{
		id: text("id").primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => runs.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		body: text("body").notNull(),
		priority: text("priority", { enum: INBOX_PRIORITIES }).notNull().default("normal"),
		fromActor: text("from_actor").notNull().default("operator"),
		state: text("state", { enum: INBOX_STATES }).notNull().default("unread"),
		createdAt: text("created_at").notNull(),
		deliveredAt: text("delivered_at"),
	},
	(t) => [index(INDEX_NAMES.runInboxRunState).on(t.runId, t.state)],
);

export type PlanRunRow = typeof planRuns.$inferSelect;
export type PlanRunInsert = typeof planRuns.$inferInsert;
export type PlanRunChildRow = typeof planRunChildren.$inferSelect;
export type PlanRunChildInsert = typeof planRunChildren.$inferInsert;
export type PlotRow = typeof plots.$inferSelect;
export type PlotInsert = typeof plots.$inferInsert;
export type RunInboxRow = typeof runInbox.$inferSelect;
export type RunInboxInsert = typeof runInbox.$inferInsert;
