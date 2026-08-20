/**
 * The warren-tracker/v1 wire protocol (warren-d3a9, plan pl-a37b Track B).
 *
 * The vocabulary for talking to an EXTERNAL tracker container over HTTP.
 * The extension container holds its own tracker credential (a GitHub
 * token, a Linear key, …) — warren stores none. Warren's RemoteTracker
 * (`src/tracker/remote/remote-tracker.ts`) is the only in-core speaker;
 * the published conformance suite + FakeTracker reference server are
 * warren-53ea, so design every response shape here as something a
 * foreign implementation can be held to.
 *
 * EXPERIMENTAL (PHILOSOPHY rule 4): the protocol is versioned and
 * documented, but it is not a stable contract until a foreign
 * implementation survives the conformance suite unchanged. The design
 * record is docs/design/issue-tracker.md (warren-240e).
 *
 * Shape rules a conforming server must honor:
 *
 *   - Every response body is JSON with `Content-Type: application/json`.
 *   - Capability discovery: `GET /capabilities` returns
 *     {@link CapabilitiesResponse}. `protocolVersion` MUST equal
 *     {@link TRACKER_PROTOCOL_VERSION}; a mismatch is a boot-time
 *     failure on warren's side, not a per-call one.
 *   - Base contract: `GET /issues/{id}`, `GET /issue-statuses`,
 *     `POST /issues/{id}/close` (idempotent — closing an already-closed
 *     issue is 200, never an error).
 *   - Optional surfaces exist only when the corresponding capability
 *     flag is `true`: `GET /plans` + `GET /plans/{id}`
 *     (supportsPlans), `POST /issues/{id}/metadata`
 *     (supportsMetadata), `GET /scheduled-issues`
 *     (supportsScheduledIssues).
 *   - Errors: any non-2xx response carries {@link TrackerErrorResponse}
 *     with a machine-readable `error.code`. `issue_not_found` is the
 *     one reserved code; warren maps it to `IssueNotFoundError` and
 *     every other code to a `TrackerError`.
 *   - Statuses: `status` fields are the tracker's RAW status strings;
 *     warren normalizes them onto `IssueStatus` (open/closed/other) at
 *     the bridge, so a server never needs to understand warren's
 *     three-state vocabulary.
 *   - Timestamps cross the wire as ISO-8601 strings; the bridge
 *     converts to `Date`.
 *
 * Auth: warren sends `Authorization: Bearer <token>` on every request
 * when the operator configured one (`.warren/config.yaml`
 * `tracker.tokenEnv`, read from warren's environment — never persisted).
 * A server MAY reject with 401; warren surfaces that as a `TrackerError`.
 */

/** The single protocol version warren's bridge speaks. */
export const TRACKER_PROTOCOL_VERSION = "warren-tracker/v1";

/** Reserved error code: the requested issue id does not exist. */
export const TRACKER_ISSUE_NOT_FOUND_CODE = "issue_not_found";

/** The capability flag set a server declares on `GET /capabilities`. */
export interface RemoteTrackerCapabilities {
	readonly supportsPlans: boolean;
	readonly supportsMetadata: boolean;
	readonly supportsScheduledIssues: boolean;
	readonly isGitNative: boolean;
}

/** `GET /capabilities` response. */
export interface CapabilitiesResponse {
	readonly protocolVersion: string;
	readonly capabilities: RemoteTrackerCapabilities;
}

/**
 * `GET /issues/{id}` response. `status` is the tracker's raw status
 * string; `title`/`description`/`blockedBy`/`metadata` are optional
 * pass-throughs of the neutral `Issue` DTO.
 */
export interface RemoteIssueResponse {
	readonly id: string;
	readonly status: string;
	readonly title?: string;
	readonly description?: string;
	readonly blockedBy?: readonly string[];
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/** `GET /issue-statuses` response: a raw `id → status` map. */
export interface RemoteIssueStatusesResponse {
	readonly statuses: Readonly<Record<string, string>>;
}

/** `GET /plans` response (supportsPlans only). */
export interface RemotePlansResponse {
	readonly plans: readonly RemotePlanSummary[];
}

/** Wire form of `PlanSummary`; timestamps are ISO-8601 strings. */
export interface RemotePlanSummary {
	readonly id: string;
	readonly status: string;
	readonly seed?: string;
	readonly template?: string;
	readonly revision?: number;
	readonly name?: string;
	readonly childCount: number;
	readonly createdAt?: string;
	readonly updatedAt?: string;
}

/** `GET /plans/{id}` response (supportsPlans only). */
export interface RemotePlanResponse {
	readonly id: string;
	readonly status: string;
	readonly children: readonly string[];
	readonly steps?: readonly RemotePlanStep[];
}

/** Wire form of `PlanStep` (forward blocks semantics). */
export interface RemotePlanStep {
	readonly title?: string;
	readonly existingSeed?: string;
	readonly blocks?: readonly number[];
}

/** `POST /issues/{id}/metadata` request body (supportsMetadata only). */
export interface RemoteMetadataRequest {
	readonly metadata: Readonly<Record<string, unknown>>;
}

/** `GET /scheduled-issues` response (supportsScheduledIssues only). */
export interface RemoteScheduledIssuesResponse {
	readonly issues: readonly RemoteScheduledIssue[];
}

/** Wire form of `ScheduledIssue`; `scheduledFor` is an ISO-8601 string. */
export interface RemoteScheduledIssue {
	readonly id: string;
	readonly status: string;
	readonly title?: string;
	readonly scheduledFor: string;
}

/**
 * The error envelope every non-2xx response carries. `code` is a
 * machine-readable discriminator; `issue_not_found` is reserved.
 */
export interface TrackerErrorResponse {
	readonly error: {
		readonly code: string;
		readonly message: string;
	};
}

/** Endpoint paths, shared by the bridge and (later) the conformance suite. */
export const TRACKER_ENDPOINTS = {
	capabilities: "/capabilities",
	issue: (id: string) => `/issues/${encodeURIComponent(id)}`,
	closeIssue: (id: string) => `/issues/${encodeURIComponent(id)}/close`,
	issueStatuses: "/issue-statuses",
	plans: "/plans",
	plan: (id: string) => `/plans/${encodeURIComponent(id)}`,
	metadata: (id: string) => `/issues/${encodeURIComponent(id)}/metadata`,
	scheduledIssues: "/scheduled-issues",
} as const;
