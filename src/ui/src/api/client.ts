// Thin fetch wrapper around the warren HTTP API (SPEC §8.1). Bearer
// token comes from localStorage; mutated via `setApiToken` after the
// login screen accepts it. A 401 clears the cached token so the
// router can redirect back to login on the next render pass.

import type {
	AgentRow,
	ApiErrorEnvelope,
	CancelRunResponse,
	CreateRunInput,
	PreviewConfigResponse,
	PreviewTeardownResponse,
	ProjectRow,
	ReadyzResponse,
	RefreshAgentsResponse,
	RefreshProjectResponse,
	RunEvent,
	RunRow,
	RunTriggerResponse,
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

export const agentsApi = {
	list: (signal?: AbortSignal) =>
		request<{ agents: AgentRow[] }>("/agents", { ...(signal ? { signal } : {}) }),
	get: (name: string, signal?: AbortSignal) =>
		request<AgentRow>(`/agents/${encodeURIComponent(name)}`, { ...(signal ? { signal } : {}) }),
	refresh: () => request<RefreshAgentsResponse>("/agents/refresh", { method: "POST", body: {} }),
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
};

/* ----------------------------------------------------------------------- */
/* Runs                                                                     */
/* ----------------------------------------------------------------------- */

export interface ListRunsFilter {
	project?: string;
	agent?: string;
	sort?: "started" | "cost";
	dir?: "asc" | "desc";
}

export const runsApi = {
	list: (filter: ListRunsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.project) params.set("project", filter.project);
		if (filter.agent) params.set("agent", filter.agent);
		if (filter.sort) params.set("sort", filter.sort);
		if (filter.dir) params.set("dir", filter.dir);
		const qs = params.toString();
		return request<{ runs: RunRow[] }>(`/runs${qs.length > 0 ? `?${qs}` : ""}`, {
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
	const params = new URLSearchParams();
	if (opts.follow) params.set("follow", "1");
	if (opts.sinceSeq !== undefined) params.set("since", String(opts.sinceSeq));
	const qs = params.toString();
	const url = `/runs/${encodeURIComponent(runId)}/events${qs.length > 0 ? `?${qs}` : ""}`;

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
