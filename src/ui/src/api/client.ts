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
	CreatePlotPlanRunInput,
	CreatePlotPlanRunResponse,
	FormalizePlotResponse,
	StartBrainstormInput,
	StartBrainstormResponse,
	AnswerPlotQuestionInput,
	AnswerPlotQuestionResponse,
	AttachPlotInput,
	AttachPlotResponse,
	MergePlotPrInput,
	MergePlotPrResponse,
	ChangePlotStatusInput,
	ChangePlotStatusResponse,
	CreatePlotInput,
	CreateRunInput,
	DetachPlotResponse,
	EditPlotIntentInput,
	RenamePlotInput,
	ListPlotsResponse,
	ListRunsResponse,
	PlotEnvelope,
	PlotSummaryArtifact,
	PlanRunDetailResponse,
	PlanRunRow,
	PlanRunState,
	PlotStatus,
	PlotSummary,
	PreviewConfigResponse,
	PreviewTeardownResponse,
	ProjectRow,
	ReadyzResponse,
	RefreshAgentsResponse,
	RefreshProjectAgentsResponse,
	RefreshProjectResponse,
	RunEvent,
	RunRow,
	RunTriggerResponse,
	SeedStatusResponse,
	SendRunMessageInput,
	SendRunMessageResponse,
	SpawnRunResponse,
	SteerRunResponse,
	TriggersResponse,
	WarrenConfigResponse,
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
	refresh: () => request<RefreshAgentsResponse>("/agents/refresh", { method: "POST", body: {} }),
	/**
	 * Refresh just one project's `.canopy/` tier (R-03 / pl-fef5 step 6).
	 * Distinct from `refresh`, which re-clones the library AND every
	 * project's tier in one pass — the per-project route is the targeted
	 * path the Agents page calls after the operator edits one project's
	 * `.canopy/`.
	 */
	refreshProject: (projectId: string) =>
		request<RefreshProjectAgentsResponse>(
			`/projects/${encodeURIComponent(projectId)}/agents/refresh`,
			{ method: "POST", body: {} },
		),
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
	 * (warren-4015). Used by PlotDetail BatchDispatch to skip closed
	 * seeds before firing N parallel POST /runs.
	 */
	seedStatus: (id: string, seedId: string, signal?: AbortSignal) =>
		request<SeedStatusResponse>(
			`/projects/${encodeURIComponent(id)}/seeds/${encodeURIComponent(seedId)}`,
			{ ...(signal ? { signal } : {}) },
		),
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
	/**
	 * `POST /runs` sugar (pl-0344 step 4 / warren-b3b9) for spawning an
	 * interactive turn bound to a Plot. Plumbs `mode: 'interactive'` +
	 * `interactiveAgent` over the same wire path as `create`; the server
	 * uses `interactiveAgent` to resolve the agent and requires `plotId`.
	 * The Chat component spawns subsequent turns via `sendMessage`
	 * against the freshly-spawned run id (`onTurnSpawned` re-anchor).
	 */
	createInteractive: (input: {
		agent: string;
		project: string;
		plotId: string;
		prompt: string;
		ref?: string;
		providerOverride?: string;
		modelOverride?: string;
		dispatcherHandle?: string;
	}) =>
		request<SpawnRunResponse>("/runs", {
			method: "POST",
			body: {
				// `agent` is still a required field server-side even when
				// `interactiveAgent` overrides it (see parseRunMode +
				// createRunHandler in src/server/handlers.ts).
				agent: input.agent,
				interactiveAgent: input.agent,
				mode: "interactive",
				project: input.project,
				plotId: input.plotId,
				prompt: input.prompt,
				...(input.ref !== undefined ? { ref: input.ref } : {}),
				...(input.providerOverride !== undefined
					? { providerOverride: input.providerOverride }
					: {}),
				...(input.modelOverride !== undefined
					? { modelOverride: input.modelOverride }
					: {}),
				...(input.dispatcherHandle !== undefined
					? { dispatcherHandle: input.dispatcherHandle }
					: {}),
			},
		}),
	sendMessage: (id: string, input: SendRunMessageInput) =>
		request<SendRunMessageResponse>(`/runs/${encodeURIComponent(id)}/messages`, {
			method: "POST",
			body: input,
		}),
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
};

/**
 * Build the URL of the auth-exempt preview login handshake
 * (`GET /runs/:id/preview/login?token=...`) so the UI can render a
 * clickable link. The server redirects to the right target based on the
 * deployment's `WARREN_PREVIEW_MODE` — `https://run-<id>.<host>/` in
 * subdomain mode, `<inbound-origin>/p/<id>/` in path mode — so this URL
 * is mode-agnostic from the client's POV (R-19 / SPEC §11.L, warren-8a10
 * / warren-edff). Returns null when no bearer is cached — the link would
 * 401 without it.
 */
export function buildPreviewLoginUrl(runId: string): string | null {
	const token = getApiToken();
	if (token === null || token.length === 0) return null;
	return `/runs/${encodeURIComponent(runId)}/preview/login?token=${encodeURIComponent(token)}`;
}

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
 * `formatPreviewUrl` (`src/preview/launch.ts`) so the displayed URL
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
		return request<{ planRuns: PlanRunRow[] }>(
			`/plan-runs${qs.length > 0 ? `?${qs}` : ""}`,
			{ ...(signal ? { signal } : {}) },
		);
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
	events: (id: string, opts: StreamRunEventsOptions = {}) =>
		streamPlanRunEvents(id, opts),
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
	yield* streamNdjsonEvents(
		`/plan-runs/${encodeURIComponent(planRunId)}/events`,
		opts,
	);
}

/* ----------------------------------------------------------------------- */
/* Plots (warren-4879 / pl-9d6a step 4).                                    */
/* ----------------------------------------------------------------------- */

export interface ListPlotsFilter {
	status?: PlotStatus;
	/**
	 * `needs_attention` routes to the server-side scorer; rows carry an
	 * ordered `reasons` array (warren-d693). Status filter composes on
	 * top so a UI can render e.g. "drafting Plots in the Needs-you view".
	 */
	filter?: "needs_attention";
}

export const plotsApi = {
	/**
	 * `GET /plots?status=` — cross-project Plot list. Empty array (200)
	 * when no `hasPlot=true` projects exist (mirrors the
	 * byte-identical-empty contract pinned by scenario 28); the UI's
	 * Plots page renders the "no hasPlot projects yet" empty state on
	 * `plots.length === 0`. Unknown status string is rejected
	 * server-side with a 400 / `bad_request`.
	 */
	list: (filter: ListPlotsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.status) params.set("status", filter.status);
		if (filter.filter) params.set("filter", filter.filter);
		const qs = params.toString();
		return request<ListPlotsResponse>(`/plots${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
	/**
	 * `GET /plots/needs-attention/count` — sidebar-badge counter
	 * (warren-d693 / pl-0344 step 9; consumed by Layout in warren-f0e2 /
	 * step 13). Returns `{ count: 0 }` on deployments without the Plot
	 * aggregator wired — byte-stable for the standalone path.
	 */
	needsAttentionCount: (signal?: AbortSignal) =>
		request<{ count: number }>("/plots/needs-attention/count", {
			...(signal ? { signal } : {}),
		}),
	/**
	 * `POST /plots` — create a fresh Plot in the named project's `.plot/`
	 * directory. Returns the new `PlotSummary` (201). Rejects with
	 * `ApiError` code `project_lacks_plot` when the project hasn't opted
	 * into Plots (mirrors the server-side `ProjectLacksPlotError`). The
	 * input is camelCase; the wire body uses snake_case per the
	 * `POST /plots` handler contract.
	 */
	create: (input: CreatePlotInput) =>
		request<PlotSummary>("/plots", {
			method: "POST",
			body: {
				project_id: input.projectId,
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.intent !== undefined ? { intent: input.intent } : {}),
				...(input.dispatcherHandle !== undefined
					? { dispatcher_handle: input.dispatcherHandle }
					: {}),
			},
		}),
	/**
	 * `GET /plots/:id` — full Plot envelope (warren-961e / pl-9d6a step 8).
	 * `event_log` is returned in ascending `at` order; the UI collapses
	 * same-kind same-actor chains client-side.
	 */
	get: (plotId: string, signal?: AbortSignal) =>
		request<PlotEnvelope>(`/plots/${encodeURIComponent(plotId)}`, {
			...(signal ? { signal } : {}),
		}),
	/**
	 * `GET /plots/:id/summary` — curated artifact view (warren-8917 /
	 * pl-0344 step 15). Returns the institutional-memory projection:
	 * formatted intent, decisions filtered from the event log,
	 * linked PRs + commits, and a structural timeline. Pure derivation
	 * over the same `.plot/` reader as `get`.
	 */
	summary: (plotId: string, signal?: AbortSignal) =>
		request<PlotSummaryArtifact>(`/plots/${encodeURIComponent(plotId)}/summary`, {
			...(signal ? { signal } : {}),
		}),
	/**
	 * `POST /plots/:id/intent` — edit Plot intent (warren-896f /
	 * pl-9d6a step 9). Server rejects with `plot_intent_frozen` (409)
	 * when status is done/archived; UI also disables the form to short
	 * the round-trip.
	 */
	editIntent: (plotId: string, input: EditPlotIntentInput) => {
		const body: Record<string, unknown> = {};
		if (input.goal !== undefined) body.goal = input.goal;
		if (input.non_goals !== undefined) body.non_goals = input.non_goals;
		if (input.constraints !== undefined) body.constraints = input.constraints;
		if (input.success_criteria !== undefined) body.success_criteria = input.success_criteria;
		if (input.dispatcherHandle !== undefined) body.dispatcher_handle = input.dispatcherHandle;
		return request<PlotEnvelope>(`/plots/${encodeURIComponent(plotId)}/intent`, {
			method: "POST",
			body,
		});
	},
	/**
	 * `POST /plots/:id/rename` — rename a Plot (warren-bed0 / pl-b0c0
	 * step 3). Server trims the name and rejects empty-after-trim with
	 * 400. Allowed in every status (the name is pure metadata).
	 */
	rename: (plotId: string, input: RenamePlotInput) => {
		const body: Record<string, unknown> = { name: input.name };
		if (input.dispatcherHandle !== undefined) body.dispatcher_handle = input.dispatcherHandle;
		return request<PlotEnvelope>(`/plots/${encodeURIComponent(plotId)}/rename`, {
			method: "POST",
			body,
		});
	},
	/**
	 * `POST /plots/:id/status` — transition status (warren-e868 /
	 * pl-9d6a step 10). The legal-transition matrix is enforced at the
	 * handler edge; UI button group should already only surface
	 * reachable next states.
	 */
	changeStatus: (plotId: string, input: ChangePlotStatusInput) =>
		request<ChangePlotStatusResponse>(`/plots/${encodeURIComponent(plotId)}/status`, {
			method: "POST",
			body: {
				next: input.next,
				...(input.dispatcherHandle !== undefined
					? { dispatcher_handle: input.dispatcherHandle }
					: {}),
			},
		}),
	/** `POST /plots/:id/attachments` — attach external reference. */
	attach: (plotId: string, input: AttachPlotInput) =>
		request<AttachPlotResponse>(`/plots/${encodeURIComponent(plotId)}/attachments`, {
			method: "POST",
			body: {
				kind: input.kind,
				ref: input.ref,
				...(input.role !== undefined ? { role: input.role } : {}),
				...(input.dispatcherHandle !== undefined
					? { dispatcher_handle: input.dispatcherHandle }
					: {}),
			},
		}),
	/** `DELETE /plots/:id/attachments/:ref` — detach by ref. */
	detach: (plotId: string, ref: string, dispatcherHandle?: string) =>
		request<DetachPlotResponse>(
			`/plots/${encodeURIComponent(plotId)}/attachments/${encodeURIComponent(ref)}`,
			{
				method: "DELETE",
				...(dispatcherHandle !== undefined
					? { body: { dispatcher_handle: dispatcherHandle } }
					: {}),
			},
		),
	/**
	 * `POST /plots/:id/attachments/:ref/merge` — click-to-merge a
	 * `gh_pr` attachment (warren-8e39 / pl-0344 step 14). Returns the
	 * fresh envelope plus the GitHub merge outcome variant. On
	 * `merged` / `already_merged` the server schedules a background
	 * project-clone refresh.
	 */
	mergeAttachment: (plotId: string, ref: string, input: MergePlotPrInput = {}) =>
		request<MergePlotPrResponse>(
			`/plots/${encodeURIComponent(plotId)}/attachments/${encodeURIComponent(ref)}/merge`,
			{
				method: "POST",
				body: {
					...(input.mergeMethod !== undefined ? { merge_method: input.mergeMethod } : {}),
					...(input.dispatcherHandle !== undefined
						? { dispatcher_handle: input.dispatcherHandle }
						: {}),
				},
			},
		),
	/**
	 * `POST /plan-runs` (sugar) — dispatch a plan run bound to this
	 * Plot. Identical wire surface to `planRunsApi.create`; surfaced on
	 * `plotsApi` so the PlotDetail "Run plan" button (warren-5d94 /
	 * pl-9d6a step 14) reads as a Plot-side action. The server-side
	 * stacked gate (mx-4b7ff8) rejects with `project_lacks_seeds` when
	 * the project has no `.seeds/` directory and with
	 * `project_lacks_plot` when `plotId` is set on a project without
	 * `.plot/`; both surface as `ApiError` to the caller.
	 */
	dispatchPlanRun: (input: CreatePlanRunInput) =>
		request<CreatePlanRunResponse>("/plan-runs", { method: "POST", body: input }),
	/**
	 * `POST /plot-plan-runs` — synthesize a seeds plan from the Plot's
	 * open `seeds_issue` attachments and dispatch it through the same
	 * §11.P coordinator as `dispatchPlanRun` (warren-99b2, SPEC §11.Q).
	 * Server-side filters: `pl-*`-shaped refs (sd_plan attachments) and
	 * closed seeds drop out before synthesis; zero candidates returns
	 * 400 `no_dispatchable_seeds`. Wire body is snake_case per the
	 * handler contract.
	 */
	dispatchSynthesizedPlanRun: (input: CreatePlotPlanRunInput) =>
		request<CreatePlotPlanRunResponse>("/plot-plan-runs", {
			method: "POST",
			body: {
				plot_id: input.plotId,
				project_id: input.projectId,
				agent_name: input.agent,
				...(input.promptTemplate !== undefined
					? { prompt_template: input.promptTemplate }
					: {}),
				...(input.ref !== undefined ? { ref: input.ref } : {}),
				...(input.providerOverride !== undefined
					? { provider_override: input.providerOverride }
					: {}),
				...(input.modelOverride !== undefined
					? { model_override: input.modelOverride }
					: {}),
				...(input.dispatcherHandle !== undefined
					? { dispatcher_handle: input.dispatcherHandle }
					: {}),
			},
		}),
	/**
	 * `POST /plots/:id/questions/:event_id/answer` — answer a
	 * question_posed event. `eventId` is the targeted event's `at` ISO
	 * timestamp.
	 */
	/**
	 * `POST /brainstorm` — atomically create a draft Plot in the named
	 * project and dispatch the first interactive turn against the
	 * built-in `brainstorm` agent (pl-0344 step 8 / warren-d22e). The
	 * one-call wrapper saves the UI an awkward `POST /plots` then
	 * `POST /runs` dance plus partial-failure rollback.
	 */
	startBrainstorm: (input: StartBrainstormInput) =>
		request<StartBrainstormResponse>("/brainstorm", {
			method: "POST",
			body: {
				project_id: input.projectId,
				prompt: input.prompt,
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.agent !== undefined ? { agent: input.agent } : {}),
				...(input.dispatcherHandle !== undefined
					? { dispatcher_handle: input.dispatcherHandle }
					: {}),
				...(input.providerOverride !== undefined
					? { providerOverride: input.providerOverride }
					: {}),
				...(input.modelOverride !== undefined
					? { modelOverride: input.modelOverride }
					: {}),
				...(input.ref !== undefined ? { ref: input.ref } : {}),
			},
		}),
	/**
	 * `POST /plots/:id/formalize` — returns a suggested Plot intent
	 * extracted from the brainstorm conversation's `agent_message`
	 * events (pl-0344 step 8 / warren-d22e). Non-mutating: the caller
	 * (PlotDetail Formalize dialog) renders the suggestion as a review
	 * form and applies via `editIntent` on accept.
	 */
	formalize: (plotId: string) =>
		request<FormalizePlotResponse>(
			`/plots/${encodeURIComponent(plotId)}/formalize`,
			{ method: "POST", body: {} },
		),
	answerQuestion: (plotId: string, input: AnswerPlotQuestionInput) =>
		request<AnswerPlotQuestionResponse>(
			`/plots/${encodeURIComponent(plotId)}/questions/${encodeURIComponent(input.eventId)}/answer`,
			{
				method: "POST",
				body: {
					answer: input.answer,
					...(input.dispatcherHandle !== undefined
						? { dispatcher_handle: input.dispatcherHandle }
						: {}),
				},
			},
		),
};

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
};

/* ----------------------------------------------------------------------- */
/* Analytics (warren-cf63 / pl-b0c0 step 6)                                 */
/* ----------------------------------------------------------------------- */

export type CostDimension =
	| "date"
	| "project"
	| "plan"
	| "plot"
	| "run"
	| "agent"
	| "model"
	| "provider";

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
		return request<CostAnalyticsResponse>(
			`/analytics/cost${qs.length > 0 ? `?${qs}` : ""}`,
			{ ...(signal ? { signal } : {}) },
		);
	},
};
