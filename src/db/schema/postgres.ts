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
 * index level. This schema is not yet wired into `openDatabase` — the
 * dialect-aware client lands in step 3 (warren-a66e). Until then this file
 * is build-only and exercised by the drift test.
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
import type { PlotProjectionState } from "./columns.ts";
import {
	CLONE_KINDS,
	CONVERSATION_STATES,
	EVENT_STREAMS,
	INDEX_NAMES,
	MESSAGE_ROLES,
	PLAN_RUN_CHILD_STATES,
	PLAN_RUN_STATES,
	PREVIEW_STATES,
	RUN_FAILURE_REASONS,
	RUN_MODES,
	RUN_STATES,
	TABLE_NAMES,
	WORKER_STATES,
} from "./columns.ts";

export const agents = pgTable(
	TABLE_NAMES.agents,
	{
		id: serial("id").primaryKey(),
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		renderedJson: jsonb("rendered_json").notNull(),
		registeredAt: text("registered_at").notNull(),
		lastRefreshed: text("last_refreshed").notNull(),
	},
	(t) => [
		uniqueIndex(INDEX_NAMES.agentsProjectName).on(t.projectId, t.name),
		uniqueIndex(INDEX_NAMES.agentsGlobalName).on(t.name).where(sql`${t.projectId} IS NULL`),
	],
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
		// Plot opt-in gating flag (warren-4e20) — mirror of sqlite. Boolean
		// rather than integer here; the drift check only compares structure
		// (column name + nullability + default presence), not the storage
		// type, so the sqlite integer-as-boolean stays in lockstep.
		hasPlot: boolean("has_plot").notNull().default(false),
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
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		burrowId: text("burrow_id"),
		burrowRunId: text("burrow_run_id"),
		workerId: text("worker_id"),
		seedId: text("seed_id"),
		// Mirror of sqlite plot_id (warren-a8c3). See sqlite.ts for shape.
		plotId: text("plot_id"),
		renderedAgentJson: jsonb("rendered_agent_json").notNull(),
		state: text("state", { enum: RUN_STATES }).notNull(),
		failureReason: text("failure_reason", { enum: RUN_FAILURE_REASONS }),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		prompt: text("prompt").notNull(),
		trigger: text("trigger").notNull(),
		prUrl: text("pr_url"),
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
		pausedAt: text("paused_at"),
		pausedQuestionEventId: text("paused_question_event_id"),
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
		index(INDEX_NAMES.runsPlotId).on(t.plotId),
		index(INDEX_NAMES.runsMode).on(t.mode),
	],
);

export const events = pgTable(
	TABLE_NAMES.events,
	{
		id: serial("id").primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => runs.id),
		burrowEventSeq: integer("burrow_event_seq").notNull(),
		ts: text("ts").notNull(),
		kind: text("kind").notNull(),
		stream: text("stream", { enum: EVENT_STREAMS }),
		payloadJson: jsonb("payload_json").notNull(),
	},
	(t) => [
		index(INDEX_NAMES.eventsRunSeq).on(t.runId, t.burrowEventSeq),
		index(INDEX_NAMES.eventsRunTs).on(t.runId, t.ts),
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

export const workers = pgTable(TABLE_NAMES.workers, {
	name: text("name").primaryKey(),
	url: text("url").notNull(),
	state: text("state", { enum: WORKER_STATES }).notNull().default("healthy"),
	addedAt: text("added_at").notNull(),
});

export const burrows = pgTable(
	TABLE_NAMES.burrows,
	{
		id: text("id").primaryKey(),
		workerId: text("worker_id").notNull(),
		addedAt: text("added_at").notNull(),
	},
	(t) => [index(INDEX_NAMES.burrowsWorker).on(t.workerId)],
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
		dispatcherHandle: text("dispatcher_handle").notNull().default("operator"),
		trigger: text("trigger").notNull().default("manual"),
		// Mirror of sqlite plan_runs.plot_id (warren-06dc / pl-7937 Phase 2).
		// See sqlite.ts for shape + gating intent.
		plotId: text("plot_id"),
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
		index(INDEX_NAMES.planRunsPlotId).on(t.plotId),
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
export type WorkerRow = typeof workers.$inferSelect;
export type WorkerInsert = typeof workers.$inferInsert;
export type BurrowRow = typeof burrows.$inferSelect;
export type BurrowInsert = typeof burrows.$inferInsert;
/**
 * Plots projection (warren-9022 / LEVERET §0.0.A / §0.0.F) — mirror of sqlite.
 * `state_json` is `jsonb` here (vs sqlite's `text mode:"json"`); the drift
 * check compares structure (column name + nullability + FK + index), not the
 * storage type. See sqlite.ts for the projection's full intent.
 */
export const plots = pgTable(
	TABLE_NAMES.plots,
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		status: text("status").notNull(),
		title: text("title"),
		updatedAt: text("updated_at").notNull(),
		stateJson: jsonb("state_json").$type<PlotProjectionState>().notNull(),
	},
	(t) => [
		index(INDEX_NAMES.plotsProjectUpdated).on(t.projectId, t.updatedAt),
		index(INDEX_NAMES.plotsStatus).on(t.status),
	],
);

/**
 * Conversations (LEVERET.md §0.5 / warren-0b91) — mirror of sqlite. See
 * sqlite.ts for shape + lifecycle intent.
 */
export const conversations = pgTable(
	TABLE_NAMES.conversations,
	{
		id: text("id").primaryKey(),
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
		plotId: text("plot_id"),
		anchoringRunId: text("anchoring_run_id"),
		status: text("status", { enum: CONVERSATION_STATES }).notNull().default("active"),
		title: text("title"),
		// Send-off submission (LEVERET.md §0.0.B / §0.7 / warren-756d) — mirror of
		// sqlite. See sqlite.ts for intent.
		submittedPrUrl: text("submitted_pr_url"),
		submittedPrNumber: integer("submitted_pr_number"),
		plannerAgent: text("planner_agent"),
		createdAt: text("created_at").notNull(),
		lastActivityAt: text("last_activity_at").notNull(),
		closedAt: text("closed_at"),
	},
	(t) => [
		index(INDEX_NAMES.conversationsProject).on(t.projectId),
		index(INDEX_NAMES.conversationsPlot).on(t.plotId),
	],
);

/**
 * Messages (LEVERET.md §0.5 / warren-0b91) — mirror of sqlite. See
 * sqlite.ts for shape + transcript intent.
 */
export const messages = pgTable(
	TABLE_NAMES.messages,
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		role: text("role", { enum: MESSAGE_ROLES }).notNull(),
		content: text("content").notNull(),
		runId: text("run_id"),
		createdAt: text("created_at").notNull(),
	},
	(t) => [index(INDEX_NAMES.messagesConversationSeq).on(t.conversationId, t.seq)],
);

export type PlanRunRow = typeof planRuns.$inferSelect;
export type PlanRunInsert = typeof planRuns.$inferInsert;
export type PlanRunChildRow = typeof planRunChildren.$inferSelect;
export type PlanRunChildInsert = typeof planRunChildren.$inferInsert;
export type PlotRow = typeof plots.$inferSelect;
export type PlotInsert = typeof plots.$inferInsert;
export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationInsert = typeof conversations.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;
