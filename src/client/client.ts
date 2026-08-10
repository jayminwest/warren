import { ValidationError } from "../core/errors.ts";
import { pollUntilTerminal } from "./client-helpers.ts";
import { type EnvLike, loadWarrenClientConfigFromEnv, type WarrenClientConfig } from "./config.ts";
import { WarrenClientError, WarrenUnreachableError } from "./errors.ts";
import { errorFromResponse, readNdjsonStream } from "./ndjson.ts";
import {
	type AgentRow,
	type CancelPlanRunResponse,
	type CancelRunInput,
	type CancelRunResponse,
	type CreatePlanRunInput,
	type CreatePlanRunResponse,
	type CreateProjectInput,
	type CreateRunInput,
	type DispatchRunInput,
	type GetRunResponse,
	isTerminalPlanRunState,
	isTerminalRunState,
	type ListAgentsResponse,
	type ListPlanRunsFilter,
	type ListPlanRunsResponse,
	type ListProjectsResponse,
	type ListReadyPlansResponse,
	type ListRunsResponse,
	type PlanRunDetailResponse,
	type PlanRunRow,
	type ProjectRow,
	type RefreshProjectInput,
	type RefreshProjectResponse,
	type RunEvent,
	type RunRow,
	type SpawnRunResponse,
	type SteerRunInput,
	type SteerRunResponse,
	type StreamPlanRunEventsOptions,
	type StreamRunEventsOptions,
	type VersionResponse,
	type WhoamiResponse,
} from "./types.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Guard the per-run spend cap before JSON serialization (warren-a63d).
 * `JSON.stringify` turns `NaN` / `±Infinity` into `null`, which the
 * server reads as "field absent" — the dispatch would then succeed
 * silently UNCAPPED instead of failing the documented positive-finite
 * validation. Fail here with the same rule the server enforces.
 */
function assertValidMaxCostUsd(value: number | undefined): void {
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new ValidationError("maxCostUsd must be a positive finite number of USD");
	}
}

export { DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_TIMEOUT_MS } from "./client-helpers.ts";

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

export interface WaitForPlanRunOptions {
	/** Poll cadence. Defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
	readonly intervalMs?: number;
	/** Overall budget. Defaults to {@link DEFAULT_POLL_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
	/** External abort. */
	readonly signal?: AbortSignal;
	/** Optional callback invoked after each poll for observability. */
	readonly onTick?: (row: PlanRunRow) => void;
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
				throw await errorFromResponse(res);
			}
			const text = await res.text();
			if (text.length === 0) return undefined as T;
			return JSON.parse(text) as T;
		});
	}

	/**
	 * `GET /whoami` — the identity and capability set warren admitted this
	 * client as (warren-e195). Useful before a mutation: a client whose
	 * capabilities lack `dispatch` is reading a public instance and will be
	 * refused with 403, so it can say so up front instead of on failure.
	 * Unlike `probe`, this is a gated route — the default `WARREN_AUTH=token`
	 * mode 401s a client configured without a token.
	 */
	async whoami(signal?: AbortSignal): Promise<WhoamiResponse> {
		return this.request<WhoamiResponse>("/whoami", { ...(signal ? { signal } : {}) });
	}

	async getProject(projectId: string): Promise<ProjectRow> {
		return this.request<ProjectRow>(`/projects/${encodeURIComponent(projectId)}`);
	}

	async listProjects(): Promise<ListProjectsResponse> {
		return this.request<ListProjectsResponse>("/projects");
	}

	/** `GET /projects/:id/ready-plans` — approved, undispatched plans with an open child (warren-7937). */
	async listReadyPlans(projectId: string, signal?: AbortSignal): Promise<ListReadyPlansResponse> {
		const path = `/projects/${encodeURIComponent(projectId)}/ready-plans`;
		return this.request<ListReadyPlansResponse>(path, signal ? { signal } : {});
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

	async listAgents(): Promise<ListAgentsResponse> {
		return this.request<ListAgentsResponse>("/agents");
	}

	async getAgent(name: string): Promise<AgentRow> {
		return this.request<AgentRow>(`/agents/${encodeURIComponent(name)}`);
	}

	async createRun(input: CreateRunInput): Promise<SpawnRunResponse> {
		assertValidMaxCostUsd(input.maxCostUsd);
		return this.request<SpawnRunResponse>("/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
	}

	/** POST /runs with ergonomic `warren run` field names. Wraps {@link createRun}. */
	async dispatch(input: DispatchRunInput): Promise<SpawnRunResponse> {
		const body: CreateRunInput = {
			agent: input.agent,
			project: input.project,
			prompt: input.prompt,
		};
		if (input.branch !== undefined) body.ref = input.branch;
		if (input.targetBranch !== undefined) body.targetBranch = input.targetBranch;
		if (input.model !== undefined) body.modelOverride = input.model;
		if (input.provider !== undefined) body.providerOverride = input.provider;
		if (input.trigger !== undefined) body.trigger = input.trigger;
		if (input.seedId !== undefined) body.seedId = input.seedId;
		if (input.dispatcherHandle !== undefined) body.dispatcherHandle = input.dispatcherHandle;
		if (input.continueFromRunId !== undefined) body.continueFromRunId = input.continueFromRunId;
		if (input.cloneFromRunId !== undefined) body.cloneFromRunId = input.cloneFromRunId;
		if (input.maxCostUsd !== undefined) body.maxCostUsd = input.maxCostUsd;
		return this.createRun(body);
	}

	/**
	 * `POST /runs/:id/steer` — mid-run steering. Forwards an operator
	 * message into the burrow inbox; valid only while the run is
	 * non-terminal AND a burrow is attached (else `ValidationError`).
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
		// warren-7d84: `GET /runs/:id` wraps the row in `{run}` like every
		// other detail envelope; the SDK unwraps it for callers.
		const res = await this.request<GetRunResponse>(`/runs/${encodeURIComponent(runId)}`);
		return res.run;
	}

	/**
	 * `POST /runs/:id/cancel` — cancel a non-terminal run. Idempotent: a run
	 * already in a terminal state returns `{ alreadyTerminal: true }` without
	 * issuing a second cancel.
	 */
	async cancelRun(runId: string, input: CancelRunInput = {}): Promise<CancelRunResponse> {
		const body: Record<string, unknown> = {};
		if (input.reason !== undefined) body.reason = input.reason;
		return this.request<CancelRunResponse>(`/runs/${encodeURIComponent(runId)}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/**
	 * `GET /version` — the running warren build's semver. Auth-exempt, so it
	 * doubles as a richer probe than `/healthz` when a client wants to know
	 * what it is talking to (warren-968c).
	 */
	async version(signal?: AbortSignal): Promise<VersionResponse> {
		return this.request<VersionResponse>("/version", signal ? { signal } : {});
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
		return pollUntilTerminal({
			label: "run",
			id: runId,
			opts,
			fetchRow: () => this.getRun(runId),
			isTerminal: (row) => isTerminalRunState(row.state),
			stateOf: (row) => row.state,
		});
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

		yield* this.streamNdjson<RunEvent>(path, opts.signal);
	}

	/**
	 * Open `path` as an NDJSON tail and yield one parsed `T` per line.
	 * Backs {@link streamRunEvents} and {@link streamPlanRunEvents}; the
	 * reader loop + error mapping live in `./ndjson.ts`.
	 */
	private streamNdjson<T>(path: string, signal?: AbortSignal): AsyncGenerator<T, void, void> {
		const init: RequestInit = { headers: { accept: "application/x-ndjson" } };
		if (signal) init.signal = signal;
		return readNdjsonStream<T>(() => this.withTransportMapping(() => this.requestRaw(path, init)));
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
	 */
	async createPlanRun(input: CreatePlanRunInput): Promise<CreatePlanRunResponse> {
		assertValidMaxCostUsd(input.maxCostUsd);
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

	/**
	 * `POST /plan-runs/:id/cancel` — flip the plan-run to `cancelled`
	 * and best-effort cancel its in-flight child run. Idempotent: a
	 * plan-run already in a terminal state returns
	 * `{ alreadyTerminal: true, cancelledChild: null }` without firing a
	 * second cancel.
	 */
	async cancelPlanRun(planRunId: string): Promise<CancelPlanRunResponse> {
		return this.request<CancelPlanRunResponse>(
			`/plan-runs/${encodeURIComponent(planRunId)}/cancel`,
			{ method: "POST" },
		);
	}

	/**
	 * Async iterator over `GET /plan-runs/:id/events` (NDJSON tail). One
	 * yield per child-run event row, parsed as {@link RunEvent}. Shares
	 * the same wire shape and reader as {@link streamRunEvents}; each
	 * envelope carries its originating `runId` discriminator.
	 *
	 * - `follow: true` keeps the connection open until the client
	 *   disconnects or the plan-run reaches a terminal state; without it
	 *   the server replays the current snapshot then closes.
	 * - `signal` aborts the underlying fetch.
	 *
	 * There is **no `sinceSeq`** — the endpoint replays the full union
	 * snapshot from the top on every (re)open. On reconnect, dedupe
	 * client-side by `(runId, seq)` to drop events already seen.
	 */
	async *streamPlanRunEvents(
		planRunId: string,
		opts: StreamPlanRunEventsOptions = {},
	): AsyncGenerator<RunEvent, void, void> {
		const params = new URLSearchParams();
		if (opts.follow) params.set("follow", "1");
		const qs = params.toString();
		const path = `/plan-runs/${encodeURIComponent(planRunId)}/events${qs.length > 0 ? `?${qs}` : ""}`;
		yield* this.streamNdjson<RunEvent>(path, opts.signal);
	}

	/**
	 * Poll `GET /plan-runs/:id` until the plan-run reaches a terminal
	 * state (`succeeded` | `failed` | `cancelled`) or the timeout/abort
	 * fires. Mirrors {@link waitForRun} for serial plan executions.
	 */
	async waitForPlanRun(planRunId: string, opts: WaitForPlanRunOptions = {}): Promise<PlanRunRow> {
		return pollUntilTerminal({
			label: "plan-run",
			id: planRunId,
			opts,
			fetchRow: async () => (await this.getPlanRun(planRunId)).planRun,
			isTerminal: (row) => isTerminalPlanRunState(row.state),
			stateOf: (row) => row.state,
		});
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
