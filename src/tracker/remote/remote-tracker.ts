/**
 * RemoteTracker — implementation #2 of the IssueTracker contract
 * (warren-d3a9, plan pl-a37b Track B). Speaks warren-tracker/v1
 * (`src/tracker/remote/protocol.ts`) to an external tracker container
 * over HTTP. The container holds its own tracker credential; warren
 * optionally sends a bearer token resolved from the operator's
 * environment (`tracker.tokenEnv` in `.warren/config.yaml`) and never
 * persists it.
 *
 * Design points from the issue:
 *
 *   - VERSION NEGOTIATION IS EXPLICIT AND BOOT-TIME: call
 *     {@link RemoteTracker.connect} once at wiring time. A protocol
 *     mismatch fails loud there, not per-call. Every operation on an
 *     unconnected tracker throws — silent capability guesses are worse
 *     than a loud miss.
 *   - CAPABILITIES COME FROM THE REMOTE (`GET /capabilities`), so a
 *     tracker that lacks plans fails with "tracker does not support
 *     plans" instead of a 404 shaped like a transient error.
 *   - TTL READ CACHE (re-derived B3): reads are cached per
 *     (projectId, operation, argument) for `cacheTtlMs` (default 15s)
 *     so the ready-plans N+1 does not hammer the container. Writes
 *     (close, metadata merge) invalidate the whole project's cache.
 *   - HONEST BACKOFF (re-derived B4): 429/5xx and network failures
 *     retry with exponential backoff (honoring `Retry-After` seconds
 *     when present), then surface as `TrackerError` carrying the last
 *     status. 4xx (other than 429) do not retry — they are the
 *     server's considered answer.
 *   - The error taxonomy maps `issue_not_found` onto
 *     `IssueNotFoundError` and everything else onto `TrackerError`.
 *
 * The conformance suite that exercises this protocol is warren-53ea.
 */

import {
	type Issue,
	type IssueStatus,
	isIssueStatus,
	isPlanStatus,
	normalizeIssueStatus,
	type Plan,
	type PlanStep,
	type PlanSummary,
	type ScheduledIssue,
	type TrackerContext,
	TrackerError,
} from "../../core/wire.ts";
import type {
	IssueTracker,
	MetadataCapableTracker,
	PlanCapableTracker,
	ScheduledIssueCapableTracker,
	TrackerCapabilities,
} from "../contract.ts";
import { TrackerHttpClient } from "./http-client.ts";
import {
	type CapabilitiesResponse,
	type RemoteIssueResponse,
	type RemoteIssueStatusesResponse,
	type RemoteMetadataRequest,
	type RemotePlanResponse,
	type RemotePlanSummary,
	type RemoteScheduledIssue,
	type RemoteScheduledIssuesResponse,
	TRACKER_ENDPOINTS,
	TRACKER_PROTOCOL_VERSION,
} from "./protocol.ts";

export interface RemoteTrackerOptions {
	/** Base URL of the tracker container, e.g. `http://tracker:8080`. */
	readonly baseUrl: string;
	/** Optional bearer sent as `Authorization: Bearer <token>`. */
	readonly bearerToken?: string;
	/** Injected for tests; defaults to the global `fetch`. */
	readonly fetchImpl?: typeof fetch;
	/** Read-cache TTL in milliseconds. Default 15000. `0` disables caching. */
	readonly cacheTtlMs?: number;
	/** Max attempts per operation (1 try + retries). Default 4. */
	readonly maxAttempts?: number;
	/** First backoff delay in ms; doubles per retry. Default 250. */
	readonly initialBackoffMs?: number;
	/** Injected clock for tests; default `Date.now`. */
	readonly now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 15_000;

interface CacheEntry {
	readonly value: unknown;
	readonly expiresAt: number;
}

export class RemoteTracker
	implements IssueTracker, PlanCapableTracker, MetadataCapableTracker, ScheduledIssueCapableTracker
{
	private readonly http: TrackerHttpClient;
	private readonly cacheTtlMs: number;
	private readonly now: () => number;
	private readonly cache = new Map<string, CacheEntry>();
	private remoteCapabilities: TrackerCapabilities | undefined;

	constructor(options: RemoteTrackerOptions) {
		this.http = new TrackerHttpClient({
			baseUrl: options.baseUrl,
			...(options.bearerToken !== undefined ? { bearerToken: options.bearerToken } : {}),
			...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
			...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
			...(options.initialBackoffMs !== undefined
				? { initialBackoffMs: options.initialBackoffMs }
				: {}),
		});
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.now = options.now ?? Date.now;
	}

	private request(
		method: "GET" | "POST",
		path: string,
		options: { body?: unknown; notFoundIsError?: boolean } = {},
	): Promise<Response> {
		return this.http.request(method, path, options);
	}

	/**
	 * Boot-time handshake: fetch `GET /capabilities`, verify the protocol
	 * version, and adopt the remote's capability flags. MUST be called
	 * (and awaited) once at wiring time — a version mismatch fails here,
	 * loud, instead of on the first per-call 500.
	 */
	async connect(): Promise<TrackerCapabilities> {
		const response = await this.request("GET", TRACKER_ENDPOINTS.capabilities);
		const body = (await this.parseJson(response)) as Partial<CapabilitiesResponse>;
		if (
			body === null ||
			typeof body !== "object" ||
			typeof body.protocolVersion !== "string" ||
			typeof body.capabilities !== "object" ||
			body.capabilities === null
		) {
			throw new TrackerError(
				`remote tracker at ${this.http.baseUrl} returned a malformed capabilities payload`,
			);
		}
		if (body.protocolVersion !== TRACKER_PROTOCOL_VERSION) {
			throw new TrackerError(
				`remote tracker at ${this.http.baseUrl} speaks protocol "${body.protocolVersion}", ` +
					`but warren implements "${TRACKER_PROTOCOL_VERSION}" — refusing to guess. ` +
					"Upgrade the tracker container (or warren) so both sides agree.",
			);
		}
		const raw = body.capabilities;
		const caps: TrackerCapabilities = {
			supportsPlans: raw.supportsPlans === true,
			supportsMetadata: raw.supportsMetadata === true,
			supportsScheduledIssues: raw.supportsScheduledIssues === true,
			isGitNative: raw.isGitNative === true,
		};
		this.remoteCapabilities = caps;
		return caps;
	}

	get capabilities(): TrackerCapabilities {
		return this.requireConnected();
	}

	/** Capability gate: every optional surface checks this before any HTTP. */
	private requireCapability(flag: keyof TrackerCapabilities, surface: string): void {
		if (!this.requireConnected()[flag]) {
			throw new TrackerError(`remote tracker does not support ${surface}`);
		}
	}

	private requireConnected(): TrackerCapabilities {
		if (this.remoteCapabilities === undefined) {
			throw new TrackerError(
				`RemoteTracker for ${this.http.baseUrl} was used before connect() — ` +
					"the boot wiring must await connect() to negotiate the protocol version",
			);
		}
		return this.remoteCapabilities;
	}

	async getIssue(ctx: TrackerContext, issueId: string): Promise<Issue> {
		this.requireConnected();
		return this.cachedRead(ctx, ["issue", issueId], async () => {
			const response = await this.request("GET", TRACKER_ENDPOINTS.issue(issueId), {
				notFoundIsError: true,
			});
			const body = (await this.parseJson(response)) as Partial<RemoteIssueResponse>;
			if (typeof body?.id !== "string" || typeof body.status !== "string") {
				throw new TrackerError(
					`remote tracker returned a malformed issue payload for ${issueId} (project ${ctx.projectId})`,
				);
			}
			const issue: Issue = {
				id: body.id,
				status: this.normalizeStatus(body.status),
				...(body.title !== undefined ? { title: body.title } : {}),
				...(body.description !== undefined ? { description: body.description } : {}),
				...(body.blockedBy !== undefined ? { blockedBy: body.blockedBy } : {}),
				...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
			};
			return issue;
		});
	}

	async listIssueStatuses(ctx: TrackerContext): Promise<ReadonlyMap<string, IssueStatus>> {
		this.requireConnected();
		return this.cachedRead(ctx, ["statuses"], async () => {
			const response = await this.request("GET", TRACKER_ENDPOINTS.issueStatuses);
			const body = (await this.parseJson(response)) as Partial<RemoteIssueStatusesResponse>;
			if (body === null || typeof body !== "object" || typeof body.statuses !== "object") {
				throw new TrackerError(
					`remote tracker returned a malformed issue-statuses payload (project ${ctx.projectId})`,
				);
			}
			const map = new Map<string, IssueStatus>();
			for (const [id, raw] of Object.entries(body.statuses)) {
				if (typeof raw !== "string") {
					throw new TrackerError(
						`remote tracker returned a non-string status for issue ${id} (project ${ctx.projectId})`,
					);
				}
				map.set(id, this.normalizeStatus(raw));
			}
			return map as ReadonlyMap<string, IssueStatus>;
		});
	}

	async closeIssue(ctx: TrackerContext, issueId: string): Promise<void> {
		this.requireConnected();
		// Idempotent by protocol: closing an already-closed issue is 200.
		await this.request("POST", TRACKER_ENDPOINTS.closeIssue(issueId));
		this.invalidateProject(ctx.projectId);
	}

	async listPlans(ctx: TrackerContext): Promise<readonly PlanSummary[]> {
		this.requireCapability("supportsPlans", "plans");
		return this.cachedRead(ctx, ["plans"], async () => {
			const response = await this.request("GET", TRACKER_ENDPOINTS.plans);
			const body = (await this.parseJson(response)) as Partial<{ plans?: unknown }>;
			if (body === null || typeof body !== "object" || !Array.isArray(body.plans)) {
				throw new TrackerError(
					`remote tracker returned a malformed plans payload (project ${ctx.projectId})`,
				);
			}
			return body.plans.map((p) => this.toPlanSummary(p, ctx.projectId));
		});
	}

	async getPlan(ctx: TrackerContext, planId: string): Promise<Plan> {
		this.requireCapability("supportsPlans", "plans");
		return this.cachedRead(ctx, ["plan", planId], async () => {
			const response = await this.request("GET", TRACKER_ENDPOINTS.plan(planId), {
				notFoundIsError: true,
			});
			const body = (await this.parseJson(response)) as Partial<RemotePlanResponse>;
			if (
				typeof body?.id !== "string" ||
				typeof body.status !== "string" ||
				!Array.isArray(body.children)
			) {
				throw new TrackerError(
					`remote tracker returned a malformed plan payload for ${planId} (project ${ctx.projectId})`,
				);
			}
			const steps = this.parsePlanSteps(body.steps, planId, ctx.projectId);
			const plan: Plan = {
				id: body.id,
				status: this.requirePlanStatus(body.status, planId),
				children: body.children,
				...(steps !== undefined ? { steps } : {}),
			};
			return plan;
		});
	}

	async mergeIssueMetadata(
		ctx: TrackerContext,
		issueId: string,
		metadata: Readonly<Record<string, unknown>>,
	): Promise<void> {
		this.requireCapability("supportsMetadata", "metadata merges");
		const payload: RemoteMetadataRequest = { metadata };
		await this.request("POST", TRACKER_ENDPOINTS.metadata(issueId), { body: payload });
		this.invalidateProject(ctx.projectId);
	}

	async listScheduledIssues(ctx: TrackerContext): Promise<readonly ScheduledIssue[]> {
		this.requireCapability("supportsScheduledIssues", "scheduled issues");
		return this.cachedRead(ctx, ["scheduled"], async () => {
			const response = await this.request("GET", TRACKER_ENDPOINTS.scheduledIssues);
			const body = (await this.parseJson(response)) as Partial<RemoteScheduledIssuesResponse>;
			if (body === null || typeof body !== "object" || !Array.isArray(body.issues)) {
				throw new TrackerError(
					`remote tracker returned a malformed scheduled-issues payload (project ${ctx.projectId})`,
				);
			}
			return body.issues.map((raw) => this.toScheduledIssue(raw, ctx.projectId));
		});
	}

	// -- internals ----------------------------------------------------------

	private normalizeStatus(raw: string): IssueStatus {
		// A server that already speaks the three-state vocabulary passes it
		// through; anything else (in_progress, reopened, …) folds to 'other'.
		return isIssueStatus(raw) ? raw : normalizeIssueStatus(raw);
	}

	private requirePlanStatus(raw: string, planId: string): Plan["status"] {
		if (!isPlanStatus(raw)) {
			throw new TrackerError(
				`remote tracker returned unknown plan status "${raw}" for plan ${planId}`,
			);
		}
		return raw;
	}

	private toPlanSummary(raw: unknown, projectId: string): PlanSummary {
		if (raw === null || typeof raw !== "object") {
			throw new TrackerError(
				`remote tracker returned a malformed plan summary (project ${projectId})`,
			);
		}
		const p = raw as Partial<RemotePlanSummary>;
		if (
			typeof p.id !== "string" ||
			typeof p.status !== "string" ||
			typeof p.childCount !== "number"
		) {
			throw new TrackerError(
				`remote tracker returned a malformed plan summary (project ${projectId})`,
			);
		}
		return {
			id: p.id,
			status: this.requirePlanStatus(p.status, p.id),
			childCount: p.childCount,
			...(p.seed !== undefined ? { seed: p.seed } : {}),
			...(p.template !== undefined ? { template: p.template } : {}),
			...(p.revision !== undefined ? { revision: p.revision } : {}),
			...(p.name !== undefined ? { name: p.name } : {}),
			...(p.createdAt !== undefined ? { createdAt: p.createdAt } : {}),
			...(p.updatedAt !== undefined ? { updatedAt: p.updatedAt } : {}),
		};
	}

	private parsePlanSteps(
		raw: unknown,
		planId: string,
		projectId: string,
	): readonly PlanStep[] | undefined {
		if (raw === undefined) return undefined;
		if (!Array.isArray(raw)) {
			throw new TrackerError(
				`remote tracker returned a non-array steps field for plan ${planId} (project ${projectId})`,
			);
		}
		return raw.map((step) => {
			if (step === null || typeof step !== "object") {
				throw new TrackerError(
					`remote tracker returned a malformed step in plan ${planId} (project ${projectId})`,
				);
			}
			const s = step as Partial<PlanStep>;
			if (s.blocks !== undefined && !Array.isArray(s.blocks)) {
				throw new TrackerError(
					`remote tracker returned a non-array blocks field in plan ${planId} (project ${projectId})`,
				);
			}
			return {
				...(s.title !== undefined ? { title: s.title } : {}),
				...(s.existingSeed !== undefined ? { existingSeed: s.existingSeed } : {}),
				...(s.blocks !== undefined ? { blocks: s.blocks } : {}),
			};
		});
	}

	private toScheduledIssue(raw: unknown, projectId: string): ScheduledIssue {
		if (raw === null || typeof raw !== "object") {
			throw new TrackerError(
				`remote tracker returned a malformed scheduled issue (project ${projectId})`,
			);
		}
		const s = raw as Partial<RemoteScheduledIssue>;
		if (
			typeof s.id !== "string" ||
			typeof s.status !== "string" ||
			typeof s.scheduledFor !== "string"
		) {
			throw new TrackerError(
				`remote tracker returned a malformed scheduled issue (project ${projectId})`,
			);
		}
		const when = new Date(s.scheduledFor);
		if (Number.isNaN(when.getTime())) {
			throw new TrackerError(
				`remote tracker returned an unparseable scheduledFor "${s.scheduledFor}" for issue ${s.id}`,
			);
		}
		return {
			id: s.id,
			status: this.normalizeStatus(s.status),
			...(s.title !== undefined ? { title: s.title } : {}),
			scheduledFor: when,
		};
	}

	/** Read-through TTL cache: the ready-plans N+1 rides on this. */
	private async cachedRead<T>(
		ctx: TrackerContext,
		key: readonly string[],
		read: () => Promise<T>,
	): Promise<T> {
		const cacheKey = `${ctx.projectId}:${key.join("|")}`;
		const hit = this.cache.get(cacheKey);
		if (hit !== undefined && hit.expiresAt > this.now()) {
			return hit.value as T;
		}
		const value = await read();
		if (this.cacheTtlMs > 0) {
			this.cache.set(cacheKey, { value, expiresAt: this.now() + this.cacheTtlMs });
		}
		return value;
	}

	/** Writes invalidate every cached read for the project. */
	private invalidateProject(projectId: string): void {
		const prefix = `${projectId}:`;
		for (const key of this.cache.keys()) {
			if (key.startsWith(prefix)) {
				this.cache.delete(key);
			}
		}
	}

	private async parseJson(response: Response): Promise<unknown> {
		try {
			return await response.json();
		} catch (err) {
			throw new TrackerError(
				`remote tracker returned a non-JSON body (status ${response.status})`,
				{
					cause: err,
				},
			);
		}
	}
}
