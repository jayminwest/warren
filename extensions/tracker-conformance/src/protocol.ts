/**
 * The warren-tracker/v1 wire protocol — PUBLISHED VOCABULARY COPY.
 *
 * This module is the extension-side mirror of warren's canonical
 * declaration (`src/tracker/remote/protocol.ts`, warren-d3a9). The
 * extension seam (docs/design/extensions.md) forbids importing warren
 * internals, so the vocabulary is duplicated here BY DESIGN: this copy
 * is what a foreign tracker author codes against, and the conformance
 * suite (`src/conformance.ts`) is the falsification test that holds
 * both copies to the same behavior. If warren's copy changes, change
 * this one in the same commit and re-run the suite.
 *
 * STATUS: EXPERIMENTAL (docs/PHILOSOPHY.md rule 4). The protocol is
 * versioned and documented, but it is not a stable contract until a
 * foreign implementation survives the conformance suite unchanged.
 *
 * Shape rules a conforming server must honor:
 *
 *   - Every response body is JSON with `Content-Type: application/json`.
 *   - `GET /capabilities` returns {@link CapabilitiesResponse};
 *     `protocolVersion` MUST equal {@link TRACKER_PROTOCOL_VERSION}.
 *   - Base contract: `GET /issues/{id}`, `GET /issue-statuses`,
 *     `POST /issues/{id}/close` (idempotent — closing an already-closed
 *     issue is 200, never an error).
 *   - Optional surfaces exist only when the corresponding capability
 *     flag is `true`: `GET /plans` + `GET /plans/{id}` (supportsPlans),
 *     `POST /issues/{id}/metadata` (supportsMetadata),
 *     `GET /scheduled-issues` (supportsScheduledIssues).
 *   - Any non-2xx response carries {@link TrackerErrorResponse} with a
 *     machine-readable `error.code`; `issue_not_found` is reserved for
 *     the missing-id case.
 *   - `status` fields are the tracker's RAW status strings — warren
 *     normalizes at its bridge; a server never speaks warren's
 *     three-state vocabulary.
 *   - Timestamps cross the wire as ISO-8601 strings.
 *
 * Auth: warren sends `Authorization: Bearer <token>` when the operator
 * configured one. A server MAY reject with 401.
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

/** `GET /issues/{id}` response. */
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

/** Wire form of a plan summary; timestamps are ISO-8601 strings. */
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

/** Wire form of a plan step (forward blocks semantics). */
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

/** Wire form of a scheduled issue; `scheduledFor` is ISO-8601. */
export interface RemoteScheduledIssue {
	readonly id: string;
	readonly status: string;
	readonly title?: string;
	readonly scheduledFor: string;
}

/** The error envelope every non-2xx response carries. */
export interface TrackerErrorResponse {
	readonly error: {
		readonly code: string;
		readonly message: string;
	};
}

/** Endpoint paths, shared by the suite and the reference server. */
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
