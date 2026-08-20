/**
 * FakeTracker HTTP server (warren-53ea) — the reference warren-tracker/v1
 * implementation a foreign tracker author tests against. In-memory, dumb,
 * and EXACTLY protocol-shaped: every response is JSON, every non-2xx
 * carries the error envelope, optional surfaces 404 with
 * `capability_not_supported` when their capability flag is off (a
 * conforming server may also omit the route entirely — warren never
 * calls a surface whose capability was not declared).
 */

import {
	type CapabilitiesResponse,
	type RemoteIssueResponse,
	type RemoteMetadataRequest,
	type RemotePlanResponse,
	type RemotePlanSummary,
	type RemoteScheduledIssue,
	TRACKER_ISSUE_NOT_FOUND_CODE,
	TRACKER_PROTOCOL_VERSION,
	type TrackerErrorResponse,
} from "../protocol.ts";
import type { FakeIssue, FakePlan, FakeTrackerStore } from "./store.ts";

export interface FakeTrackerOptions {
	readonly store: FakeTrackerStore;
	/** Capability flags the server declares. Optional surfaces default ON. */
	readonly capabilities?: {
		readonly supportsPlans?: boolean;
		readonly supportsMetadata?: boolean;
		readonly supportsScheduledIssues?: boolean;
		readonly isGitNative?: boolean;
	};
	/** When set, every request must carry `Authorization: Bearer <token>`. */
	readonly bearerToken?: string;
	/** Protocol-version override — ONLY for the suite's wrong-version case. */
	readonly protocolVersion?: string;
}

export const CAPABILITY_NOT_SUPPORTED_CODE = "capability_not_supported";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function errorBody(code: string, message: string): TrackerErrorResponse {
	return { error: { code, message } };
}

function toIssueResponse(issue: FakeIssue): RemoteIssueResponse {
	return {
		id: issue.id,
		status: issue.status,
		...(issue.title !== undefined ? { title: issue.title } : {}),
		...(issue.description !== undefined ? { description: issue.description } : {}),
		...(issue.blockedBy !== undefined ? { blockedBy: issue.blockedBy } : {}),
		...(issue.metadata !== undefined ? { metadata: issue.metadata } : {}),
	};
}

function toPlanSummary(plan: FakePlan): RemotePlanSummary {
	return {
		id: plan.id,
		status: plan.status,
		childCount: plan.childCount ?? plan.children.length,
		...(plan.name !== undefined ? { name: plan.name } : {}),
	};
}

function toPlanResponse(plan: FakePlan): RemotePlanResponse {
	return {
		id: plan.id,
		status: plan.status,
		children: plan.children,
		...(plan.steps !== undefined ? { steps: plan.steps } : {}),
	};
}

function toScheduledIssue(issue: FakeIssue): RemoteScheduledIssue {
	// The filter upstream guarantees scheduledFor is set.
	return {
		id: issue.id,
		status: issue.status,
		...(issue.title !== undefined ? { title: issue.title } : {}),
		scheduledFor: issue.scheduledFor ?? "",
	};
}

const ISSUE_PATH = /^\/issues\/([^/]+)$/;
const CLOSE_PATH = /^\/issues\/([^/]+)\/close$/;
const METADATA_PATH = /^\/issues\/([^/]+)\/metadata$/;
const PLAN_PATH = /^\/plans\/([^/]+)$/;

interface ResolvedCapabilities {
	readonly supportsPlans: boolean;
	readonly supportsMetadata: boolean;
	readonly supportsScheduledIssues: boolean;
	readonly isGitNative: boolean;
}

function resolveCapabilities(options: FakeTrackerOptions): ResolvedCapabilities {
	const c = options.capabilities ?? {};
	return {
		supportsPlans: c.supportsPlans ?? true,
		supportsMetadata: c.supportsMetadata ?? true,
		supportsScheduledIssues: c.supportsScheduledIssues ?? true,
		isGitNative: c.isGitNative ?? false,
	};
}

/** The request handler, separated from Bun.serve so tests drive it directly. */
export function createFakeTrackerHandler(
	options: FakeTrackerOptions,
): (request: Request) => Promise<Response> {
	const { store } = options;
	const caps = resolveCapabilities(options);
	const protocolVersion = options.protocolVersion ?? TRACKER_PROTOCOL_VERSION;

	const unauthorized = (): Response => errorJson("unauthorized", "missing or invalid bearer token", 401);
	const errorJson = (code: string, message: string, status: number): Response =>
		json(errorBody(code, message), status);
	const notFound = (id: string): Response =>
		errorJson(TRACKER_ISSUE_NOT_FOUND_CODE, `issue not found: ${id}`, 404);
	const capabilityOff = (surface: string): Response =>
		errorJson(CAPABILITY_NOT_SUPPORTED_CODE, `capability not supported: ${surface}`, 404);

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname;
		store.recordCall(request.method, path);

		if (options.bearerToken !== undefined) {
			if (request.headers.get("authorization") !== `Bearer ${options.bearerToken}`) {
				return unauthorized();
			}
		}

		if (request.method === "GET" && path === "/capabilities") {
			const body: CapabilitiesResponse = { protocolVersion, capabilities: caps };
			return json(body);
		}

		const issueMatch = ISSUE_PATH.exec(path);
		if (request.method === "GET" && issueMatch !== null) {
			const id = decodeURIComponent(issueMatch[1] ?? "");
			const issue = store.getIssue(id);
			return issue === undefined ? notFound(id) : json(toIssueResponse(issue));
		}

		if (request.method === "GET" && path === "/issue-statuses") {
			return json({ statuses: store.listStatuses() });
		}

		const closeMatch = CLOSE_PATH.exec(path);
		if (request.method === "POST" && closeMatch !== null) {
			const id = decodeURIComponent(closeMatch[1] ?? "");
			if (store.closeIssue(id) === "not_found") return notFound(id);
			await store.flush();
			const issue = store.getIssue(id);
			return json(toIssueResponse(issue as FakeIssue));
		}

		if (request.method === "GET" && path === "/plans") {
			if (!caps.supportsPlans) return capabilityOff("plans");
			return json({ plans: store.listPlans().map(toPlanSummary) });
		}

		const planMatch = PLAN_PATH.exec(path);
		if (request.method === "GET" && planMatch !== null) {
			if (!caps.supportsPlans) return capabilityOff("plans");
			const id = decodeURIComponent(planMatch[1] ?? "");
			const plan = store.getPlan(id);
			return plan === undefined
				? errorJson(TRACKER_ISSUE_NOT_FOUND_CODE, `plan not found: ${id}`, 404)
				: json(toPlanResponse(plan));
		}

		const metadataMatch = METADATA_PATH.exec(path);
		if (request.method === "POST" && metadataMatch !== null) {
			if (!caps.supportsMetadata) return capabilityOff("metadata");
			const id = decodeURIComponent(metadataMatch[1] ?? "");
			let payload: RemoteMetadataRequest;
			try {
				payload = (await request.json()) as RemoteMetadataRequest;
			} catch {
				return errorJson("bad_request", "metadata payload must be a JSON object", 400);
			}
			if (payload === null || typeof payload !== "object" || typeof payload.metadata !== "object") {
				return errorJson("bad_request", "metadata payload must carry a metadata object", 400);
			}
			if (store.mergeMetadata(id, payload.metadata) === "not_found") return notFound(id);
			await store.flush();
			const issue = store.getIssue(id);
			return json(toIssueResponse(issue as FakeIssue));
		}

		if (request.method === "GET" && path === "/scheduled-issues") {
			if (!caps.supportsScheduledIssues) return capabilityOff("scheduled-issues");
			return json({ issues: store.listScheduledIssues().map(toScheduledIssue) });
		}

		return errorJson("not_found", `no route: ${request.method} ${path}`, 404);
	};
}

export interface RunningFakeTracker {
	readonly port: number;
	readonly url: string;
	stop(): Promise<void>;
}

/** Serve a FakeTracker over HTTP. `port: 0` picks an ephemeral port. */
export async function startFakeTracker(
	options: FakeTrackerOptions & { readonly port?: number; readonly hostname?: string },
): Promise<RunningFakeTracker> {
	const handler = createFakeTrackerHandler(options);
	const server = Bun.serve({
		port: options.port ?? 0,
		hostname: options.hostname ?? "127.0.0.1",
		fetch: handler,
	});
	const boundPort: number | undefined = server.port;
	if (boundPort === undefined) {
		throw new Error("Bun.serve did not report a bound port");
	}
	return {
		port: boundPort,
		url: `http://127.0.0.1:${boundPort}`,
		stop: async () => {
			server.stop(true);
		},
	};
}
