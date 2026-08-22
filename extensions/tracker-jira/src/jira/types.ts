/**
 * The slice of the Jira Cloud REST v3 response shapes this tracker reads.
 *
 * Everything is optional on purpose. Jira returns fields per the `fields`
 * query parameter, a workflow can leave a status category unset, and a
 * self-hosted proxy can strip things, so the mapping narrows rather than
 * trusts. Nothing here is a Jira type import: the payloads cross an HTTP
 * boundary, so they are parsed, not asserted.
 */

export interface JiraStatusCategory {
	readonly key?: string;
	readonly name?: string;
}

export interface JiraStatus {
	readonly name?: string;
	readonly statusCategory?: JiraStatusCategory;
}

export interface JiraLinkedIssueRef {
	readonly key?: string;
}

export interface JiraIssueLinkType {
	readonly name?: string;
	readonly inward?: string;
	readonly outward?: string;
}

export interface JiraIssueLink {
	readonly type?: JiraIssueLinkType;
	readonly inwardIssue?: JiraLinkedIssueRef;
	readonly outwardIssue?: JiraLinkedIssueRef;
}

export interface JiraIssueFields {
	readonly summary?: string | null;
	/** Atlassian Document Format node tree on v3; a plain string on v2. */
	readonly description?: unknown;
	readonly status?: JiraStatus;
	readonly issuelinks?: readonly JiraIssueLink[];
}

export interface JiraIssue {
	readonly key?: string;
	readonly fields?: JiraIssueFields;
}

/** `GET /rest/api/3/search/jql` page. */
export interface JiraSearchPage {
	readonly issues?: readonly JiraIssue[];
	readonly nextPageToken?: string;
	readonly isLast?: boolean;
}

export interface JiraTransition {
	readonly id?: string;
	readonly name?: string;
	readonly to?: JiraStatus;
}

/** `GET /rest/api/3/issue/{key}/transitions` response. */
export interface JiraTransitionsResponse {
	readonly transitions?: readonly JiraTransition[];
}

/** The status category key Jira uses for every terminal status. */
export const JIRA_DONE_CATEGORY = "done";
