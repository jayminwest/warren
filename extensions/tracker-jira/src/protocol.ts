/**
 * The warren-tracker/v1 wire protocol, base-contract subset.
 *
 * PUBLISHED VOCABULARY COPY. The extension seam
 * (docs/design/extensions.md) forbids importing warren internals, so this
 * is a deliberate copy of the published declaration that ships with
 * `@warren-ext/tracker-conformance` (`src/protocol.ts`), which is itself
 * the extension-side mirror of warren's canonical
 * `src/tracker/remote/protocol.ts`. The conformance suite is what holds
 * all three to the same behavior, so run it after touching this file.
 *
 * Only the base contract lives here. This tracker declares
 * `supportsPlans`, `supportsMetadata` and `supportsScheduledIssues` all
 * false, and warren never calls a surface whose capability was not
 * declared, so copying the plan, metadata and scheduled-issue shapes
 * would be copying vocabulary this package cannot speak.
 */

/** The single protocol version warren's bridge speaks. */
export const TRACKER_PROTOCOL_VERSION = "warren-tracker/v1";

/** Reserved error code: the requested issue id does not exist. */
export const TRACKER_ISSUE_NOT_FOUND_CODE = "issue_not_found";

/** Returned when a path segment is not valid percent-encoding. */
export const INVALID_ISSUE_ID_CODE = "invalid_issue_id";

/** Returned on an optional surface this tracker does not declare. */
export const CAPABILITY_NOT_SUPPORTED_CODE = "capability_not_supported";

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

/** `GET /issues/{id}` response. `status` is the tracker's RAW string. */
export interface RemoteIssueResponse {
	readonly id: string;
	readonly status: string;
	readonly title?: string;
	readonly description?: string;
	readonly blockedBy?: readonly string[];
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/** `GET /issue-statuses` response: a raw `id -> status` map. */
export interface RemoteIssueStatusesResponse {
	readonly statuses: Readonly<Record<string, string>>;
}

/** The error envelope every non-2xx response carries. */
export interface TrackerErrorResponse {
	readonly error: {
		readonly code: string;
		readonly message: string;
	};
}
