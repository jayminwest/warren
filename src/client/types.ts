export type RunState = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export type RunTerminalState = "succeeded" | "failed" | "cancelled";

/** Canonical set of terminal run states. Mirrors src/db/schema.ts RUN_TERMINAL_STATES. */
export const RUN_TERMINAL_STATES: ReadonlySet<RunState> = new Set([
	"succeeded",
	"failed",
	"cancelled",
]);

export function isTerminalRunState(state: RunState): state is RunTerminalState {
	return RUN_TERMINAL_STATES.has(state);
}

export type RunFailureReason =
	| "never_started"
	| "no_model_response"
	| "crashed"
	| "timed_out"
	| "burrow_run_lost"
	| "burrow_unreachable"
	| "dropped_commit"
	| "provider_error"
	| "oom_killed";

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
	/** Chain back-link (warren-4b11 / warren-e96f); null for root runs. */
	parentRunId: string | null;
	cloneKind: "replicate" | "continue" | null;
	mode: "batch";
	renderedAgentJson: unknown;
	state: RunState;
	failureReason: RunFailureReason | null;
	startedAt: string | null;
	endedAt: string | null;
	prompt: string;
	trigger: string;
	prUrl: string | null;
	targetBranch: string | null;
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
	// agent/project/prompt: required unless cloneFromRunId is set (warren-e96f).
	agent?: string;
	project?: string;
	prompt?: string;
	ref?: string;
	/** Existing branch to push the workspace back to at reap (warren-05ea / #419). */
	targetBranch?: string;
	providerOverride?: string;
	modelOverride?: string;
	seedId?: string;
	dispatcherHandle?: string;
	/** Continuation parent (warren-4b11): seed the workspace from this run's branch. */
	continueFromRunId?: string;
	/** Replicate parent (warren-e96f): re-dispatch this run's config against the project base. */
	cloneFromRunId?: string;
}

/** Ergonomic input for {@link WarrenClient.dispatch}: mirrors {@link CreateRunInput} with
 * `warren run` CLI field names (`model`/`branch`/`provider`), mapped at request time. */
export interface DispatchRunInput {
	agent: string;
	project: string;
	prompt: string;
	/** Maps to CreateRunInput.ref — git branch / ref to clone the workspace from. */
	branch?: string;
	/** Maps to CreateRunInput.targetBranch — branch reap pushes back to (#419). */
	targetBranch?: string;
	/** Maps to CreateRunInput.modelOverride. */
	model?: string;
	/** Maps to CreateRunInput.providerOverride. */
	provider?: string;
	seedId?: string;
	dispatcherHandle?: string;
	/** Maps to CreateRunInput.continueFromRunId (warren-4b11). */
	continueFromRunId?: string;
	/** Maps to CreateRunInput.cloneFromRunId (warren-e96f). */
	cloneFromRunId?: string;
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

/** A plan from `GET /projects/:id/ready-plans` — approved, undispatched, ≥1 open child (warren-7937). */
export interface ReadyPlan {
	id: string;
	name?: string;
	status: string;
	openChildCount: number;
}

export interface ListReadyPlansResponse {
	plans: ReadyPlan[];
}

export interface RefreshProjectInput {
	ref?: string;
}

export interface RefreshProjectResponse {
	project: ProjectRow;
	headSha: string;
	ref: string;
}

/** Burrow inbox message priority. Mirrors `MESSAGE_PRIORITIES` from `@os-eco/burrow-cli`. */
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
/* Plan-runs — typed facade over /plan-runs (warren-8ffc).                 */
/* Wire envelope is camelCase, mirroring /runs. Types live in              */
/* `./types.plan-runs.ts` (warren-fcc8); re-exported here for the          */
/* canonical `./types.ts` import surface.                                  */
/* ----------------------------------------------------------------------- */
export * from "./types.plan-runs.ts";
