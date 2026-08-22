/**
 * The three base-contract operations, over the Jira client.
 *
 * This is where a Jira failure becomes a protocol failure. The mapping is
 * the interesting part, because the two sides mean different things by
 * the same status code:
 *
 *   - Jira 404 is the one case that IS the protocol's `issue_not_found`.
 *   - Jira 401/403 means THIS container's credential is wrong. Passing it
 *     through would tell warren its own bearer was rejected, sending an
 *     operator to the wrong secret, so it surfaces as 502.
 *   - Jira 429 passes through with `Retry-After`, because warren's bridge
 *     already backs off on it and knows how to wait.
 *   - Everything else, unreachable included, is 502: the tracker is
 *     present but the system behind it did not answer.
 */

import type { JiraTrackerConfig } from "./config.ts";
import { JiraApiError, type JiraClient } from "./jira/client.ts";
import { isDone, pickCloseTransition, toIssueResponse } from "./jira/map.ts";
import type { RemoteIssueResponse } from "./protocol.ts";
import { TRACKER_ISSUE_NOT_FOUND_CODE } from "./protocol.ts";

/** A failure already shaped for the wire. */
export class TrackerOperationError extends Error {
	readonly code: string;
	readonly status: number;
	readonly retryAfter: string | null;

	constructor(code: string, message: string, status: number, retryAfter: string | null = null) {
		super(message);
		this.name = "TrackerOperationError";
		this.code = code;
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

export function toTrackerError(err: unknown, key?: string): TrackerOperationError {
	if (!(err instanceof JiraApiError)) {
		const reason = err instanceof Error ? err.message : String(err);
		return new TrackerOperationError("internal_error", reason, 500);
	}
	if (err.status === 404 && key !== undefined) {
		return new TrackerOperationError(TRACKER_ISSUE_NOT_FOUND_CODE, `issue not found: ${key}`, 404);
	}
	if (err.status === 401 || err.status === 403) {
		return new TrackerOperationError(
			"upstream_unauthorized",
			`jira rejected this tracker's own credential: ${err.message}`,
			502,
		);
	}
	if (err.status === 429) {
		return new TrackerOperationError("upstream_rate_limited", err.message, 429, err.retryAfter);
	}
	if (err.status === 0) {
		return new TrackerOperationError("upstream_unreachable", err.message, 502);
	}
	return new TrackerOperationError("upstream_error", err.message, 502);
}

export async function readIssue(
	client: JiraClient,
	config: JiraTrackerConfig,
	key: string,
): Promise<RemoteIssueResponse> {
	try {
		const issue = await client.getIssue(key);
		return toIssueResponse(issue, key, config.blockedByInward);
	} catch (err) {
		throw toTrackerError(err, key);
	}
}

export async function readStatuses(client: JiraClient): Promise<Record<string, string>> {
	try {
		return await client.issueStatuses();
	} catch (err) {
		throw toTrackerError(err);
	}
}

/**
 * Close, idempotently. Jira has no close verb, only workflow transitions,
 * and a workflow usually offers none out of a terminal status. So the
 * already-done case is answered by the read and never reaches a
 * transition: closing twice is 200 both times, which the protocol
 * requires and the conformance suite checks.
 *
 * A workflow that offers no way to a terminal status from here is a
 * configuration answer rather than a transient failure, so it surfaces as
 * 409. Warren does not retry a 4xx.
 */
export async function closeIssue(
	client: JiraClient,
	config: JiraTrackerConfig,
	key: string,
): Promise<RemoteIssueResponse> {
	try {
		const current = await client.getIssue(key);
		if (isDone(current)) return toIssueResponse(current, key, config.blockedByInward);

		const { transitions } = await client.transitions(key);
		const transition = pickCloseTransition(transitions, config.doneTransition);
		if (transition?.id === undefined) {
			throw new TrackerOperationError(
				"no_close_transition",
				config.doneTransition === undefined
					? `no transition from "${current.fields?.status?.name ?? "?"}" lands in the done category for ${key}`
					: `transition "${config.doneTransition}" is not available on ${key} right now`,
				409,
			);
		}
		await client.applyTransition(key, transition.id);
		const closed = await client.getIssue(key);
		return toIssueResponse(closed, key, config.blockedByInward);
	} catch (err) {
		if (err instanceof TrackerOperationError) throw err;
		throw toTrackerError(err, key);
	}
}
