export interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly hasSeeds?: boolean;
	readonly hasPlot?: boolean;
}

export interface PlotAttachment {
	readonly id: string;
	readonly type: string;
	readonly ref: string;
	readonly role?: string;
	readonly added_at: string;
	readonly added_by: string;
}

export interface PlotEventWire {
	readonly type: string;
	readonly actor: string;
	readonly at: string;
	readonly data?: Record<string, unknown>;
}

export interface PlotEnvelope {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly intent: {
		readonly goal: string;
		readonly non_goals: readonly string[];
		readonly constraints: readonly string[];
		readonly success_criteria: readonly string[];
	};
	readonly attachments: readonly PlotAttachment[];
	readonly event_log: readonly PlotEventWire[];
	readonly project_id: string;
}

export interface AttachResponse {
	readonly envelope: PlotEnvelope;
	readonly attachment: PlotAttachment;
}

export interface DetachResponse {
	readonly envelope: PlotEnvelope;
	readonly removed_id: string;
}

export interface AnswerResponse {
	readonly event: PlotEventWire;
}

export interface PlanRunRow {
	readonly id: string;
	readonly planId: string;
	readonly projectId: string;
	readonly agentName: string;
	readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	readonly plotId: string | null;
}

export interface PlanRunChildRow {
	readonly planRunId: string;
	readonly seq: number;
	readonly seedId: string;
	readonly runId: string | null;
	readonly state:
		| "pending"
		| "dispatched"
		| "running"
		| "pr_open"
		| "merged"
		| "failed"
		| "skipped";
}

export interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly trigger?: string;
	readonly prUrl?: string | null;
	readonly plotId: string | null;
}

export interface CreatePlanRunResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
}

export interface CreatePlotPlanRunResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
	readonly synthesizedPlanId: string;
	readonly parentSeedId: string;
}

export interface PlanRunDetailResponse {
	readonly planRun: PlanRunRow;
	readonly children: readonly PlanRunChildRow[];
	readonly runs: readonly RunRow[];
}

export interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly kind: string;
	readonly payload: Record<string, unknown> | null;
}

export interface ErrorEnvelope {
	readonly error?: { readonly code?: string; readonly message?: string };
}

export interface PlotSnapshot {
	readonly id: string;
	readonly status: string;
}

export interface ParsedPlotEvent {
	readonly type: string;
	readonly actor: string;
	readonly at: string;
	readonly data: unknown;
}
