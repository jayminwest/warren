import { type EnvLike, loadWarrenClientConfigFromEnv, type WarrenClientConfig } from "./config.ts";
import { WarrenClientError, WarrenUnreachableError } from "./errors.ts";
import {
	type AgentRow,
	type ApiErrorEnvelope,
	type ChangePlotStatusInput,
	type ChangePlotStatusResponse,
	type CreatePlanRunInput,
	type CreatePlanRunResponse,
	type CreatePlotInput,
	type CreateProjectInput,
	type CreateRunInput,
	type DispatchRunInput,
	type EditPlotIntentInput,
	isTerminalRunState,
	type ListAgentsQuery,
	type ListAgentsResponse,
	type ListPlanRunsFilter,
	type ListPlanRunsResponse,
	type ListPlotsFilter,
	type ListPlotsResponse,
	type ListProjectsResponse,
	type ListRunsResponse,
	type PlanRunDetailResponse,
	type PlotEnvelope,
	type PlotSummary,
	type PlotSyncResponse,
	type ProjectRow,
	type RefreshAgentsResponse,
	type RefreshProjectAgentsResult,
	type RefreshProjectInput,
	type RefreshProjectResponse,
	type RunEvent,
	type RunRow,
	type SpawnRunResponse,
	type SteerRunInput,
	type SteerRunResponse,
	type StreamRunEventsOptions,
} from "./types.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/** Default poll cadence for {@link WarrenClient.waitForRun}. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Default overall budget for {@link WarrenClient.waitForRun}. */
export const DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1_000;

export interface WaitForRunOptions {
	/** Poll cadence. Defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
	readonly intervalMs?: number;
	/** Overall budget. Defaults to {@link DEFAULT_POLL_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
	/** External abort. */
	readonly signal?: AbortSignal;
	/** Optional callback invoked after each poll for observability. */
	readonly onTick?: (row: RunRow) => void;
}

export interface WarrenClientOptions {
	readonly config: WarrenClientConfig;
	/** Override fetch (tests, instrumentation). */
	readonly fetch?: typeof fetch;
}

export class WarrenClient {
	readonly config: WarrenClientConfig;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: WarrenClientOptions) {
		this.config = opts.config;
		this.fetchImpl = opts.fetch ?? fetch;
	}

	static fromEnv(env: EnvLike = process.env, fetchImpl?: typeof fetch): WarrenClient {
		const config = loadWarrenClientConfigFromEnv(env);
		return new WarrenClient(fetchImpl !== undefined ? { config, fetch: fetchImpl } : { config });
	}

	/**
	 * Hit `/healthz` with a timeout and convert transport-layer failures
	 * into `WarrenUnreachableError`. `/healthz` is auth-exempt.
	 */
	async probe(timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS): Promise<void> {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			await this.withTransportMapping(async () => {
				const aborted = new Promise<never>((_, reject) => {
					ctrl.signal.addEventListener(
						"abort",
						() => reject(new WarrenUnreachableError(`warren probe timed out after ${timeoutMs}ms`)),
						{ once: true },
					);
				});
				await Promise.race([this.requestRaw("/healthz", { signal: ctrl.signal }), aborted]);
			});
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Helper to send requests and handle common things like bearer token auth,
	 * URL concatenation, and response deserialization.
	 */
	async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		return this.withTransportMapping(async () => {
			const res = await this.requestRaw(path, init);
			if (!res.ok) {
				let envelope: ApiErrorEnvelope | null = null;
				try {
					envelope = (await res.json()) as ApiErrorEnvelope;
				} catch {
					// Non-JSON or malformed body
				}
				const code = envelope?.error?.code ?? `http_${res.status}`;
				const message =
					envelope?.error?.message ?? `warren request failed with status ${res.status}`;
				const hint = envelope?.error?.hint;
				throw new WarrenClientError(res.status, code, message, hint);
			}
			const text = await res.text();
			if (text.length === 0) return undefined as T;
			return JSON.parse(text) as T;
		});
	}

	async getProject(projectId: string): Promise<ProjectRow> {
		return this.request<ProjectRow>(`/projects/${encodeURIComponent(projectId)}`);
	}

	async listProjects(): Promise<ListProjectsResponse> {
		return this.request<ListProjectsResponse>("/projects");
	}

	async createProject(input: CreateProjectInput): Promise<ProjectRow> {
		return this.request<ProjectRow>("/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
	}

	async refreshProject(
		projectId: string,
		input: RefreshProjectInput = {},
	): Promise<RefreshProjectResponse> {
		return this.request<RefreshProjectResponse>(
			`/projects/${encodeURIComponent(projectId)}/refresh`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			},
		);
	}

	async refreshProjectAgents(projectId: string): Promise<RefreshProjectAgentsResult> {
		return this.request<RefreshProjectAgentsResult>(
			`/projects/${encodeURIComponent(projectId)}/agents/refresh`,
			{ method: "POST" },
		);
	}

	async listAgents(query: ListAgentsQuery = {}): Promise<ListAgentsResponse> {
		const qs =
			query.projectId !== undefined && query.projectId !== ""
				? `?projectId=${encodeURIComponent(query.projectId)}`
				: "";
		return this.request<ListAgentsResponse>(`/agents${qs}`);
	}

	async getAgent(name: string, query: ListAgentsQuery = {}): Promise<AgentRow> {
		const qs =
			query.projectId !== undefined && query.projectId !== ""
				? `?projectId=${encodeURIComponent(query.projectId)}`
				: "";
		return this.request<AgentRow>(`/agents/${encodeURIComponent(name)}${qs}`);
	}

	async refreshAgents(): Promise<RefreshAgentsResponse> {
		return this.request<RefreshAgentsResponse>("/agents/refresh", { method: "POST" });
	}

	async createRun(input: CreateRunInput): Promise<SpawnRunResponse> {
		return this.request<SpawnRunResponse>("/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
	}

	/**
	 * POST /runs with the ergonomic `warren run` field names
	 * (`branch`, `model`, `provider`). Thin wrapper over {@link createRun}.
	 */
	async dispatch(input: DispatchRunInput): Promise<SpawnRunResponse> {
		const body: CreateRunInput = {
			agent: input.agent,
			project: input.project,
			prompt: input.prompt,
		};
		if (input.branch !== undefined) body.ref = input.branch;
		if (input.model !== undefined) body.modelOverride = input.model;
		if (input.provider !== undefined) body.providerOverride = input.provider;
		if (input.seedId !== undefined) body.seedId = input.seedId;
		if (input.plotId !== undefined) body.plotId = input.plotId;
		if (input.mode !== undefined) body.mode = input.mode;
		if (input.interactiveAgent !== undefined) body.interactiveAgent = input.interactiveAgent;
		if (input.dispatcherHandle !== undefined) body.dispatcherHandle = input.dispatcherHandle;
		return this.createRun(body);
	}

	/**
	 * `POST /runs/:id/steer` — mid-run steering. Forwards an operator
	 * message into the burrow inbox; the next agent turn on the run's
	 * burrow receives it. Valid only while the run is non-terminal AND a
	 * burrow is attached (the spawn-rollback window throws
	 * `ValidationError` server-side).
	 *
	 * For interactive runs this is the prompt-injection seam. For batch
	 * runs the same path delivers nudges, but blocking-question
	 * `pause ↔ resume` is driven server-side by Plot `question_answered`
	 * events (`src/runs/pause.ts`), not by this endpoint — callers do not
	 * need to issue an explicit "resume" after a steer.
	 */
	async steer(runId: string, input: SteerRunInput): Promise<SteerRunResponse> {
		const body: Record<string, unknown> = { body: input.body };
		if (input.priority !== undefined) body.priority = input.priority;
		if (input.fromActor !== undefined) body.fromActor = input.fromActor;
		return this.request<SteerRunResponse>(`/runs/${encodeURIComponent(runId)}/steer`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async getRun(runId: string): Promise<RunRow> {
		return this.request<RunRow>(`/runs/${encodeURIComponent(runId)}`);
	}

	async listRuns(): Promise<ListRunsResponse> {
		return this.request<ListRunsResponse>("/runs");
	}

	/**
	 * Poll `GET /runs/:id` until the run reaches a terminal state
	 * (`succeeded` | `failed` | `cancelled`) or the timeout/abort fires.
	 *
	 * Polling — not SSE — is the right primitive for short-lived
	 * external callers that just want a final state without holding
	 * an open connection.
	 */
	async waitForRun(runId: string, opts: WaitForRunOptions = {}): Promise<RunRow> {
		const interval = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		const timeout = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
		const deadline = Date.now() + timeout;
		for (;;) {
			if (opts.signal?.aborted) {
				throw new DOMException("waitForRun aborted", "AbortError");
			}
			const row = await this.getRun(runId);
			opts.onTick?.(row);
			if (isTerminalRunState(row.state)) return row;
			if (Date.now() + interval >= deadline) {
				throw new WarrenClientError(
					408,
					"wait_timeout",
					`run ${runId} did not reach a terminal state within ${timeout}ms (last state: ${row.state})`,
				);
			}
			await sleepWithSignal(interval, opts.signal);
		}
	}

	/**
	 * Async iterator over `GET /runs/:id/events` (NDJSON tail). One yield
	 * per event row, parsed as {@link RunEvent}. The wire format is
	 * NDJSON, not SSE — each line is a JSON envelope terminated by `\n`.
	 *
	 * - `follow: true` keeps the connection open so new events stream as
	 *   the run progresses. Without it, the server closes once the
	 *   current backlog is drained.
	 * - `sinceSeq` replays only events with `burrowEventSeq > sinceSeq`,
	 *   matching the server's `?since=` semantics.
	 * - `signal` aborts the underlying fetch so callers can tear the
	 *   connection down on unmount / cancel.
	 *
	 * Malformed lines are dropped silently — the stream is best-effort by
	 * design, mirroring the UI consumer in `src/ui/src/api/client.ts`.
	 */
	async *streamRunEvents(
		runId: string,
		opts: StreamRunEventsOptions = {},
	): AsyncGenerator<RunEvent, void, void> {
		const params = new URLSearchParams();
		if (opts.follow) params.set("follow", "1");
		if (opts.sinceSeq !== undefined) params.set("since", String(opts.sinceSeq));
		const qs = params.toString();
		const path = `/runs/${encodeURIComponent(runId)}/events${qs.length > 0 ? `?${qs}` : ""}`;

		const init: RequestInit = { headers: { accept: "application/x-ndjson" } };
		if (opts.signal) init.signal = opts.signal;

		const res = await this.withTransportMapping(() => this.requestRaw(path, init));
		if (!res.ok) {
			let envelope: ApiErrorEnvelope | null = null;
			try {
				envelope = (await res.json()) as ApiErrorEnvelope;
			} catch {
				// Non-JSON or malformed body — fall through to the default code/message.
			}
			const code = envelope?.error?.code ?? `http_${res.status}`;
			const message = envelope?.error?.message ?? `warren request failed with status ${res.status}`;
			const hint = envelope?.error?.hint;
			throw new WarrenClientError(res.status, code, message, hint);
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

	/* --------------------------------------------------------------- */
	/* Plots — warren-8ffc.                                            */
	/*                                                                  */
	/* Inputs accept camelCase for ergonomics; the request bodies map  */
	/* to the wire's snake_case (`project_id`, `dispatcher_handle`,    */
	/* `plot_id`) at the boundary. Responses pass through unchanged    */
	/* — the wire envelope under /plots is snake_case end-to-end       */
	/* (mirror of the on-disk @os-eco/plot-cli shape).                 */
	/* --------------------------------------------------------------- */

	/**
	 * `GET /plots[?status=&filter=needs_attention]` — cross-project
	 * Plot list. Unknown status or filter values are rejected
	 * server-side with 400. Empty result set when no `hasPlot=true`
	 * projects exist.
	 */
	async listPlots(filter: ListPlotsFilter = {}): Promise<ListPlotsResponse> {
		const params = new URLSearchParams();
		if (filter.status !== undefined) params.set("status", filter.status);
		if (filter.needsAttention === true) params.set("filter", "needs_attention");
		const qs = params.toString();
		return this.request<ListPlotsResponse>(`/plots${qs.length > 0 ? `?${qs}` : ""}`);
	}

	/** `GET /plots/:id` — full Plot envelope (intent + attachments + event log). */
	async getPlot(plotId: string): Promise<PlotEnvelope> {
		return this.request<PlotEnvelope>(`/plots/${encodeURIComponent(plotId)}`);
	}

	/**
	 * `POST /plots` — create a draft Plot in the named project's
	 * `.plot/` directory. Server requires `project.hasPlot === true`
	 * (otherwise 400 `project_lacks_plot`). Empty `name` is rejected;
	 * omit the field to accept the `"Untitled Plot"` default. The
	 * optional `intent` patch is applied on top of `PlotStore.create`
	 * defaults.
	 */
	async createPlot(input: CreatePlotInput): Promise<PlotSummary> {
		const body: Record<string, unknown> = { project_id: input.projectId };
		if (input.name !== undefined) body.name = input.name;
		if (input.intent !== undefined) body.intent = input.intent;
		if (input.dispatcherHandle !== undefined) body.dispatcher_handle = input.dispatcherHandle;
		return this.request<PlotSummary>("/plots", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/**
	 * `POST /plots/:id/intent` — edit the intent block. Flat top-level
	 * fields (no `intent:` wrapper, unlike createPlot). Omitted fields
	 * are left untouched; an empty patch is accepted as a no-op.
	 * Returns the refreshed `PlotEnvelope`.
	 */
	async editPlotIntent(plotId: string, input: EditPlotIntentInput = {}): Promise<PlotEnvelope> {
		const body: Record<string, unknown> = {};
		if (input.goal !== undefined) body.goal = input.goal;
		if (input.non_goals !== undefined) body.non_goals = input.non_goals;
		if (input.constraints !== undefined) body.constraints = input.constraints;
		if (input.success_criteria !== undefined) body.success_criteria = input.success_criteria;
		if (input.dispatcherHandle !== undefined) body.dispatcher_handle = input.dispatcherHandle;
		return this.request<PlotEnvelope>(`/plots/${encodeURIComponent(plotId)}/intent`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/**
	 * `POST /plots/:id/status` — transition the Plot status. Server
	 * validates the SPEC §6.5 transition matrix; invalid transitions
	 * return 400 with a typed code.
	 */
	async changePlotStatus(
		plotId: string,
		input: ChangePlotStatusInput,
	): Promise<ChangePlotStatusResponse> {
		const body: Record<string, unknown> = { next: input.next };
		if (input.dispatcherHandle !== undefined) body.dispatcher_handle = input.dispatcherHandle;
		return this.request<ChangePlotStatusResponse>(`/plots/${encodeURIComponent(plotId)}/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/**
	 * `POST /plots/:id/sync` — trigger a manual sync of the Plot's
	 * on-disk state to GitHub. Returns `{kind:'no_op'}` when the
	 * working tree is clean, or `{kind:'synced', ...}` with PR details
	 * when a sync branch was opened/updated.
	 */
	async syncPlot(plotId: string): Promise<PlotSyncResponse> {
		return this.request<PlotSyncResponse>(`/plots/${encodeURIComponent(plotId)}/sync`, {
			method: "POST",
		});
	}

	/* --------------------------------------------------------------- */
	/* Plan-runs — warren-8ffc.                                        */
	/* Wire envelope is camelCase, mirroring /runs.                    */
	/* --------------------------------------------------------------- */

	/**
	 * `POST /plan-runs` — dispatch a serial plan execution against a
	 * seeds plan. Walks the plan's children one at a time, gating
	 * each on the previous PR merging. Re-dispatching the same
	 * `planId` after children land resumes from the next open child
	 * (idempotent resume contract).
	 *
	 * When the project has a `.plot/` directory and `plotId` is
	 * supplied, warren emits a `plan_run_dispatched` event onto the
	 * Plot and threads `PLOT_ID`/`PLOT_ACTOR` into every child run.
	 */
	async createPlanRun(input: CreatePlanRunInput): Promise<CreatePlanRunResponse> {
		return this.request<CreatePlanRunResponse>("/plan-runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
	}

	/**
	 * `GET /plan-runs/:id` — full plan-run status: row + children +
	 * fanned-out child `RunRow[]` (excludes children whose `runId` is
	 * still null) so callers can render a detail view in one
	 * round-trip.
	 */
	async getPlanRun(planRunId: string): Promise<PlanRunDetailResponse> {
		return this.request<PlanRunDetailResponse>(`/plan-runs/${encodeURIComponent(planRunId)}`);
	}

	/** `GET /plan-runs[?project=&state=]` — list plan-runs, optionally filtered. */
	async listPlanRuns(filter: ListPlanRunsFilter = {}): Promise<ListPlanRunsResponse> {
		const params = new URLSearchParams();
		if (filter.project !== undefined && filter.project !== "")
			params.set("project", filter.project);
		if (filter.state !== undefined) params.set("state", filter.state);
		const qs = params.toString();
		return this.request<ListPlanRunsResponse>(`/plan-runs${qs.length > 0 ? `?${qs}` : ""}`);
	}

	async close(): Promise<void> {
		// No-op for now, but adheres to BurrowClient's shape.
	}

	private async requestRaw(path: string, init: RequestInit = {}): Promise<Response> {
		const base = this.config.baseUrl;
		const cleanBase = base.endsWith("/") ? base : `${base}/`;
		const cleanPath = path.startsWith("/") ? path.slice(1) : path;
		const url = new URL(cleanPath, cleanBase);

		const headers = new Headers(init.headers);
		if (this.config.token !== undefined && this.config.token !== "") {
			headers.set("authorization", `Bearer ${this.config.token}`);
		}
		return await this.fetchImpl(url.toString(), {
			...init,
			headers,
		});
	}

	private async withTransportMapping<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			if (err instanceof WarrenUnreachableError || err instanceof WarrenClientError) {
				throw err;
			}
			if (err instanceof Error) {
				const isAbort =
					err.name === "AbortError" ||
					err.message.includes("timed out") ||
					err.message.includes("abort");
				if (isAbort) {
					throw err;
				}
				throw new WarrenUnreachableError(
					`warren unreachable at ${this.config.baseUrl}: ${err.message}`,
					{ cause: err },
				);
			}
			throw err;
		}
	}
}

/**
 * Promise-based delay that resolves early if `signal` aborts. Used by
 * {@link WarrenClient.waitForRun}. Throws `AbortError` on abort so the
 * outer poll loop can propagate the cancellation.
 */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("waitForRun aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("waitForRun aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
