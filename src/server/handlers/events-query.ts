/**
 * Global events query handler — `GET /events` (pl-7e38 step 15 /
 * warren-5eec).
 *
 * Thin surface over `queryGlobalEvents` (`src/runs/global-events.ts`):
 * the domain module owns the SQL, this file only parses query params and
 * applies the public projection.
 *
 * Public projection: a `WARREN_AUTH=public` spectator gets exactly the
 * per-event reduction `GET /runs/:id/events` already applies
 * (`projectEvent` — internal kinds dropped, failure payloads
 * body/log-split, deep credential scrub), so the global view can never
 * disclose more about a run than its own event tail does. Internal
 * kinds are dropped from the page rather than emitted as redacted
 * placeholders, so a spectator's page may be shorter than an
 * operator's — same behaviour as the per-run NDJSON tail.
 *
 * Envelope: `{ events, total, limit, offset }` — the same shape
 * `GET /runs` uses, with `limit`/`offset` pagination (cap 500).
 */

import { ValidationError } from "../../core/errors.ts";
import { EVENT_STREAMS, type EventStream } from "../../core/wire.ts";
import {
	GLOBAL_EVENTS_DEFAULT_LIMIT,
	GLOBAL_EVENTS_MAX_LIMIT,
	type GlobalEventRow,
	type GlobalEventsFilter,
	queryGlobalEvents,
} from "../../runs/global-events.ts";
import { isPublicOnly } from "../projection.ts";
import { jsonResponse } from "../response.ts";
import type { Actor, RouteHandler, ServerDeps } from "../types.ts";
import { INTERNAL_EVENT_KINDS, projectEvent } from "./runs/event-projection.ts";
import { toWireEventFields, type WireEventFields } from "./runs/events.ts";
import { parseAnalyticsDateBound } from "./runs/lifecycle.ts";

/** One event on the wire — the same field names `eventToNdjson` emits. */
export type WireEvent = WireEventFields;

/** Narrow one row for `actor`; `null` means dropped (internal kind). */
export function toWireEvent(row: GlobalEventRow, actor: Actor | undefined): WireEvent | null {
	const projected = projectEvent(row, actor);
	if (projected === null) return null;
	return toWireEventFields(projected);
}

function parsePositiveInt(
	raw: string | null,
	name: string,
	{ max, min }: { max: number; min: number },
): number | undefined {
	if (raw === null) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < min || String(n) !== raw) {
		throw new ValidationError(`?${name} must be an integer ≥ ${min}; got '${raw}'`);
	}
	if (n > max) throw new ValidationError(`?${name} must be ≤ ${max}`);
	return n;
}

function parseStream(raw: string | null): EventStream | undefined {
	if (raw === null) return undefined;
	if (!(EVENT_STREAMS as readonly string[]).includes(raw)) {
		throw new ValidationError(`?stream must be one of ${EVENT_STREAMS.join(", ")}; got '${raw}'`);
	}
	return raw as EventStream;
}

/** Parse the full `GET /events` query string into a domain filter. */
export function parseGlobalEventsQuery(url: URL): GlobalEventsFilter {
	return {
		projectId: url.searchParams.get("projectId") || undefined,
		runId: url.searchParams.get("runId") || undefined,
		stream: parseStream(url.searchParams.get("stream")),
		kind: url.searchParams.get("kind") || undefined,
		since: parseAnalyticsDateBound({ url }, "since"),
		until: parseAnalyticsDateBound({ url }, "until"),
		limit:
			parsePositiveInt(url.searchParams.get("limit"), "limit", {
				min: 1,
				max: GLOBAL_EVENTS_MAX_LIMIT,
			}) ?? GLOBAL_EVENTS_DEFAULT_LIMIT,
		offset:
			parsePositiveInt(url.searchParams.get("offset"), "offset", { min: 0, max: 1 << 40 }) ?? 0,
	};
}

export function eventsQueryHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const filter = parseGlobalEventsQuery(ctx.url);
		// Spectators never even page over internal kinds: the exclusion
		// rides the SQL where-clause, so the page and the `total` agree
		// with the post-projection view rather than leaking that internal
		// events exist via a count the page can't fill.
		const scopedFilter = isPublicOnly(ctx.actor)
			? { ...filter, excludedKinds: [...INTERNAL_EVENT_KINDS] }
			: filter;
		const page =
			deps.dbAdapter === undefined
				? { events: [], total: 0 }
				: await queryGlobalEvents(deps.dbAdapter, scopedFilter);
		const events: WireEvent[] = [];
		for (const row of page.events) {
			const wire = toWireEvent(row, ctx.actor);
			if (wire !== null) events.push(wire);
		}
		// Body varies with Authorization (spectator pages drop internal
		// kinds and scrub payloads); jsonResponse already merges
		// `Vary: Authorization`.
		return jsonResponse(200, {
			events,
			total: page.total,
			limit: filter.limit,
			offset: filter.offset,
		});
	};
}
