// Thin fetch wrapper around the warren HTTP API (SPEC §8.1). Bearer
// token comes from localStorage; mutated via `setApiToken` after the
// login screen accepts it. A 401 clears the cached token so the
// router can redirect back to login on the next render pass.

import type {
	AgentRow,
	ApiErrorEnvelope,
	CancelPlanRunResponse,
	CancelRunResponse,
	CreatePlanRunInput,
	CreatePlanRunResponse,
	CreateRunInput,
	ListRunsResponse,
	PlanRunDetailResponse,
	PlanRunRow,
	PlanRunState,
	PreviewConfigResponse,
	PreviewLoginResponse,
	PreviewTeardownResponse,
	ProjectRow,
	ReadyPlansResponse,
	ReadyzResponse,
	RefreshProjectResponse,
	RunAnalyticsTokensSection,
	RunEvent,
	RunRow,
	RunTriggerResponse,
	SeedPlansResponse,
	SeedStatusResponse,
	SpawnRunResponse,
	SteerRunResponse,
	TokenBreakdown,
	TriggersResponse,
	WarrenConfigResponse,
	WhoamiResponse,
} from "./types.ts";

export type {
	DimensionTokenSeries,
	RunAnalyticsTokensSection,
	TokenBreakdown,
	TokenDayBucket,
} from "./types.ts";

const TOKEN_KEY = "warren.apiToken";

export class UnauthorizedError extends Error {
	constructor(message = "unauthorized") {
		super(message);
		this.name = "UnauthorizedError";
	}
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly hint: string | undefined;
	constructor(status: number, envelope: ApiErrorEnvelope["error"]) {
		super(envelope.message);
		this.name = "ApiError";
		this.status = status;
		this.code = envelope.code;
		this.hint = envelope.hint;
	}
}

export function getApiToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

export function setApiToken(token: string | null): void {
	try {
		if (token === null) localStorage.removeItem(TOKEN_KEY);
		else localStorage.setItem(TOKEN_KEY, token);
	} catch {
		// localStorage may be unavailable (private mode) — token only
		// lives for the session in that case.
	}
}

interface RequestOptions {
	method?: string;
	body?: unknown;
	signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
	const headers: Record<string, string> = {
		accept: "application/json",
	};
	if (opts.body !== undefined) headers["content-type"] = "application/json";
	const token = getApiToken();
	if (token !== null && token.length > 0) headers.authorization = `Bearer ${token}`;

	const init: RequestInit = { method: opts.method ?? "GET", headers };
	if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
	if (opts.signal !== undefined) init.signal = opts.signal;

	const res = await fetch(path, init);
	if (res.status === 401) {
		setApiToken(null);
		throw new UnauthorizedError("API token rejected; please re-authenticate");
	}
	const text = await res.text();
	if (!res.ok) {
		let envelope: ApiErrorEnvelope | null = null;
		try {
			envelope = text.length > 0 ? (JSON.parse(text) as ApiErrorEnvelope) : null;
		} catch {
			envelope = null;
		}
		const err = envelope?.error ?? {
			code: `http_${res.status}`,
			message: text || res.statusText,
		};
		throw new ApiError(res.status, err);
	}
	if (text.length === 0) return undefined as T;
	return JSON.parse(text) as T;
}

/* ----------------------------------------------------------------------- */
/* Agents                                                                   */
/* ----------------------------------------------------------------------- */

/**
 * Optional projectId filter for agent reads (R-03 / pl-fef5 step 6).
 * When set, the server returns global ∪ that project's tier on `list`,
 * and resolves project-first with global fallback on `get`. Empty string
 * is rejected by the server, so callers must omit the filter rather than
 * passing `""` when no project is selected.
 */
export interface AgentsFilter {
	projectId?: string;
}

function agentsQuery(filter: AgentsFilter): string {
	if (filter.projectId === undefined || filter.projectId.length === 0) return "";
	const params = new URLSearchParams({ projectId: filter.projectId });
	return `?${params.toString()}`;
}

export const agentsApi = {
	list: (filter: AgentsFilter = {}, signal?: AbortSignal) =>
		request<{ agents: AgentRow[] }>(`/agents${agentsQuery(filter)}`, {
			...(signal ? { signal } : {}),
		}),
	get: (name: string, filter: AgentsFilter = {}, signal?: AbortSignal) =>
		request<AgentRow>(`/agents/${encodeURIComponent(name)}${agentsQuery(filter)}`, {
			...(signal ? { signal } : {}),
		}),
};

/* ----------------------------------------------------------------------- */
/* Projects                                                                 */
/* ----------------------------------------------------------------------- */

export const projectsApi = {
	list: (signal?: AbortSignal) =>
		request<{ projects: ProjectRow[] }>("/projects", { ...(signal ? { signal } : {}) }),
	create: (input: { gitUrl: string; defaultBranch?: string }) =>
		request<ProjectRow>("/projects", { method: "POST", body: input }),
	delete: (id: string) =>
		request<ProjectRow>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
	refresh: (id: string, input: { ref?: string } = {}) =>
		request<RefreshProjectResponse>(`/projects/${encodeURIComponent(id)}/refresh`, {
			method: "POST",
			body: input,
		}),
	warrenConfig: (id: string, signal?: AbortSignal) =>
		request<WarrenConfigResponse>(`/projects/${encodeURIComponent(id)}/warren-config`, {
			...(signal ? { signal } : {}),
		}),
	triggers: (id: string, signal?: AbortSignal) =>
		request<TriggersResponse>(`/projects/${encodeURIComponent(id)}/triggers`, {
			...(signal ? { signal } : {}),
		}),
	runTrigger: (id: string, triggerId: string) =>
		request<RunTriggerResponse>(
			`/projects/${encodeURIComponent(id)}/triggers/${encodeURIComponent(triggerId)}/run`,
			{ method: "POST", body: {} },
		),
	/**
	 * `GET /projects/:id/seeds/:seedId` — read a seed's current status
	 * (warren-4015).
	 */
	seedStatus: (id: string, seedId: string, signal?: AbortSignal) =>
		request<SeedStatusResponse>(
			`/projects/${encodeURIComponent(id)}/seeds/${encodeURIComponent(seedId)}`,
			{ ...(signal ? { signal } : {}) },
		),
	/**
	 * `GET /projects/:id/seeds/plans` — list the project's seeds plans
	 * (warren-9b49). Populates the plan-run dispatch form's plan-id
	 * selector with a manual-entry fallback.
	 */
	seedPlans: (id: string, signal?: AbortSignal) =>
		request<SeedPlansResponse>(`/projects/${encodeURIComponent(id)}/seeds/plans`, {
			...(signal ? { signal } : {}),
		}),

	/**
	 * `GET /projects/:id/ready-plans` — approved plans with ≥1 open child
	 * seed that have not yet been dispatched (warren-7937). Powers the
	 * "Ready to dispatch" operator surface.
	 */
	readyPlans: (id: string, signal?: AbortSignal) =>
		request<ReadyPlansResponse>(`/projects/${encodeURIComponent(id)}/ready-plans`, {
			...(signal ? { signal } : {}),
		}),
};

/* ----------------------------------------------------------------------- */
/* Runs                                                                     */
/* ----------------------------------------------------------------------- */

export interface ListRunsFilter {
	project?: string;
	agent?: string;
	sort?: "started" | "cost";
	dir?: "asc" | "desc";
	limit?: number;
	offset?: number;
}

export const runsApi = {
	list: (filter: ListRunsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.project) params.set("project", filter.project);
		if (filter.agent) params.set("agent", filter.agent);
		if (filter.sort) params.set("sort", filter.sort);
		if (filter.dir) params.set("dir", filter.dir);
		if (filter.limit !== undefined) params.set("limit", String(filter.limit));
		if (filter.offset !== undefined) params.set("offset", String(filter.offset));
		const qs = params.toString();
		return request<ListRunsResponse>(`/runs${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
	get: (id: string, signal?: AbortSignal) =>
		request<RunRow>(`/runs/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) }),
	create: (input: CreateRunInput) =>
		request<SpawnRunResponse>("/runs", { method: "POST", body: input }),
	steer: (id: string, input: { body: string }) =>
		request<SteerRunResponse>(`/runs/${encodeURIComponent(id)}/steer`, {
			method: "POST",
			body: input,
		}),
	cancel: (id: string, input: { reason?: string } = {}) =>
		request<CancelRunResponse>(`/runs/${encodeURIComponent(id)}/cancel`, {
			method: "POST",
			body: input,
		}),
	previewTeardown: (id: string, input: { actor?: string } = {}) =>
		request<PreviewTeardownResponse>(`/runs/${encodeURIComponent(id)}/preview/teardown`, {
			method: "POST",
			body: input,
		}),
	/**
	 * Preview login handshake (`POST /runs/:id/preview/login`, R-19 /
	 * SPEC §11.L, warren-8a10 / warren-edff; warren-e1b0 moved the bearer
	 * out of the URL). The bearer rides the `Authorization` header like
	 * every other call in this module; the server answers with a
	 * `Set-Cookie` the browser stores for the same-origin preview surface
	 * plus the `url` to navigate to. The server picks the target from the
	 * deployment's `WARREN_PREVIEW_MODE` — `https://run-<id>.<host>/` in
	 * subdomain mode, `<origin>/p/<id>/` in path mode — so callers stay
	 * mode-agnostic.
	 */
	previewLogin: (id: string, input: { redirect?: string } = {}) =>
		request<PreviewLoginResponse>(`/runs/${encodeURIComponent(id)}/preview/login`, {
			method: "POST",
			body: input,
		}),
};

/**
 * Deployment-wide preview config (R-19 / SPEC §11.L path addendum,
 * warren-016d). Fetched once per session — mode/host can only change via
 * a warren restart — and consumed by `PreviewCard` to render the
 * canonical preview URL string.
 */
export const previewApi = {
	config: (signal?: AbortSignal) =>
		request<PreviewConfigResponse>("/preview/config", { ...(signal ? { signal } : {}) }),
};

/**
 * Format the canonical preview URL for a run. Mirrors server-side
 * `formatPreviewUrl` (`src/preview/launch/index.ts`) so the displayed URL
 * matches where the login handshake actually redirects:
 *
 *   - path mode      → `<origin>/p/<runId>/` (origin from `config.host`
 *                       when set, otherwise the current `window.location.origin`
 *                       — previews ride on the warren host itself).
 *   - subdomain mode → `https://run-<runId>.<host>/` (host always set in
 *                       this mode; boot rejects subdomain without host).
 */
export function formatPreviewUrl(
	runId: string,
	config: PreviewConfigResponse,
	origin: string,
): string {
	if (config.mode === "path") {
		const base = config.host !== null ? `https://${config.host}` : origin;
		return `${base}/p/${encodeURIComponent(runId)}/`;
	}
	const host = config.host ?? "";
	return `https://run-${encodeURIComponent(runId)}.${host}/`;
}

/* ----------------------------------------------------------------------- */
/* Plan-runs (warren-f923 / warren-a87f, pl-a258).                          */
/* ----------------------------------------------------------------------- */

export interface ListPlanRunsFilter {
	project?: string;
	state?: PlanRunState;
}

export const planRunsApi = {
	list: (filter: ListPlanRunsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.project) params.set("project", filter.project);
		if (filter.state) params.set("state", filter.state);
		const qs = params.toString();
		return request<{ planRuns: PlanRunRow[] }>(`/plan-runs${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
	get: (id: string, signal?: AbortSignal) =>
		request<PlanRunDetailResponse>(`/plan-runs/${encodeURIComponent(id)}`, {
			...(signal ? { signal } : {}),
		}),
	create: (input: CreatePlanRunInput) =>
		request<CreatePlanRunResponse>("/plan-runs", { method: "POST", body: input }),
	cancel: (id: string) =>
		request<CancelPlanRunResponse>(`/plan-runs/${encodeURIComponent(id)}/cancel`, {
			method: "POST",
			body: {},
		}),
	events: (id: string, opts: StreamRunEventsOptions = {}) => streamPlanRunEvents(id, opts),
};

/**
 * NDJSON tail of every child run's events for a plan-run
 * (`GET /plan-runs/:id/events`). Each yielded envelope shares the
 * `RunEvent` shape — the server uses the same `eventToNdjson` serializer
 * as `/runs/:id/events`, with `runId` discriminating between children.
 */
export async function* streamPlanRunEvents(
	planRunId: string,
	opts: StreamRunEventsOptions = {},
): AsyncGenerator<RunEvent, void, void> {
	yield* streamNdjsonEvents(`/plan-runs/${encodeURIComponent(planRunId)}/events`, opts);
}

/* ----------------------------------------------------------------------- */
/* NDJSON event stream — `GET /runs/:id/events?follow=1` (SPEC §8.1).      */
/* ----------------------------------------------------------------------- */

export interface StreamRunEventsOptions {
	follow?: boolean;
	sinceSeq?: number;
	signal?: AbortSignal;
}

/**
 * Async iterator over NDJSON events. Each `yield` is one parsed
 * `RunEvent` from the wire. Caller's `signal` aborts the underlying
 * fetch so component unmount tears the connection down promptly.
 */
export async function* streamRunEvents(
	runId: string,
	opts: StreamRunEventsOptions = {},
): AsyncGenerator<RunEvent, void, void> {
	yield* streamNdjsonEvents(`/runs/${encodeURIComponent(runId)}/events`, opts);
}

/**
 * Shared NDJSON consumer for run + plan-run event streams. The server
 * uses the same `eventToNdjson` serializer for both, so the wire shape
 * matches and the only thing that varies is the URL prefix + `runId`
 * discriminator in each envelope.
 */
async function* streamNdjsonEvents(
	basePath: string,
	opts: StreamRunEventsOptions,
): AsyncGenerator<RunEvent, void, void> {
	const params = new URLSearchParams();
	if (opts.follow) params.set("follow", "1");
	if (opts.sinceSeq !== undefined) params.set("since", String(opts.sinceSeq));
	const qs = params.toString();
	const url = `${basePath}${qs.length > 0 ? `?${qs}` : ""}`;

	const headers: Record<string, string> = { accept: "application/x-ndjson" };
	const token = getApiToken();
	if (token !== null && token.length > 0) headers.authorization = `Bearer ${token}`;

	const init: RequestInit = { headers };
	if (opts.signal) init.signal = opts.signal;

	const res = await fetch(url, init);
	if (res.status === 401) {
		setApiToken(null);
		throw new UnauthorizedError("API token rejected; please re-authenticate");
	}
	if (!res.ok) {
		const text = await res.text();
		let envelope: ApiErrorEnvelope | null = null;
		try {
			envelope = text.length > 0 ? (JSON.parse(text) as ApiErrorEnvelope) : null;
		} catch {
			envelope = null;
		}
		throw new ApiError(
			res.status,
			envelope?.error ?? { code: `http_${res.status}`, message: text || res.statusText },
		);
	}
	if (res.body === null) return;

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.length > 0) {
					try {
						yield JSON.parse(line) as RunEvent;
					} catch {
						// drop malformed line; keep streaming
					}
				}
				nl = buf.indexOf("\n");
			}
		}
		// flush trailing line if the server closed without a newline
		const tail = buf.trim();
		if (tail.length > 0) {
			try {
				yield JSON.parse(tail) as RunEvent;
			} catch {
				// drop
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// ignore — releaseLock can throw if we already errored out
		}
	}
}

/* ----------------------------------------------------------------------- */
/* Meta                                                                     */
/* ----------------------------------------------------------------------- */

export const metaApi = {
	healthz: () => request<{ ok: boolean }>("/healthz"),
	readyz: () => request<ReadyzResponse>("/readyz"),
	version: (signal?: AbortSignal) =>
		request<{ version: string }>("/version", { ...(signal ? { signal } : {}) }),
	/**
	 * Who warren admitted this browser as, and what it may do (warren-e195).
	 * The capability layer calls this on mount and renders operator-only
	 * affordances from the answer instead of inferring permission from the
	 * presence of a stored token. Gated: under the default
	 * `WARREN_AUTH=token` a browser with no token gets a 401, which
	 * `request` already turns into `UnauthorizedError`.
	 */
	whoami: (signal?: AbortSignal) =>
		request<WhoamiResponse>("/whoami", { ...(signal ? { signal } : {}) }),
};

/* ----------------------------------------------------------------------- */
/* Analytics (warren-cf63 / pl-b0c0 step 6)                                 */
/* ----------------------------------------------------------------------- */

export type CostDimension = "date" | "project" | "plan" | "run" | "agent" | "model" | "provider";

export interface CostBucket {
	key: string;
	costUsd: number;
	runs: number;
	priced: number;
}

export interface CostAnalyticsResponse {
	filter: { projectId: string | null; from: string | null; to: string | null };
	totals: { runs: number; priced: number; costUsd: number };
	breakdowns: Record<CostDimension, CostBucket[]>;
}

export interface CostAnalyticsFilter {
	projectId?: string;
	from?: string;
	to?: string;
}

export const COST_ANALYTICS_NONE_KEY = "__none__";

export const analyticsApi = {
	cost: (filter: CostAnalyticsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.projectId) params.set("projectId", filter.projectId);
		if (filter.from) params.set("from", filter.from);
		if (filter.to) params.set("to", filter.to);
		const qs = params.toString();
		return request<CostAnalyticsResponse>(`/analytics/cost${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
};

/* ----------------------------------------------------------------------- */
/* Run analytics (warren-df6e / pl-ad0f step 4)                            */
/* ----------------------------------------------------------------------- */

/** Sentinel key for a null group (no startedAt, model, provider, etc.). */
export const RUN_ANALYTICS_NONE_KEY = "__none__";
/** Sentinel key for the folded remainder in per-dimension token series (≥6 keys). */
export const RUN_ANALYTICS_OTHER_KEY = "__other__";

/** avg/median/p95 over the non-null sample, all-null when empty. */
export interface RunStatSummary {
	avg: number | null;
	median: number | null;
	p95: number | null;
	count: number;
}

export interface RunAnalyticsTotals {
	runs: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	active: number;
	successRate: number | null;
	durationMs: RunStatSummary;
	contextTokens: RunStatSummary;
	cost: { total: number; avg: number | null; priced: number };
}

export interface RunDayBucket {
	key: string;
	runs: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	active: number;
	contextTokensTotal: number;
}

export interface RunGroupBucket {
	key: string;
	runs: number;
	succeeded: number;
	failed: number;
	successRate: number | null;
	contextTokensTotal: number;
	avgContextTokens: number | null;
	tokens: TokenBreakdown;
	costUsd: number;
	priced: number;
	avgDurationMs: number | null;
}

export interface RunFailureBucket {
	key: string;
	runs: number;
}

export interface SeedContextBucket {
	seedId: string;
	runs: number;
	contextTokensTotal: number;
	avgContextTokens: number | null;
}

export interface RunAnalyticsResponse {
	filter: { projectId: string | null; from: string | null; to: string | null };
	totals: RunAnalyticsTotals;
	timeSeries: RunDayBucket[];
	byAgent: RunGroupBucket[];
	byModel: RunGroupBucket[];
	byProvider: RunGroupBucket[];
	byFailureReason: RunFailureBucket[];
	topSeedsByContext: SeedContextBucket[];
	/** Token analytics section added by warren-1244 / pl-d1a2 step 2. */
	tokens: RunAnalyticsTokensSection;
}

export interface RunAnalyticsFilter {
	projectId?: string;
	from?: string;
	to?: string;
}

/* ----------------------------------------------------------------------- */
/* Run behavior analytics — command mining + insights (warren-436a /       */
/* pl-ad0f step 10). Mirrors the server shapes in                          */
/* src/runs/analytics/command-mining.ts + insights.ts.                     */
/* ----------------------------------------------------------------------- */

/** Generalized command category — `os-eco` rows are highlighted in the UI. */
export type CommandCategory =
	| "os-eco"
	| "vcs"
	| "package"
	| "build"
	| "test"
	| "filesystem"
	| "network"
	| "other";

export interface CommandStat {
	command: string;
	category: CommandCategory;
	osEco: boolean;
	runs: number;
	invocations: number;
	failures: number;
	failureRate: number | null;
	retries: number;
	stuckScore: number;
}

export interface CommandCategoryBucket {
	category: CommandCategory;
	invocations: number;
	failures: number;
	commands: number;
}

export interface CommandMiningTotals {
	toolUses: number;
	commands: number;
	distinctCommands: number;
	failures: number;
	retries: number;
}

export interface CommandMining {
	totals: CommandMiningTotals;
	byFrequency: CommandStat[];
	byFailures: CommandStat[];
	byStuckScore: CommandStat[];
	osEcoCommands: CommandStat[];
	byCategory: CommandCategoryBucket[];
}

export type InsightSeverity = "info" | "warning" | "critical";

export type InsightKind =
	| "highest-context-seed"
	| "worst-success-agent"
	| "most-failed-command"
	| "most-retried-command"
	| "model-cost-outlier"
	| "steering-anomaly"
	| "pause-anomaly";

export interface Insight {
	kind: InsightKind;
	severity: InsightSeverity;
	title: string;
	detail: string;
	value: number;
	subject: string | null;
}

export interface RunBehaviorResponse {
	filter: { projectId: string | null; from: string | null; to: string | null };
	mining: CommandMining;
	insights: Insight[];
}

export const runAnalyticsApi = {
	runs: (filter: RunAnalyticsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.projectId) params.set("projectId", filter.projectId);
		if (filter.from) params.set("from", filter.from);
		if (filter.to) params.set("to", filter.to);
		const qs = params.toString();
		return request<RunAnalyticsResponse>(`/analytics/runs${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
	behavior: (filter: RunAnalyticsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.projectId) params.set("projectId", filter.projectId);
		if (filter.from) params.set("from", filter.from);
		if (filter.to) params.set("to", filter.to);
		const qs = params.toString();
		return request<RunBehaviorResponse>(`/analytics/behavior${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
};
