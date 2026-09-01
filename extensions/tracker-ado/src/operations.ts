/**
 * The three base-contract operations, over the Azure DevOps client.
 *
 * This is where an Azure DevOps failure becomes a protocol failure. The
 * mapping is the interesting part, because the two sides mean different
 * things by the same status code:
 *
 *   - Azure DevOps 404 is the one case that IS the protocol's
 *     `issue_not_found`. So is an id that is not a number: no work item
 *     could have it, and asking would only earn a 400.
 *   - Azure DevOps 401/403, and the 203 sign-in page it serves instead of
 *     a 401 on a bad token, mean THIS container's credential is wrong.
 *     Passing that through would tell warren its own bearer was
 *     rejected, sending an operator to the wrong secret, so it surfaces
 *     as 502.
 *   - Azure DevOps 429 passes through with `Retry-After`, because
 *     warren's bridge already backs off on it and knows how to wait.
 *   - Everything else, unreachable included, is 502: the tracker is
 *     present but the system behind it did not answer.
 */

import {
	AdoApiError,
	type AdoClient,
	AdoQueryTooBroadError,
	AdoTimeoutError,
} from "./ado/client.ts";
import {
	issueStatus,
	isTerminal,
	parseWorkItemId,
	pickCloseState,
	toIssueResponse,
} from "./ado/map.ts";
import type { AdoWorkItem, AdoWorkItemTypeState } from "./ado/types.ts";
import type { AdoTrackerConfig } from "./config.ts";
import type { IssueStatus, RemoteIssueResponse } from "./protocol.ts";
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

function notFound(key: string): TrackerOperationError {
	return new TrackerOperationError(TRACKER_ISSUE_NOT_FOUND_CODE, `issue not found: ${key}`, 404);
}

function toTrackerError(err: unknown, key?: string): TrackerOperationError {
	// A configuration answer: the query stays too broad on a retry, so a
	// 4xx keeps warren from repeating an expensive query for nothing.
	if (err instanceof AdoQueryTooBroadError) {
		return new TrackerOperationError("query_too_broad", err.message, 409);
	}
	// A 5xx, so warren's bridge backs off and tries again, which is the
	// right answer to a stalled upstream.
	if (err instanceof AdoTimeoutError) {
		return new TrackerOperationError("upstream_timeout", err.message, 504);
	}
	if (!(err instanceof AdoApiError)) {
		const reason = err instanceof Error ? err.message : String(err);
		return new TrackerOperationError("internal_error", reason, 500);
	}
	if (err.status === 404 && key !== undefined) return notFound(key);
	if (err.status === 401 || err.status === 403 || err.status === 203) {
		return new TrackerOperationError(
			"upstream_unauthorized",
			`azure devops rejected this tracker's own credential: ${err.message}`,
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

/**
 * The work item behind a key. This is the only read whose 404 means the
 * ISSUE is missing: every later call in an operation names a type or a
 * state, so a 404 there is Azure DevOps misbehaving, not an absent issue.
 */
async function readWorkItem(client: AdoClient, key: string): Promise<AdoWorkItem> {
	const id = parseWorkItemId(key);
	if (id === undefined) throw notFound(key);
	try {
		return await client.getWorkItem(id);
	} catch (err) {
		throw toTrackerError(err, key);
	}
}

/**
 * The states the work item's type defines. The type's spelling is the
 * process's own, so it is passed through as read; a work item without
 * one is not something Azure DevOps produces.
 */
function statesOf(client: AdoClient, item: AdoWorkItem): Promise<readonly AdoWorkItemTypeState[]> {
	return client.states(item.fields["System.WorkItemType"] ?? "");
}

export async function readIssue(
	client: AdoClient,
	config: AdoTrackerConfig,
	key: string,
): Promise<RemoteIssueResponse> {
	const item = await readWorkItem(client, key);
	try {
		return toIssueResponse(item, await statesOf(client, item), config.blockedByLink);
	} catch (err) {
		throw toTrackerError(err);
	}
}

/**
 * The status map. Each work item's state is folded through its type's
 * states, which the client caches, so a map over N types costs N state
 * lookups once and then only the query and the batch reads.
 */
export async function readStatuses(client: AdoClient): Promise<Record<string, IssueStatus>> {
	try {
		const statuses: Record<string, IssueStatus> = {};
		for (const item of await client.queryWorkItems()) {
			statuses[String(item.id)] = issueStatus(item, await statesOf(client, item));
		}
		return statuses;
	} catch (err) {
		throw toTrackerError(err);
	}
}

/**
 * Close, idempotently. A work item's terminal states are whatever its
 * process defines, so close reads the item and its type's states first.
 * The already-terminal case is answered by that read and never reaches a
 * state change: closing twice is 200 both times, which the protocol
 * requires and the conformance suite checks.
 *
 * A process that offers no terminal state, or one whose configured name
 * is not a terminal state of the type, is a configuration answer rather
 * than a transient failure, so it surfaces as 409. Warren does not retry
 * a 4xx.
 *
 * The state change names the revision the decision was made on. When
 * someone edited the work item in between, Azure DevOps refuses it, and
 * close re-reads the item once: an edit that made it terminal (a board
 * user removed it, say) is honored as is, any other edit gets the state
 * change again on the fresh revision. A second refusal surfaces as the
 * upstream failure it is.
 */
export async function closeIssue(
	client: AdoClient,
	config: AdoTrackerConfig,
	key: string,
): Promise<RemoteIssueResponse> {
	const current = await readWorkItem(client, key);
	try {
		const states = await statesOf(client, current);
		if (isTerminal(current, states)) {
			return toIssueResponse(current, states, config.blockedByLink);
		}

		const target = pickCloseState(states, config.doneState);
		if (target === undefined) {
			throw noCloseState(config.doneState, current.fields["System.WorkItemType"] ?? "", key);
		}
		const closed = await moveIntoState(client, current, states, target);
		return toIssueResponse(closed, states, config.blockedByLink);
	} catch (err) {
		if (err instanceof TrackerOperationError) throw err;
		throw toTrackerError(err);
	}
}

/** What Azure DevOps answers when the patch's revision test fails (VS403351). */
const REVISION_CONFLICT_STATUS = 412;

async function moveIntoState(
	client: AdoClient,
	current: AdoWorkItem,
	states: readonly AdoWorkItemTypeState[],
	target: string,
): Promise<AdoWorkItem> {
	try {
		return await client.setState(current, target);
	} catch (err) {
		if (!(err instanceof AdoApiError) || err.status !== REVISION_CONFLICT_STATUS) throw err;
		const fresh = await client.getWorkItem(current.id);
		if (isTerminal(fresh, states)) return fresh;
		return client.setState(fresh, target);
	}
}

function noCloseState(
	doneState: string | undefined,
	type: string,
	key: string,
): TrackerOperationError {
	return new TrackerOperationError(
		"no_close_state",
		doneState === undefined
			? `the "${type}" process defines no Completed-category state to close ${key} into`
			: `state "${doneState}" is not a Completed- or Removed-category state of "${type}", so ${key} cannot be closed into it`,
		409,
	);
}
