/**
 * Minimal read-only HTTP client for the three warren surfaces the judge
 * needs: `GET /runs` (terminal-run discovery), `GET /runs/:id` (run
 * facts), and `GET /runs/:id/events` (bounded NDJSON pages).
 *
 * Hand-rolled against `docs/openapi.yaml` because no published client
 * artifact exists for out-of-core consumers (FRICTION §2). The token is
 * held inside the client closure and never appears in errors or return
 * values (the audit-log client.ts pattern).
 */

import {
	type RunDetail,
	type RunEvent,
	type RunListPage,
	parseRunDetail,
	parseRunEvent,
	parseRunListPage,
} from "./warren-wire.ts";

export type FetchFn = typeof fetch;

export interface WarrenClient {
	readonly baseUrl: string;
	readonly fetchFn: FetchFn;
	/** Authorization header value, pre-rendered once. Never logged. */
	readonly authorization: string;
}

export function createClient(opts: {
	baseUrl: string;
	token: string;
	fetchFn?: FetchFn;
}): WarrenClient {
	return {
		baseUrl: opts.baseUrl.replace(/\/+$/, ""),
		fetchFn: opts.fetchFn ?? fetch,
		authorization: `Bearer ${opts.token}`,
	};
}

/** A non-2xx from warren. Carries status and a body excerpt, never the token. */
export class WarrenHttpError extends Error {
	readonly status: number;
	readonly bodyExcerpt: string;
	constructor(status: number, bodyExcerpt: string, url: string) {
		super(`warren responded ${status} for ${url}: ${bodyExcerpt}`);
		this.name = "WarrenHttpError";
		this.status = status;
		this.bodyExcerpt = bodyExcerpt;
	}
}

async function requireOk(res: Response, url: string): Promise<void> {
	if (res.ok) return;
	const excerpt = (await res.text().catch(() => "")).slice(0, 500);
	throw new WarrenHttpError(res.status, excerpt, url);
}

/**
 * One page of the runs list for terminal-run discovery. The server
 * paginates by `?limit`/`?offset` (limit capped at 500 server-side) over
 * a list sorted `started desc`.
 *
 * FRICTION §1: there is no "runs changed since <cursor>" parameter and no
 * ascending order, so discovery re-lists from offset 0 every poll cycle,
 * and offset-paging over a moving desc list can skip or re-see rows
 * mid-page. Re-polling every cycle is the mitigation — discovery is
 * eventually consistent, never exact.
 */
export async function listRuns(
	client: WarrenClient,
	page: { limit: number; offset: number },
): Promise<RunListPage> {
	const url = `${client.baseUrl}/runs?limit=${page.limit}&offset=${page.offset}`;
	const res = await client.fetchFn(url, {
		headers: { authorization: client.authorization },
	});
	await requireOk(res, "GET /runs");
	return parseRunListPage(await res.json());
}

/**
 * One run's facts: outcome, failure reason, cost, and PR ground truth.
 * The response wraps the payload as `{run: {...}}` (warren-7d84);
 * {@link parseRunDetail} unwraps the envelope.
 */
export async function getRun(client: WarrenClient, runId: string): Promise<RunDetail> {
	const url = `${client.baseUrl}/runs/${encodeURIComponent(runId)}`;
	const res = await client.fetchFn(url, {
		headers: { authorization: client.authorization },
	});
	await requireOk(res, `GET /runs/${runId}`);
	return parseRunDetail(await res.json());
}

/**
 * One bounded page of a run's event tail: `?since=<seq>&limit=<n>`.
 *
 * `?since=<seq>` is EXCLUSIVE (events with `seq > since`), and `?limit`
 * implies `follow=false` — the response closes after the page. That is
 * exactly the read the judge wants: no held connection, no half-consumed
 * stream to reason about on restart.
 *
 * FRICTION §1: the alternative, `?follow=1`, holds one long-lived
 * connection per judged run, and the endpoint has no long-poll mode, so
 * the judge chooses bounded polling and pays poll-interval latency
 * instead of connection fan-out.
 */
export async function readEventsSince(
	client: WarrenClient,
	runId: string,
	opts: { since: number; limit: number },
): Promise<RunEvent[]> {
	const url =
		`${client.baseUrl}/runs/${encodeURIComponent(runId)}/events` +
		`?since=${opts.since}&limit=${opts.limit}`;
	const res = await client.fetchFn(url, {
		headers: { authorization: client.authorization },
	});
	await requireOk(res, `GET /runs/${runId}/events`);
	const body = await res.text();
	const events: RunEvent[] = [];
	for (const line of body.split("\n")) {
		if (line.trim() === "") continue;
		events.push(parseRunEvent(JSON.parse(line)));
	}
	return events;
}
