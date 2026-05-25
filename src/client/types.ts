export type RunState = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export type RunTerminalState = "succeeded" | "failed" | "cancelled";

/** Canonical set of terminal run states. Mirrors src/db/schema.ts RUN_TERMINAL_STATES. */
export const RUN_TERMINAL_STATES: ReadonlySet<RunState> = new Set([
	"succeeded",
	"failed",
	"cancelled",
]);

/** Narrow a RunState to a terminal one. */
export function isTerminalRunState(state: RunState): state is RunTerminalState {
	return RUN_TERMINAL_STATES.has(state);
}

export type RunFailureReason =
	| "never_started"
	| "no_model_response"
	| "crashed"
	| "timed_out"
	| "burrow_run_lost";

export type PreviewState = "starting" | "live" | "failed" | "torn-down";

export type AgentSource = "builtin" | "library" | `project:${string}`;

export interface AgentRow {
	name: string;
	renderedJson: unknown;
	registeredAt: string;
	lastRefreshed: string;
	source?: AgentSource;
}

export interface RefreshSkipped {
	name: string;
	reason: string;
	code: string;
}

export interface CloneResult {
	cloned: boolean;
	localDir: string;
}

export interface ListAgentsQuery {
	projectId?: string;
}

export interface ListAgentsResponse {
	agents: AgentRow[];
}

export interface RefreshProjectAgentsResult {
	projectId: string;
	registered: AgentRow[];
	skipped: RefreshSkipped[];
	removed: string[];
}

export interface ProjectRefreshErrorRow {
	projectId: string;
	code: string;
	message: string;
}

export interface RefreshAgentsResponse {
	clone: CloneResult;
	registered: AgentRow[];
	skipped: RefreshSkipped[];
	removed: string[];
	projects: RefreshProjectAgentsResult[];
	projectErrors: ProjectRefreshErrorRow[];
}

export interface ProjectRow {
	id: string;
	gitUrl: string;
	localPath: string;
	defaultBranch: string;
	addedAt: string;
	lastFetchedAt: string | null;
	lastHeadSha: string | null;
	hasPlot: boolean;
	hasSeeds: boolean;
}

export interface RunRow {
	id: string;
	agentName: string;
	projectId: string | null;
	burrowId: string | null;
	burrowRunId: string | null;
	seedId: string | null;
	plotId: string | null;
	mode: "batch" | "interactive";
	renderedAgentJson: unknown;
	state: RunState;
	failureReason: RunFailureReason | null;
	startedAt: string | null;
	endedAt: string | null;
	prompt: string;
	trigger: string;
	prUrl: string | null;
	costUsd: number | null;
	tokensInput: number | null;
	tokensOutput: number | null;
	tokensCacheRead: number | null;
	tokensCacheWrite: number | null;
	previewState: PreviewState | null;
	previewPort: number | null;
	previewStartedAt: string | null;
	previewLastHitAt: string | null;
	previewFailureMessage: string | null;
}

export interface RunEvent {
	id: number;
	runId: string;
	seq: number;
	ts: string;
	kind: string;
	stream: "stdout" | "stderr" | "system" | null;
	payload: unknown;
	plotId: string | null;
}

export interface StreamRunEventsOptions {
	/** Keep the connection open and emit new events as they arrive. */
	follow?: boolean;
	/** Replay starting just after this `burrowEventSeq`. */
	sinceSeq?: number;
	/** External abort signal — closes the underlying HTTP body. */
	signal?: AbortSignal;
}

export interface ApiErrorEnvelope {
	error: {
		code: string;
		message: string;
		hint?: string;
	};
}

export interface CreateRunInput {
	agent: string;
	project: string;
	prompt: string;
	ref?: string;
	providerOverride?: string;
	modelOverride?: string;
	seedId?: string;
	plotId?: string;
	mode?: "batch" | "interactive";
	interactiveAgent?: string;
	dispatcherHandle?: string;
}

/**
 * Ergonomic input for {@link WarrenClient.dispatch}. Mirrors
 * {@link CreateRunInput} but uses the user-facing field names
 * (`model`, `branch`, `provider`) from `warren run` CLI flags. Mapped
 * onto CreateRunInput at request time.
 */
export interface DispatchRunInput {
	agent: string;
	project: string;
	prompt: string;
	/** Maps to CreateRunInput.ref — git branch / ref to clone the workspace from. */
	branch?: string;
	/** Maps to CreateRunInput.modelOverride. */
	model?: string;
	/** Maps to CreateRunInput.providerOverride. */
	provider?: string;
	seedId?: string;
	plotId?: string;
	mode?: "batch" | "interactive";
	interactiveAgent?: string;
	dispatcherHandle?: string;
}

export interface SpawnRunResponse {
	run: RunRow;
	burrow: {
		id: string;
		workspacePath: string;
	};
}

export interface ListProjectsResponse {
	projects: ProjectRow[];
}

export interface CreateProjectInput {
	gitUrl: string;
	defaultBranch?: string;
}

export interface RefreshProjectInput {
	ref?: string;
}

export interface RefreshProjectResponse {
	project: ProjectRow;
	headSha: string;
	ref: string;
}

/**
 * Burrow inbox message priority. Mirrors `MESSAGE_PRIORITIES` from
 * `@os-eco/burrow-cli` — kept inline so the client package has no
 * server-side deps.
 */
export type MessagePriority = "low" | "normal" | "high" | "urgent";

/** Burrow inbox message row returned by `POST /runs/:id/steer`. */
export interface InboxMessage {
	id: string;
	burrowId: string;
	fromActor: string;
	body: string;
	priority: MessagePriority;
	state: "unread" | "delivered" | "failed";
	deliveredAtRunId: string | null;
	createdAt: string;
	deliveredAt: string | null;
}

export interface SteerRunInput {
	/** Steering body — non-empty after trim. */
	body: string;
	priority?: MessagePriority;
	/** Actor identifier recorded on the burrow message. */
	fromActor?: string;
}

export interface SteerRunResponse {
	message: InboxMessage;
}

export interface ListRunsResponse {
	runs: RunRow[];
	total: number;
	limit: number;
	offset: number;
	costTotalUsd: number | null;
	costPricedCount: number;
}

/* ----------------------------------------------------------------------- */
/* Plots — typed facade over /plots endpoints (warren-8ffc).               */
/*                                                                          */
/* The wire envelope under /plots is snake_case end-to-end (mirror of the  */
/* @os-eco/plot-cli on-disk shape); the client surfaces it verbatim so     */
/* readers can hand a `PlotEnvelope` straight to a Plot library consumer   */
/* without re-keying. Inputs accept camelCase for ergonomics and the       */
/* client maps to snake_case at the request boundary (parallel to          */
/* `dispatch()` mapping `branch/model/provider` onto the runs wire).       */
/* ----------------------------------------------------------------------- */

export type PlotStatus = "drafting" | "ready" | "active" | "done" | "archived";

export const PLOT_STATUSES: readonly PlotStatus[] = [
	"drafting",
	"ready",
	"active",
	"done",
	"archived",
];

export const NEEDS_ATTENTION_REASONS = [
	"paused_run",
	"merged_pr_unreviewed",
	"stale_draft",
] as const;
export type NeedsAttentionReason = (typeof NEEDS_ATTENTION_REASONS)[number];

export interface PlotSummary {
	id: string;
	name: string;
	status: PlotStatus;
	/** First ~160 chars of `intent.goal`, with ellipsis when truncated. */
	intent_goal_preview: string;
	attachments_count: number;
	last_event_ts: string;
	last_event_actor: string;
	project_id: string;
	/** Populated only by `GET /plots?filter=needs_attention`. */
	reasons?: NeedsAttentionReason[];
}

export const ATTACHMENT_TYPES = [
	"seeds_issue",
	"mulch_record",
	"agent_run",
	"gh_pr",
	"gh_issue",
	"file",
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export interface PlotIntent {
	goal: string;
	non_goals: string[];
	constraints: string[];
	success_criteria: string[];
}

export interface PlotAttachment {
	id: string;
	type: AttachmentType;
	ref: string;
	role: string;
	added_at: string;
	added_by: string;
}

export interface PlotEvent {
	type: string;
	actor: string;
	at: string;
	data: Record<string, unknown>;
}

/** Snapshot of warren runs in state=paused bound to this plot. */
export interface PausedRunInfo {
	run_id: string;
	paused_at: string;
	paused_question_event_id: string;
	pause_timeout_ms: number;
}

export interface PlotEnvelope {
	id: string;
	name: string;
	status: PlotStatus;
	intent: PlotIntent;
	attachments: PlotAttachment[];
	event_log: PlotEvent[];
	project_id: string;
	paused_runs: PausedRunInfo[];
}

export interface ListPlotsResponse {
	plots: PlotSummary[];
}

export interface ListPlotsFilter {
	status?: PlotStatus;
	/** `?filter=needs_attention` — rows carry a `reasons` array. */
	needsAttention?: boolean;
}

/** Optional partial intent body accepted on `POST /plots`. */
export interface CreatePlotIntentPatch {
	goal?: string;
	non_goals?: string[];
	constraints?: string[];
	success_criteria?: string[];
}

export interface CreatePlotInput {
	projectId: string;
	name?: string;
	intent?: CreatePlotIntentPatch;
	dispatcherHandle?: string;
}

/** `POST /plots/:id/intent` — flat top-level fields (no `intent:` wrapper). */
export interface EditPlotIntentInput {
	goal?: string;
	non_goals?: string[];
	constraints?: string[];
	success_criteria?: string[];
	dispatcherHandle?: string;
}

export interface ChangePlotStatusInput {
	next: PlotStatus;
	dispatcherHandle?: string;
}

export interface ChangePlotStatusResponse {
	summary: PlotSummary;
	event: PlotEvent;
}

export type PlotSyncResponse =
	| { kind: "no_op" }
	| {
			kind: "synced";
			branch: string;
			prUrl: string;
			prNumber?: number;
			merged: boolean;
	  };

/* ----------------------------------------------------------------------- */
/* Plan-runs — typed facade over /plan-runs (warren-8ffc).                 */
/* Wire envelope is camelCase, mirroring /runs.                            */
/* ----------------------------------------------------------------------- */

export type PlanRunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const PLAN_RUN_TERMINAL_STATES: ReadonlySet<PlanRunState> = new Set([
	"succeeded",
	"failed",
	"cancelled",
]);

export function isTerminalPlanRunState(
	state: PlanRunState,
): state is "succeeded" | "failed" | "cancelled" {
	return PLAN_RUN_TERMINAL_STATES.has(state);
}

export type PlanRunChildState =
	| "pending"
	| "dispatched"
	| "running"
	| "pr_open"
	| "merged"
	| "failed"
	| "skipped";

export interface PlanRunRow {
	id: string;
	planId: string;
	projectId: string;
	agentName: string;
	promptTemplate: string;
	ref: string | null;
	providerOverride: string | null;
	modelOverride: string | null;
	dispatcherHandle: string;
	trigger: string;
	state: PlanRunState;
	failureReason: string | null;
	createdAt: string;
	startedAt: string | null;
	endedAt: string | null;
	plotId: string | null;
}

export interface PlanRunChildRow {
	planRunId: string;
	seq: number;
	seedId: string;
	runId: string | null;
	state: PlanRunChildState;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	endedAt: string | null;
	prMergedAt: string | null;
	failureReason: string | null;
}

/** `POST /plan-runs` request body. Wire envelope is camelCase. */
export interface CreatePlanRunInput {
	project: string;
	planId: string;
	agent: string;
	promptTemplate?: string;
	ref?: string;
	providerOverride?: string;
	modelOverride?: string;
	dispatcherHandle?: string;
	plotId?: string;
}

export interface CreatePlanRunResponse {
	planRun: PlanRunRow;
	children: PlanRunChildRow[];
}

export interface PlanRunDetailResponse {
	planRun: PlanRunRow;
	children: PlanRunChildRow[];
	runs: RunRow[];
}

export interface ListPlanRunsFilter {
	project?: string;
	state?: PlanRunState;
}

export interface ListPlanRunsResponse {
	planRuns: PlanRunRow[];
}
