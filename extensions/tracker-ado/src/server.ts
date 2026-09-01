/**
 * The warren-tracker/v1 HTTP surface.
 *
 * Base contract only. The three optional surfaces answer 404
 * `capability_not_supported`, matching the reference server: warren never
 * calls a surface whose capability was not declared, so the route exists
 * to give a misconfigured caller a readable answer rather than a bare
 * "no route".
 *
 * Every response is JSON with the protocol's error envelope on any
 * non-2xx, and the handler is separated from `Bun.serve` so tests drive
 * it directly with a `Request`.
 */

import { AdoClient } from "./ado/client.ts";
import type { AdoTrackerConfig } from "./config.ts";
import { closeIssue, readIssue, readStatuses, TrackerOperationError } from "./operations.ts";
import {
	CAPABILITY_NOT_SUPPORTED_CODE,
	type CapabilitiesResponse,
	INVALID_ISSUE_ID_CODE,
	type RemoteIssueResponse,
	type RemoteIssueStatusesResponse,
	type RemoteTrackerCapabilities,
	TRACKER_PROTOCOL_VERSION,
	type TrackerErrorResponse,
} from "./protocol.ts";
import { json } from "./responses.ts";

/**
 * What this tracker can do. Azure DevOps has no plan object warren can
 * walk (a feature's child links are a hierarchy, not an ordered walk), so
 * a plan-run over work items uses `POST /plan-runs` with an explicit
 * ordered `issues: [...]` list, which the base contract is enough to
 * drive. Metadata would need a custom field per warren key and scheduled
 * issues would need a date-field convention; neither is guessable, so
 * neither is declared.
 */
const ADO_CAPABILITIES: RemoteTrackerCapabilities = {
	supportsPlans: false,
	supportsMetadata: false,
	supportsScheduledIssues: false,
	isGitNative: false,
};

const CAPABILITIES_BODY: CapabilitiesResponse = {
	protocolVersion: TRACKER_PROTOCOL_VERSION,
	capabilities: ADO_CAPABILITIES,
};

function errorJson(
	code: string,
	message: string,
	status: number,
	headers: Record<string, string> = {},
): Response {
	const body: TrackerErrorResponse = { error: { code, message } };
	return json(body, status, headers);
}

/**
 * Percent-decode one path segment. A malformed escape such as the `%` in
 * `/issues/%` makes `decodeURIComponent` throw, and the route has to answer
 * with the JSON error envelope rather than let a URIError leave the handler.
 */
function decodeSegment(raw: string | undefined): string | undefined {
	try {
		return decodeURIComponent(raw ?? "");
	} catch {
		return undefined;
	}
}

function badIssueId(raw: string | undefined): Response {
	return errorJson(
		INVALID_ISSUE_ID_CODE,
		`issue id is not a valid percent-encoded segment: ${raw ?? ""}`,
		400,
	);
}

function capabilityOff(surface: string): Response {
	return errorJson(CAPABILITY_NOT_SUPPORTED_CODE, `capability not supported: ${surface}`, 404);
}

function operationFailure(err: unknown): Response {
	const failure =
		err instanceof TrackerOperationError
			? err
			: new TrackerOperationError(
					"internal_error",
					err instanceof Error ? err.message : String(err),
					500,
				);
	const headers: Record<string, string> =
		failure.retryAfter === null ? {} : { "retry-after": failure.retryAfter };
	return errorJson(failure.code, failure.message, failure.status, headers);
}

export interface AdoTrackerServerOptions {
	readonly config: AdoTrackerConfig;
	/** Override the Azure DevOps transport. Tests pass recorded payloads through it. */
	readonly fetchImpl?: typeof fetch;
}

/** Runs an operation and turns its outcome, either way, into a JSON response. */
async function attempt(operation: () => Promise<unknown>): Promise<Response> {
	try {
		return json(await operation());
	} catch (err) {
		return operationFailure(err);
	}
}

interface Route {
	readonly method: "GET" | "POST";
	readonly path: RegExp;
	/** Receives the path's first capture group, the issue id segment where there is one. */
	readonly handle: (segment: string | undefined) => Promise<Response>;
}

/**
 * One operation per issue route. The id segment is decoded here so a
 * malformed escape answers 400 before any operation runs.
 */
function issueRoute(
	method: Route["method"],
	path: RegExp,
	operation: (key: string) => Promise<RemoteIssueResponse>,
): Route {
	return {
		method,
		path,
		handle: (segment) => {
			const key = decodeSegment(segment);
			if (key === undefined) return Promise.resolve(badIssueId(segment));
			return attempt(() => operation(key));
		},
	};
}

function buildRoutes(client: AdoClient, config: AdoTrackerConfig): readonly Route[] {
	const off = (surface: string) => async () => capabilityOff(surface);
	return [
		{ method: "GET", path: /^\/capabilities$/, handle: async () => json(CAPABILITIES_BODY) },
		issueRoute("GET", /^\/issues\/([^/]+)$/, (key) => readIssue(client, config, key)),
		{
			method: "GET",
			path: /^\/issue-statuses$/,
			handle: () =>
				attempt(
					async (): Promise<RemoteIssueStatusesResponse> => ({
						statuses: await readStatuses(client),
					}),
				),
		},
		issueRoute("POST", /^\/issues\/([^/]+)\/close$/, (key) => closeIssue(client, config, key)),
		{ method: "GET", path: /^\/plans(?:\/[^/]+)?$/, handle: off("plans") },
		{ method: "POST", path: /^\/issues\/[^/]+\/metadata$/, handle: off("metadata") },
		{ method: "GET", path: /^\/scheduled-issues$/, handle: off("scheduled-issues") },
	];
}

function isAuthorized(request: Request, config: AdoTrackerConfig): boolean {
	if (config.bearerToken === undefined) return true;
	return request.headers.get("authorization") === `Bearer ${config.bearerToken}`;
}

export function createAdoTrackerHandler(
	options: AdoTrackerServerOptions,
): (request: Request) => Promise<Response> {
	const { config } = options;
	const routes = buildRoutes(new AdoClient(config, options.fetchImpl ?? fetch), config);

	return async (request: Request): Promise<Response> => {
		if (!isAuthorized(request, config)) {
			return errorJson("unauthorized", "missing or invalid bearer token", 401);
		}
		const path = new URL(request.url).pathname;
		for (const route of routes) {
			if (request.method !== route.method) continue;
			const match = route.path.exec(path);
			if (match !== null) return route.handle(match[1]);
		}
		return errorJson("not_found", `no route: ${request.method} ${path}`, 404);
	};
}

export interface RunningAdoTracker {
	readonly port: number;
	readonly url: string;
	stop(): Promise<void>;
}

export async function startAdoTracker(
	options: AdoTrackerServerOptions & { readonly hostname?: string },
): Promise<RunningAdoTracker> {
	const handler = createAdoTrackerHandler(options);
	const server = Bun.serve({
		port: options.config.port,
		hostname: options.hostname ?? "0.0.0.0",
		fetch: handler,
	});
	const boundPort: number | undefined = server.port;
	if (boundPort === undefined) throw new Error("Bun.serve did not report a bound port");
	return {
		port: boundPort,
		url: `http://127.0.0.1:${boundPort}`,
		stop: async () => {
			server.stop(true);
		},
	};
}
