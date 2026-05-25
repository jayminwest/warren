import { type EnvLike, loadWarrenClientConfigFromEnv, type WarrenClientConfig } from "./config.ts";
import { WarrenClientError, WarrenUnreachableError } from "./errors.ts";
import {
	type AgentRow,
	type ApiErrorEnvelope,
	type CreateProjectInput,
	type CreateRunInput,
	type DispatchRunInput,
	isTerminalRunState,
	type ListAgentsQuery,
	type ListAgentsResponse,
	type ListProjectsResponse,
	type ListRunsResponse,
	type ProjectRow,
	type RefreshAgentsResponse,
	type RefreshProjectAgentsResult,
	type RefreshProjectInput,
	type RefreshProjectResponse,
	type RunRow,
	type SpawnRunResponse,
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
