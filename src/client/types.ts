/* ----------------------------------------------------------------------- */
/* Canonical wire vocabulary (warren-b229).                                 */
/*                                                                          */
/* Run / preview lifecycle states, the failure-cause discriminator, run     */
/* mode and the inbox classes are DEFINED ONCE in `src/core/wire.ts` and    */
/* re-exported here so the SDK's import surface is unchanged. Never         */
/* redeclare one of these names — `check:wire-types` (warren-d371) fails    */
/* the build if you do.                                                     */
/* ----------------------------------------------------------------------- */
import type {
	AgentSource,
	CloneKind,
	EventStream,
	InboxPriority,
	InboxState,
	PreviewState,
	RunFailureReason,
	RunMode,
	RunState,
} from "../core/wire.ts";

export {
	type AgentSource,
	type CloneKind,
	type EventStream,
	type InboxState,
	isTerminalRunState,
	type PreviewState,
	RUN_TERMINAL_STATES,
	type RunFailureReason,
	type RunMode,
	type RunState,
	type RunTerminalState,
} from "../core/wire.ts";

/**
 * Identity discriminant reported by `GET /whoami` (warren-e195). Mirrors
 * `ActorKind` in src/server/types.ts.
 */
export type ActorIdentity = "operator" | "anonymous";

/** One capability name. Mirrors `CapabilityName` in src/server/types.ts. */
export type CapabilityName = "readPublic" | "readOperator" | "dispatch" | "admin";

/**
 * `GET /whoami` — who warren thinks the caller is and what it may do.
 * `capabilities` holds only the granted names, so a client checks
 * membership rather than a boolean flag.
 */
export interface WhoamiResponse {
	identity: ActorIdentity;
	capabilities: CapabilityName[];
}

export interface AgentRow {
	name: string;
	renderedJson: unknown;
	registeredAt: string;
	lastRefreshed: string;
	source?: AgentSource;
}

export interface ListAgentsResponse {
	agents: AgentRow[];
}

export interface ProjectRow {
	id: string;
	gitUrl: string;
	localPath: string;
	defaultBranch: string;
	addedAt: string;
	lastFetchedAt: string | null;
	lastHeadSha: string | null;
	hasSeeds: boolean;
}

export interface RunRow {
	id: string;
	agentName: string;
	projectId: string | null;
	burrowId: string | null;
	burrowRunId: string | null;
	seedId: string | null;
	/** Chain back-link (warren-4b11 / warren-e96f); null for root runs. */
	parentRunId: string | null;
	cloneKind: CloneKind | null;
	mode: RunMode;
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
	stream: EventStream | null;
	payload: unknown;
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

/**
 * Burrow inbox message priority. Alias of the canonical `InboxPriority`
 * (`src/core/wire.ts`), kept under the SDK's historical name; both mirror
 * `MESSAGE_PRIORITIES` from `@os-eco/burrow-cli`.
 */
export type MessagePriority = InboxPriority;

/** Burrow inbox message row returned by `POST /runs/:id/steer`. */
export interface InboxMessage {
	id: string;
	burrowId: string;
	fromActor: string;
	body: string;
	priority: InboxPriority;
	state: InboxState;
	deliveredAtRunId: string | null;
	createdAt: string;
	deliveredAt: string | null;
}

export interface SteerRunInput {
	/** Steering body — non-empty after trim. */
	body: string;
	priority?: InboxPriority;
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
