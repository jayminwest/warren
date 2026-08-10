/**
 * Postgres physical schema for warren's durable state (R-13, pl-f17e step 2).
 *
 * Mirror of `./sqlite.ts` — same table names, same column names, same FK
 * targets + onDelete behavior, same index names + columns, same enum tuples.
 * The schemas drift only at the type level:
 *
 *   - `text mode:"json"` (SQLite, stored as TEXT) → `jsonb` (Postgres, stored
 *     as binary; richer query operators, no string round-trip).
 *   - `real` (SQLite, 8-byte IEEE float) → `doublePrecision` (Postgres, 8-byte;
 *     `real` in pg is 4-byte single precision and would lose accuracy on
 *     `costUsd`).
 *   - `integer().primaryKey({autoIncrement:true})` (SQLite ROWID alias) →
 *     `serial().primaryKey()` (Postgres SERIAL = int + sequence).
 *   - Text-enum columns stay TEXT in both (mx-2ab984: TS-only narrowing, no
 *     SQL CHECK).
 *
 * `./drift.test.ts` enforces parity at the column-list / nullability / FK /
 * index level. This schema is wired into the dialect-aware `openDatabase`
 * (`../client.ts`), which selects it when handed a `postgres://` /
 * `postgresql://` `WARREN_DB_URL`; the drift test still exercises it for
 * parity coverage.
 */

import { sql } from "drizzle-orm";
import {
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	serial,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
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

export const agents = pgTable(
	TABLE_NAMES.agents,
	{
		id: serial("id").primaryKey(),
		name: text("name").notNull(),
		renderedJson: jsonb("rendered_json").notNull(),
		registeredAt: text("registered_at").notNull(),
		lastRefreshed: text("last_refreshed").notNull(),
	},
	(t) => [uniqueIndex(INDEX_NAMES.agentsName).on(t.name)],
);

export const projects = pgTable(
	TABLE_NAMES.projects,
	{
		id: text("id").primaryKey(),
		gitUrl: text("git_url").notNull(),
		localPath: text("local_path").notNull(),
		defaultBranch: text("default_branch").notNull(),
		addedAt: text("added_at").notNull(),
		lastFetchedAt: text("last_fetched_at"),
		lastHeadSha: text("last_head_sha"),
		// Seeds opt-in gating flag (warren-9990 / pl-a258 step 1) — mirror of
		// sqlite. See sqlite.ts for shape.
		hasSeeds: boolean("has_seeds").notNull().default(false),
	},
	(t) => [index(INDEX_NAMES.projectsGitUrl).on(t.gitUrl)],
);

export const runs = pgTable(
	TABLE_NAMES.runs,
	{
		id: text("id").primaryKey(),
		// Plain text, no FK to agents.name — mirror of sqlite (R-03 step 1,
		// pl-fef5, warren-094a). With agents identified by (name, project_id)
		// rather than a single-column PK, this FK is no longer representable.
		agentName: text("agent_name").notNull(),
		// ON DELETE CASCADE (warren-41b3) — mirror of sqlite. Deleting a
		// project removes its runs and (via events.run_id CASCADE) their
		// event transcripts rather than orphaning them. See sqlite.ts.
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
		burrowId: text("burrow_id"),
		burrowRunId: text("burrow_run_id"),
		workerId: text("worker_id"),
		seedId: text("seed_id"),
		renderedAgentJson: jsonb("rendered_agent_json").notNull(),
		state: text("state", { enum: RUN_STATES }).notNull(),
		failureReason: text("failure_reason", { enum: RUN_FAILURE_REASONS }),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		prompt: text("prompt").notNull(),
		trigger: text("trigger").notNull(),
		prUrl: text("pr_url"),
		targetBranch: text("target_branch"),
		// Salvage-before-destroy (warren-cd3b); see the sqlite schema comment.
		salvageRef: text("salvage_ref"),
		salvagePath: text("salvage_path"),
		costUsd: doublePrecision("cost_usd"),
		tokensInput: integer("tokens_input"),
		tokensOutput: integer("tokens_output"),
		tokensCacheRead: integer("tokens_cache_read"),
		tokensCacheWrite: integer("tokens_cache_write"),
		previewState: text("preview_state", { enum: PREVIEW_STATES }),
		previewPort: integer("preview_port"),
		previewStartedAt: text("preview_started_at"),
		previewLastHitAt: text("preview_last_hit_at"),
		previewFailureMessage: text("preview_failure_message"),
		// Mirror of sqlite mode (pl-0344 step 1 / warren-67b6). See sqlite.ts
		// for shape + state-machine intent.
		mode: text("mode", { enum: RUN_MODES }).notNull().default("batch"),
		// Mirror of sqlite parent_run_id (warren-4b11). Continuation back-link
		// for re-run-with-follow-up; see sqlite.ts for the full shape + intent.
		parentRunId: text("parent_run_id"),
		// Mirror of sqlite clone_kind (warren-e96f). Discriminates `continue`
		// vs `replicate` chain links; see sqlite.ts for the full shape + intent.
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

export const events = pgTable(
	TABLE_NAMES.events,
	{
		id: serial("id").primaryKey(),
		// ON DELETE CASCADE (warren-41b3) — mirror of sqlite. Removes a
		// run's event transcript with the run, including the project-delete
		// cascade.
		runId: text("run_id")
			.notNull()
			.references(() => runs.id, { onDelete: "cascade" }),
		burrowEventSeq: integer("burrow_event_seq").notNull(),
		ts: text("ts").notNull(),
		kind: text("kind").notNull(),
		stream: text("stream", { enum: EVENT_STREAMS }),
		payloadJson: jsonb("payload_json").notNull(),
	},
	(t) => [
		index(INDEX_NAMES.eventsRunSeq).on(t.runId, t.burrowEventSeq),
		index(INDEX_NAMES.eventsRunTs).on(t.runId, t.ts),
		// warren-55cf: healer attempt history filters by kind + payload
		// fingerprint at the SQL level; this keeps the kind scan bounded.
		index(INDEX_NAMES.eventsKindTs).on(t.kind, t.ts),
	],
);

export const triggers = pgTable(
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
 * Plan-run coordinator state (pl-a258 step 2 / warren-4d7c) — mirror of
 * sqlite. See sqlite.ts for shape + state-machine intent.
 */
export const planRuns = pgTable(
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
		// Mirror of sqlite plan_runs.max_cost_usd (warren-a63d): per-child
		// spend cap the coordinator forwards on each dispatch.
		maxCostUsd: doublePrecision("max_cost_usd"),
		dispatcherHandle: text("dispatcher_handle").notNull().default("operator"),
		trigger: text("trigger").notNull().default("manual"),
		// Mirror of sqlite plan_runs.parent_run_id (warren-d9a2). See
		// sqlite.ts for shape + gating intent.
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
 * Per-child plan-run progress (pl-a258 step 2 / warren-4d7c) — mirror of
 * sqlite. See sqlite.ts for shape + state-machine intent.
 */
export const planRunChildren = pgTable(
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
 * Run inbox (warren-3d0b) — mirror of sqlite. See sqlite.ts for the pod-per-run
 * steering-channel intent + delivery semantics.
 */
export const runInbox = pgTable(
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
