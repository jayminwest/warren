/**
 * SQLite physical schema for warren's durable state (docs/design/runtime-and-supervisor.md).
 *
 * Tables: agents (canopy registry cache), projects (cloned repos), runs
 * (warren-side run rows that mirror burrow's lifecycle), events (write-through
 * cache of burrow's stream — see the event-durability rationale in
 * docs/design/runtime-and-supervisor.md), triggers
 * (R-06 scheduler bookkeeping), planRuns + planRunChildren, and
 * runInbox. The plots projection table was dropped in warren-0b13 (0031)
 * as part of the plot deletion pass (pl-3a79). The conversations + messages
 * tables were dropped in
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
 * Agent registry cache. Rows are identified by `name` alone — the global
 * registry seeded from `src/registry/builtins/`, plus any same-named
 * library override. A synthetic rowid PK backs the table; a single unique
 * index on `name` enforces registry identity (warren-f787, which removed
 * the per-project `.canopy/` tier and its `project_id` column).
 *
 * `runs.agent_name` does not FK to `agents.name` — the agents table is a
 * soft cache, re-seeded on boot, so a run row keeps its frozen
 * `rendered_agent_json` even if the agent row is later removed.
 */
export const agents = sqliteTable(
	TABLE_NAMES.agents,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		name: text("name").notNull(),
		renderedJson: text("rendered_json", { mode: "json" }).notNull(),
		registeredAt: text("registered_at").notNull(),
		lastRefreshed: text("last_refreshed").notNull(),
	},
	(t) => [uniqueIndex(INDEX_NAMES.agentsName).on(t.name)],
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
		// Nullable, ON DELETE CASCADE (warren-41b3). Deleting a project
		// removes its runs (and, via events.run_id CASCADE, their event
		// transcripts) rather than orphaning them with project_id = NULL.
		// The prior SET NULL intent (warren-5f19) preserved run history
		// across de-registration, but that leaked unattributable private
		// transcripts on public instances and grew the events table without
		// bound — 58% of production runs and 81% of events were orphans.
		// Removing the orphan class outright is the fail-closed fix.
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
		// Salvage-before-destroy (warren-cd3b). When a reap's branch push never
		// landed, the workspace's committed work is captured BEFORE destroy:
		// `salvage_ref` is the rescue branch pushed to origin
		// (`warren/rescue/<runId>`) when that push landed; `salvage_path` is the
		// durable warren-side git-bundle file (`<dataDir>/salvage/<runId>.bundle`)
		// when a bundle was captured (pod-POSTed under k8s, host-written under
		// local). Both null ⇒ no salvage was captured (or none was needed).
		salvageRef: text("salvage_ref"),
		salvagePath: text("salvage_path"),
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
		// Per-run preview environment columns (R-19 / docs/design/preview-environments.md). All nullable
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
		index(INDEX_NAMES.runsMode).on(t.mode),
		index(INDEX_NAMES.runsPrUrl).on(t.prUrl),
	],
);

export const events = sqliteTable(
	TABLE_NAMES.events,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		// ON DELETE CASCADE (warren-41b3) so a run's event transcript is
		// removed with the run — including the cascade from a deleted
		// project (runs.project_id ON DELETE CASCADE).
		runId: text("run_id")
			.notNull()
			.references(() => runs.id, { onDelete: "cascade" }),
		burrowEventSeq: integer("burrow_event_seq").notNull(),
		ts: text("ts").notNull(),
		kind: text("kind").notNull(),
		stream: text("stream", { enum: EVENT_STREAMS }),
		payloadJson: text("payload_json", { mode: "json" }).notNull(),
	},
	(t) => [
		index(INDEX_NAMES.eventsRunSeq).on(t.runId, t.burrowEventSeq),
		index(INDEX_NAMES.eventsRunTs).on(t.runId, t.ts),
		// warren-55cf: healer attempt history filters by kind + payload
		// fingerprint at the SQL level; this keeps the kind scan bounded.
		index(INDEX_NAMES.eventsKindTs).on(t.kind, t.ts),
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
		// warren-a63d: per-dispatch USD spend cap applied to EACH child run
		// (forwarded as spawnRun maxCostUsdOverride), persisted like the
		// provider/model overrides so the coordinator re-reads it per child.
		maxCostUsd: real("max_cost_usd"),
		dispatcherHandle: text("dispatcher_handle").notNull().default("operator"),
		trigger: text("trigger").notNull().default("manual"),
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

export type AgentDbRow = typeof agents.$inferSelect;
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
export type RunInboxRow = typeof runInbox.$inferSelect;
export type RunInboxInsert = typeof runInbox.$inferInsert;
