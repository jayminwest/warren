/**
 * The Jira Cloud REST v3 client.
 *
 * Every call goes through {@link JiraClient.request}, so the credential
 * is attached in one place and an upstream failure becomes one error type
 * carrying the status. `fetchImpl` is the seam the tests drive with
 * recorded Jira payloads.
 *
 * No retries live here. Warren's bridge already retries 429 and 5xx with
 * backoff that honors `Retry-After` (docs/design/issue-tracker.md §5), so
 * this server passes the upstream's answer up rather than growing a
 * second, unsynchronized backoff underneath the first.
 */

import { jiraAuthHeader, type JiraTrackerConfig } from "../config.ts";
import type { JiraIssue, JiraSearchPage, JiraTransitionsResponse } from "./types.ts";

/** A non-2xx or unreachable Jira. `status` is 0 when the call never landed. */
export class JiraApiError extends Error {
	readonly status: number;
	readonly retryAfter: string | null;

	constructor(message: string, status: number, retryAfter: string | null = null) {
		super(message);
		this.name = "JiraApiError";
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

/** The issue fields this tracker reads. Anything else is Jira's business. */
const ISSUE_FIELDS = "summary,description,status,issuelinks";

export class JiraClient {
	private readonly config: JiraTrackerConfig;
	private readonly fetchImpl: typeof fetch;

	constructor(config: JiraTrackerConfig, fetchImpl: typeof fetch = fetch) {
		this.config = config;
		this.fetchImpl = fetchImpl;
	}

	async getIssue(key: string): Promise<JiraIssue> {
		const path = `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`;
		return requireObject(await this.request("GET", path), `GET ${path}`) as JiraIssue;
	}

	/**
	 * The raw `key -> status name` map for every issue the configured JQL
	 * selects, walked page by page. Jira Cloud's enhanced search paginates
	 * on an opaque `nextPageToken` rather than an offset, and stops when it
	 * stops returning one. `maxSearchPages` is the backstop against a query
	 * that never stops, and it throws rather than truncating: a silently
	 * short status map would read to warren as issues that vanished.
	 */
	async issueStatuses(): Promise<Record<string, string>> {
		const statuses: Record<string, string> = {};
		let token: string | undefined;
		for (let page = 0; page < this.config.maxSearchPages; page++) {
			const query = new URLSearchParams({
				jql: this.config.jql,
				fields: "status",
				maxResults: String(this.config.searchPageSize),
			});
			if (token !== undefined) query.set("nextPageToken", token);
			const path = `/rest/api/3/search/jql?${query}`;
			const body = requireObject(await this.request("GET", path), `GET ${path}`) as JiraSearchPage;
			for (const issue of body.issues ?? []) {
				if (typeof issue.key === "string" && issue.key.length > 0) {
					statuses[issue.key] = issue.fields?.status?.name ?? "";
				}
			}
			token = body.isLast === true ? undefined : body.nextPageToken;
			if (token === undefined || token === "") return statuses;
		}
		throw new JiraApiError(
			`the configured JQL returned more than ${this.config.maxSearchPages} pages; narrow it or raise JIRA_MAX_SEARCH_PAGES`,
			0,
		);
	}

	async transitions(key: string): Promise<JiraTransitionsResponse> {
		const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
		return requireObject(await this.request("GET", path), `GET ${path}`) as JiraTransitionsResponse;
	}

	async applyTransition(key: string, transitionId: string): Promise<void> {
		const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
		await this.request("POST", path, { transition: { id: transitionId } });
	}

	private async request(method: string, path: string, body?: unknown): Promise<unknown> {
		const headers: Record<string, string> = {
			accept: "application/json",
			authorization: jiraAuthHeader(this.config.auth),
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
				method,
				headers,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new JiraApiError(`jira unreachable: ${reason}`, 0);
		}
		if (!response.ok) {
			throw new JiraApiError(
				`jira ${method} ${path} failed: ${response.status} ${await errorText(response)}`,
				response.status,
				response.headers.get("retry-after"),
			);
		}
		// A transition returns 204 with no body, and so may a proxy on a
		// path that normally carries one.
		if (response.status === 204) return undefined;
		const text = await response.text();
		if (text.trim() === "") return undefined;
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new JiraApiError(`jira ${method} ${path} returned a body that is not JSON`, 502);
		}
	}
}

/**
 * A 2xx that carried no object. `applyTransition` expects exactly that and
 * does not come through here, but a read does: a proxy answering 200 with
 * an empty body would otherwise reach the mapping as `undefined` and
 * surface as an internal error rather than as the upstream problem it is.
 */
function requireObject(body: unknown, what: string): object {
	if (body === null || typeof body !== "object") {
		throw new JiraApiError(`jira ${what} answered 2xx with no object`, 502);
	}
	return body;
}

/**
 * Jira's error bodies come in several shapes (`errorMessages`, `errors`,
 * an HTML page from a proxy), so the text is only ever a diagnostic
 * string. It is bounded because it lands in this server's logs and in the
 * message warren surfaces.
 */
async function errorText(response: Response): Promise<string> {
	try {
		const text = await response.text();
		return text.slice(0, 300);
	} catch {
		return "<unreadable body>";
	}
}
