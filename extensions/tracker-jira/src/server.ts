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

import type { JiraTrackerConfig } from "./config.ts";
import { JiraClient } from "./jira/client.ts";
import {
	CAPABILITY_NOT_SUPPORTED_CODE,
	type CapabilitiesResponse,
	INVALID_ISSUE_ID_CODE,
	type RemoteIssueStatusesResponse,
	type RemoteTrackerCapabilities,
	TRACKER_PROTOCOL_VERSION,
	type TrackerErrorResponse,
} from "./protocol.ts";
import { closeIssue, readIssue, readStatuses, TrackerOperationError } from "./operations.ts";

/**
 * What this tracker can do, per the issue that asked for it. Jira has no
 * plan object warren can walk, so a plan-run over Jira issues uses
 * `POST /plan-runs` with an explicit ordered `issues: [...]` list, which
 * the base contract is enough to drive. Metadata would need a Jira custom
 * field per warren key and scheduled issues would need a due-date
 * convention; neither is guessable, so neither is declared.
 */
export const JIRA_CAPABILITIES: RemoteTrackerCapabilities = {
	supportsPlans: false,
	supportsMetadata: false,
	supportsScheduledIssues: false,
	isGitNative: false,
};

const ISSUE_PATH = /^\/issues\/([^/]+)$/;
const CLOSE_PATH = /^\/issues\/([^/]+)\/close$/;
const METADATA_PATH = /^\/issues\/([^/]+)\/metadata$/;
const PLAN_PATH = /^\/plans\/([^/]+)$/;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

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
	return errorJson(
		CAPABILITY_NOT_SUPPORTED_CODE,
		`capability not supported: ${surface}`,
		404,
	);
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

export interface JiraTrackerServerOptions {
	readonly config: JiraTrackerConfig;
	/** Override the Jira transport. Tests pass recorded payloads through it. */
	readonly fetchImpl?: typeof fetch;
}

export function createJiraTrackerHandler(
	options: JiraTrackerServerOptions,
): (request: Request) => Promise<Response> {
	const { config } = options;
	const client = new JiraClient(config, options.fetchImpl ?? fetch);

	return async (request: Request): Promise<Response> => {
		const path = new URL(request.url).pathname;

		if (config.bearerToken !== undefined) {
			if (request.headers.get("authorization") !== `Bearer ${config.bearerToken}`) {
				return errorJson("unauthorized", "missing or invalid bearer token", 401);
			}
		}

		if (request.method === "GET" && path === "/capabilities") {
			const body: CapabilitiesResponse = {
				protocolVersion: TRACKER_PROTOCOL_VERSION,
				capabilities: JIRA_CAPABILITIES,
			};
			return json(body);
		}

		const issueMatch = ISSUE_PATH.exec(path);
		if (request.method === "GET" && issueMatch !== null) {
			const key = decodeSegment(issueMatch[1]);
			if (key === undefined) return badIssueId(issueMatch[1]);
			try {
				return json(await readIssue(client, config, key));
			} catch (err) {
				return operationFailure(err);
			}
		}

		if (request.method === "GET" && path === "/issue-statuses") {
			try {
				const body: RemoteIssueStatusesResponse = { statuses: await readStatuses(client) };
				return json(body);
			} catch (err) {
				return operationFailure(err);
			}
		}

		const closeMatch = CLOSE_PATH.exec(path);
		if (request.method === "POST" && closeMatch !== null) {
			const key = decodeSegment(closeMatch[1]);
			if (key === undefined) return badIssueId(closeMatch[1]);
			try {
				return json(await closeIssue(client, config, key));
			} catch (err) {
				return operationFailure(err);
			}
		}

		if (request.method === "GET" && (path === "/plans" || PLAN_PATH.test(path))) {
			return capabilityOff("plans");
		}
		if (request.method === "POST" && METADATA_PATH.test(path)) {
			return capabilityOff("metadata");
		}
		if (request.method === "GET" && path === "/scheduled-issues") {
			return capabilityOff("scheduled-issues");
		}

		return errorJson("not_found", `no route: ${request.method} ${path}`, 404);
	};
}

export interface RunningJiraTracker {
	readonly port: number;
	readonly url: string;
	stop(): Promise<void>;
}

export async function startJiraTracker(
	options: JiraTrackerServerOptions & { readonly hostname?: string },
): Promise<RunningJiraTracker> {
	const handler = createJiraTrackerHandler(options);
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
